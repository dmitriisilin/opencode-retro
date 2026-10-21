import { test } from "node:test"
import assert from "node:assert/strict"
import { createIngest } from "../src/ingest.js"
import { replay } from "./replay.js"

test("the lint-trap session replays into a shadow log", () => {
  const { records } = replay("session-lint-trap.jsonl")

  const prompts = records.filter((r) => r.k === "prompt")
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].text, /average\(numbers\)/)

  const tools = records.filter((r) => r.k === "tool")
  assert.equal(tools.length, 12, "M0 captured exactly 12 tool calls")
  assert.deepEqual(
    [...new Set(tools.map((t) => t.tool))].sort(),
    ["edit", "glob", "read", "shell", "skill"],
    "tool names as verified in M0 — note shell, not bash",
  )

  const end = records.at(-1)
  assert.equal(end.k, "session")
  assert.equal(end.outcome, "succeeded")
})

test("n is monotonic per session and unique", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const ns = records.map((r) => r.n)
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b))
  assert.equal(new Set(ns).size, ns.length)
})

test("a failing shell command keeps its exit code, which status hides", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const eslint = records.find((r) => r.k === "tool" && /eslint/.test(r.input?.command ?? ""))

  assert.equal(eslint.status, "completed", "OpenCode reports a non-zero exit as completed")
  assert.equal(eslint.exit, 2, "so the exit code is the only failure signal")
  assert.match(eslint.output, /couldn't find an eslint\.config/)
})

test("an edit keeps its patch, and a skill keeps the directory to propose against", () => {
  const { records } = replay("session-lint-trap.jsonl")

  const edit = records.find((r) => r.k === "tool" && r.tool === "edit")
  assert.equal(edit.files.length, 1)
  assert.equal(edit.files[0].file, "src/sum.js")
  assert.match(edit.files[0].patch, /\+export function average/)

  const skill = records.find((r) => r.k === "tool" && r.tool === "skill")
  assert.equal(skill.skill.name, "lint")
  assert.match(skill.skill.directory, /\.opencode\/skills\/lint$/)
})

test("tool calls are paired by id, not by arrival order", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const reads = records.filter((r) => r.k === "tool" && r.tool === "read")

  // M0 observed three `before` payloads arriving ahead of their three `after`s.
  assert.ok(reads.length >= 3)
  for (const r of reads) {
    assert.ok(r.input?.path, "a mispaired call would have lost its input")
    assert.equal(r.status, "completed")
  }
})

test("step records carry what the git snapshot and the changed files say", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const steps = records.filter((r) => r.k === "step")
  assert.ok(steps.length > 0)
  assert.ok(steps.some((s) => s.snapshot), "snapshot is what makes revert checkable against git")
  assert.ok(steps.some((s) => typeof s.cost === "number"), "cost grounds a lesson score in real tokens")
})

test("output is clamped head-and-tail with the loss stated", () => {
  const { records } = replay("session-lint-trap.jsonl", { maxOutput: 200 })
  const clamped = records.filter((r) => r.k === "tool" && r.outputLength)
  assert.ok(clamped.length > 0)
  for (const r of clamped) {
    assert.ok(r.output.length < r.outputLength)
    assert.match(r.output, /characters elided/)
  }
})

/* ------------------------------------------------- the ingest directly */

const collector = (opts = {}) => {
  const out = []
  const ingest = createIngest({
    maxOutput: 8000,
    now: () => 1000,
    emit: (sessionID, record) => out.push({ sessionID, ...record }),
    ...opts,
  })
  return { out, ingest }
}

test("a failed call keeps the error, and claims no output it does not have", () => {
  const { out, ingest } = collector()
  ingest.toolAfter({ sessionID: "s", id: "c1", tool: "shell", status: "error", error: "spawn failed" })

  assert.equal(out.length, 1)
  assert.equal(out[0].status, "error")
  assert.equal(out[0].error, "spawn failed")
  assert.equal(out[0].output, undefined)
})

test("tool output split into content parts is joined, and output.output wins", () => {
  const { out, ingest } = collector()
  ingest.toolAfter({
    sessionID: "s",
    id: "c1",
    tool: "read",
    status: "completed",
    result: {
      content: [
        { type: "text", text: "first" },
        { type: "tool", text: "not text" },
        { type: "text", text: "second" },
      ],
    },
  })
  ingest.toolAfter({
    sessionID: "s",
    id: "c2",
    tool: "shell",
    status: "completed",
    result: { output: { output: "from output" }, content: [{ type: "text", text: "ignored" }] },
  })

  assert.equal(out[0].output, "first\nsecond")
  assert.equal(out[1].output, "from output")
})

test("a session that ends with a call still open records it, so an interrupt leaves no gap", () => {
  const { out, ingest } = collector()
  ingest.toolBefore({ sessionID: "s", id: "c1", tool: "read", input: { path: "a.js" }, agent: "build" })
  ingest.toolBefore({ sessionID: "s", id: "c2", tool: "shell", input: { command: "sleep 100" } })

  ingest.event({ type: "session.execution.interrupted", data: { sessionID: "s" } })

  const unfinished = out.filter((r) => r.k === "tool")
  assert.deepEqual(unfinished.map((r) => r.id), ["c1", "c2"])
  assert.equal(unfinished[0].status, "unfinished")
  assert.equal(unfinished[0].input.path, "a.js", "the input survives, so the projection can say what was cut off")
  assert.equal(unfinished[0].ms, 0)
  assert.equal(out.at(-1).k, "session")
  assert.equal(out.at(-1).outcome, "interrupted")
  assert.deepEqual(ingest.pending("s"), [], "and the queue of open calls is cleared")
})

test("a delegation's start and end are dropped, but its work stays in the parent's log", () => {
  const { out, ingest } = collector({ parentOf: (id) => (id === "child" ? "parent" : null) })
  ingest.prompt({ sessionID: "child", messageID: "m1", prompt: { text: "look at src/sum.js" } })
  ingest.event({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "child" } })
  ingest.toolAfter({
    sessionID: "child",
    id: "c1",
    tool: "read",
    agent: "explore",
    status: "completed",
    result: { output: { output: "export function sum" } },
  })
  ingest.event({ type: "session.execution.succeeded", durable: { seq: 9 }, data: { sessionID: "child" } })

  assert.ok(out.every((r) => r.sessionID === "parent"), "nothing is written under the child")
  assert.equal(out.filter((r) => r.k === "session").length, 0, "a delegation is a step, not a session")
  assert.deepEqual(out.map((r) => r.k), ["prompt", "tool"])
  assert.deepEqual(out.map((r) => r.n), [1, 2], "and it joins the parent's one sequence")
})

test("absorb renumbers records written before the parent link was known", () => {
  let link = null
  const { out, ingest } = collector({ parentOf: (id) => (id === "child" ? link : null) })
  ingest.prompt({ sessionID: "child", prompt: { text: "You are a subagent spawned by another session." } })
  assert.equal(out[0].sessionID, "child", "it lands in the only log that exists so far")

  link = "parent"
  ingest.absorb("child", [{ n: 1, t: 5, k: "prompt", text: "You are a subagent spawned by another session." }])

  assert.equal(out.at(-1).sessionID, "parent")
  assert.equal(out.at(-1).n, 1, "renumbered into the parent's sequence")
  assert.equal(out.at(-1).t, 1000, "with the parent's clock, not the orphan's")
  assert.deepEqual(ingest.sessions(), ["parent"], "the orphan session is forgotten")
})

test("an event with no session is ignored rather than crashing the stream", () => {
  const { out, ingest } = collector()
  assert.doesNotThrow(() => ingest.event({ type: "session.text.ended", data: {} }))
  assert.doesNotThrow(() => ingest.event({ type: "session.text.ended" }))
  assert.deepEqual(out, [])
})

test("text and step events keep what the projection and the score need", () => {
  const { out, ingest } = collector()
  // A hook first: a session is ours because a hook fired for it, and the event stream can
  // only annotate a log that already exists.
  ingest.prompt({ sessionID: "s", messageID: "m0", prompt: { text: "go" } })
  ingest.event({
    type: "session.text.ended",
    durable: { seq: 5 },
    data: { sessionID: "s", assistantMessageID: "m1", text: "Done." },
  })
  ingest.event({
    type: "session.step.ended",
    durable: { seq: 6 },
    data: {
      sessionID: "s",
      assistantMessageID: "m1",
      finish: "stop",
      snapshot: "abc123",
      files: ["src/sum.js"],
      tokens: { input: 10 },
      cost: 0.02,
    },
  })

  assert.deepEqual(out[1], {
    sessionID: "s",
    v: 1,
    n: 2,
    t: 1000,
    k: "text",
    seq: 5,
    message: "m1",
    text: "Done.",
  })
  assert.equal(out[2].k, "step")
  assert.equal(out[2].finish, "stop")
  assert.equal(out[2].snapshot, "abc123")
  assert.deepEqual(out[2].files, ["src/sum.js"])
  assert.equal(out[2].cost, 0.02)
})

test("a session no hook ever fired for is not ours, and gets no log at all", () => {
  // Measured, not hypothetical: a session run in a git worktree of this project reaches
  // every instance through the event stream, but the hooks fire only for the location the
  // session belongs to. Both instances wrote a log under the same session id with different
  // contents, ours missing the prompt entirely — so ours reported `BROKEN prompt hook,
  // most likely renamed upstream` about a healthy session, queued it, and counted it.
  const { out, ingest } = collector()

  for (const type of [
    "session.execution.started",
    "session.text.ended",
    "session.step.ended",
    "session.execution.succeeded",
  ]) {
    ingest.event({ type, durable: { seq: 2 }, data: { sessionID: "ses_elsewhere", text: "hi" } })
  }

  assert.deepEqual(out, [], "no record, so no file, so nothing to queue or verify")
})

test("once a hook has fired, the event stream annotates that same session", () => {
  const { out, ingest } = collector()
  ingest.prompt({ sessionID: "ses_ours", messageID: "m0", prompt: { text: "go" } })
  ingest.event({ type: "session.execution.succeeded", durable: { seq: 9 }, data: { sessionID: "ses_ours" } })

  assert.deepEqual(
    out.map((r) => r.k),
    ["prompt", "session"],
    "the end of our own session is still recorded",
  )
})

test("counts are the self-check's evidence, and forgetting a session clears them", () => {
  const { ingest } = collector()
  ingest.prompt({ sessionID: "s", prompt: { text: "hi" } })
  ingest.toolBefore({ sessionID: "s", id: "c1", tool: "read", input: {} })
  ingest.toolAfter({ sessionID: "s", id: "c1", tool: "read", status: "completed" })
  ingest.event({ type: "session.tool.called", durable: { seq: 2 }, data: { sessionID: "s", id: "c1" } })
  ingest.event({ type: "session.text.ended", durable: { seq: 3 }, data: { sessionID: "s", text: "hi" } })

  assert.deepEqual(ingest.counts("s"), { prompts: 1, toolHook: 1, toolEvents: 1, steps: 0, texts: 1, records: 3 })
  assert.deepEqual(ingest.sessions(), ["s"])
  ingest.forget("s")
  assert.deepEqual(ingest.sessions(), [])
})

test("a paired call with no input of its own takes the one the before hook recorded", () => {
  const { out, ingest } = collector()
  ingest.toolBefore({
    sessionID: "s",
    id: "c1",
    tool: "read",
    input: { path: "a.js" },
    messageID: "m1",
    agent: "build",
  })
  ingest.toolAfter({ sessionID: "s", id: "c1", tool: "read", status: "completed" })

  assert.deepEqual(out[0].input, { path: "a.js" })
  assert.equal(out[0].agent, "build")
  assert.equal(out[0].message, "m1")
  assert.equal(out[0].ms, 0)
})

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

test("a tool run through execute is one call, not two records with the same id", () => {
  const { out, ingest } = collector()
  // Measured live: an agent calling `retro_decide` through Code Mode's `execute` produced two
  // `tool` records with the same call id, one naming the inner tool and one naming `execute`.
  // The extractor read that as the same decision being recorded twice and derived a lesson
  // about the plugin from work that happened once.
  ingest.toolBefore({ sessionID: "s", id: "c1", tool: "retro_decide", input: { id: "lesson" } })
  ingest.toolBefore({ sessionID: "s", id: "c1", tool: "execute", input: { code: "tools.retro_decide(...)" } })
  ingest.toolAfter({
    sessionID: "s",
    id: "c1",
    tool: "retro_decide",
    status: "completed",
    result: { output: { output: "recorded" } },
  })
  ingest.toolAfter({
    sessionID: "s",
    id: "c1",
    tool: "execute",
    status: "completed",
    result: { output: { output: "recorded" } },
  })

  const tools = out.filter((r) => r.k === "tool")
  assert.equal(tools.length, 1, "one call id is one record")
  assert.equal(tools[0].tool, "retro_decide", "the inner tool is the action, so it is the record kept")
  assert.deepEqual(tools[0].input, { id: "lesson" }, "and the wrapper's before did not overwrite its input")
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
  assert.equal(ingest.owned("parent"), true, "and the parent is ours by association, even if its own hook was missed")
  assert.equal(ingest.counts("parent").prompts, 1, "the prompt moves with the record, or the report calls the hook dead")
})

test("a delegation inside a delegation belongs to the session that asked for it", () => {
  // A subagent can spawn one of its own, and `parentOf` gives one link at a time. Writing to
  // the middle session's log loses the deepest work: a session that is somebody's child is
  // never queued or analysed, and its log is pruned as uncited.
  const links = { leaf: "middle", middle: "root" }
  const { out, ingest } = collector({ parentOf: (id) => links[id] ?? null })

  ingest.prompt({ sessionID: "root", prompt: { text: "the task" } })
  ingest.prompt({ sessionID: "leaf", prompt: { text: "You are a subagent spawned by another session." } })
  ingest.toolAfter({
    sessionID: "leaf",
    id: "c1",
    tool: "read",
    status: "completed",
    result: { output: { output: "export function sum" } },
  })

  assert.ok(out.every((r) => r.sessionID === "root"), "nothing is written under an intermediate delegation")
  assert.deepEqual(out.map((r) => r.n), [1, 2, 3], "and it joins the one sequence")
})

test("ownership is a hook having fired, and the counters follow the owner", () => {
  const { ingest } = collector({ parentOf: (id) => (id === "child" ? "parent" : null) })
  assert.equal(ingest.owned("parent"), false, "an event alone may not open a session")

  ingest.prompt({ sessionID: "parent", prompt: { text: "go" } })
  assert.equal(ingest.owned("parent"), true)
  assert.equal(ingest.owned("child"), true, "a child is ours through its owner")

  ingest.toolAfter({ sessionID: "child", id: "c1", tool: "read", status: "completed" })
  assert.equal(ingest.counts("child").toolHook, 1, "read through the owner, not a session of its own")
  assert.equal(ingest.counts("parent").toolHook, 1)
})

test("an event with no session is ignored rather than crashing the stream", () => {
  const { out, ingest } = collector()
  assert.doesNotThrow(() => ingest.event({ type: "session.text.ended", data: {} }))
  assert.doesNotThrow(() => ingest.event({ type: "session.text.ended" }))
  assert.deepEqual(out, [])
})

test("text and step events keep what an analysis and the score need", () => {
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

  assert.deepEqual(ingest.counts("s"), { prompts: 1, handovers: 0, toolHook: 1, toolEvents: 1, unfinished: 0, steps: 0, texts: 1, records: 3 })
  assert.deepEqual(ingest.sessions(), ["s"])
  ingest.forget("s")
  assert.deepEqual(ingest.sessions(), [])
})

test("a hand-over is counted, because it is the only input some sessions get", () => {
  // `/retro` delivers its message through `session.synthetic`, which does not fire the
  // prompt hook. The self-check reads the prompt count to decide whether that hook works,
  // so a review session with no prompt used to be reported BROKEN — about a working hook,
  // in the session the plugin had just started.
  const { ingest } = collector()
  ingest.handover("s", "a lesson", "lesson", { sent: true })
  assert.equal(ingest.counts("s").handovers, 1)
  assert.equal(ingest.counts("s").prompts, 0)
})

test("only a hand-over sent to start a turn is counted as one", () => {
  // As `turnHandovers` reads the log: a proposal handed back as a tool result, or a send that
  // failed, started nothing, and must not excuse a turn with no prompt when the log cannot be read.
  const { ingest } = collector()
  ingest.handover("s", "a lesson")
  ingest.handover("s", "could not be delivered", "notice", { undelivered: true })
  assert.equal(ingest.counts("s").handovers, 0)
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

test("a turn after another process wrote the session numbers on from the file", () => {
  // The file is the shared truth: what another process appended between two turns of this one.
  let onDisk = 0
  const { out, ingest } = collector({ startAt: () => onDisk })
  const write = ingest.prompt.bind(ingest)
  write({ sessionID: "s", messageID: "m1", prompt: { text: "first" } })
  onDisk = out.at(-1).n
  ingest.endTurn("s")
  onDisk = 40 // turns 2 and 3, in the other process
  write({ sessionID: "s", messageID: "m2", prompt: { text: "again" } })
  assert.equal(out.at(-1).n, 41)
})

test("a hand-over whose send failed is taken back from the count", () => {
  const { ingest } = collector()
  ingest.handover("s", "the logs come first", "work", { sent: true })
  ingest.handover("s", "could not be delivered", "notice", { undelivered: true, of: 1 })
  assert.equal(ingest.counts("s").handovers, 0)
})

test("a failed send takes back only the hand-over it names, in the turn it was counted", () => {
  // Numbered on from what was written, as the file would say after the turn ends.
  let written = 0
  const { ingest } = collector({ startAt: () => written, emit: (_, r) => (written = r.n) })
  const first = ingest.handover("s", "a lesson", "lesson", { sent: true })
  ingest.endTurn("s")
  ingest.handover("s", "the logs come first", "work", { sent: true })
  ingest.handover("s", "could not be delivered", "notice", { undelivered: true, of: first })
  assert.equal(ingest.counts("s").handovers, 1, "the turn's own hand-over still counts")
})

test("a delegation's call left open at the root's end is written with its origin", () => {
  const parents = new Map()
  const { out, ingest } = collector({ parentOf: (id) => parents.get(id) ?? null })
  ingest.prompt({ sessionID: "p", messageID: "m1", prompt: { text: "go" } })
  parents.set("c", "p")
  ingest.toolBefore({ sessionID: "c", id: "k1", tool: "shell", input: { command: "sleep 99" } })
  ingest.event({ type: "session.execution.interrupted", durable: { seq: 9 }, data: { sessionID: "p" } })
  const open = out.find((r) => r.status === "unfinished")
  assert.equal(open.from, "c", "the subagent's call, not the agent's")
})

test("a turn's end delivered twice is written once, a hand-over between them notwithstanding", () => {
  const { out, ingest } = collector()
  ingest.prompt({ sessionID: "s", messageID: "m1", prompt: { text: "go" } })
  ingest.event({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "s" } })
  ingest.event({ type: "session.execution.succeeded", durable: { seq: 2 }, data: { sessionID: "s" } })
  ingest.handover("s", "the logs come first", "work", { sent: true })
  ingest.event({ type: "session.execution.succeeded", durable: { seq: 2 }, data: { sessionID: "s" } })
  assert.equal(out.filter((r) => r.k === "session" && r.event === "end").length, 1)
  ingest.event({ type: "session.execution.started", durable: { seq: 3 }, data: { sessionID: "s" } })
  ingest.event({ type: "session.execution.succeeded", durable: { seq: 4 }, data: { sessionID: "s" } })
  assert.equal(out.filter((r) => r.k === "session" && r.event === "end").length, 2, "the next turn's end is news")
})

test("a child's end folded into its parent's log does not swallow the parent's own end", () => {
  const parents = new Map()
  const { out, ingest } = collector({ parentOf: (id) => parents.get(id) ?? null })
  ingest.prompt({ sessionID: "p", messageID: "m1", prompt: { text: "go" } })
  ingest.event({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "p" } })
  parents.set("c", "p")
  ingest.absorb("c", [{ n: 1, k: "session", event: "end", outcome: "succeeded" }])
  ingest.event({ type: "session.execution.succeeded", durable: { seq: 2 }, data: { sessionID: "p" } })
  assert.equal(out.filter((r) => r.k === "session" && r.event === "end" && !r.from).length, 1)
})

test("a turn's end delivered again after the next turn started is known by its place in the sequence", () => {
  const { out, ingest } = collector()
  ingest.prompt({ sessionID: "s", messageID: "m1", prompt: { text: "go" } })
  ingest.event({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "s" } })
  assert.equal(ingest.event({ type: "session.execution.succeeded", durable: { seq: 5 }, data: { sessionID: "s" } }), "ended")
  ingest.prompt({ sessionID: "s", messageID: "m2", prompt: { text: "two" } })
  ingest.event({ type: "session.execution.started", durable: { seq: 6 }, data: { sessionID: "s" } })
  assert.equal(ingest.event({ type: "session.execution.succeeded", durable: { seq: 5 }, data: { sessionID: "s" } }), "repeated")
  assert.equal(out.filter((r) => r.k === "session" && r.event === "end").length, 1, "no end in the middle of the new turn")
})

test("any event delivered again is taken in once, a subagent's sequence apart from its parent's", () => {
  const parents = new Map([["c", "p"]])
  const { out, ingest } = collector({ parentOf: (id) => parents.get(id) ?? null })
  ingest.prompt({ sessionID: "p", messageID: "m1", prompt: { text: "do the thing" } })
  ingest.handover("p", "the logs come first", "work", { sent: true })
  ingest.event({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "p" } })
  assert.equal(ingest.event({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "p" } }), "repeated")
  ingest.event({ type: "session.text.ended", durable: { seq: 2 }, data: { sessionID: "p", assistantMessageID: "a", text: "hi" } })
  ingest.event({ type: "session.text.ended", durable: { seq: 2 }, data: { sessionID: "p", assistantMessageID: "a", text: "hi" } })
  // The child's own sequence starts low again, and is not a repeat of the parent's.
  ingest.event({ type: "session.text.ended", durable: { seq: 1 }, data: { sessionID: "c", assistantMessageID: "b", text: "child" } })
  assert.equal(out.filter((r) => r.k === "session" && r.event === "start").length, 1)
  assert.equal(out.filter((r) => r.k === "text" && !r.from).length, 1)
  assert.equal(out.filter((r) => r.k === "text" && r.from === "c").length, 1)
})

test("a turn whose start went unlogged keeps its end, told apart by its seq", () => {
  const { out, ingest } = collector()
  ingest.prompt({ sessionID: "s", messageID: "m1", prompt: { text: "go" } })
  ingest.event({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "s" } })
  ingest.event({ type: "session.execution.succeeded", durable: { seq: 2 }, data: { sessionID: "s" } })
  ingest.prompt({ sessionID: "s", messageID: "m2", prompt: { text: "and stop" } })
  // Its start dropped, nothing else written: interrupted at once.
  ingest.event({ type: "session.execution.interrupted", durable: { seq: 4 }, data: { sessionID: "s" } })
  assert.equal(out.filter((r) => r.k === "session" && r.event === "end").length, 2)
})

test("a call written as unfinished at an interrupt is not written again when its after-hook comes late", () => {
  const { out, ingest } = collector()
  ingest.prompt({ sessionID: "s", messageID: "m1", prompt: { text: "go" } })
  ingest.event({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "s" } })
  ingest.toolBefore({ sessionID: "s", id: "c1", tool: "shell", input: { command: "sleep 99" } })
  ingest.event({ type: "session.execution.interrupted", durable: { seq: 3 }, data: { sessionID: "s" } })
  ingest.endTurn("s")
  ingest.toolAfter({ sessionID: "s", id: "c1", tool: "shell", input: { command: "sleep 99" }, status: "error", error: "aborted" })
  assert.equal(out.filter((r) => r.k === "tool" && r.id === "c1").length, 1)
  assert.equal(ingest.counts("s").toolHook, 0, "and the next turn's counts are not its")
})

test("an event that arrives out of order is not taken for a repeat", () => {
  const { out, ingest } = collector()
  ingest.prompt({ sessionID: "s", messageID: "m1", prompt: { text: "go" } })
  ingest.event({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "s" } })
  ingest.event({ type: "session.text.ended", durable: { seq: 41 }, data: { sessionID: "s", assistantMessageID: "a", text: "late text first" } })
  assert.equal(ingest.event({ type: "session.execution.succeeded", durable: { seq: 40 }, data: { sessionID: "s" } }), "ended")
  assert.equal(out.filter((r) => r.k === "session" && r.event === "end").length, 1)
})

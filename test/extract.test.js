import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { extract } from "../src/extract.js"
import { createStore } from "../src/lessons.js"
import { createPrompts } from "../src/prompts.js"
import { createState } from "../src/state.js"
import { parseShadowLog } from "../src/shadowlog.js"
import { parseFrontmatter } from "../src/frontmatter.js"

const here = dirname(fileURLToPath(import.meta.url))
const live = () =>
  parseShadowLog(readFileSync(join(here, "..", "fixtures", "sessions", "lint-trap-live.jsonl"), "utf8"))

const MODEL = { providerID: "deepseek", id: "deepseek-flash" }

function rig({ reply, fail } = {}) {
  const root = mkdtempSync(join(tmpdir(), "retro-extract-"))
  const calls = []
  return {
    root,
    calls,
    lessonsDir: join(root, "lessons"),
    store: createStore({ dir: join(root, "lessons"), archive: join(root, "archive") }),
    state: createState({ path: join(root, "state.json") }),
    prompts: createPrompts({ dir: join(root, "prompts"), updates: join(root, "prompts", "updates") }),
    model: MODEL,
    generate: async (input) => {
      calls.push(input)
      if (fail) throw new Error(fail)
      return { text: reply }
    },
  }
}

const REPLY = (over = {}) =>
  "```json\n" +
  JSON.stringify({
    lessons: [
      {
        id: "lint-skill-no-config",
        statement: "The lint skill prescribes eslint, which this project cannot run.",
        steps: [9, 18],
        cost: 9,
        confidence: 0.9,
        matches: null,
        proposal: { target: ".opencode/skills/lint/SKILL.md", change: "Check for a config first." },
        why: "Step 9 invoked the skill; its command failed at step 18 with exit 2.",
        ...over,
      },
    ],
  }) +
  "\n```"

test("the live lint-trap session extracts into a lesson on disk", async () => {
  const r = rig({ reply: REPLY() })
  const result = await extract({ records: live(), session: "ses_live", ...r })

  assert.ok(result.ok, result.detail)
  assert.deepEqual(result.recorded.created, ["lint-skill-no-config"])

  const { data } = parseFrontmatter(readFileSync(join(r.lessonsDir, "lint-skill-no-config.md"), "utf8"))
  assert.equal(data.recurrence, 1)
  assert.deepEqual(data.evidence, [{ session: "ses_live", steps: [9, 18] }])
})

test("the prompt handed to the model carries the log and the contract, and nothing else", async () => {
  const r = rig({ reply: REPLY() })
  await extract({ records: live(), session: "ses_live", ...r })

  const [input] = r.calls
  assert.match(input.prompt, /shorter and straighter/, "the user-editable prompt")
  assert.match(input.prompt, /## Log/)
  assert.match(input.prompt, /\[9\] skill: lint/, "the projection, addressable by step")
  assert.match(input.prompt, /fenced `json` block/, "the contract is appended, not stored")

  // Retired, with the measurement in fixtures/ab-anchors/: no detector decides what the
  // model is allowed to notice. What they knew is prose in the prompt now.
  assert.doesNotMatch(input.prompt, /## Anchors/)
  assert.doesNotMatch(input.prompt, /skill-failure/)
})

test("the guidance the detectors used to encode is in the prompt the user can edit", async () => {
  const r = rig({ reply: REPLY() })
  await extract({ records: live(), session: "ses_live", ...r })
  const [input] = r.calls

  // Each of these was a detector. None of them is code any more.
  assert.match(input.prompt, /nothing changed in between/, "what `repeat` knew")
  assert.match(input.prompt, /made and then undone/, "what `revert` knew")
  assert.match(input.prompt, /followed into a dead end/, "what `skill-failure` knew")
  assert.match(input.prompt, /exit codes, not the statuses/, "the trap that made all three necessary")
  assert.match(input.prompt, /quietly dropped/, "and the two that were never built")
  assert.match(input.prompt, /correction the user had to make/)
  assert.match(input.prompt, /a place to start, not a checklist/, "stated as guidance, not rules")
})

test("a single exchange that did nothing costs no model call", async () => {
  const r = rig({ reply: REPLY() })
  const result = await extract({
    records: [{ k: "prompt", n: 1, text: "hi" }, { k: "session", n: 2, event: "end", outcome: "succeeded" }],
    session: "ses_quiet",
    ...r,
  })

  assert.ok(result.ok)
  assert.ok(result.skipped)
  assert.equal(r.calls.length, 0, "no model call means no bill")
  assert.match(result.detail, /one exchange, nothing done/)
})

test("a conversation with no tool calls is still analysed", async () => {
  // The wrong instruction file is the clearest lesson there is, and it produces a wrong
  // answer and a correction, with nothing executed. A tool-call threshold would drop it.
  const r = rig({ reply: REPLY() })
  const result = await extract({
    records: [
      { k: "prompt", n: 1, text: "how do we deploy here?" },
      { k: "text", n: 2, text: "AGENTS.md says to run `make deploy`." },
      { k: "prompt", n: 3, text: "no, that was removed a year ago, we use the pipeline" },
      { k: "session", n: 4, event: "end", outcome: "succeeded" },
    ],
    session: "ses_talk",
    ...r,
  })

  assert.ok(result.ok)
  assert.ok(!result.skipped, "a correction is evidence, and it never touches a tool")
  assert.equal(r.calls.length, 1)
})

test("one prompt with work done is analysed too", async () => {
  const r = rig({ reply: REPLY() })
  const result = await extract({
    records: [
      { k: "prompt", n: 1, text: "fix it" },
      { k: "tool", n: 2, tool: "shell", input: { command: "make" }, status: "completed", exit: 2 },
      { k: "session", n: 3, event: "end", outcome: "succeeded" },
    ],
    session: "ses_one",
    ...r,
  })
  assert.ok(!result.skipped)
})

test("a recurring lesson increments rather than duplicating", async () => {
  const r = rig({ reply: REPLY() })
  await extract({ records: live(), session: "ses_one", ...r })
  await extract({ records: live(), session: "ses_two", ...r })

  assert.equal(readdirSync(r.lessonsDir).length, 1)
  const { data } = parseFrontmatter(readFileSync(join(r.lessonsDir, "lint-skill-no-config.md"), "utf8"))
  assert.equal(data.recurrence, 2)
  assert.equal(data.evidence.length, 2)
})

test("rejected lessons are named in the prompt and dropped from the result", async () => {
  const r = rig({ reply: REPLY() })
  r.state.reject("lint-skill-no-config", "we do want eslint here eventually")

  const result = await extract({ records: live(), session: "ses_live", ...r })
  assert.match(r.calls[0].prompt, /do not propose these again/)
  assert.match(r.calls[0].prompt, /we do want eslint here eventually/)
  assert.deepEqual(result.lessons, [], "a rejected lesson never reaches the store")
  assert.deepEqual(r.store.list(), [], "and nothing is written")
})

test("already-recorded lessons are shown so the model matches instead of re-stating", async () => {
  const r = rig({ reply: REPLY() })
  await extract({ records: live(), session: "ses_one", ...r })
  await extract({ records: live(), session: "ses_two", ...r })

  assert.match(r.calls[1].prompt, /## Lessons already recorded/)
  assert.match(r.calls[1].prompt, /`lint-skill-no-config` \(seen in 1\)/)
})

test("a failing model call is reported, not swallowed", async () => {
  const r = rig({ fail: "Model unavailable: foo/bar" })
  const result = await extract({ records: live(), session: "ses_live", ...r })

  assert.equal(result.ok, false)
  assert.match(result.detail, /model call failed: Model unavailable/)
})

test("an unparseable reply is reported, not treated as nothing to learn", async () => {
  const r = rig({ reply: "I had a look and everything seemed fine to me." })
  const result = await extract({ records: live(), session: "ses_live", ...r })

  assert.equal(result.ok, false)
  assert.match(result.detail, /unparseable reply/)
})

test("a reply that cannot be parsed is quoted, so the human can see what the model said", async () => {
  // "unparseable reply" on its own tells nobody anything: a model that answered in prose
  // and a model that stopped half way through a JSON object need different remedies.
  const r = rig({ reply: "Sure — here are the two problems I found:\n\n1. the lint skill" })
  const result = await extract({ records: live(), session: "ses_live", ...r })

  assert.equal(result.ok, false)
  assert.match(result.detail, /the model answered \(60 chars\)/)
  assert.match(result.detail, /the lint skill/)
})

test("a model that said nothing is reported as having said nothing", async () => {
  const r = rig({ reply: "" })
  const result = await extract({ records: live(), session: "ses_live", ...r })

  assert.equal(result.ok, false)
  assert.match(result.detail, /the model returned nothing at all/)
})

test("the reply itself is kept, because the analysis session is transient", async () => {
  const r = rig({ reply: "not json" })
  const result = await extract({ records: live(), session: "ses_live", ...r })

  assert.equal(result.reply, "not json", "the caller can put it somewhere that lasts")
})

test("an empty lesson list is a clean result with nothing written", async () => {
  const r = rig({ reply: '```json\n{"lessons": []}\n```' })
  const result = await extract({ records: live(), session: "ses_live", ...r })

  assert.ok(result.ok)
  assert.match(result.detail, /nothing to learn/)
  assert.deepEqual(r.store.list(), [])
})

test("the configured model is passed through", async () => {
  const r = rig({ reply: REPLY() })
  await extract({ records: live(), session: "s", ...r })
  assert.deepEqual(r.calls[0].model, MODEL)
})

test("no resolvable model refuses up front instead of hanging on the free tier", async () => {
  const r = rig({ reply: REPLY() })
  const result = await extract({ records: live(), session: "s", ...r, model: null })

  assert.equal(result.ok, false)
  assert.match(result.detail, /no model could be resolved/)
  assert.match(result.detail, /options\.model/, "and says exactly what to set")
  assert.equal(r.calls.length, 0)
})

test("the free-tier refusal is explained, since a plugin may not use it", async () => {
  const r = rig({ fail: "OpenCode's free tier can only be used from within OpenCode." })
  const result = await extract({ records: live(), session: "s", ...r })

  assert.equal(result.ok, false)
  assert.match(result.detail, /free tier/)
  assert.match(result.detail, /pin a different model in options\.model/, "a remedy, not just the error")
})

test("where the model came from is not passed to the model call itself", async () => {
  const r = rig({ reply: REPLY() })
  await extract({ records: live(), session: "s", ...r, model: { ...MODEL, from: "your session's model" } })

  assert.deepEqual(r.calls[0].model, MODEL, "`from` is for the report, not for the API")
})

test("the queue survives a restart and does not re-extract a finished session", () => {
  const r = rig({ reply: REPLY() })
  r.state.queue("ses_a")
  r.state.queue("ses_b")
  assert.equal(r.state.nextPending(null).session, "ses_a")
  assert.equal(r.state.nextPending("ses_a").session, "ses_b", "the running session is not its own debt")

  r.state.markExtracted("ses_a", { ok: true, detail: "done" })
  assert.equal(r.state.nextPending(null).session, "ses_b")
  assert.ok(r.state.wasExtracted("ses_a"))

  const reloaded = createState({ path: join(r.root, "state.json") })
  assert.equal(reloaded.nextPending(null).session, "ses_b")
  assert.ok(reloaded.wasExtracted("ses_a"))
})

test("a session is given up on after three attempts rather than billed forever", () => {
  const r = rig({ reply: REPLY() })
  r.state.queue("ses_a")
  for (let i = 0; i < 3; i++) r.state.attempt("ses_a")
  assert.equal(r.state.nextPending(null), null)
})

test("a model call that never settles is given up on, not waited on forever", async () => {
  const r = rig()
  const result = await extract({
    records: live(),
    session: "ses_hang",
    ...r,
    generate: () => new Promise(() => {}),
    timeoutMs: 50,
  })

  assert.equal(result.ok, false)
  assert.match(result.detail, /no reply after/)
})

test("a slow but finite call still succeeds", async () => {
  const r = rig({ reply: REPLY() })
  const slow = (input) => new Promise((res) => setTimeout(() => res({ text: REPLY() }), 10)).then((x) => (r.calls.push(input), x))
  const result = await extract({ records: live(), session: "ses_slow", ...r, generate: slow, timeoutMs: 2000 })
  assert.ok(result.ok, result.detail)
})

test("a backlog is analysed in order and bounded, so one command cannot bill without limit", () => {
  // processQueue's contract, exercised through the state it drives.
  const r = rig({ reply: REPLY() })
  for (const id of ["ses_a", "ses_b", "ses_c"]) r.state.queue(id)

  const order = []
  let guard = 0
  while (guard++ < 2) {
    const next = r.state.nextPending("ses_current")
    if (!next) break
    order.push(next.session)
    r.state.markExtracted(next.session, { ok: true, detail: "done" })
  }

  assert.deepEqual(order, ["ses_a", "ses_b"], "oldest first")
  assert.equal(r.state.pending.length, 1, "and the bound leaves the rest for the next call")
})

test("the per-command log limit is unlimited by default and can be capped", async () => {
  const { DEFAULTS, resolveConfig } = await import("../src/config.js")
  assert.equal(DEFAULTS.extractLimit, Infinity, "a half-analysed backlog only moves the work")
  assert.equal(resolveConfig({ options: {} }).extractLimit, Infinity)
  assert.equal(resolveConfig({ options: { extractLimit: 3 } }).extractLimit, 3, "but it is a knob")
})

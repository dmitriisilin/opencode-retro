import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { WORK_MARK, composeOrder, recordAnswer } from "../src/extract.js"
import { createStore } from "../src/lessons.js"
import { createPrompts } from "../src/prompts.js"
import { createState } from "../src/state.js"
import { parseShadowLog } from "../src/shadowlog.js"
import { parseFrontmatter } from "../src/frontmatter.js"
import { project } from "../src/projection.js"

/**
 * The plugin's two halves of an analysis (docs/concepts/analysis.md): `composeOrder` writes
 * what a subagent is asked to read, and `recordAnswer` folds its answer into the store. No
 * model is called from here, or from anywhere else in the plugin — the reading happens in a
 * subagent the agent in the `/retro` session starts, which is exercised end to end in
 * `test/orders.test.js` and `test/plugin.test.js`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const live = () =>
  parseShadowLog(readFileSync(join(here, "..", "fixtures", "sessions", "lint-trap-live.jsonl"), "utf8"))

function rig() {
  const root = mkdtempSync(join(tmpdir(), "retro-extract-"))
  return {
    root,
    lessonsDir: join(root, "lessons"),
    store: createStore({ dir: join(root, "lessons"), archive: join(root, "archive") }),
    state: createState({ path: join(root, "state.json") }),
    prompts: createPrompts({ dir: join(root, "prompts"), updates: join(root, "prompts", "updates") }),
  }
}

/** What a subagent found, as `retro_record` receives it. */
const LESSONS = (over = {}) => [
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
]

/** One analysis, both halves: the order a subagent would read, then the answer it gives. */
const analyse = (r, { records = live(), session = "ses_live", lessons = LESSONS(), ...rest } = {}) => {
  const order = composeOrder({ records, session, ...r, ...rest })
  if (!order.ok || order.skipped) return { order }
  const answer = recordAnswer({ session, lessons, elided: order.elided, ...r })
  return { order, answer }
}

test("the live lint-trap session records into a lesson on disk", () => {
  const r = rig()
  const { order, answer } = analyse(r)

  assert.ok(order.ok, order.detail)
  assert.deepEqual(answer.recorded.created, ["lint-skill-no-config"])

  const { data } = parseFrontmatter(readFileSync(join(r.lessonsDir, "lint-skill-no-config.md"), "utf8"))
  assert.equal(data.recurrence, 1)
  assert.deepEqual(data.evidence, [{ session: "ses_live", steps: [9, 18] }])
})

test("the work order carries the log and the contract, and nothing else", () => {
  const { order } = analyse(rig())

  assert.ok(order.text.startsWith(`<!-- ${WORK_MARK} -->`), "the mark comes first, so our own work is recognisable")
  assert.match(order.text, /^id: ses_live$/m, "the session to record against")
  assert.match(order.text, /shorter and straighter/, "the user-editable prompt")
  assert.match(order.text, /## Log/)
  assert.match(order.text, /\[9\] skill: lint/, "the projection, addressable by step")
  assert.match(order.text, /retro_record/, "the contract is written in, not stored in the prompt file")

  // Retired, with the measurement in fixtures/ab-anchors/: no detector decides what the
  // reader is allowed to notice. What they knew is prose in the prompt now.
  assert.doesNotMatch(order.text, /## Anchors/)
  assert.doesNotMatch(order.text, /skill-failure/)
})

test("the guidance the detectors used to encode is in the prompt the user can edit", () => {
  const { order } = analyse(rig())

  // Each of these was a detector. None of them is code any more.
  assert.match(order.text, /nothing changed in between/, "what `repeat` knew")
  assert.match(order.text, /made and then undone/, "what `revert` knew")
  assert.match(order.text, /followed into a dead end/, "what `skill-failure` knew")
  assert.match(order.text, /exit codes, not the statuses/, "the trap that made all three necessary")
  assert.match(order.text, /quietly dropped/, "and the two that were never built")
  assert.match(order.text, /correction the user had to make/)
  assert.match(order.text, /a place to start, not a checklist/, "stated as guidance, not rules")
})

test("a single exchange that did nothing takes no work order", () => {
  const { order } = analyse(rig(), {
    records: [{ k: "prompt", n: 1, text: "hi" }, { k: "session", n: 2, event: "end", outcome: "succeeded" }],
    session: "ses_quiet",
  })

  assert.ok(order.ok)
  assert.ok(order.skipped, "nothing to read means nothing to ask anyone to read")
  assert.equal(order.text, undefined)
  assert.match(order.detail, /one exchange, nothing done/)
})

test("a conversation with no tool calls is still analysed", () => {
  // The wrong instruction file is the clearest lesson there is, and it produces a wrong
  // answer and a correction, with nothing executed. A tool-call threshold would drop it.
  const { order } = analyse(rig(), {
    records: [
      { k: "prompt", n: 1, text: "how do we deploy here?" },
      { k: "text", n: 2, text: "AGENTS.md says to run `make deploy`." },
      { k: "prompt", n: 3, text: "no, that was removed a year ago, we use the pipeline" },
      { k: "session", n: 4, event: "end", outcome: "succeeded" },
    ],
    session: "ses_talk",
  })

  assert.ok(order.ok)
  assert.ok(!order.skipped, "a correction is evidence, and it never touches a tool")
  assert.match(order.text, /we use the pipeline/)
})

test("one prompt with work done is analysed too", () => {
  const { order } = analyse(rig(), {
    records: [
      { k: "prompt", n: 1, text: "fix it" },
      { k: "tool", n: 2, tool: "shell", input: { command: "make" }, status: "completed", exit: 2 },
      { k: "session", n: 3, event: "end", outcome: "succeeded" },
    ],
    session: "ses_one",
  })
  assert.ok(!order.skipped)
})

test("a recurring lesson increments rather than duplicating", () => {
  const r = rig()
  analyse(r, { session: "ses_one" })
  analyse(r, { session: "ses_two" })

  assert.equal(readdirSync(r.lessonsDir).length, 1)
  const { data } = parseFrontmatter(readFileSync(join(r.lessonsDir, "lint-skill-no-config.md"), "utf8"))
  assert.equal(data.recurrence, 2)
  assert.equal(data.evidence.length, 2)
})

test("rejected lessons are named in the order and dropped from the record", () => {
  const r = rig()
  r.state.reject("lint-skill-no-config", "we do want eslint here eventually")

  const { order, answer } = analyse(r)
  assert.match(order.text, /do not propose these again/)
  assert.match(order.text, /we do want eslint here eventually/)
  assert.deepEqual(answer.lessons, [], "a rejected lesson never reaches the store")
  assert.deepEqual(r.store.list(), [], "and nothing is written")
})

test("already-recorded lessons are shown so the reader matches instead of re-stating", () => {
  const r = rig()
  analyse(r, { session: "ses_one" })
  const { order } = analyse(r, { session: "ses_two" })

  assert.match(order.text, /## Lessons already recorded/)
  assert.match(order.text, /`lint-skill-no-config` \(seen in 1\)/)
})

test("a record with no lessons is a clean result with nothing written", () => {
  const r = rig()
  const { answer } = analyse(r, { lessons: [] })

  assert.match(answer.detail, /nothing to learn/)
  assert.deepEqual(r.store.list(), [])
})

test("the per-command log limit is unlimited by default and can be capped", async () => {
  const { DEFAULTS, resolveConfig } = await import("../src/config.js")
  assert.equal(DEFAULTS.extractLimit, Infinity, "a half-analysed backlog only moves the work")
  assert.equal(resolveConfig({ options: {} }).extractLimit, Infinity)
  assert.equal(resolveConfig({ options: { extractLimit: 3 } }).extractLimit, 3, "but it is a knob")
})

test("no extract prompt at any layer refuses before an order is written", () => {
  const r = rig()
  r.prompts = { resolve: () => null }
  const { order } = analyse(r)

  assert.equal(order.ok, false)
  assert.match(order.detail, /no extract prompt could be resolved/)
  assert.equal(order.text, undefined, "nobody is asked to read a file we could not write")
})

test("the summary says whether a lesson is new, recurring or back from the archive", () => {
  const r = rig()
  assert.match(analyse(r, { session: "ses_one" }).answer.detail, /1 new \(lint-skill-no-config\)/)
  assert.match(analyse(r, { session: "ses_two" }).answer.detail, /1 recurring \(lint-skill-no-config\)/)

  r.store.close("lint-skill-no-config", "accepted", "removed the skill")
  const third = analyse(r, { session: "ses_three" })
  assert.match(third.answer.detail, /1 came back \(lint-skill-no-config\)/, "a closed problem that returns is news")
})

test("a rejected id is dropped even when the record reaches it through `matches`", () => {
  const r = rig()
  r.state.reject("lint-skill-no-config", "we want eslint eventually")

  const { answer } = analyse(r, { lessons: LESSONS({ id: "eslint-again", matches: "lint-skill-no-config" }) })
  assert.deepEqual(answer.lessons, [])
  assert.deepEqual(r.store.list(), [], "a near-duplicate is the same rejection")
})

test("a lesson drawn from an excerpt says so, so the human knows what was read", () => {
  const r = rig()
  const answer = recordAnswer({ session: "ses_part", lessons: LESSONS(), elided: true, ...r })
  assert.match(answer.detail, /from an excerpt: the log was over budget/)
})

test("the composed input stays inside maxInput, and says when it had to", () => {
  // The budget bounds what one subagent is asked to read, which is what an analysis costs.
  // It is also the reason an order fits in a single read: a file nobody can read in one call
  // is a file that gets read in pieces, or not at all.
  const records = [
    { v: 1, n: 1, k: "prompt", text: "fix the lint skill" },
    ...Array.from({ length: 200 }, (_, i) => ({
      v: 1,
      n: i + 2,
      k: "tool",
      id: `c${i}`,
      tool: "shell",
      input: { command: `npx eslint pass-${i}` },
      status: "completed",
      exit: 2,
      output: "no config found ".repeat(60),
    })),
  ]

  const whole = analyse(rig(), { records, session: "ses_long" })
  assert.ok(whole.order.text.length > 20_000, "the whole thing is big enough to be worth bounding")
  assert.doesNotMatch(whole.answer.detail, /excerpt/, "nothing was dropped, so nothing is claimed")

  const bounded = analyse(rig(), { records, session: "ses_long", maxInput: 12_000 })

  assert.ok(bounded.order.ok)
  assert.ok(
    bounded.order.text.length <= 12_000,
    `wrote ${bounded.order.text.length} characters against a budget of 12000`,
  )
  assert.match(bounded.order.text, /elided to fit the budget/, "and the reader is told it is an excerpt")
  assert.match(bounded.answer.detail, /from an excerpt: the log was over budget/, "as is the human")
})

test("a budget that leaves no room for the log still leaves room for the log", () => {
  // The prompt, the contract and the lesson list are not negotiable, so an absurd budget
  // cannot be honoured. It must degrade to a small excerpt rather than to an empty section.
  const { order } = analyse(rig(), {
    records: [
      { v: 1, n: 1, k: "prompt", text: "do the thing" },
      { v: 1, n: 2, k: "tool", id: "c1", tool: "shell", input: { command: "npx eslint ." }, status: "completed", exit: 2, output: "no config" },
    ],
    session: "ses_tiny",
    maxInput: 10,
  })

  assert.ok(order.ok, "it still writes one")
  assert.match(order.text, /do the thing/, "and the log is still in there")
})

test("a projection that fits the log budget still fits maxInput once the Log section is added", () => {
  // The budget was computed from the composition with no log at all, so it never paid for
  // the "## Log" heading and the separators a non-empty log adds. A full projection of
  // exactly `budget` therefore composed to `maxInput + a few characters`.
  const records = [
    { v: 1, n: 1, k: "prompt", text: "first instruction" },
    { v: 1, n: 2, k: "prompt", text: "second instruction" },
    ...Array.from({ length: 10 }, (_, i) => ({
      v: 1,
      n: i + 3,
      k: "tool",
      id: `c${i}`,
      tool: "shell",
      input: { command: `run-${i}` },
      status: "completed",
      output: "y".repeat(600),
    })),
  ]

  const full = analyse(rig(), { records, session: "ses_frame", lessons: [], maxInput: 1_000_000 })
  const whole = full.order.text.length
  assert.ok(whole > 3000, "big enough that the 2,000 floor is not what is being measured")

  const bounded = analyse(rig(), { records, session: "ses_frame", lessons: [], maxInput: whole - 1 })

  assert.ok(bounded.order.ok, bounded.order.detail)
  assert.ok(
    bounded.order.text.length <= whole - 1,
    `wrote ${bounded.order.text.length} characters against a budget of ${whole - 1}`,
  )
})

test("a small but positive log budget is spent, not rounded up to 2,000", () => {
  // The 2,000 floor is for the case where the fixed part alone is over budget. When there
  // is room — even only a few hundred characters — using more than it is how a bounded
  // input went over maxInput for no reason.
  const records = [
    { v: 1, n: 1, k: "prompt", text: "first instruction" },
    { v: 1, n: 2, k: "prompt", text: "second instruction" },
    { v: 1, n: 3, k: "tool", id: "c0", tool: "shell", input: { command: "ls" }, status: "completed", output: "y".repeat(600) },
  ]

  const full = analyse(rig(), { records, session: "ses_small_room", lessons: [], maxInput: 1_000_000 })
  const whole = full.order.text.length
  const bounded = analyse(rig(), { records, session: "ses_small_room", lessons: [], maxInput: whole - 1 })

  assert.ok(bounded.order.ok, bounded.order.detail)
  assert.ok(
    bounded.order.text.length <= whole - 1,
    `wrote ${bounded.order.text.length} characters against a budget of ${whole - 1}`,
  )
  assert.ok(bounded.order.text.length > whole - project(records).length, "the room that was left was spent")
})

test("lessons already concluded from this session are put in front of the extractor", () => {
  const { order } = analyse(rig(), {
    concluded: [{ id: "lint-skill-no-config", status: "accepted", statement: "The lint skill assumes eslint." }],
  })

  assert.match(order.text, /## Already concluded from this session/)
  assert.match(order.text, /`lint-skill-no-config` \(accepted\): The lint skill assumes eslint\./)
})

test("a re-read with a reply is analysed even when it has no prompt or tool call of its own", () => {
  // The skip rule is about material that cannot hold evidence. A re-read's slice carries the
  // session's old prompts and drops the tool calls already turned into lessons, so counting
  // prompts and tools alone called a new assistant reply "one quiet exchange". A reply is
  // exactly where a wrong answer and a dropped task live, with nothing executed.
  const { order } = analyse(rig(), {
    records: [
      { k: "prompt", n: 1, text: "do a thing" },
      { k: "text", n: 3, text: "I could not do that, the command does not exist here." },
      { k: "session", n: 4, event: "end", outcome: "succeeded" },
    ],
    session: "ses_followup",
    analysedUpTo: 2,
  })

  assert.ok(order.ok)
  assert.ok(!order.skipped, "the new reply is material, so the session is read")
  assert.match(order.text, /the command does not exist here/)
  assert.match(order.text, /Steps up to 2 of this session were analysed before/)
})

test("a reply to the plugin's own hand-over, with nothing done, takes no work order", () => {
  // `/retro` with nothing to review still resumes the agent, which answers. Counted as
  // material, that answer bought an analysis on the next command, whose own hand-over was
  // answered in turn: one analysis per `/retro`, spent on the plugin talking to itself.
  const { order } = analyse(rig(), {
    records: [
      { k: "prompt", n: 1, text: "do a thing" },
      { k: "handover", n: 3, text: "opencode-retro handed a lesson over" },
      { k: "text", n: 4, text: "Thanks — nothing to do about that one." },
    ],
    session: "ses_selftalk",
    analysedUpTo: 2,
  })

  assert.ok(order.skipped, order.detail)
})

test("a problem already recorded is asked for again, with matches, when it recurs", () => {
  // Measured on the friction bench: a second session hit the same three planted traps and the
  // extractor answered "nothing to learn" — it read "already recorded" as "already handled".
  // Recurrence is the strongest signal in the score, and it is only counted through `matches`.
  const r = rig()
  analyse(r, { session: "ses_one" })
  const { order } = analyse(r, { session: "ses_two" })
  const flat = order.text.replace(/\s+/g, " ")
  assert.match(flat, /ran into one of these again, list it again with `matches`/)
  assert.match(flat, /report it again with `matches` set — that is how recurrence is counted/)
})

test("the review of a handed-over lesson is not counted as the problem recurring", () => {
  // Measured on the friction bench: the agent in a review session checked the lint lesson it
  // had been handed — read the skill, ran eslint — and the next analysis reported that check
  // as the problem recurring, adding a session and 19 steps of cost to the lesson.
  // Matched against the text with its line breaks flattened: a rewrap of the contract is not
  // a change of meaning, and three of these assertions have been broken by one before.
  const flat = analyse(rig()).order.text.replace(/\s+/g, " ")
  assert.match(flat, /opencode-retro handed a lesson over"\) and checks or applies the lesson it handed over/)
  assert.match(flat, /do not report it as a recurrence, and do not count its steps as cost/)
})

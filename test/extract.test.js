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

/**
 * The plugin's two halves of an analysis (docs/concepts/analysis.md): `composeOrder` writes
 * what a subagent is asked to read, and `recordAnswer` folds its answer into the store. No
 * model is called from here, or from anywhere else in the plugin — the reading happens in a
 * subagent the agent in the `/retro` session starts, which is exercised end to end in
 * `test/orders.test.js` and `test/plugin.test.js`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const LIVE_LOG = join(here, "..", "fixtures", "sessions", "lint-trap-live.jsonl")
const live = () => parseShadowLog(readFileSync(LIVE_LOG, "utf8"))

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
const analyse = (r, { records = live(), session = "ses_live", logPath = LIVE_LOG, lessons = LESSONS(), ...rest } = {}) => {
  const lastN = records.length ? Math.max(...records.map((x) => x.n ?? 0)) : 0
  const order = composeOrder({ records, session, logPath, lastN, ...r, ...rest })
  if (!order.ok || order.skipped) return { order }
  const answer = recordAnswer({ session, lessons, ...r })
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

test("the work order points at the log instead of carrying it", () => {
  const { order } = analyse(rig())

  assert.ok(order.text.startsWith(`<!-- ${WORK_MARK} -->`), "the mark comes first, so our own work is recognisable")
  assert.match(order.text, /^id: ses_live$/m, "the session to record against")
  assert.match(order.text, new RegExp(`^log: ${LIVE_LOG}$`, "m"), "and the file to open, absolutely")
  assert.match(order.text, /^steps: 1 to 32$/m, "with how much there is to read")
  assert.match(order.text, /shorter and straighter/, "the user-editable prompt")
  assert.match(order.text, /retro_record/, "the contract is written in, not stored in the prompt file")
  assert.match(order.text, /one JSON object\s+per line/, "and how to read a shadow log")

  // The order used to hold a rendering of the log, trimmed to a budget. A subagent has read
  // tools; deciding for it what it may see was work that bought nothing.
  assert.doesNotMatch(order.text, /\[9\] skill: lint/, "no rendering of the log")
  assert.doesNotMatch(order.text, /elided to fit the budget/)
  assert.ok(order.text.length < 14_000, `an order is small now: ${order.text.length} characters`)

  // Retired, with the measurement in fixtures/ab-anchors/: no detector decides what the
  // reader is allowed to notice. What they knew is prose in the prompt now.
  assert.doesNotMatch(order.text, /## Anchors/)
  assert.doesNotMatch(order.text, /skill-failure/)
})

test("an order with no log to point at is refused", () => {
  const r = rig()
  const order = composeOrder({ records: live(), session: "ses_live", lastN: 32, logPath: null, ...r })
  assert.equal(order.ok, false)
  assert.match(order.detail, /no path to point an analysis at/)
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
    logPath: "/tmp/talk.jsonl",
  })

  assert.ok(order.ok)
  assert.ok(!order.skipped, "a correction is evidence, and it never touches a tool")
  assert.match(order.text, /^log: \/tmp\/talk\.jsonl$/m, "and the log it is in gets an order")
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
  const { order } = analyse(r, { session: "ses_two", lessonsDir: r.lessonsDir })

  assert.match(order.text, /## Lessons already recorded/)
  assert.match(order.text, /`lint-skill-no-config` \(seen in 1\)/)

  // And where to find the current set, because the list is only a snapshot taken when the
  // order was written. Measured on the friction bench: three sessions that hit the same two
  // traps produced five lessons with five ids and a recurrence of 1 each, because all three
  // orders were written before any of them recorded, so every one of them read "None yet".
  //
  // The pointer comes before the list, for the second half of the same measurement: with it
  // after, one analysis still anchored on the snapshot and filed a problem another had
  // recorded seconds earlier. A reader told there is nothing there does not go looking.
  const pointer = order.text.indexOf(r.lessonsDir)
  const list = order.text.indexOf("`lint-skill-no-config` (seen in 1)")
  assert.ok(pointer !== -1 && pointer < list, `the directory is named ahead of the snapshot`)
  assert.match(order.text, /before you decide that anything is new/)
  assert.match(order.text, /may have recorded something since/)
})

test("an order with nothing recorded yet still says where the lessons will be", () => {
  const r = rig()
  const { order } = analyse(r, { lessonsDir: r.lessonsDir })
  assert.match(order.text, new RegExp(`Read \`${r.lessonsDir}\``))
  // Not "None yet": that is a claim about now, and it is only true of when this was written.
  assert.doesNotMatch(order.text, /None yet/)
  assert.match(order.text, /Nothing was recorded when this order was last brought up to date/)
  assert.match(order.text, /same as nothing being there now/)
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

test("a lesson from part of a log says so, so the human knows what was read", () => {
  const r = rig()
  const answer = recordAnswer({ session: "ses_part", lessons: LESSONS(), partial: true, ...r })
  assert.match(answer.detail, /from part of the log; the rest is still owed/)
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
  assert.match(order.text, /Steps up to 2 were analysed before/, "and the order says where to start")
  assert.match(order.text, /step 3 onwards — that is what to report on/)
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
  assert.match(flat, /ran into a problem that is already recorded, report it again with `matches` set to its id/)
  assert.match(flat, /report it again with `matches` set — that is how recurrence is counted/)
})

test("the review of a handed-over lesson is not counted as the problem recurring", () => {
  // Measured on the friction bench: the agent in a review session checked the lint lesson it
  // had been handed — read the skill, ran eslint — and the next analysis reported that check
  // as the problem recurring, adding a session and 19 steps of cost to the lesson.
  // Matched against the text with its line breaks flattened: a rewrap of the contract is not
  // a change of meaning, and three of these assertions have been broken by one before.
  const flat = analyse(rig()).order.text.replace(/\s+/g, " ")
  assert.match(flat, /`handover` step with `"about": "lesson"` and checks or applies the lesson it handed over/)
  assert.match(flat, /do not report it as a recurrence, and do not count its steps as cost/)
})

test("problems already fixed are named in the order, with the date they were fixed", () => {
  // A backlog is the normal case: `/retro`, accept, integrate — and the next command analyses
  // the logs that were waiting behind it, written before the fix and into the same trap.
  const r = rig()
  analyse(r, { session: "ses_one" })
  r.store.close("lint-skill-no-config", "accepted", { changed: [".opencode/skills/lint/SKILL.md"] })

  const { order } = analyse(r, { session: "ses_two" })
  assert.match(order.text, /## Already fixed/)
  assert.match(order.text, /`lint-skill-no-config` \(fixed \d{4}-\d{2}-\d{2}\)/)
  assert.match(order.text, /changed \.opencode\/skills\/lint\/SKILL\.md/, "and what was done about it")
  assert.match(order.text, /the fix came later/, "with what that means for an older session")
  assert.doesNotMatch(order.text, /## Lessons already recorded[\s\S]*lint-skill-no-config/, "it is not also listed as open")
})

test("evidence from before a fix does not reopen it, and evidence from after does", () => {
  // Reopening on a log that predates the fix says "the fix did not hold" about a fix that was
  // never tested — once per waiting log. The date is the one the log itself carries.
  const r = rig()
  const steps = [9, 18]
  const dateOf = (at) => () => at

  recordAnswer({ session: "ses_one", lessons: LESSONS(), dateOf: dateOf(1000), ...r })
  r.store.close("lint-skill-no-config", "accepted", { changed: ["SKILL.md"] })
  const closedAt = Date.parse(r.store.listArchive()[0].closedAt)

  const older = recordAnswer({ session: "ses_two", lessons: LESSONS({ steps }), dateOf: dateOf(closedAt - 60_000), ...r })
  assert.deepEqual(older.recorded.stale, ["lint-skill-no-config"], "old evidence is discarded")
  assert.deepEqual(older.recorded.reopened, [])
  assert.match(older.detail, /already fixed before this session ran/, "and said out loud, not dropped silently")
  assert.deepEqual(r.store.list(), [], "the lesson stays closed")

  const newer = recordAnswer({ session: "ses_three", lessons: LESSONS({ steps }), dateOf: dateOf(closedAt + 60_000), ...r })
  assert.deepEqual(newer.recorded.reopened, ["lint-skill-no-config"], "evidence from after the fix is real news")
  assert.equal(r.store.list()[0].reopenedFrom, "accepted")
})

test("undated evidence reopens a decision, because nothing says it is old", () => {
  // The log could not be read, or carries no timestamps. Reopening is the safe side: a lesson
  // put to a human again costs attention, and silently dropping one costs the whole point.
  const r = rig()
  recordAnswer({ session: "ses_one", lessons: LESSONS(), ...r })
  r.store.close("lint-skill-no-config", "accepted", { changed: ["SKILL.md"] })

  const again = recordAnswer({ session: "ses_two", lessons: LESSONS(), ...r })
  assert.deepEqual(again.recorded.reopened, ["lint-skill-no-config"])
})

test("an order's lesson list is found by its own marks, not by a heading the person may write", async () => {
  const { refreshLessons, recordedLessons } = await import("../src/extract.js")
  const r = rig()
  const { order } = analyse(r, { lessonsDir: r.lessonsDir, lessons: [] })
  const withHeading = order.text.replace("<!-- opencode-retro work order -->", "<!-- opencode-retro work order -->\n## Lessons already recorded\n\nmy own notes")
  r.store.record([{ id: "a-new-one", statement: "A new problem.", steps: [1, 2], cost: 1, confidence: 0.5, why: "once" }], { session: "ses_x" })
  const fresh = refreshLessons(withHeading, recordedLessons({ store: r.store, lessonsDir: r.lessonsDir }))
  assert.match(fresh, /my own notes/, "the person's text is left as it was")
  assert.match(fresh, /`a-new-one`/, "and the plugin's list is brought up to date")
})

test("a lesson that quotes the list's own mark does not multiply the list", async () => {
  const { refreshLessons, recordedLessons } = await import("../src/extract.js")
  const r = rig()
  const { order } = analyse(r, { lessonsDir: r.lessonsDir, lessons: [] })
  r.store.record([{ id: "quoted-mark", statement: "refresh breaks on <!-- lessons recorded --> in text", steps: [1, 2], cost: 1, confidence: 0.5, why: "x" }], { session: "ses_x" })
  let text = order.text
  for (let i = 0; i < 3; i++) text = refreshLessons(text, recordedLessons({ store: r.store, lessonsDir: r.lessonsDir }))
  assert.equal(text.split("`quoted-mark`").length - 1, 1, "one list, however often it is brought up to date")
})

test("a rejection reason quoting the list's mark does not stop the list being brought up to date", async () => {
  const { refreshLessons, recordedLessons } = await import("../src/extract.js")
  const r = rig()
  r.state.reject?.("old-one", "it broke on <!-- lessons recorded --> and <!-- /lessons recorded -->")
  const { order } = analyse(r, { lessonsDir: r.lessonsDir, lessons: [] })
  r.store.record([{ id: "fresh-one", statement: "A new problem.", steps: [1, 2], cost: 1, confidence: 0.5, why: "x" }], { session: "ses_x" })
  const text = refreshLessons(order.text, recordedLessons({ store: r.store, lessonsDir: r.lessonsDir }))
  const list = text.slice(text.indexOf("## Lessons already recorded"), text.indexOf("## Rejected"))
  assert.match(list, /`fresh-one`/)
})

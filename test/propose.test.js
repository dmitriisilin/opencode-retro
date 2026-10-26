import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROPOSE_LIMIT,
  asLeadIn,
  backlogLine,
  hintLines,
  pickLesson,
  pickOpen,
  renderBatch,
  renderFailures,
  renderNothing,
  renderProposal,
  renderWorkOrders,
  failureLine,
} from "../src/propose.js"
import { createStore } from "../src/lessons.js"
import { createState } from "../src/state.js"

const lesson = (over = {}) => ({
  id: "lint-skill-no-config",
  statement: "The lint skill prescribes eslint, which this project cannot run.",
  evidence: [{ session: "ses_a", steps: [9, 18] }],
  cost: 9,
  recurrence: 2,
  confidence: 0.9,
  proposal: { target: ".opencode/skills/lint/SKILL.md", change: "Check for a config first." },
  ask: "Is eslint meant to be part of this project?",
  status: "new",
  body: "Step 9 invoked the skill; step 18 failed.",
  ...over,
})

const rig = () => {
  const root = mkdtempSync(join(tmpdir(), "retro-propose-"))
  return {
    store: createStore({ dir: join(root, "lessons"), archive: join(root, "archive") }),
    state: createState({ path: join(root, "state.json") }),
  }
}

test("the top open lesson is picked by score", () => {
  const picked = pickLesson([
    lesson({ id: "low", cost: 1, recurrence: 1, confidence: 0.2 }),
    lesson({ id: "high", cost: 40, recurrence: 3, confidence: 1 }),
  ])
  assert.equal(picked.id, "high")
})

test("decided lessons are not shown again; later ones are", () => {
  assert.equal(pickLesson([lesson({ status: "accepted" }), lesson({ status: "rejected" })]), null)
  assert.equal(pickLesson([lesson({ id: "l", status: "later" })]).id, "l")
})

test("a hand-written lesson with no status is open, not invisible", () => {
  // Users edit these files, and a lesson typed by hand may simply omit `status`. Treating
  // only the literal `new` as open would make it disappear from every review without a word.
  assert.equal(pickLesson([lesson({ status: undefined })]).id, "lint-skill-no-config")
  assert.equal(pickLesson([lesson({ status: null })]).id, "lint-skill-no-config")
})

test("the proposal says what it is, what it would change, and that nothing was changed", () => {
  const text = renderProposal(lesson(), { total: 3, remaining: 2 })

  assert.match(text, /# retro — `lint-skill-no-config`/)
  assert.match(text, /prescribes eslint/)
  assert.match(text, /Seen in 2 sessions, 9 steps spent on it, confidence 0\.9 → score 16\.2/)
  assert.match(text, /## Proposed change/)
  assert.match(text, /\*\*\.opencode\/skills\/lint\/SKILL\.md\*\*/)
  assert.match(text, /## It needs your call/)
  assert.match(text, /Is eslint meant to be part of this project\?/)
  assert.match(text, /sessions\/ses_a\.jsonl` steps 9–18/)
  assert.match(text, /From `\.retro\/sessions\/ses_a\.jsonl` steps 9–18\./, "the log is named where it lives, not at the project root")
  assert.match(text, /This is a proposal, not a change — nothing has been edited/)
  assert.match(text, /2 more lessons waiting of 3/)
  assert.match(text, /^_opencode-retro: is each lesson below already resolved/, "the fallback, when no prompt resolves")
  assert.doesNotMatch(text, /git log/, "we do not prescribe how to look")
})

test("a lesson with no proposal is still worth showing, and says why", () => {
  const text = renderProposal(lesson({ proposal: null }), { total: 1, remaining: 0 })
  assert.match(text, /## No proposal/)
  assert.match(text, /Naming it is the useful part/)
  assert.doesNotMatch(text, /more lessons waiting/)
})

test("an empty store explains itself rather than looking broken", () => {
  const text = renderNothing({ queued: 2, extracted: { analysed: 3, left: 2 } })
  assert.match(text, /Nothing to review/)
  assert.match(text, /Analysed 3 session logs just now/, "say the work was done")
  assert.match(text, /2 logs not analysed yet. Run `\/retro` again/, "and that more is left, with what to do")
  assert.match(text, /selfcheck\.md/)
})

test("the evidence names the log where the plugin keeps it, not at the project root", () => {
  // Cycle 7 found the prompt body sending a reviewer to `sessions/`; the footer built in
  // source said the same thing. Both are relative to `.retro/`, which the reader has no
  // reason to know, so the hand-over names the whole path.
  const text = renderProposal(lesson())
  assert.match(text, /From `\.retro\/sessions\/ses_a\.jsonl` steps 9–18\./)
})

test("the evidence follows options.dir when the log directory moves", () => {
  const text = renderProposal(lesson(), { logs: "harness/sessions" })
  assert.match(text, /From `harness\/sessions\/ses_a\.jsonl` steps 9–18\./)
  assert.doesNotMatch(text, /\.retro\/sessions/, "the default is not named when the caller knows better")
})

test("a log that could not be read is not reported as a session that went straight", () => {
  // Measured live: the message said "Could not analyse …" and then "Either the sessions have
  // been going straight, or nothing is recorded yet" — a failed read dressed as a clean bill
  // of health, which is the one thing this plugin exists to prevent.
  const text = renderNothing({
    extracted: {
      analysed: 1,
      left: 0,
      failures: [{ session: "ses_bad", detail: "unparseable reply — the model returned nothing" }],
    },
  })
  assert.match(text, /opencode-retro on `ses_bad`/)
  assert.match(text, /Analysed 1 session log just now/, "the one that was read is still reported")
  assert.doesNotMatch(text, /going straight/, "a failed read is not evidence that nothing went wrong")
  assert.match(text, /not read, so this is not a clean result/, "say what the failure means")
  assert.match(text, /next `\/retro` tries again/, "and what happens next")
  assert.match(text, /plugin\.log/, "and where the reason is")
})

test("auto carries every waiting lesson and asks for one plan", () => {
  const lessons = [
    lesson({ id: "a", cost: 20 }),
    lesson({ id: "b", cost: 10, proposal: null }),
    lesson({ id: "c", cost: 5, reopenedFrom: "accepted" }),
  ]
  const text = renderBatch(lessons, {
    currencies: new Map([["a", { hint: "`x.md` has changed." }]]),
  })

  assert.match(text, /^_opencode-retro: is each lesson below already resolved/, "one fallback, both messages")
  assert.doesNotMatch(text, /git log/)
  assert.match(text, /# retro — 3 lessons waiting/)
  assert.match(text, /## 1\. `a` — score 36/)
  assert.match(text, /## 2\. `b`/)
  assert.match(text, /\*\*No proposal\*\*/)
  assert.match(text, /## 3\. `c`/)
  assert.match(text, /\*\*Came back\*\* after being closed as accepted/)
  assert.match(text, /Worth knowing before you check: `x\.md` has changed\./, "a hint, not a verdict")
  assert.match(text, /Nothing has been changed\. The plan comes first\./)
})

test("the hand-over instructions come from the prompt file, not from source", () => {
  const leadIn = "Check the repo first. Then relay it. My own wording."

  const one = renderProposal(lesson(), { leadIn })
  assert.match(one, /^_opencode-retro — how to hand this over:_/)
  assert.match(one, /My own wording\./)
  assert.doesNotMatch(one, /is each lesson below already resolved/, "the fallback must not leak in alongside it")

  const many = renderBatch([lesson()], { leadIn })
  assert.match(many, /My own wording\./)
})

test("a missing prompt degrades to a terse hand-off rather than a silent one", () => {
  for (const text of [renderProposal(lesson(), { leadIn: "   " }), renderProposal(lesson(), {})]) {
    assert.match(text, /^_opencode-retro: is each lesson below already resolved/)
    assert.match(text, /retro_decide/, "the bookkeeping instruction survives either way")
  }
})

test("auto is capped, and says what it left out", () => {
  const many = Array.from({ length: 14 }, (_, i) => lesson({ id: `l${i}`, cost: 14 - i }))
  const text = renderBatch(many, { limit: 10 })

  assert.match(text, /# retro — 10 lessons waiting/)
  assert.match(text, /4 more below the cut/)
  assert.doesNotMatch(text, /## 11\./)
})

test("ordering is by effective score, so stale lessons sink in the batch", () => {
  const ordered = pickOpen(
    [
      lesson({ id: "stale", cost: 100, recurrence: 1, confidence: 1, lastSeen: 0 }),
      lesson({ id: "fresh", cost: 6, recurrence: 3, confidence: 0.9, lastSeen: 39 }),
    ],
    { sessions: 40, halfLife: 10 },
  )
  assert.deepEqual(
    ordered.map((l) => l.id),
    ["fresh", "stale"],
  )
})

test("closed lessons never reach the batch", () => {
  const text = renderBatch(pickOpen([lesson({ id: "open" }), lesson({ id: "done", status: "accepted" })]))
  assert.match(text, /`open`/)
  assert.doesNotMatch(text, /`done`/)
})

test("a lesson that has gone unseen for a while says so, in sessions not days", () => {
  const text = renderProposal(lesson({ lastSeen: 5 }), { sessions: 20 })
  assert.match(text, /Last seen 15 sessions ago\./)

  const one = renderProposal(lesson({ lastSeen: 9 }), { sessions: 10 })
  assert.match(one, /Last seen 1 session ago\./, "and counts one session as one session")
})

test("the recorded date is offered as a fact to bound the check with, not a verdict", () => {
  assert.deepEqual(hintLines({ recordedAt: "2026-10-19T20:29:00.000Z" }, null), [
    "_Worth knowing before you check: recorded 2026-10-19_",
  ])
  assert.deepEqual(hintLines({}, { hint: "`AGENTS.md` has changed." }), [
    "_Worth knowing before you check: `AGENTS.md` has changed._",
  ])
  assert.deepEqual(hintLines({}, null), [], "nothing known, nothing said")
  assert.deepEqual(
    hintLines({ recordedAt: "2026-10-19T00:00:00Z" }, { hint: "`AGENTS.md` has changed." }),
    ["_Worth knowing before you check: recorded 2026-10-19; `AGENTS.md` has changed._"],
    "both facts in one line, not two paragraphs",
  )
})

test("a single proposal also names the backlog behind it", () => {
  // A proposal in hand is exactly when someone assumes the backlog is done.
  const text = renderProposal(lesson(), { queued: 2 })
  assert.match(text, /2 logs not analysed yet\. Run `\/retro` again to pick them up\./)
})

test("a batch names a single backlog log in the singular", () => {
  const text = renderBatch([lesson()], { queued: 1 })
  assert.match(text, /1 log not analysed yet\. Run `\/retro` again to pick it up\./)
})

test("the batch limit has a default, so nothing has to pass one", () => {
  const many = Array.from({ length: PROPOSE_LIMIT + 2 }, (_, i) => lesson({ id: `l${i}`, cost: 20 - i }))
  const text = renderBatch(many)

  assert.match(text, new RegExp(`# retro — ${PROPOSE_LIMIT} lessons waiting`))
  assert.match(text, /2 more below the cut/)
})

test("a hand-edited lesson with one evidence entry instead of a list is still cited", () => {
  const text = renderProposal(lesson({ evidence: { session: "ses_solo", steps: [3, 4] } }))
  assert.match(text, /sessions\/ses_solo\.jsonl` steps 3–4/)
})

test("the small pieces both messages share say the same thing the same way", () => {
  assert.equal(asLeadIn("  My own wording.  ", "fallback"), "_opencode-retro — how to hand this over:_\n\nMy own wording.")
  assert.equal(asLeadIn(null, "fallback"), "fallback")
  assert.equal(asLeadIn("   ", "fallback"), "fallback", "whitespace is not a prompt")

  assert.equal(backlogLine(1), "1 log not analysed yet. Run `/retro` again to pick it up.")
  assert.match(backlogLine(3), /^3 logs not analysed yet/)

  assert.equal(renderFailures(null), "", "no failures, nothing to say")
  assert.equal(renderFailures({ failures: [] }), "")
  // Not "could not analyse": the plugin may not have analysed anything — it asked, and the
  // asking is all it knows. The detail says what actually happened.
  assert.match(
    renderFailures({ failures: [{ session: "ses_bad", detail: "asked 2 times and no record came back" }] }),
    /on `ses_bad`: asked 2 times and no record came back/,
  )
})

test("an evidence entry without steps is cited by session, not as an empty range", () => {
  // `steps` is optional in the parser, so a lesson can legitimately arrive with none. The
  // hand-over used to print "steps " with nothing after it.
  const text = renderProposal(lesson({ evidence: [{ session: "ses_solo", steps: [] }] }))
  assert.match(text, /sessions\/ses_solo\.jsonl`/)
  assert.doesNotMatch(text, /steps\s*[.`]/)
})

test("an empty hand-over names the plugin's files where options.dir put them", () => {
  // A stranger's run: with the directory moved, "see `.retro/plugin.log`" named a file that
  // did not exist — the same class of mistake as the evidence footer.
  const failed = renderNothing({ extracted: { failures: [{ session: "ses_a", detail: "empty" }] }, dir: "tools/retro" })
  assert.match(failed, /`tools\/retro\/plugin\.log` says why/)
  assert.doesNotMatch(failed, /\.retro\//)
  assert.match(renderNothing({ dir: "tools/retro" }), /`tools\/retro\/selfcheck\.md`/)
})

test("a round with several orders asks for them one at a time, and says why", () => {
  // Measured on the friction bench: the hand-over said "all of them at once if you can", the
  // three analyses ran in parallel, and each one's order had been written before any of them
  // recorded — so all three read "None yet" and reported the same problem under three
  // different ids, each with a recurrence of 1. Recurrence is the strongest signal in a
  // lesson's score, and the bench measured it at zero.
  const many = renderWorkOrders([
    { session: "ses_a", path: ".retro/work/ses_a.md" },
    { session: "ses_b", path: ".retro/work/ses_b.md" },
  ])
  assert.match(many, /One at a time, waiting for each to record before starting the next/)
  assert.match(many, /as one recurring problem rather than as several new ones/)
  assert.match(many, /slower on purpose/)
  assert.doesNotMatch(many, /all of them at once/, "which is what caused it")

  // One order has nothing to be ordered against, and the instruction would only be noise.
  const one = renderWorkOrders([{ session: "ses_a", path: ".retro/work/ses_a.md" }])
  assert.match(one, /Start one subagent per work order/)
  assert.doesNotMatch(one, /One at a time/)
})

test("every message that names a failed log names it the same way", () => {
  // The same failure was rendered by three functions in three phrasings, and a change to the
  // words reached two of them twice running: cycle 10 fixed the work-order hand-over and the
  // proposal, and cycle 11 found the "nothing to review" message still saying "Could not
  // analyse" about a log nobody had tried to analyse. One helper now, held to by this test.
  const f = { session: "ses_bad", detail: "asked 2 times and no record came back" }
  const line = failureLine(f)
  assert.ok(renderFailures({ failures: [f] }).includes(line), "the proposal")
  assert.ok(renderNothing({ extracted: { failures: [f] } }).includes(line), "nothing to review")
  assert.ok(renderWorkOrders([{ session: "ses_x", path: ".retro/work/ses_x.md" }], { failures: [f] }).includes(line), "the work orders")
  assert.doesNotMatch(line, /could not analyse/i, "and none of them claims an analysis that may not have happened")
})

test("nothing to review does not promise another try for a log set aside", async () => {
  // Fifth pre-release review.
  const { renderNothing } = await import("../src/propose.js")
  const { SET_ASIDE } = await import("../src/selfcheck.js")
  const text = renderNothing({ extracted: { failures: [{ session: "ses_x", detail: `${SET_ASIDE}: shadow log could not be read`, setAside: true }] } })
  assert.doesNotMatch(text, /tries again/)
  assert.match(text, /unless it grows/)
})

test("a lesson that came back is handed over with what was decided before", () => {
  const back = lesson({
    reopenedFrom: "accepted",
    decisions: [
      { status: "accepted", closedAt: "2026-10-26T04:05:00.000Z", statement: "AGENTS.md names `npm run build`.", note: "dropped the build line", decidedIn: "ses_r1", changed: ["AGENTS.md", "package.json"] },
    ],
  })
  const text = renderProposal(back, { total: 1, remaining: 0 })
  assert.match(text, /accepted on 2026-10-26 04:05 UTC in `ses_r1`: AGENTS\.md names `npm run build`\./)
  assert.match(text, /Decided: dropped the build line/)
  assert.match(text, /Changed: AGENTS\.md, package\.json/)
  assert.doesNotMatch(text, /whatever was done about it did not hold/)
  assert.match(renderBatch([back], {}), /Decided: dropped the build line/)
})

test("nothing to review after every lesson was decided says so, not that nothing is recorded", () => {
  const text = renderNothing({ decided: 2 })
  assert.match(text, /Nothing is open\. In `\.retro\/archive\/`: 2 decided\. Nothing new has come up since\./)
  assert.doesNotMatch(text, /nothing is recorded yet/)
})

test("nothing to review with logs still unread does not say nothing new has come up", () => {
  const text = renderNothing({ decided: 3, queued: 2 })
  assert.doesNotMatch(text, /nothing new has come up/)
  assert.match(text, /2 logs/)
})

test("nothing open with lessons the cap pushed out does not call them decided", () => {
  const text = renderNothing({ decided: 1, evicted: 5 })
  assert.match(text, /1 decided; 5 pushed out by the cap without being decided/, "both, told apart")
})

test("a decision's several-line proposal stays inside its item in the hand-over", () => {
  const back = lesson({
    reopenedFrom: "accepted",
    decisions: [{ status: "accepted", statement: "s", proposal: { target: "SKILL.md", change: "Add a precondition:\n1. check for .eslintrc\n2. skip otherwise" } }],
  })
  const text = renderProposal(back, { total: 1, remaining: 0 })
  assert.match(text, /\n {4}1\. check for \.eslintrc\n {4}2\. skip otherwise/)
})

test("nothing open with logs still waiting says neither that nothing is recorded nor that nothing came up", () => {
  const text = renderNothing({ decided: 3, queued: 2 })
  assert.match(text, /Nothing is open\. In `\.retro\/archive\/`: 3 decided\./)
  assert.doesNotMatch(text, /nothing is recorded yet|nothing new has come up/i)
})

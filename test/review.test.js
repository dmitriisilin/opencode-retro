import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DECIDE_INPUT, decide, pickLesson, pickOpen, renderBatch, renderNothing, renderProposal } from "../src/review.js"
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
  const root = mkdtempSync(join(tmpdir(), "retro-review-"))
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
  assert.match(text, /This is a proposal, not a change — nothing has been edited/)
  assert.match(text, /2 more lessons waiting of 3/)
  assert.match(text, /^_opencode-retro: is this already resolved/, "the fallback, when no prompt resolves")
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
  assert.match(text, /Analysed 3 finished sessions just now/, "say the work was done")
  assert.match(text, /2 more logs waiting. Run `\/retro` again/, "and that more is left, with what to do")
  assert.match(text, /selfcheck\.md/)
})

test("deciding closes the lesson: out of the open set, into the archive", () => {
  const r = rig()
  r.store.record([{ ...lesson(), steps: [9, 18], matches: null, why: "b" }], { session: "ses_a" })

  const result = decide({ id: "lint-skill-no-config", status: "accepted" }, r)
  assert.ok(result.ok)
  assert.match(result.detail, /moved to archive/)
  assert.deepEqual(r.store.list(), [], "lessons/ holds open questions only")

  const [archived] = r.store.listArchive()
  assert.equal(archived.status, "accepted")
  assert.ok(archived.closedAt, "and when it was closed")
})

test("later keeps the lesson open rather than closing it", () => {
  const r = rig()
  r.store.record([{ ...lesson(), steps: [9, 18], matches: null, why: "b" }], { session: "ses_a" })

  decide({ id: "lint-skill-no-config", status: "later" }, r)
  assert.equal(r.store.list()[0].status, "later")
  assert.deepEqual(r.store.listArchive(), [])
})

test("a rejection outlives the lesson file, or it comes back", () => {
  const r = rig()
  r.store.record([{ ...lesson(), steps: [9, 18], matches: null, why: "b" }], { session: "ses_a" })

  decide({ id: "lint-skill-no-config", status: "rejected", note: "we want eslint eventually" }, r)
  assert.equal(r.store.listArchive()[0].status, "rejected")
  assert.deepEqual(
    r.state.rejected.map((x) => x.id),
    ["lint-skill-no-config"],
  )
  assert.match(r.state.rejected[0].reason, /eslint eventually/)
})

test("deciding on a lesson that is not there fails clearly", () => {
  assert.match(decide({ id: "nope", status: "accepted" }, rig()).detail, /no lesson `nope`/)
})

test("the tool schema is plain JSON Schema, so it needs no dependency", () => {
  assert.equal(DECIDE_INPUT.type, "object")
  assert.deepEqual(DECIDE_INPUT.required, ["id", "status"])
  assert.deepEqual(DECIDE_INPUT.properties.status.enum, ["accepted", "rejected", "later"])
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

  assert.match(text, /^_opencode-retro: for each lesson below/, "the fallback, when no prompt resolves")
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
  assert.doesNotMatch(one, /is this already resolved/, "the fallback must not leak in alongside it")

  const many = renderBatch([lesson()], { leadIn })
  assert.match(many, /My own wording\./)
})

test("a missing prompt degrades to a terse hand-off rather than a silent one", () => {
  for (const text of [renderProposal(lesson(), { leadIn: "   " }), renderProposal(lesson(), {})]) {
    assert.match(text, /^_opencode-retro: is this already resolved/)
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

test("deciding twice is safe and says so, instead of reading as a failure", () => {
  const r = rig()
  r.store.record([{ ...lesson(), steps: [9, 18], matches: null, why: "b" }], { session: "ses_a" })

  const first = decide({ id: "lint-skill-no-config", status: "accepted" }, r)
  assert.ok(first.ok)

  // A live session failed here: the second call answered "no lesson", the agent read that
  // as broken and went looking through the filesystem for a tool it already had.
  const again = decide({ id: "lint-skill-no-config", status: "accepted" }, r)
  assert.ok(again.ok, "a repeat call must not look like a failure")
  assert.ok(again.already)
  assert.match(again.detail, /already recorded as accepted/)
})

test("an unknown id says what is actually open", () => {
  const r = rig()
  r.store.record([{ ...lesson(), steps: [9, 18], matches: null, why: "b" }], { session: "ses_a" })

  const got = decide({ id: "typo-in-the-id", status: "accepted" }, r)
  assert.equal(got.ok, false)
  assert.match(got.detail, /no lesson `typo-in-the-id` is open or archived/)
  assert.match(got.detail, /lint-skill-no-config/, "and names what it could have meant")
})

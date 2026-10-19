import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DECIDE_INPUT, decide, pickLesson, renderNothing, renderProposal } from "../src/review.js"
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
  assert.match(text, /^_opencode-retro: relay the proposal below/, "the agent reads it first")
  assert.match(text, /change nothing until they have decided/)
})

test("a lesson with no proposal is still worth showing, and says why", () => {
  const text = renderProposal(lesson({ proposal: null }), { total: 1, remaining: 0 })
  assert.match(text, /## No proposal/)
  assert.match(text, /Naming it is the useful part/)
  assert.doesNotMatch(text, /more lessons waiting/)
})

test("an empty store explains itself rather than looking broken", () => {
  const text = renderNothing({ queued: 2 })
  assert.match(text, /Nothing to review/)
  assert.match(text, /2 sessions still queued/)
  assert.match(text, /selfcheck\.md/)
})

test("a decision is recorded on the lesson", () => {
  const r = rig()
  r.store.record([{ ...lesson(), steps: [9, 18], matches: null, why: "b" }], { session: "ses_a" })

  const result = decide({ id: "lint-skill-no-config", status: "accepted" }, r)
  assert.ok(result.ok)
  assert.equal(r.store.list()[0].status, "accepted")
})

test("a rejection outlives the lesson file, or it comes back", () => {
  const r = rig()
  r.store.record([{ ...lesson(), steps: [9, 18], matches: null, why: "b" }], { session: "ses_a" })

  decide({ id: "lint-skill-no-config", status: "rejected", note: "we want eslint eventually" }, r)
  assert.equal(r.store.list()[0].status, "rejected")
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

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DECIDE_INPUT, decide } from "../src/decide.js"
import { createStore } from "../src/lessons.js"
import { createState } from "../src/state.js"

/**
 * The third artifact. `retro_decide` records what the work actually did, which is not what
 * the proposal said it would — and that gap is the only thing the accept/reject history is
 * worth learning from.
 */

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

test("the decision records what was actually done, not what was proposed", () => {
  const r = rig()
  r.store.record([{ ...lesson(), steps: [9, 18], matches: null, why: "b" }], { session: "ses_a" })

  decide(
    {
      id: "lint-skill-no-config",
      status: "accepted",
      note: "the skill was unfixable here, so it went",
      changed: ["AGENTS.md", ".opencode/skills/lint/SKILL.md"],
      discovered: "AGENTS.md still pointed at the skill, so removing it alone would have broken that line",
    },
    r,
  )

  const [archived] = r.store.listArchive()
  assert.equal(archived.status, "accepted")
  assert.deepEqual(archived.changed, ["AGENTS.md", ".opencode/skills/lint/SKILL.md"], "the real targets")
  assert.match(archived.discovered, /still pointed at the skill/, "and what only the work could reveal")
  assert.ok(archived.closedAt)
})

test("an outcome with nothing to add does not litter the record", () => {
  const r = rig()
  r.store.record([{ ...lesson(), steps: [9, 18], matches: null, why: "b" }], { session: "ses_a" })
  decide({ id: "lint-skill-no-config", status: "rejected", note: "we want eslint eventually" }, r)

  const [archived] = r.store.listArchive()
  assert.equal(archived.changed, undefined)
  assert.equal(archived.discovered, undefined)
  assert.match(archived.note, /eslint eventually/)
})

test("the decision tool asks for both, since only the work can produce them", () => {
  assert.match(DECIDE_INPUT.properties.changed.description, /not what the proposal named/)
  assert.match(DECIDE_INPUT.properties.discovered.description, /only exists because the work happened/)
})


import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore, freshness, score, staleSessions } from "../src/lessons.js"
import { parseFrontmatter } from "../src/frontmatter.js"

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "retro-lessons-"))
  return {
    root,
    store: (cap) => createStore({ dir: join(root, "lessons"), archive: join(root, "archive"), cap }),
    lessons: join(root, "lessons"),
    archive: join(root, "archive"),
  }
}

const lesson = (over = {}) => ({
  id: "lint-skill-no-config",
  statement: "The lint skill assumes eslint; this project has no linter.",
  steps: [9, 18],
  cost: 9,
  confidence: 0.8,
  matches: null,
  proposal: { target: ".opencode/skills/lint/SKILL.md", change: "Check for a config first." },
  ask: null,
  why: "Step 9 invoked the skill; step 18 exited 2.",
  ...over,
})

test("score is cost x recurrence x confidence", () => {
  assert.equal(score({ cost: 34, recurrence: 3, confidence: 0.9 }), 34 * 3 * 0.9)
  assert.equal(score({}), 0)
})

test("a new lesson is written in the documented format", () => {
  const s = sandbox()
  const result = s.store().record([lesson()], { session: "ses_a" })

  assert.deepEqual(result.created, ["lint-skill-no-config"])
  const { data, body } = parseFrontmatter(readFileSync(join(s.lessons, "lint-skill-no-config.md"), "utf8"))
  assert.equal(data.recurrence, 1)
  assert.equal(data.status, "new")
  assert.deepEqual(data.evidence, [{ session: "ses_a", steps: [9, 18] }])
  assert.equal(data.proposal.target, ".opencode/skills/lint/SKILL.md")
  assert.match(body, /Step 9 invoked the skill/)
})

test("the same lesson in a second session increments recurrence instead of duplicating", () => {
  const s = sandbox()
  const store = s.store()
  store.record([lesson()], { session: "ses_a" })
  const result = store.record([lesson({ steps: [4, 7], cost: 4, confidence: 0.95 })], { session: "ses_b" })

  assert.deepEqual(result.merged, ["lint-skill-no-config"])
  assert.deepEqual(result.created, [])
  assert.equal(readdirSync(s.lessons).length, 1)

  const { data } = parseFrontmatter(readFileSync(join(s.lessons, "lint-skill-no-config.md"), "utf8"))
  assert.equal(data.recurrence, 2)
  assert.equal(data.cost, 13, "cost accumulates across sessions")
  assert.equal(data.confidence, 0.95, "confidence takes the higher of the two")
  assert.equal(data.evidence.length, 2)
})

test("`matches` folds a differently named lesson into the existing one", () => {
  const s = sandbox()
  const store = s.store()
  store.record([lesson()], { session: "ses_a" })
  const result = store.record([lesson({ id: "eslint-missing", matches: "lint-skill-no-config" })], { session: "ses_b" })

  assert.deepEqual(result.merged, ["lint-skill-no-config"])
  assert.equal(readdirSync(s.lessons).length, 1)
})

test("re-extracting the same session does not inflate recurrence", () => {
  const s = sandbox()
  const store = s.store()
  store.record([lesson()], { session: "ses_a" })
  store.record([lesson()], { session: "ses_a" })

  const { data } = parseFrontmatter(readFileSync(join(s.lessons, "lint-skill-no-config.md"), "utf8"))
  assert.equal(data.recurrence, 1)
  assert.equal(data.cost, 9)
})

test("a ruling the user already made is not reopened by recurrence", () => {
  const s = sandbox()
  const store = s.store()
  store.record([lesson()], { session: "ses_a" })

  const file = join(s.lessons, "lint-skill-no-config.md")
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"))
  writeFileSync(file, readFileSync(file, "utf8").replace("status: new", "status: later"))

  store.record([lesson()], { session: "ses_b" })
  const after = parseFrontmatter(readFileSync(file, "utf8")).data
  assert.equal(after.status, "later")
  assert.equal(after.recurrence, 2, "it still counts, it just does not reset the decision")
  assert.ok(data.id && body !== undefined)
})

test("two different lessons with the same slug do not overwrite each other", () => {
  const s = sandbox()
  const store = s.store()
  store.record([lesson({ id: "same" }), lesson({ id: "same", statement: "A different problem entirely." })], {
    session: "ses_a",
  })
  assert.equal(readdirSync(s.lessons).length, 2)
})

test("over the cap, the lowest scores are archived rather than deleted", () => {
  const s = sandbox()
  const store = s.store(2)
  const batch = [
    lesson({ id: "big", statement: "Big", cost: 100, confidence: 1 }),
    lesson({ id: "mid", statement: "Mid", cost: 50, confidence: 1 }),
    lesson({ id: "small", statement: "Small", cost: 1, confidence: 0.1 }),
  ]
  const result = store.record(batch, { session: "ses_a" })

  assert.deepEqual(result.archived, ["small"])
  assert.deepEqual(readdirSync(s.lessons).sort(), ["big.md", "mid.md"])
  assert.deepEqual(readdirSync(s.archive), ["small.md"])
})

test("a lesson marked later is never archived out from under the user", () => {
  const s = sandbox()
  const store = s.store(1)
  mkdirSync(s.lessons, { recursive: true })
  store.record([lesson({ id: "keep", statement: "Keep", cost: 1, confidence: 0.1 })], { session: "ses_a" })
  const file = join(s.lessons, "keep.md")
  writeFileSync(file, readFileSync(file, "utf8").replace("status: new", "status: later"))

  store.record([lesson({ id: "huge", statement: "Huge", cost: 100, confidence: 1 })], { session: "ses_b" })
  assert.ok(readdirSync(s.lessons).includes("keep.md"))
})

test("list returns highest score first", () => {
  const s = sandbox()
  const store = s.store()
  store.record(
    [
      lesson({ id: "low", statement: "Low", cost: 1, confidence: 0.1 }),
      lesson({ id: "high", statement: "High", cost: 90, confidence: 1 }),
    ],
    { session: "ses_a" },
  )
  assert.deepEqual(
    store.list().map((l) => l.id),
    ["high", "low"],
  )
})

test("an empty store is not an error on first run", () => {
  const s = sandbox()
  assert.deepEqual(s.store().list(), [])
})

test("freshness halves the score every half-life of sessions without a recurrence", () => {
  const l = { cost: 10, recurrence: 2, confidence: 1, lastSeen: 0 }
  assert.equal(score(l), 20, "raw score when no session count is given")
  assert.equal(score(l, { sessions: 0, halfLife: 10 }), 20)
  assert.equal(score(l, { sessions: 10, halfLife: 10 }), 10)
  assert.equal(score(l, { sessions: 20, halfLife: 10 }), 5)
})

test("freshness is measured in sessions, so a lesson seen this session is at full weight", () => {
  assert.equal(freshness({ lastSeen: 7 }, { sessions: 7, halfLife: 10 }), 1)
  assert.equal(freshness({}, { sessions: 7 }), 1, "a lesson with no lastSeen is not punished for it")
  assert.equal(staleSessions({ lastSeen: 3 }, 9), 6)
})

test("a stale high-cost one-off loses to a fresh recurring problem", () => {
  const sessions = 40
  const old = { cost: 100, recurrence: 1, confidence: 1, lastSeen: 0 }
  const fresh = { cost: 6, recurrence: 3, confidence: 0.9, lastSeen: 39 }
  assert.ok(score(old) > score(fresh), "and would have won on the raw score")
  assert.ok(score(fresh, { sessions, halfLife: 10 }) > score(old, { sessions, halfLife: 10 }))
})

test("record stamps lastSeen with the current session count", () => {
  const root = mkdtempSync(join(tmpdir(), "retro-fresh-"))
  const store = createStore({ dir: join(root, "lessons"), archive: join(root, "archive"), sessions: () => 12 })
  store.record([lesson()], { session: "ses_a" })
  assert.equal(store.list()[0].lastSeen, 12)
})

test("a closed lesson that recurs is reopened with its history, not started over", () => {
  const root = mkdtempSync(join(tmpdir(), "retro-reopen-"))
  let seen = 1
  const store = createStore({ dir: join(root, "lessons"), archive: join(root, "archive"), sessions: () => seen })

  store.record([lesson()], { session: "ses_a" })
  store.close("lint-skill-no-config", "accepted")
  assert.deepEqual(store.list(), [])

  seen = 5
  const result = store.record([lesson()], { session: "ses_b" })
  assert.deepEqual(result.reopened, ["lint-skill-no-config"])
  assert.deepEqual(result.created, [])

  const [back] = store.list()
  assert.equal(back.recurrence, 2, "the history is carried over")
  assert.equal(back.evidence.length, 2)
  assert.equal(back.status, "new")
  assert.equal(back.reopenedFrom, "accepted", "and it says the fix did not hold")
  assert.equal(back.lastSeen, 5)
  assert.deepEqual(store.listArchive(), [], "it is no longer in two places at once")
})

test("record keeps a fingerprint of the target so currency can be checked later", () => {
  const root = mkdtempSync(join(tmpdir(), "retro-fp-"))
  const store = createStore({ dir: join(root, "lessons"), archive: join(root, "archive") })
  store.record([lesson()], { session: "ses_a", fingerprint: (t) => (t ? "abc123" : undefined) })
  assert.equal(store.list()[0].targetFingerprint, "abc123")
})

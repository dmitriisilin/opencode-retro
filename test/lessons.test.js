import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CAP, DEFAULT_HALF_LIFE, createStore, freshness, score, staleSessions } from "../src/lessons.js"
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
  assert.match(body, /Step 9 invoked the skill/, "and the narrative survives the status rewrite")
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

test("two problems that slug to the same name get honest distinct ids", () => {
  const s = sandbox()
  s.store().record(
    [lesson({ id: "same", statement: "The first problem." }), lesson({ id: "same", statement: "The second problem." })],
    { session: "ses_a" },
  )

  assert.deepEqual(readdirSync(s.lessons).sort(), ["same-2.md", "same.md"], "one file did not overwrite the other")
  const statements = readdirSync(s.lessons).map((f) => parseFrontmatter(readFileSync(join(s.lessons, f), "utf8")).data.statement)
  assert.deepEqual(statements.sort(), ["The first problem.", "The second problem."])
})

test("closing a lesson that is not open returns null rather than an empty record", () => {
  const s = sandbox()
  assert.equal(s.store().close("nope", "accepted"), null)
  assert.ok(!existsSync(s.archive), "and writes nothing, not even an empty archive")
})

test("close takes a bare note too, so an older outcome shape still records", () => {
  const s = sandbox()
  const store = s.store()
  store.record([lesson()], { session: "ses_a" })
  const closed = store.close("lint-skill-no-config", "accepted", "done by hand")

  assert.equal(closed.note, "done by hand")
  const [archived] = store.listArchive()
  assert.equal(archived.note, "done by hand")
})

test("a lesson that matches an archived id reopens that lesson, not a new one", () => {
  // The `matches` hint can name a lesson that was decided while this one was being
  // extracted. It is the same problem plus the news that the closing did not hold.
  const s = sandbox()
  const store = s.store()
  store.record([lesson()], { session: "ses_a" })
  store.close("lint-skill-no-config", "accepted", "removed the skill")

  const result = store.record([lesson({ id: "eslint-again", matches: "lint-skill-no-config" })], { session: "ses_b" })
  assert.deepEqual(result.reopened, ["lint-skill-no-config"])
  assert.deepEqual(result.created, [], "a differently named slug is not a new lesson")
  assert.deepEqual(store.listArchive(), [])

  const [back] = store.list()
  assert.equal(back.recurrence, 2)
  assert.equal(back.reopenedFrom, "accepted")
  assert.match(back.note, /removed the skill/, "the closing reason travels with it, as history")
})

test("the store's score, freshness and staleness all use its own session counter", () => {
  const root = mkdtempSync(join(tmpdir(), "retro-store-clock-"))
  let seen = 20
  const store = createStore({ dir: join(root, "lessons"), archive: join(root, "archive"), sessions: () => seen })
  store.record([lesson({ cost: 10, confidence: 1 })], { session: "ses_a" })
  assert.equal(store.list()[0].lastSeen, 20)

  seen = 30
  assert.equal(store.freshness({ lastSeen: 20 }), 0.5, "ten sessions is one half-life")
  assert.equal(store.staleSessions({ lastSeen: 20 }), 10)
  assert.equal(store.score({ cost: 10, recurrence: 1, confidence: 1, lastSeen: 20 }), 5)
})

test("write puts one lesson on disk under its id, body and all", () => {
  const s = sandbox()
  const store = s.store()
  assert.equal(store.write({ id: "hand-made", statement: "typed by a human", cost: 3, confidence: 1, body: "why it matters" }), true)

  const { data, body } = parseFrontmatter(readFileSync(join(s.lessons, "hand-made.md"), "utf8"))
  assert.equal(data.id, "hand-made")
  assert.equal(body, "why it matters")
  assert.deepEqual(store.list().map((l) => l.id), ["hand-made"])
})

test("a merge keeps the fingerprint taken when the lesson was first recorded", () => {
  const root = mkdtempSync(join(tmpdir(), "retro-fp-merge-"))
  const store = createStore({ dir: join(root, "lessons"), archive: join(root, "archive") })
  store.record([lesson()], { session: "ses_a", fingerprint: () => "first-hash" })
  store.record([lesson()], { session: "ses_b", fingerprint: () => "would-have-been-second" })

  // The recorded hash is the baseline a later review compares against; silently moving it
  // forward on every recurrence would make "changed since" unanswerable.
  assert.equal(store.list()[0].targetFingerprint, "first-hash")
})

test("the documented cap and half-life are the defaults, not just exported numbers", () => {
  assert.equal(DEFAULT_CAP, 30)
  assert.equal(DEFAULT_HALF_LIFE, 10)

  // The cap does the work: with no cap passed, 31 lessons leave one in the archive.
  const root = mkdtempSync(join(tmpdir(), "retro-default-cap-"))
  const store = createStore({ dir: join(root, "lessons"), archive: join(root, "archive") })
  const batch = Array.from({ length: DEFAULT_CAP + 1 }, (_, i) =>
    lesson({ id: `l${i}`, statement: `problem ${i}`, cost: DEFAULT_CAP - i + 1, confidence: 1 }),
  )
  const result = store.record(batch, { session: "ses_a" })

  assert.equal(store.list().length, DEFAULT_CAP)
  assert.equal(result.archived.length, 1)
  assert.deepEqual(store.listArchive().map((l) => l.id), [`l${DEFAULT_CAP}`], "the lowest score goes")

  // And freshness counts in half-lives of ten sessions unless told otherwise.
  assert.equal(score({ cost: 1, recurrence: 1, confidence: 1, lastSeen: 0 }, { sessions: 10 }), 0.5)
})

test("a store that cannot create its directory reports it and carries on", () => {
  const root = mkdtempSync(join(tmpdir(), "retro-store-blocked-"))
  writeFileSync(join(root, "blocked"), "not a directory\n")
  const errors = []
  const store = createStore({
    dir: join(root, "blocked", "lessons"),
    archive: join(root, "archive"),
    onError: (where) => errors.push(where),
  })

  assert.equal(store.write({ id: "x", statement: "a problem" }), false)
  assert.deepEqual(errors, ["lessons.mkdir"])
  assert.deepEqual(store.list(), [], "and a store that cannot be written reads as empty")
})

test("a lesson the user rejected does not come back from the archive", () => {
  // `state.rejected` is fed to the extractor and filters its answer, but that list lives in
  // one file and was lost once here. The archive is the record of the decision itself, so
  // "do not propose this again" has to hold from either side.
  const root = mkdtempSync(join(tmpdir(), "retro-rejected-"))
  const store = createStore({ dir: join(root, "lessons"), archive: join(root, "archive") })

  store.record([{ id: "lint-skill-no-config", statement: "eslint is not configured here", steps: [1, 2], cost: 3, confidence: 0.8, why: "x" }], { session: "ses_a" })
  store.close("lint-skill-no-config", "rejected", { note: "wrong for this project" })
  assert.deepEqual(store.list(), [])

  // The same problem, seen again in a later session.
  const again = store.record(
    [{ id: "lint-skill-no-config", statement: "eslint is not configured here", steps: [9, 11], cost: 4, confidence: 0.9, why: "y" }],
    { session: "ses_b" },
  )

  assert.deepEqual(again.created, [], "not created")
  assert.deepEqual(again.reopened, [], "and not reopened: the answer was no")
  assert.deepEqual(store.list(), [], "lessons/ stays empty")
  assert.equal(store.listArchive().find((l) => l.id === "lint-skill-no-config").status, "rejected")
})

test("a lesson that was accepted and comes back is reopened, because the fix did not hold", () => {
  const root = mkdtempSync(join(tmpdir(), "retro-reopen-"))
  const store = createStore({ dir: join(root, "lessons"), archive: join(root, "archive") })

  store.record([{ id: "build-script-missing", statement: "AGENTS.md names a build script that does not exist", steps: [1, 2], cost: 3, confidence: 0.8, why: "x" }], { session: "ses_a" })
  store.close("build-script-missing", "accepted", { note: "removed the line" })

  const again = store.record(
    [{ id: "build-script-missing", statement: "AGENTS.md names a build script that does not exist", steps: [4, 6], cost: 2, confidence: 0.9, why: "y" }],
    { session: "ses_b" },
  )

  assert.deepEqual(again.reopened, ["build-script-missing"], "this one does come back")
  assert.equal(store.list()[0].reopenedFrom, "accepted")
})

test("reading the same session again is not a second session", () => {
  // How these sessions are really used: left open, returned to, never finished — so a log is
  // read more than once. Recurrence is the number of *independent* sessions a problem showed
  // up in (decision 8), so a second look at one session must not reopen a lesson that was
  // accepted, which would say the fix did not hold when nothing of the sort happened.
  const root = mkdtempSync(join(tmpdir(), "retro-reread-"))
  const store = createStore({ dir: join(root, "lessons"), archive: join(root, "archive") })
  const lesson = { id: "lint-skill-no-config", statement: "eslint is not configured here", steps: [1, 2], cost: 3, confidence: 0.8, why: "x" }

  store.record([lesson], { session: "ses_open" })
  store.close("lint-skill-no-config", "accepted", { note: "added the precondition" })

  const again = store.record([{ ...lesson, steps: [40, 44] }], { session: "ses_open" })

  assert.deepEqual(again.reopened, [], "the same session, so not news")
  assert.deepEqual(again.created, [])
  assert.deepEqual(store.list(), [], "and it stays decided")

  // A different session is a different matter.
  const elsewhere = store.record([{ ...lesson, steps: [7, 9] }], { session: "ses_other" })
  assert.deepEqual(elsewhere.reopened, ["lint-skill-no-config"])
  assert.equal(store.list()[0].reopenedFrom, "accepted")
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createState } from "../src/state.js"

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "retro-state-"))
  return { root, path: join(root, "state.json") }
}

test("a fresh state has nothing rejected, queued or extracted", () => {
  const s = sandbox()
  const state = createState({ path: s.path })

  assert.deepEqual(state.rejected, [])
  assert.deepEqual(state.pending, [])
  assert.equal(state.sessions, 0)
  assert.equal(state.wasExtracted("ses_none"), false)
})

test("a rejection is remembered once, and outlives the process", () => {
  // A rejection has to survive the lesson file moving to archive/, or the extractor is
  // free to propose the same thing again next session.
  const s = sandbox()
  const state = createState({ path: s.path })
  state.reject("lint-skill-no-config", "we do want eslint here")
  state.reject("lint-skill-no-config", "a second reason must not duplicate the id")

  const reloaded = createState({ path: s.path })
  assert.equal(reloaded.rejected.length, 1)
  assert.equal(reloaded.rejected[0].id, "lint-skill-no-config")
  assert.match(reloaded.rejected[0].reason, /want eslint/)
  assert.match(reloaded.rejected[0].at, /^\d{4}-\d{2}-\d{2}T/, "and when it was rejected")
})

test("the queue is oldest first, deduped, and the running session is not its own debt", () => {
  const s = sandbox()
  const state = createState({ path: s.path })
  state.queue("ses_a")
  state.queue("ses_a")
  state.queue("ses_b")

  assert.deepEqual(state.pending.map((p) => p.session), ["ses_a", "ses_b"])
  assert.equal(state.nextPending(null).session, "ses_a")
  assert.equal(state.nextPending("ses_a").session, "ses_b")
})

test("a session that has already been extracted is never queued again", () => {
  const s = sandbox()
  const state = createState({ path: s.path })
  state.markExtracted("ses_done", { ok: true, detail: "nothing to learn" })
  state.queue("ses_done")

  assert.deepEqual(state.pending, [])
  assert.ok(state.wasExtracted("ses_done"))
})

test("markExtracted records the outcome and drops the session from the queue", () => {
  const s = sandbox()
  const state = createState({ path: s.path })
  state.queue("ses_a")
  state.queue("ses_b")
  state.markExtracted("ses_a", { ok: false, detail: "unparseable reply" })

  assert.deepEqual(state.pending.map((p) => p.session), ["ses_b"])

  const reloaded = createState({ path: s.path })
  const entry = JSON.parse(readFileSync(s.path, "utf8")).extracted.ses_a
  assert.equal(entry.ok, false, "a failure is recorded as a failure")
  assert.match(entry.detail, /unparseable/)
  assert.ok(reloaded.wasExtracted("ses_a"))
})

test("skip is for one run, so a broken log cannot hold up the ones behind it", () => {
  const s = sandbox()
  const state = createState({ path: s.path })
  for (const id of ["ses_a", "ses_b"]) state.queue(id)

  assert.equal(state.nextPending(null, new Set(["ses_a"])).session, "ses_b")
  assert.equal(state.nextPending(null, ["ses_a"]).session, "ses_b", "a plain array works too")
})

test("a session is given up on after three attempts, not billed forever", () => {
  const s = sandbox()
  const state = createState({ path: s.path })
  state.queue("ses_a")
  for (let i = 0; i < 3; i++) state.attempt("ses_a")

  assert.equal(state.nextPending(null), null)
  assert.equal(state.pending[0].attempts, 3, "the count is kept, so a restart does not restart the bill")
})

test("sessions are counted and persisted, because freshness is measured in them", () => {
  const s = sandbox()
  const state = createState({ path: s.path })
  assert.equal(state.countSession(), 1)
  assert.equal(state.countSession(), 2)

  assert.equal(createState({ path: s.path }).sessions, 2)
})

test("pending hands out copies, so a caller cannot corrupt the queue in place", () => {
  const s = sandbox()
  const state = createState({ path: s.path })
  state.queue("ses_a")

  const copy = state.pending
  copy[0].attempts = 99
  copy.push({ session: "invented" })
  assert.equal(state.pending[0].attempts, 0)
  assert.equal(state.pending.length, 1)
})

test("a corrupt state file starts clean instead of refusing to run", () => {
  // The plugin is not allowed to break the user's session over its own bookkeeping.
  const s = sandbox()
  writeFileSync(s.path, "{ this is not json")
  const state = createState({ path: s.path })

  assert.deepEqual(state.rejected, [])
  assert.deepEqual(state.pending, [])
  assert.equal(state.sessions, 0)

  state.queue("ses_a")
  assert.deepEqual(createState({ path: s.path }).pending.map((p) => p.session), ["ses_a"], "and it can still save")
})

test("a hand-edited file with the wrong shapes is repaired, not trusted", () => {
  const s = sandbox()
  writeFileSync(
    s.path,
    JSON.stringify({ version: 1, rejected: "nope", pending: {}, extracted: "nope", sessions: "twelve" }),
  )
  const state = createState({ path: s.path })

  assert.deepEqual(state.rejected, [])
  assert.deepEqual(state.pending, [])
  assert.equal(state.wasExtracted("anything"), false)
  assert.equal(state.sessions, 0)
})

test("a save that cannot happen is reported, never thrown at the session", () => {
  // A file where the directory should be is the cheapest way to make the write fail.
  const s = sandbox()
  writeFileSync(join(s.root, "blocked"), "not a directory\n")
  const errors = []
  const state = createState({ path: join(s.root, "blocked", "state.json"), onError: (where) => errors.push(where) })

  assert.doesNotThrow(() => state.countSession())
  assert.deepEqual(errors, ["state.save"])
})

test("a save merges with the file instead of overwriting another writer", () => {
  // Measured here: a rejection recorded out of band vanished when a long-running instance
  // saved its own older copy. A rejection is the one thing that must outlive the lesson it
  // belongs to, so losing it silently is the worst case this file has.
  const path = join(mkdtempSync(join(tmpdir(), "retro-state-merge-")), "state.json")
  const mine = createState({ path })
  mine.queue("ses_a")

  // Somebody else records a rejection and an extraction while we hold our own copy.
  const theirs = createState({ path })
  theirs.reject("lint-skill-no-config", "wrong for this project")
  theirs.markExtracted("ses_b", { ok: true, detail: "nothing to learn" })
  theirs.countSession()

  mine.countSession()

  const saved = JSON.parse(readFileSync(path, "utf8"))
  assert.deepEqual(
    saved.rejected.map((r) => r.id),
    ["lint-skill-no-config"],
    "the other writer's rejection survived our save",
  )
  assert.ok(saved.extracted.ses_b, "and its extraction")
  // The larger of the two, not the sum: two writers counting the same session must not count
  // it twice, and freshness only needs the counter to move forward.
  assert.equal(saved.sessions, 1, "the counter never goes backwards")
  assert.deepEqual(saved.pending.map((p) => p.session), ["ses_a"], "our own queue is ours")
})

test("an entry the file says is extracted leaves our queue on the next save", () => {
  const path = join(mkdtempSync(join(tmpdir(), "retro-state-merge2-")), "state.json")
  const mine = createState({ path })
  mine.queue("ses_a")
  mine.queue("ses_b")

  createState({ path }).markExtracted("ses_a", { ok: true, detail: "done elsewhere" })
  mine.countSession()

  const saved = JSON.parse(readFileSync(path, "utf8"))
  assert.deepEqual(saved.pending.map((p) => p.session), ["ses_b"], "no work is done twice")
})

test("the step mark only moves forward, and an old byte-count file still loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-mark-"))
  const path = join(dir, "state.json")

  // A state.json written before the offset existed holds a bare byte count.
  writeFileSync(path, JSON.stringify({ version: 1, rejected: [], extracted: {}, pending: [], sessions: 3, looked: { ses_a: 4096 } }))
  const state = createState({ path })
  assert.deepEqual(state.looked("ses_a"), { n: 0, size: 4096 }, "read as 'nothing analysed, this much sent'")

  state.look("ses_a", { n: 30, size: 8192 })
  assert.deepEqual(state.looked("ses_a"), { n: 30, size: 8192 })

  // A later read that got further in bytes but failed to produce lessons must not move `n`.
  state.look("ses_a", { size: 9000 })
  assert.deepEqual(state.looked("ses_a"), { n: 30, size: 9000 })

  // And neither number ever goes backwards.
  state.look("ses_a", { n: 2, size: 10 })
  assert.deepEqual(state.looked("ses_a"), { n: 30, size: 9000 })
})

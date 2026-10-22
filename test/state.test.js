import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createState } from "../src/state.js"

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "retro-state-"))
  return { root, path: join(root, "state.json") }
}

test("a fresh state has nothing rejected, read or extracted", () => {
  const s = sandbox()
  const state = createState({ path: s.path })

  assert.deepEqual(state.rejected, [])
  assert.deepEqual(state.looked("ses_none"), { n: 0, size: 0 })
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

test("sessions are counted and persisted, because freshness is measured in them", () => {
  const s = sandbox()
  const state = createState({ path: s.path })
  assert.equal(state.countSession(), 1)
  assert.equal(state.countSession(), 2)

  assert.equal(createState({ path: s.path }).sessions, 2)
})

test("a corrupt state file starts clean instead of refusing to run", () => {
  // The plugin is not allowed to break the user's session over its own bookkeeping.
  const s = sandbox()
  writeFileSync(s.path, "{ this is not json")
  const state = createState({ path: s.path })

  assert.deepEqual(state.rejected, [])
  assert.equal(state.sessions, 0)

  state.look("ses_a", { n: 1, size: 10 })
  assert.deepEqual(createState({ path: s.path }).looked("ses_a"), { n: 1, size: 10 }, "and it can still save")
})

test("a hand-edited file with the wrong shapes is repaired, not trusted", () => {
  const s = sandbox()
  writeFileSync(
    s.path,
    JSON.stringify({ version: 1, rejected: "nope", pending: {}, extracted: "nope", looked: "nope", sessions: "twelve" }),
  )
  const state = createState({ path: s.path })

  assert.deepEqual(state.rejected, [])
  assert.deepEqual(state.looked("anything"), { n: 0, size: 0 })
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
  mine.look("ses_a", { n: 4, size: 400 })

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
  // Each writer takes in the other's copy before counting, so two anonymous counts made one
  // after the other are two — and the counter never goes backwards.
  assert.equal(saved.sessions, 2, "the counter never goes backwards")
  assert.deepEqual([saved.looked.ses_a.n, saved.looked.ses_a.size], [4, 400], "and our own mark is ours")
})

test("the step mark only moves forward, and an old byte-count file still loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-mark-"))
  const path = join(dir, "state.json")

  // A state.json written before the offset existed holds a bare byte count.
  writeFileSync(path, JSON.stringify({ version: 1, rejected: [], extracted: {}, pending: [{ session: "ses_a" }], sessions: 3, looked: { ses_a: 4096 } }))
  const state = createState({ path })
  assert.deepEqual(state.looked("ses_a"), { n: 0, size: 4096 }, "read as 'nothing analysed, this much sent'")
  state.countSession()
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pending, undefined, "and the old queue is not carried forward")

  state.look("ses_a", { n: 30, size: 8192 })
  assert.deepEqual(state.looked("ses_a"), { n: 30, size: 8192 })

  // A later read that got further in bytes but failed to produce lessons must not move `n`.
  state.look("ses_a", { size: 9000 })
  assert.deepEqual(state.looked("ses_a"), { n: 30, size: 9000 })

  // And neither number ever goes backwards.
  state.look("ses_a", { n: 2, size: 10 })
  assert.deepEqual(state.looked("ses_a"), { n: 30, size: 9000 })
})

test("settling keeps the step mark, because the session may be picked up again", () => {
  // Sessions are left open and returned to. Deleting the mark when one is settled meant the
  // next read started at step 1 again, paid for everything a second time, and re-derived the
  // lessons already integrated. It never actually deleted it either — `save` merges with the
  // file, so the old number came straight back — but relying on that accident is not a rule.
  const s = sandbox()
  const state = createState({ path: s.path })
  state.look("ses_a", { n: 12, size: 4096 })
  state.markExtracted("ses_a", { ok: true, detail: "done" })

  assert.deepEqual(state.looked("ses_a"), { n: 12, size: 4096 }, "still the same process")
  assert.deepEqual(createState({ path: s.path }).looked("ses_a"), { n: 12, size: 4096 }, "and after a reload")
})

test("a session is counted once, however many times it runs", () => {
  // Freshness is counted in sessions, and OpenCode emits an execution per prompt: a session
  // left open and prompted five times is still one session, and counting turns would age the
  // lesson it just produced while the person is still working in the same place.
  const s = sandbox()
  const state = createState({ path: s.path })
  assert.equal(state.countSession("ses_a"), 1)
  assert.equal(state.countSession("ses_a"), 1, "a second turn is not a second session")
  assert.equal(state.countSession("ses_b"), 2)
  assert.equal(state.countSession(), 3, "without an id it still just counts")
  assert.equal(createState({ path: s.path }).sessions, 3, "and the count survives a restart")
})


test("two writers counting different sessions count two, not one", () => {
  // The counter used to be merged as a maximum. Two instances that each counted a different
  // session each moved their own copy to 1, the maximum kept 1, and a workspace that had
  // lived two sessions aged by one — the direction that makes every lesson look fresher
  // than it is.
  const path = join(mkdtempSync(join(tmpdir(), "retro-count-merge-")), "state.json")
  const mine = createState({ path })
  const theirs = createState({ path })

  mine.countSession("ses_a")
  theirs.countSession("ses_b")

  const saved = JSON.parse(readFileSync(path, "utf8"))
  assert.equal(saved.sessions, 2, "both sessions are in the count")
  assert.deepEqual(Object.keys(saved.counted).sort(), ["ses_a", "ses_b"])
})

test("a session discovered to be a subagent is taken back out of the counter", () => {
  // Its end can be processed before the parent link is known, which counts it. A delegation
  // is a step, not a session, and that has to remain true when we find out afterwards.
  const path = join(mkdtempSync(join(tmpdir(), "retro-uncount-")), "state.json")
  const state = createState({ path })
  state.countSession("ses_child")
  // A second writer loaded the count before the link was known.
  const stale = createState({ path })

  assert.equal(state.uncountSession("ses_child"), 0)
  assert.deepEqual(state.looked("ses_child"), { n: 0, size: 0 }, "and no mark is invented")

  stale.countSession("ses_other")

  const saved = JSON.parse(readFileSync(path, "utf8"))
  assert.equal(saved.sessions, 1, "only the real session is left")
  assert.equal(saved.counted.ses_child, undefined, "and the stale writer cannot put it back")
  assert.deepEqual(Object.keys(saved.counted), ["ses_other"])
})

test("an open mark survives a save and is cleared by a read that reaches the end", () => {
  // An excerpt sends the bytes but covers only its unbroken prefix. Without the mark the
  // next command sees a log no larger than what was sent and never reads the gap.
  const s = sandbox()
  const state = createState({ path: s.path })
  state.look("ses_a", { n: 5, size: 100, open: true })

  assert.deepEqual(state.looked("ses_a"), { n: 5, size: 100, open: true })
  assert.equal(createState({ path: s.path }).looked("ses_a").open, true, "and it is on disk")

  state.look("ses_a", { n: 9, size: 200, open: false })
  assert.deepEqual(state.looked("ses_a"), { n: 9, size: 200 }, "a complete read closes it")
})

test("a mark about a replaced log cannot be resurrected by a writer that never saw the replacement", () => {
  // Two writers hold the same mark. One sees the log replaced and writes a mark about the
  // new file; the other, still holding the old one in memory, saves something unrelated.
  // Without an identity on the mark the merge maxed the numbers and the old 50 came back;
  // without an order on the marks it could not tell which writer had seen the file.
  const path = join(mkdtempSync(join(tmpdir(), "retro-identity-")), "state.json")
  let tick = 1000
  const clock = () => tick++

  const stale = createState({ path, now: clock })
  stale.look("ses_x", { n: 50, size: 5000, id: "old-file" })

  const fresh = createState({ path, now: clock })
  fresh.look("ses_x", { n: 3, size: 300, id: "new-file" })
  assert.deepEqual(fresh.looked("ses_x"), { n: 3, size: 300, id: "new-file" }, "a different file starts over")

  stale.countSession("ses_other") // any save at all

  const saved = JSON.parse(readFileSync(path, "utf8")).looked.ses_x
  assert.equal(saved.id, "new-file", "the writer that saw the file wins")
  assert.equal(saved.n, 3, "and the old number does not come back through the maximum")
})

test("bookkeeping about a session is dropped once nothing can refer to it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "retro-compact-")), "state.json")
  const state = createState({ path })

  state.countSession("ses_gone")
  state.uncountSession("ses_gone")
  state.look("ses_gone", { n: 1, size: 10, id: "f" })
  state.markExtracted("ses_gone", { ok: true, detail: "x" })

  state.look("ses_kept", { n: 1, size: 10, id: "g" })
  // A session counted long ago, whose log is gone and which nothing owes. Its identity is
  // not bookkeeping: a session left open can be prompted again months later, and folding it
  // away would count it a second time and make everything look fresher than it is.
  state.countSession("ses_counted_only")

  state.compact((id) => id === "ses_kept")

  const saved = JSON.parse(readFileSync(path, "utf8"))
  assert.equal(saved.uncounted.includes("ses_gone"), true, "the tombstone is the defence against a stale writer")
  assert.equal(saved.looked.ses_gone, undefined, "the mark is bookkeeping and goes")
  assert.equal(saved.extracted.ses_gone, undefined, "so does the extraction outcome")
  assert.ok(saved.looked.ses_kept, "what can still be referred to stays")
  assert.equal(saved.counted.ses_counted_only, true, "but a counted session keeps its identity")
  assert.equal(saved.sessions, 1, "so the session count still means what it says")
})

test("a deliberate removal survives a merge that happens after compaction", async () => {
  // The tombstones used to be compacted away with the marks. A writer that loaded before the
  // removal then saved its older copy: the queue union brought the child back and the counted
  // union made it a session again, so a delegation both cost an analysis that could only fail
  // (its log is gone) and aged every lesson in the workspace. Compaction is now about marks
  // and extraction outcomes, which nothing can refer to; a tombstone is a decision.
  const path = join(mkdtempSync(join(tmpdir(), "retro-tombstone-compact-")), "state.json")
  const mine = createState({ path })
  const stale = createState({ path })
  stale.countSession("ses_child")

  mine.uncountSession("ses_child")
  mine.countSession("ses_other")
  mine.compact((id) => id === "ses_other")

  stale.countSession("ses_other") // any save at all, from the writer that never learned
  const saved = JSON.parse(readFileSync(path, "utf8"))

  assert.equal(saved.counted.ses_child, undefined, "the child is not a session again")
  assert.equal(saved.sessions, 1, "freshness counts the real session only")
})

test("a stale writer cannot clear a mark flag at the same step", () => {
  // Both flags mean "still owed", and a writer that loaded before the read that set one can
  // save an equally advanced mark without it. The merge used to prefer its own copy whenever
  // the step was not smaller, so a failed read — or an excerpt still owed — vanished on the
  // next save, and after a restart the log looked read for ever. At the same step the later
  // mark is the one that knows.
  const path = join(mkdtempSync(join(tmpdir(), "retro-flags-merge-")), "state.json")
  let tick = 1000
  const clock = () => tick++

  const base = createState({ path, now: clock })
  base.look("ses_failed", { n: 5, size: 100, id: "f" })
  base.look("ses_open", { n: 7, size: 200, id: "o" })

  const stale = createState({ path, now: clock })
  const fresh = createState({ path, now: clock })
  fresh.look("ses_failed", { n: 5, size: 100, failed: true, id: "f" })
  fresh.look("ses_open", { n: 7, size: 200, open: true, id: "o" })

  stale.countSession("ses_other") // any save at all, from the older copy
  const saved = JSON.parse(readFileSync(path, "utf8")).looked

  assert.equal(saved.ses_failed.failed, true, "the failed read is still owed")
  assert.equal(saved.ses_open.open, true, "and the excerpt is still owed now")
})

test("two writers' marks are merged, so neither loses what the other read", () => {
  // There is no queue: what is owed is computed from each log and its mark. So the marks are
  // the whole of the debt, and losing one is reading a log twice or, worse, never reading
  // what another writer left open.
  const path = join(mkdtempSync(join(tmpdir(), "retro-marks-merge-")), "state.json")
  const mine = createState({ path })
  const theirs = createState({ path })
  mine.look("ses_a", { n: 4, size: 400, id: "a" })
  theirs.look("ses_b", { n: 0, size: 200, failed: true, attempts: 2, id: "b" })
  mine.look("ses_a", { n: 6, size: 600, id: "a" })

  const saved = JSON.parse(readFileSync(path, "utf8")).looked
  assert.deepEqual(saved.ses_a, { n: 6, size: 600, id: "a", at: saved.ses_a.at })
  assert.equal(saved.ses_b.failed, true, "the other writer's failure is still owed")
  assert.equal(saved.ses_b.attempts, 2, "with the attempts it has spent")
})

test("attempts belong to the input they were spent on", () => {
  const s = sandbox()
  const state = createState({ path: s.path })
  state.look("ses_a", { size: 100, failed: true, attempts: 2 })
  assert.equal(state.looked("ses_a").attempts, 2)
  state.look("ses_a", { size: 100, failed: true })
  assert.equal(state.looked("ses_a").attempts, 2, "the same input keeps its count")
  state.look("ses_a", { size: 180, failed: true })
  assert.equal(state.looked("ses_a").attempts, undefined, "a log that grew is a different input")
})

test("a mark about a log that is gone or was replaced does not survive a merge", () => {
  // The writer that never saw a log pruned or replaced still holds the old mark. The merge
  // asks the disk which file is there now, so the old numbers cannot come back and make the
  // new log look read — the job the `rebased` tombstone used to do, for one writer only.
  const dir = mkdtempSync(join(tmpdir(), "retro-probe-"))
  const path = join(dir, "state.json")
  const files = { ses_kept: { id: "k", size: 100 }, ses_replaced: { id: "new", size: 50 } }
  const probe = (id) => files[id] ?? null

  const stale = createState({ path, probe })
  stale.look("ses_kept", { n: 3, size: 100, id: "k" })
  stale.look("ses_replaced", { n: 9, size: 900, id: "old" })
  stale.look("ses_pruned", { n: 2, size: 20, id: "p" })
  stale.countSession("ses_other")

  const saved = JSON.parse(readFileSync(path, "utf8")).looked
  assert.ok(saved.ses_kept, "a mark about the file on disk stays")
  assert.equal(saved.ses_replaced, undefined, "a mark about a different file goes")
  assert.equal(saved.ses_pruned, undefined, "and so does one about a file that is gone")
})

test("a later outcome wins the merge, whichever writer holds it", () => {
  const path = join(mkdtempSync(join(tmpdir(), "retro-outcome-merge-")), "state.json")
  const stale = createState({ path })
  stale.markExtracted("ses_a", { ok: true, detail: "read" })
  const fresh = createState({ path })
  fresh.markExtracted("ses_a", { ok: false, detail: "given up after three failed analyses" })

  stale.countSession("ses_other") // any save, from the writer holding the older outcome
  assert.equal(JSON.parse(readFileSync(path, "utf8")).extracted.ses_a.ok, false, "the newer outcome stands")
})

test("a writer reads what another saved since, not only what it loaded", () => {
  // Reads used to come from memory, refreshed only by the reader's own next save: a second
  // instance counted a third failure as a first and re-read what the other had just read.
  const path = join(mkdtempSync(join(tmpdir(), "retro-refresh-")), "state.json")
  const mine = createState({ path })
  const theirs = createState({ path })
  theirs.look("ses_a", { n: 7, size: 700, failed: true, attempts: 2, id: "a" })

  assert.deepEqual(
    [mine.looked("ses_a").n, mine.looked("ses_a").attempts],
    [7, 2],
    "the other writer's mark is seen without saving anything first",
  )
})


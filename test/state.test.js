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

test("a rebased mark is not resurrected by the merge", () => {
  // A pruned log written again under the same id starts at step 1 and is shorter than the
  // mark. A size that only ever grows would then call the new file already read, for ever.
  const s = sandbox()
  const state = createState({ path: s.path })
  state.look("ses_a", { n: 40, size: 9000 })
  state.rebase("ses_a")

  assert.deepEqual(state.looked("ses_a"), { n: 0, size: 0 }, "forgotten, not maxed")
  assert.deepEqual(createState({ path: s.path }).looked("ses_a"), { n: 0, size: 0 }, "and the write wins over the old file")

  state.look("ses_a", { n: 3, size: 120 })
  assert.deepEqual(state.looked("ses_a"), { n: 3, size: 120 }, "and the new file can be read from its own start")
})

test("an entry queued before an extraction is done; one queued for later work is not", () => {
  const s = sandbox()
  const state = createState({ path: s.path })

  // Settled at byte 100. A run of the queue that predates that settle is stale work.
  state.look("ses_a", { n: 10, size: 100 })
  state.markExtracted("ses_a", { ok: true, detail: "done" })
  state.queue("ses_a", 90)
  assert.deepEqual(state.pending, [], "the extraction covered what was queued")

  // The session was prompted again and wrote past where the analysis stopped.
  state.queue("ses_a", 240)
  assert.deepEqual(state.pending.map((p) => p.session), ["ses_a"], "new material is owed")
  assert.deepEqual(
    createState({ path: s.path }).pending.map((p) => p.session),
    ["ses_a"],
    "and a reload does not drop it as though it had been extracted",
  )
})

test("a rebase also clears what the old extraction covered", () => {
  // The extraction's byte size describes the file that was replaced. A shorter new log would
  // otherwise look already covered and be dropped from the queue on the next save.
  const s = sandbox()
  const state = createState({ path: s.path })
  state.look("ses_a", { n: 40, size: 9000 })
  state.markExtracted("ses_a", { ok: true, detail: "done", size: 9000 })
  state.rebase("ses_a")
  state.queue("ses_a", 30)

  assert.deepEqual(state.pending.map((p) => p.session), ["ses_a"], "new bytes are not covered by an extraction of the old file")
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


test("two writers' queues are merged, so neither loses what the other owed", () => {
  // A lost queue entry is a session nobody analyses: the log sits there and nothing is owed
  // for it. Entries only ever leave through an extraction, which the coverage filter already
  // expresses, so a union cannot resurrect one that was removed on purpose.
  const path = join(mkdtempSync(join(tmpdir(), "retro-queue-merge-")), "state.json")
  const mine = createState({ path })
  mine.queue("ses_a", 100)
  mine.attempt("ses_a")

  const theirs = createState({ path })
  theirs.queue("ses_b", 200)

  mine.queue("ses_c", 300)

  const saved = JSON.parse(readFileSync(path, "utf8"))
  assert.deepEqual(
    saved.pending.map((p) => p.session).sort(),
    ["ses_a", "ses_b", "ses_c"],
    "both writers' debts survive",
  )
  assert.equal(saved.pending.find((p) => p.session === "ses_a").attempts, 1, "and the attempt count is not reset")
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

test("a session removed from the queue stays removed even if another writer queued it", () => {
  // The removal tombstone used to be cleared when *our* copy had no entry to remove. The
  // entry can exist only on disk — the other instance queued the child before we learned it
  // was a child — and the queue union would then bring it straight back.
  const path = join(mkdtempSync(join(tmpdir(), "retro-unqueue-merge-")), "state.json")
  const mine = createState({ path })
  const theirs = createState({ path })
  theirs.queue("ses_child", 100)

  mine.unqueue("ses_child")
  mine.countSession("ses_x") // any later save

  const saved = JSON.parse(readFileSync(path, "utf8"))
  assert.deepEqual(saved.pending, [], "the child is not owed an analysis")
  assert.deepEqual(createState({ path }).pending, [], "and a reload agrees")
})

test("a rebase whose save failed is not undone by the next look", () => {
  // `look` used to clear the rebase tombstone before saving. If the rebase itself could not
  // be written, the next successful merge maxed the new, smaller mark against the old one
  // still on disk and the replaced log became invisible for ever.
  const dir = mkdtempSync(join(tmpdir(), "retro-rebase-fail-"))
  const path = join(dir, "state.json")
  const errors = []
  const state = createState({ path, onError: (where) => errors.push(where) })

  state.look("ses_a", { n: 40, size: 9000 })
  const old = readFileSync(path, "utf8")

  rmSync(path)
  mkdirSync(path) // makes the rebase's write fail with EISDIR
  state.rebase("ses_a")
  assert.deepEqual(state.looked("ses_a"), { n: 0, size: 0 }, "forgotten in memory")
  assert.deepEqual(errors, ["state.save"], "and the failure was reported, not thrown")

  rmSync(path, { recursive: true })
  writeFileSync(path, old) // the old mark survives on disk, as it would after a failed write
  state.look("ses_a", { n: 3, size: 120 })

  assert.deepEqual(state.looked("ses_a"), { n: 3, size: 120 }, "the new file's own mark, not the old one")
  assert.deepEqual(createState({ path }).looked("ses_a"), { n: 3, size: 120 }, "and the write wins")
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

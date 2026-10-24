import { mkdirSync, readFileSync, statSync } from "node:fs"
import { writeAtomic } from "./atomic.js"
import { dirname } from "node:path"

/**
 * state.json — the small things that must outlive a process: which lessons the user
 * rejected (so the extractor is told not to propose them again, decision 9), how far each
 * log has been read (the marks), the last analysis of each session, and the session count.
 *
 * There is no queue. What is owed is computed from each log and its mark every time it is
 * asked (log.md), so nothing in this file can claim a log is owed when it is not, or forget
 * one that is. The queue that used to live here was the part that fell out of step with the
 * logs most often: a union across writers held together by tombstones, and the source of the
 * one hang the model test found.
 */

/** The on-disk shape of a mark, in one place: flags and counts only when they say something. */
const mark = ({ n = 0, size = 0, open = false, failed = false, attempts = 0, id = null, at = null } = {}) => ({
  n,
  size,
  ...(open ? { open: true } : {}),
  ...(failed ? { failed: true } : {}),
  ...(attempts ? { attempts } : {}),
  ...(id ? { id } : {}),
  ...(at ? { at } : {}),
})

/** A stored mark, in either shape: a bare byte count predates the step offset. */
const asMark = (v) => ({
  present: v !== undefined,
  n: typeof v === "number" ? 0 : (v?.n ?? 0),
  size: typeof v === "number" ? v : (v?.size ?? 0),
  open: typeof v === "number" ? false : Boolean(v?.open),
  failed: typeof v === "number" ? false : Boolean(v?.failed),
  attempts: typeof v === "number" ? 0 : (v?.attempts ?? 0),
  id: typeof v === "number" ? null : (v?.id ?? null),
  at: typeof v === "number" ? 0 : (v?.at ?? 0),
})

/**
 * @param probe `(session) => { id, size } | null` — the log actually on disk. A mark is about
 *   one file, and only the disk can say which file is there now. Without a probe (tests that
 *   have no logs) marks are merged on their own evidence alone.
 */
export function createState({ path, onError, now = () => Date.now(), probe = null }) {
  let data = {
    version: 2,
    rejected: [],
    extracted: {},
    sessions: 0,
    looked: {},
    counted: {},
    anonymous: 0,
    uncounted: [],
    orders: {},
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed && typeof parsed === "object") {
      data = { ...data, ...parsed }
      if (!Array.isArray(data.rejected)) data.rejected = []
      if (!data.extracted || typeof data.extracted !== "object") data.extracted = {}
      if (typeof data.sessions !== "number") data.sessions = 0
      if (!data.looked || typeof data.looked !== "object") data.looked = {}
      if (!data.counted || typeof data.counted !== "object") data.counted = {}
      if (!Array.isArray(data.uncounted)) data.uncounted = []
      if (!data.orders || typeof data.orders !== "object" || Array.isArray(data.orders)) data.orders = {}
      // A file written before the identity list existed has only the number. Recover the
      // anonymous part rather than trusting a total we can no longer decompose.
      if (typeof data.anonymous !== "number") {
        data.anonymous = Math.max(0, data.sessions - Object.keys(data.counted).length)
      }
      data.sessions = Math.max(0, data.anonymous + Object.keys(data.counted).length)
    }
  } catch {
    /* absent or hand-broken: start clean rather than refuse to run */
  }
  // A file from before the queue was removed carries one; it says nothing the marks do not.
  delete data.pending
  delete data.unqueued
  data.version = 2

  /** A predicate for one save: keep only the sessions it says can still be referred to. */
  let compactWith = null

  /**
   * Whether a mark describes the log that is on disk now. Two files under one session id are
   * two logs — a pruned log written again, a file replaced by hand — and a mark is about
   * exactly one of them. Different identities settle it; a mark without one (written before
   * identities existed) is void when it claims more bytes than the file has. No file at all
   * means nothing is left for the mark to describe.
   */
  const describes = (session, m) => {
    if (!probe) return true
    const file = probe(session)
    if (!file) return false
    if (m.id && file.id && m.id !== file.id) return false
    if (!m.id && m.size > file.size) return false
    return true
  }

  /** Fold another writer's copy into ours: unions, maxima, and marks checked against the disk. */
  const merge = (raw) => {
    // Another writer's copy is read with the same suspicion as our own at load: a hand edit
    // can put any shape anywhere, and a string spread into a map becomes one entry per letter.
    const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {})
    const disk = raw
      ? { ...raw, extracted: obj(raw.extracted), counted: obj(raw.counted), looked: obj(raw.looked), orders: obj(raw.orders) }
      : null
    if (disk) {
      const rejected = [...(Array.isArray(disk.rejected) ? disk.rejected : [])]
      for (const r of data.rejected) if (!rejected.some((o) => o?.id === r.id)) rejected.push(r)
      data.rejected = rejected

      // The later outcome of each session wins, whoever wrote it. "Ours wins" let a writer
      // holding an old success overwrite the other's newer "given up on", and a retired log
      // then counted as read — found by the model test, with two instances.
      const extracted = { ...(disk.extracted ?? {}) }
      for (const [id, x] of Object.entries(data.extracted ?? {})) {
        if (!extracted[id] || String(x?.at ?? "") > String(extracted[id]?.at ?? "")) extracted[id] = x
      }
      data.extracted = extracted

      /**
       * Counted sessions are identities, and the number is derived from them.
       *
       * The old merge took the maximum of two counters, which is only right when both
       * writers counted the same sessions. Two instances that each counted a different
       * session each moved their own counter by one, the maximum kept one, and the
       * workspace aged by one session less than it had lived. Distinct ids are merged, then
       * the anonymous calls (which have no id to merge by) take the maximum.
       */
      const uncounted = [
        ...new Set([
          ...(Array.isArray(disk.uncounted) ? disk.uncounted : []),
          ...(Array.isArray(data.uncounted) ? data.uncounted : []),
        ]),
      ]
      const counted = { ...(disk.counted ?? {}), ...(data.counted ?? {}) }
      for (const id of uncounted) delete counted[id]
      data.counted = counted
      data.uncounted = uncounted
      data.anonymous = Math.max(
        typeof data.anonymous === "number" ? data.anonymous : 0,
        typeof disk.anonymous === "number"
          ? disk.anonymous
          : Math.max(0, (disk.sessions ?? 0) - Object.keys(disk.counted ?? {}).length),
      )
      data.sessions = data.anonymous + Object.keys(counted).length

      /**
       * Marks, per session. About the same file, both numbers are maxima — that is what
       * stops the same bytes being paid for twice — and at the same step the later mark
       * decides which flags stand, so a writer that loaded before a failed read cannot clear
       * the failure with an equally advanced mark. Attempts belong to the input they were
       * spent on: the count of the mark about the larger log, or the higher one at one size.
       *
       * About different files, numbers about one say nothing about the other, and the one
       * that describes the file on disk wins. This replaces the `rebased` tombstone, which a
       * writer that never saw the replacement could not have, and which had to be carried
       * through every byte count in the file.
       */
      const own = data.looked ?? {}
      const looked = {}
      for (const id of new Set([...Object.keys(disk.looked ?? {}), ...Object.keys(own)])) {
        const a = asMark(disk.looked?.[id])
        const b = asMark(own[id])
        const candidates = [a, b].filter((m) => m.present && describes(id, m))
        if (!candidates.length) continue
        if (candidates.length === 1 || (a.id && b.id && a.id !== b.id)) {
          // Different files, or only one side describes the file at all. With no probe both
          // may survive the filter; the later one is then the better guess.
          const pick = candidates.length === 1 ? candidates[0] : b.at >= a.at ? b : a
          looked[id] = mark(pick)
          continue
        }
        const newer = b.n > a.n || (b.n === a.n && b.at >= a.at) ? b : a
        const attempts = a.size === b.size ? Math.max(a.attempts, b.attempts) : a.size > b.size ? a.attempts : b.attempts
        looked[id] = mark({
          n: Math.max(a.n, b.n),
          size: Math.max(a.size, b.size),
          open: newer.open,
          failed: newer.failed,
          // Attempts count failures still standing; a mark whose failure was cleared has none.
          attempts: newer.failed ? attempts : 0,
          id: b.id ?? a.id,
          at: Math.max(a.at, b.at) || null,
        })
      }
      data.looked = looked

      // Work orders: the later one of each session wins, issued or answered, whoever wrote it.
      // An answer is kept as `done` rather than deleted, so a writer that still holds the open
      // order cannot bring it back by saving after the answer.
      const orders = { ...(disk.orders ?? {}) }
      for (const [id, o] of Object.entries(data.orders ?? {})) {
        if (!orders[id] || (o?.at ?? 0) > (orders[id]?.at ?? 0)) orders[id] = o
      }
      data.orders = orders
    } else if (probe) {
      for (const id of Object.keys(data.looked)) if (!describes(id, asMark(data.looked[id]))) delete data.looked[id]
    }
  }

  /** The file as it was when we last read or wrote it, so a refresh is a stat when nothing moved. */
  let known = null
  const stamp = () => {
    try {
      const st = statSync(path)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  /**
   * Take in what another writer saved since we last looked. Reads used to come from memory
   * alone, refreshed only by our own next save, so a second instance on the project decided
   * from a picture minutes old: it re-read a log the other had just read, and counted a third
   * failure as a first. A stat when nothing changed; a merge when something did.
   */
  const refresh = () => {
    const now = stamp()
    if (!now || now === known) return
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed && typeof parsed === "object") merge(parsed)
    } catch {
      /* mid-write by another process, or hand-broken: keep what we have */
    }
    known = now
  }
  known = stamp() // what was loaded above needs no second merge

  /**
   * Written by merging with whatever is on disk, not by overwriting it.
   *
   * A second writer — another plugin instance on this project, or anything editing the file
   * between a load and a save — used to be silently clobbered. Measured here: a rejection
   * recorded out of band disappeared when a long-running instance saved its own older copy,
   * and a rejection is the one thing that must outlive the lesson it belongs to (decision 9).
   */
  const save = () => {
    try {
      let disk = null
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"))
        if (parsed && typeof parsed === "object") disk = parsed
      } catch {
        /* absent or unreadable: nothing to merge with */
      }

      if (disk) merge(disk)
      else if (probe) for (const id of Object.keys(data.looked)) if (!describes(id, asMark(data.looked[id]))) delete data.looked[id]

      if (compactWith) {
        // Marks and extraction outcomes are bookkeeping, and are dropped once nothing can
        // refer to them. The tombstone is not: it is the only defence against a writer that
        // loaded before the removal and saves afterwards, and the counted union would bring
        // the delegation straight back. It grows with the number of delegations — one
        // identity per session, like `counted` — not with the age of the project.
        for (const key of ["looked", "extracted", "orders"]) {
          for (const id of Object.keys(data[key] ?? {})) if (!compactWith(id)) delete data[key][id]
        }
      }

      mkdirSync(dirname(path), { recursive: true })
      writeAtomic(path, JSON.stringify(data, null, 2) + "\n")
      known = stamp()
    } catch (err) {
      onError?.("state.save", err)
    }
  }

  return {
    get rejected() {
      refresh()
      return [...data.rejected]
    },
    reject(id, reason) {
      if (!data.rejected.some((r) => r.id === id)) {
        data.rejected.push({ id, reason: reason ?? null, at: new Date().toISOString() })
        save()
      }
    },
    wasExtracted: (session) => {
      refresh()
      return Boolean(data.extracted[session])
    },
    /** What the last analysis of this session concluded, if any — including that it failed. */
    extractionOf: (session) => {
      refresh()
      return data.extracted[session] ?? null
    },

    /**
     * How much of a session's log has already been dealt with (log.md, "The mark").
     *
     * `n` is the last step actually turned into lessons, so the next analysis starts after
     * it — sessions are left open and returned to, so a log is never final, and without it a
     * `/retro` a fortnight later would pay for all of it again. `size` is the largest log
     * already sent, success or not. `open` says a successful read stopped at a gap, `failed`
     * that the last read failed, and `attempts` how many times at this size.
     */
    looked(session) {
      refresh()
      const m = asMark(data.looked[session])
      return {
        n: m.n,
        size: m.size,
        ...(m.open ? { open: true } : {}),
        ...(m.failed ? { failed: true } : {}),
        ...(m.attempts ? { attempts: m.attempts } : {}),
        ...(m.id ? { id: m.id } : {}),
      }
    },
    look(session, { n, size, open, failed, attempts, id }) {
      const before = this.looked(session)
      // A mark is about one file. Told which file this is and finding it is not the one the
      // mark described, the old numbers are void: start over rather than max against them.
      if (id && before.id && before.id !== id) {
        data.looked[session] = mark({ n, size, open, failed, attempts, id, at: now() })
        save()
        return
      }
      const nextSize = Math.max(size ?? 0, before.size)
      // Growth is a different input, and new material has not failed anywhere yet.
      const kept = nextSize > before.size ? 0 : (before.attempts ?? 0)
      data.looked[session] = mark({
        n: Math.max(n ?? 0, before.n),
        size: nextSize,
        open: open === undefined ? Boolean(before.open) : Boolean(open),
        failed: failed === undefined ? Boolean(before.failed) : Boolean(failed),
        attempts: attempts === undefined ? kept : attempts,
        id: id ?? before.id ?? null,
        at: now(),
      })
      save()
    },

    /**
     * Forget how far a session's log had been read, because it is not the same log any more.
     * The merge does the rest: a mark that does not describe the file on disk does not come
     * back from another writer's copy.
     */
    forget(session) {
      delete data.looked[session]
      save()
    },

    /**
     * Sessions seen in this workspace. Freshness is measured against this rather than the
     * clock: at one session a day, a wall-clock decay would bury everything.
     *
     * Counted once per session, not once per execution. OpenCode emits an execution per
     * prompt, and a session left open and prompted again is the same session: counting turns
     * would age a lesson by a half-life while the person is still working in the one place it
     * came from. Without an id it simply counts, which is what the old callers did.
     */
    get sessions() {
      refresh()
      return data.sessions
    },
    countSession(session) {
      refresh()
      if (session) {
        if (data.counted[session] || data.uncounted.includes(session)) return data.sessions
        data.counted[session] = true
      } else {
        data.anonymous = (data.anonymous ?? 0) + 1
      }
      data.sessions = (data.anonymous ?? 0) + Object.keys(data.counted).length
      save()
      return data.sessions
    },

    /**
     * Take a session back out of the counter, because it turned out to be a delegation.
     *
     * A child's end can be processed before the parent link is known, and that counts it.
     * "A delegation is a step, not a session" has to survive finding out afterwards, or
     * freshness is moved by work that will never be analysed on its own. The id is kept in
     * `uncounted` so a writer that still has the old count cannot put it back.
     */
    uncountSession(session) {
      refresh()
      let changed = false
      if (!data.uncounted.includes(session)) {
        data.uncounted.push(session)
        changed = true
      }
      if (data.counted[session]) {
        delete data.counted[session]
        changed = true
      }
      const sessions = (data.anonymous ?? 0) + Object.keys(data.counted).length
      if (sessions !== data.sessions) {
        data.sessions = sessions
        changed = true
      }
      if (changed) save()
      return data.sessions
    },

    /**
     * Drop bookkeeping about sessions nothing can refer to any more — their log is gone.
     * Applied after the merge, on the merged result, so a writer that loaded earlier cannot
     * bring a dropped entry back. `counted` is left alone on purpose: a session left open can
     * be prompted again months later, and folding its identity away would count it twice.
     */
    compact(referable) {
      compactWith = referable
      try {
        save()
      } finally {
        compactWith = null
      }
    },

    /**
     * A work order issued for this session (analysis.md): the log's identity and the size it
     * was read at, the last step in it (`lastN`), the mark it was read from (`n`), and how many
     * times this log has been asked about (`asked`). One per session; a newer order replaces
     * an older one.
     */
    issue(session, order) {
      refresh()
      const before = Number(data.orders[session]?.at ?? 0)
      data.orders[session] = { ...order, at: Math.max(now(), before + 1) }
      save()
    },
    /** The order still waiting for an answer, if there is one. */
    orderOf(session) {
      refresh()
      const o = data.orders[session]
      return o && !o.done ? { ...o } : null
    },
    /**
     * An order settled as unanswered and not replaced since: the one case where an answer
     * that arrives after the round was closed is still worth having, because the reading did
     * happen and only the reporting was late.
     */
    unansweredOrder(session) {
      refresh()
      const o = data.orders[session]
      return o && o.done === "unanswered" ? { ...o } : null
    },
    /**
     * The last order issued for this log, answered or not: how many times it has been asked
     * about and the size it was asked about at. Kept on the order, which survives being
     * closed, so it is still there when the next one is issued — the mark cannot carry it,
     * because an unanswered order deliberately leaves the mark alone (analysis.md).
     */
    askedFor(session) {
      refresh()
      const o = data.orders[session]
      return { asked: Number(o?.asked ?? 0), size: Number(o?.size ?? 0), done: o?.done ?? null }
    },
    /** Every order still waiting for an answer, by session. */
    openOrders() {
      refresh()
      return Object.entries(data.orders)
        .filter(([, o]) => o && !o.done)
        .map(([session, o]) => ({ session, ...o }))
    },
    /** Closed — answered, or given up on — so it is not answered or failed twice. */
    close(session, outcome) {
      refresh()
      const o = data.orders[session]
      if (!o) return
      data.orders[session] = { ...o, done: outcome ?? true, at: Math.max(now(), Number(o.at ?? 0) + 1) }
      save()
    },

    markExtracted(session, summary) {
      // Strictly after whatever outcome is already known for the session, mine or another
      // writer's: two outcomes in one millisecond are still ordered, the one recorded now being
      // the later, and the merge keeps the later one. An equal stamp kept the copy on disk, so
      // the outcome recorded second was lost when both landed in the same millisecond.
      refresh()
      const before = Date.parse(data.extracted[session]?.at ?? "")
      const t = Math.max(now(), Number.isFinite(before) ? before + 1 : 0)
      data.extracted[session] = { at: new Date(t).toISOString(), ...summary }
      save()
    },
  }
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * state.json — the small things that must outlive a process: which lessons the user
 * rejected (so the extractor is told not to propose them again, decision 9) and which
 * sessions have already been extracted (so a restart does not pay twice).
 */
/** The on-disk shape of a mark, in one place: flags only when true. */
const mark = (n, size, open, failed, id = null, at = null) => ({
  n,
  size,
  ...(open ? { open: true } : {}),
  ...(failed ? { failed: true } : {}),
  ...(id ? { id } : {}),
  ...(at ? { at } : {}),
})

export function createState({ path, onError, now = () => Date.now() }) {
  let data = {
    version: 1,
    rejected: [],
    extracted: {},
    pending: [],
    sessions: 0,
    looked: {},
    counted: {},
    anonymous: 0,
    uncounted: [],
    unqueued: [],
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed && typeof parsed === "object") {
      data = { ...data, ...parsed }
      if (!Array.isArray(data.rejected)) data.rejected = []
      if (!Array.isArray(data.pending)) data.pending = []
      if (!data.extracted || typeof data.extracted !== "object") data.extracted = {}
      if (typeof data.sessions !== "number") data.sessions = 0
      if (!data.looked || typeof data.looked !== "object") data.looked = {}
      if (!data.counted || typeof data.counted !== "object") data.counted = {}
      if (!Array.isArray(data.uncounted)) data.uncounted = []
      if (!Array.isArray(data.unqueued)) data.unqueued = []
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

  /**
   * Sessions whose log was replaced rather than appended to — pruned, then written again
   * under the same id. The merge below is append-only and would resurrect the mark that
   * described the old file, so a rebase has to be stated explicitly for one save.
   */
  let rebased = new Set()
  /** A predicate for one save: keep only the sessions it says can still be referred to. */
  let compactWith = null

  /**
   * Written by merging with whatever is on disk, not by overwriting it.
   *
   * The file is read once at load and used from memory, so a second writer — another plugin
   * instance on this project, or anything editing it between a load and a save — used to be
   * silently clobbered. Measured here: a rejection recorded out of band disappeared when a
   * long-running instance saved its own older copy, and a rejection is the one thing that
   * must outlive the lesson it belongs to (decision 9).
   *
   * Only the append-only parts are merged, because only they have a safe answer: rejections,
   * extractions and counted sessions are unions, each `looked` mark takes the newer view.
   * The queue is a union as well, with deliberate removals carried as persisted tombstones —
   * a writer's older copy must not be able to bring back a child it never learned about.
   *
   * A rebase is the exception to the maxima: when the log a mark described is gone, the
   * writer knows something the disk does not, and resurrecting the old number would make the
   * new, shorter log invisible for good.
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

      if (disk) {
        const rejected = [...(Array.isArray(disk.rejected) ? disk.rejected : [])]
        for (const r of data.rejected) if (!rejected.some((o) => o?.id === r.id)) rejected.push(r)
        data.rejected = rejected

        const ownExtracted = data.extracted ?? {}
        data.extracted = { ...(disk.extracted ?? {}), ...ownExtracted }

        /**
         * Counted sessions are identities, and the number is derived from them.
         *
         * The old merge took the maximum of two counters, which is only right when both
         * writers counted the same sessions. Two instances that each counted a different
         * session each moved their own counter by one, the maximum kept one, and the
         * workspace aged by one session less than it had lived — exactly the direction that
         * makes everything look fresher than it is. Distinct ids are merged, then the
         * anonymous calls (which have no id to merge by) take the maximum.
         */
        const ownCounted = data.counted ?? {}
        const uncounted = [
          ...new Set([
            ...(Array.isArray(disk.uncounted) ? disk.uncounted : []),
            ...(Array.isArray(data.uncounted) ? data.uncounted : []),
          ]),
        ]
        const counted = { ...(disk.counted ?? {}), ...ownCounted }
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

        // Both marks are maxima, and both shapes exist: a state.json written before the
        // step offset has a bare byte count here. `open` is different: it records that the
        // last successful read stopped before the end of the log, and it must survive so the
        // next command reads the elided middle rather than treating the bytes sent as steps
        // covered. The newer mark decides; at the same step the writer's own view does.
        const asMark = (v) => ({
          present: v !== undefined,
          n: typeof v === "number" ? 0 : (v?.n ?? 0),
          size: typeof v === "number" ? v : (v?.size ?? 0),
          open: typeof v === "number" ? false : Boolean(v?.open),
          failed: typeof v === "number" ? false : Boolean(v?.failed),
          id: typeof v === "number" ? null : (v?.id ?? null),
          at: typeof v === "number" ? 0 : (v?.at ?? 0),
        })
        const ownLooked = data.looked ?? {}
        const looked = {}
        for (const id of new Set([...Object.keys(disk.looked ?? {}), ...Object.keys(ownLooked)])) {
          if (rebased.has(id)) {
            // The disk mark describes a file that was replaced. Only a mark this writer made
            // after the rebase may be used; the old number must not come back.
            if (!(id in ownLooked)) continue
            const own = asMark(ownLooked[id])
            looked[id] = mark(own.n, own.size, own.open, own.failed, own.id, own.at)
            continue
          }
          const a = asMark(disk.looked?.[id])
          const b = asMark(ownLooked[id])
          // Two marks with different identities describe two different files, and numbers
          // about one say nothing about the other. The writer who has seen the file wins;
          // this is what stops a writer that never saw a replacement resurrecting the old
          // mark by maxing against it.
          if (a.id && b.id && a.id !== b.id) {
            // Neither side can see the file from here, so the later mark wins: a stale
            // writer's memory is older than what the writer that saw the replacement wrote.
            const later = b.at >= a.at ? b : a
            looked[id] = mark(later.n, later.size, later.open, later.failed, later.id, later.at)
            continue
          }
          const n = Math.max(a.n, b.n)
          const size = Math.max(a.size, b.size)
          // Both flags follow the writer whose mark is at least as far along, and they are
          // rebuilt here rather than carried: a flag assembled in `look()` and forgotten in
          // this merge is invisible until something downstream quietly stops happening.
          const newer = b.present && b.n >= a.n ? b : a
          looked[id] = mark(n, size, newer.open, newer.failed, b.id ?? a.id, Math.max(a.at, b.at) || null)
        }
        // The extraction describes the file that was replaced, so its byte size no longer
        // covers anything: a new log may be smaller than the old one and still be new work.
        // A writer that has extracted again since the rebase has a newer fact of its own.
        for (const id of rebased) {
          if (!(id in ownExtracted) && data.extracted[id]) data.extracted[id] = { ...data.extracted[id], size: 0 }
        }
        data.looked = looked

        // An entry queued before an extraction is done once that extraction has covered it;
        // an entry queued for material the extraction never read is new work and must
        // survive. Compare against the size the extraction itself covered, not the current
        // mark: a later attempt that failed advances the mark without covering anything, and
        // using it here would silently drop the retry.
        const coveredSizeOf = (session) => {
          const ex = data.extracted[session]
          if (typeof ex?.size === "number") return ex.size
          return asMark(looked[session]).size
        }
        // The queue is a union too, not the writer's own. Two instances on one project used
        // to lose each other's entries, which means a session nobody analyses: the log sits
        // there, and nothing is owed for it. Entries leave through an extraction, which the
        // coverage filter expresses, or through a deliberate removal, which the persisted
        // `unqueued` list expresses. For a session both writers hold, the higher attempt count
        // wins — otherwise a retry budget resets — and the smaller queued size, so the
        // coverage comparison stays conservative.
        const ownUnqueued = Array.isArray(data.unqueued) ? data.unqueued : []
        const unqueued = [
          ...new Set([...(Array.isArray(disk.unqueued) ? disk.unqueued : []), ...ownUnqueued]),
        ]
        data.unqueued = unqueued
        const excluded = new Set(unqueued)
        const queued = new Map()
        for (const entry of [...(Array.isArray(disk.pending) ? disk.pending : []), ...data.pending]) {
          if (!entry?.session) continue
          const held = queued.get(entry.session)
          queued.set(
            entry.session,
            held
              ? {
                  ...held,
                  attempts: Math.max(held.attempts ?? 0, entry.attempts ?? 0),
                  size: Math.min(held.size ?? 0, entry.size ?? 0),
                }
              : { ...entry },
          )
        }
        data.pending = [...queued.values()]
          .filter((p) => !excluded.has(p.session))
          .filter((p) => !data.extracted[p.session] || (p.size ?? 0) > coveredSizeOf(p.session))
      }

      // The tombstone has to hold even when there is no file to merge with yet.
      const excluded = new Set(Array.isArray(data.unqueued) ? data.unqueued : [])
      if (excluded.size) data.pending = data.pending.filter((p) => !excluded.has(p.session))

      if (compactWith) {
        data.unqueued = (data.unqueued ?? []).filter(compactWith)
        data.uncounted = (data.uncounted ?? []).filter(compactWith)
        for (const key of ["looked", "extracted"]) {
          for (const id of Object.keys(data[key] ?? {})) if (!compactWith(id)) delete data[key][id]
        }
      }

      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(data, null, 2) + "\n")
      rebased = new Set()
    } catch (err) {
      onError?.("state.save", err)
    }
  }

  return {
    get rejected() {
      return [...data.rejected]
    },
    reject(id, reason) {
      if (!data.rejected.some((r) => r.id === id)) {
        data.rejected.push({ id, reason: reason ?? null, at: new Date().toISOString() })
        save()
      }
    },
    wasExtracted: (session) => Boolean(data.extracted[session]),
    /** What the last analysis of this session concluded, if any — including that it failed. */
    extractionOf: (session) => data.extracted[session] ?? null,
    isPending: (session) => data.pending.some((p) => p.session === session),

    /**
     * How much of a session's log has already been dealt with. Two numbers and a flag,
     * because they answer three questions and move at different times.
     *
     * `n` is the last step that has actually been turned into lessons, so the next analysis
     * starts after it. This matters most for the way sessions are really used: they are left
     * open and come back to, so a log is never "finished" and `/retro` a fortnight later
     * would otherwise re-read all of it, pay for all of it, and re-derive the lessons that
     * were already integrated. It only moves when an analysis succeeded.
     *
     * `size` is the largest log already sent, success or not — the bytes actually read, not
     * the file's length at some later moment. A log no bigger than that has nothing new in
     * it, so nothing is spent on asking again — which also means a session abandoned by a
     * server that stopped is read once and then left alone for good.
     *
     * `open` is the exception to that last sentence: a successful read that had to excerpt
     * the log covered only its unbroken prefix, so there is still material behind the gap.
     * The bytes were sent, but the steps were not covered, and the log has to be read again
     * without waiting for it to grow. It is cleared when a later read reaches the end.
     */
    looked(session) {
      const mark = data.looked[session]
      // Was a bare byte count before the offset existed; an old state.json still has one.
      // Flags appear only when true, which is the shape callers compare against — and a
      // falsy `undefined` reads the same to every `!mark.open` in the plugin.
      if (typeof mark === "number") return { n: 0, size: mark }
      return {
        n: mark?.n ?? 0,
        size: mark?.size ?? 0,
        ...(mark?.open ? { open: true } : {}),
        ...(mark?.failed ? { failed: true } : {}),
        ...(mark?.id ? { id: mark.id } : {}),
      }
    },
    /**
     * `open` and `failed` are both "still owed", and they are not the same debt. An excerpt
     * that covered a prefix is owed *now*, so the live pass reads on without waiting for the
     * session to grow. A read that failed is owed *later*: re-reading the same bytes would
     * fail the same way, so it waits for growth while the session is live, and the moment it
     * is not, the queue picks it up and the attempt budget applies. With only one flag, a
     * failed read of a live session either looped on every command or — once its size was
     * recorded and the plugin restarted before the session's end event — was skipped for
     * good.
     */
    look(session, { n, size, open, failed, id }) {
      const before = this.looked(session)
      // A mark is about one file. Told which file this is and finding it is not the one the
      // mark described, the old numbers are void: start over rather than max against them.
      if (id && before.id && before.id !== id) {
        data.looked[session] = mark(n ?? 0, size ?? 0, Boolean(open), Boolean(failed), id, now())
        save()
        return
      }
      // A rebase is deliberately *not* deleted here. Until a save has carried the rebase to
      // the file, the old mark is still on disk; letting this fresh (necessarily smaller)
      // mark be maxed against it would resurrect the number that described the replaced log.
      const nextOpen = open === undefined ? Boolean(before.open) : Boolean(open)
      const nextFailed = failed === undefined ? Boolean(before.failed) : Boolean(failed)
      data.looked[session] = mark(
        Math.max(n ?? 0, before.n),
        Math.max(size ?? 0, before.size),
        nextOpen,
        nextFailed,
        id ?? before.id ?? null,
        now(),
      )
      save()
    },

    /**
     * Forget how far a session's log had been read, because it is not the same log any more.
     *
     * A pruned log that the session later writes again starts at step 1 and is shorter than
     * the mark, and a size that only ever moves forward would then say "nothing new here"
     * about a file that has plenty. The extraction recorded against the old file goes with
     * it: its byte size says nothing about the new one. The writer knows the file was
     * replaced; the merge must not resurrect either number.
     */
    rebase(session) {
      rebased.add(session)
      delete data.looked[session]
      if (data.extracted[session]) data.extracted[session] = { ...data.extracted[session], size: 0 }
      save()
    },

    /**
     * Extraction cannot run where it is triggered: `generate.text` hangs when called from
     * the event stream, and only returns from inside a hook callback (AGENTS.md
     * "Gotchas"). So a finished session is queued here and drained from the next prompt.
     */
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
      return data.sessions
    },
    countSession(session) {
      if (session) {
        if (data.counted[session]) return data.sessions
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
     * Owe this session an analysis.
     *
     * `size` is how large its log was at the moment it was queued. It is what tells an entry
     * that predates an extraction (done, drop it) from one queued because the session has
     * written more since it was settled (new work, keep it). A caller that has no log — a
     * test, or a hand-written state file — gets the conservative answer: an entry for an
     * already-extracted session stays only if there is no extraction to cover it.
     */
    /**
     * A session that turned out to be somebody's child. Its end may have been processed
     * before the link was known — `session.created` can be missed when the plugin loads
     * lazily, leaving the parent's `subagent` result as the only route — and a delegation is
     * a step, not a session to analyse.
     */
    /**
     * Drop bookkeeping about sessions nothing can refer to any more — no log, not queued,
     * not live. The tombstones and the per-session marks would otherwise grow for the life of
     * the project. It is applied *after* the merge, on the merged result, so a writer that
     * loaded earlier cannot bring a dropped entry back and an entry another writer added for
     * a session that still exists is not lost. `counted` is left alone on purpose: a session
     * left open can be prompted again months later, and folding its identity away would
     * count it twice.
     */
    compact(referable) {
      compactWith = referable
      try {
        save()
      } finally {
        compactWith = null
      }
    },
    unqueue(session) {
      let changed = false
      if (!data.unqueued.includes(session)) {
        data.unqueued.push(session)
        changed = true
      }
      const before = data.pending.length
      data.pending = data.pending.filter((p) => p.session !== session)
      if (data.pending.length !== before) changed = true
      // Saved even when our copy had nothing to remove: the entry may exist only on disk,
      // and a tombstone that never reaches the file is no tombstone at all.
      if (changed) save()
    },
    queue(session, size = 0) {
      let changed = false
      const at = data.unqueued.indexOf(session)
      if (at >= 0) {
        data.unqueued.splice(at, 1) // queued again on purpose, so the tombstone no longer applies
        changed = true
      }
      if (!data.pending.some((p) => p.session === session)) {
        data.pending.push({ session, queuedAt: new Date().toISOString(), attempts: 0, size })
        changed = true
      }
      if (changed) save()
    },
    get pending() {
      return data.pending.map((p) => ({ ...p }))
    },
    /**
     * The oldest owed session that is not the one currently running.
     *
     * `skip` is for one run: a log that has just failed must not be picked again in the
     * same command, or one broken log is retried until it hits the attempt cap while the
     * logs behind it are never read.
     */
    nextPending(exclude, skip = []) {
      const skipped = skip instanceof Set ? skip : new Set(skip)
      return (
        data.pending.find(
          (p) => p.session !== exclude && !skipped.has(p.session) && p.attempts < 3,
        ) ?? null
      )
    },
    attempt(session) {
      const entry = data.pending.find((p) => p.session === session)
      if (entry) {
        entry.attempts++
        save()
      }
    },
    markExtracted(session, summary) {
      data.extracted[session] = { at: new Date().toISOString(), ...summary }
      data.pending = data.pending.filter((p) => p.session !== session)
      // The step mark survives: a settled session that is picked up again writes more, and
      // the next read has to start after the steps already turned into lessons rather than
      // pay for all of them a second time. Deleting it here used to be undone by the merge
      // in `save` anyway, so the mark outlived every settle; now it does so on purpose.
      save()
    },
  }
}

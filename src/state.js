import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * state.json — the small things that must outlive a process: which lessons the user
 * rejected (so the extractor is told not to propose them again, decision 9) and which
 * sessions have already been extracted (so a restart does not pay twice).
 */
export function createState({ path, onError }) {
  let data = { version: 1, rejected: [], extracted: {}, pending: [], sessions: 0, looked: {}, counted: {} }

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
   * extractions and counted sessions are unions, the session counter and each `looked` size
   * are maxima. The queue is not append-only, so the writer's own view of it wins — minus
   * anything the disk says has since been extracted, which is the one way another writer
   * removes an entry.
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

        data.extracted = { ...(disk.extracted ?? {}), ...data.extracted }
        data.sessions = Math.max(data.sessions ?? 0, typeof disk.sessions === "number" ? disk.sessions : 0)
        data.counted = { ...(disk.counted ?? {}), ...data.counted }

        // Both marks are maxima, and both shapes exist: a state.json written before the
        // step offset has a bare byte count here.
        const asMark = (v) => (typeof v === "number" ? { n: 0, size: v } : { n: v?.n ?? 0, size: v?.size ?? 0 })
        const looked = {}
        for (const id of new Set([...Object.keys(disk.looked ?? {}), ...Object.keys(data.looked ?? {})])) {
          const a = asMark(disk.looked?.[id])
          const b = asMark(data.looked?.[id])
          looked[id] = { n: Math.max(a.n, b.n), size: Math.max(a.size, b.size) }
        }
        // The extraction describes the file that was replaced, so its byte size no longer
        // covers anything: a new log may be smaller than the old one and still be new work.
        for (const id of rebased) {
          delete looked[id]
          if (data.extracted[id]) data.extracted[id] = { ...data.extracted[id], size: 0 }
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
        data.pending = data.pending.filter((p) => !data.extracted[p.session] || (p.size ?? 0) > coveredSizeOf(p.session))
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
    isPending: (session) => data.pending.some((p) => p.session === session),

    /**
     * How much of a session's log has already been dealt with. Two numbers, because they
     * answer two questions and move at different times.
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
     */
    looked(session) {
      const mark = data.looked[session]
      // Was a bare byte count before the offset existed; an old state.json still has one.
      if (typeof mark === "number") return { n: 0, size: mark }
      return { n: mark?.n ?? 0, size: mark?.size ?? 0 }
    },
    look(session, { n, size }) {
      const before = this.looked(session)
      rebased.delete(session) // a fresh mark supersedes any rebase still waiting to be saved
      data.looked[session] = {
        n: Math.max(n ?? 0, before.n),
        size: Math.max(size ?? 0, before.size),
      }
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
      if (session && data.counted[session]) return data.sessions
      if (session) data.counted[session] = true
      data.sessions++
      save()
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
    queue(session, size = 0) {
      if (!data.pending.some((p) => p.session === session)) {
        data.pending.push({ session, queuedAt: new Date().toISOString(), attempts: 0, size })
        save()
      }
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

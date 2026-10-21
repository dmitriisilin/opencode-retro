import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * state.json — the small things that must outlive a process: which lessons the user
 * rejected (so the extractor is told not to propose them again, decision 9) and which
 * sessions have already been extracted (so a restart does not pay twice).
 */
export function createState({ path, onError }) {
  let data = { version: 1, rejected: [], extracted: {}, pending: [], sessions: 0, looked: {} }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed && typeof parsed === "object") {
      data = { ...data, ...parsed }
      if (!Array.isArray(data.rejected)) data.rejected = []
      if (!Array.isArray(data.pending)) data.pending = []
      if (!data.extracted || typeof data.extracted !== "object") data.extracted = {}
      if (typeof data.sessions !== "number") data.sessions = 0
      if (!data.looked || typeof data.looked !== "object") data.looked = {}
    }
  } catch {
    /* absent or hand-broken: start clean rather than refuse to run */
  }

  /**
   * Written by merging with whatever is on disk, not by overwriting it.
   *
   * The file is read once at load and used from memory, so a second writer — another plugin
   * instance on this project, or anything editing it between a load and a save — used to be
   * silently clobbered. Measured here: a rejection recorded out of band disappeared when a
   * long-running instance saved its own older copy, and a rejection is the one thing that
   * must outlive the lesson it belongs to (decision 9).
   *
   * Only the append-only parts are merged, because only they have a safe answer: rejections
   * and extractions are unions, the session counter and each `looked` size are maxima. The
   * queue is not append-only, so the writer's own view of it wins — minus anything the disk
   * says has since been extracted, which is the one way another writer removes an entry.
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

        // Both marks are maxima, and both shapes exist: a state.json written before the
        // step offset has a bare byte count here.
        const asMark = (v) => (typeof v === "number" ? { n: 0, size: v } : { n: v?.n ?? 0, size: v?.size ?? 0 })
        const looked = {}
        for (const id of new Set([...Object.keys(disk.looked ?? {}), ...Object.keys(data.looked ?? {})])) {
          const a = asMark(disk.looked?.[id])
          const b = asMark(data.looked?.[id])
          looked[id] = { n: Math.max(a.n, b.n), size: Math.max(a.size, b.size) }
        }
        data.looked = looked

        data.pending = data.pending.filter((p) => !data.extracted[p.session])
      }

      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(data, null, 2) + "\n")
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
     * `size` is the largest log already sent, success or not. A log no bigger than that has
     * nothing new in it, so nothing is spent on asking again — which also means a session
     * abandoned by a server that stopped is read once and then left alone for good.
     */
    looked(session) {
      const mark = data.looked[session]
      // Was a bare byte count before the offset existed; an old state.json still has one.
      if (typeof mark === "number") return { n: 0, size: mark }
      return { n: mark?.n ?? 0, size: mark?.size ?? 0 }
    },
    look(session, { n, size }) {
      const before = this.looked(session)
      data.looked[session] = {
        n: Math.max(n ?? 0, before.n),
        size: Math.max(size ?? 0, before.size),
      }
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
     */
    get sessions() {
      return data.sessions
    },
    countSession() {
      data.sessions++
      save()
      return data.sessions
    },

    queue(session) {
      if (!data.extracted[session] && !data.pending.some((p) => p.session === session)) {
        data.pending.push({ session, queuedAt: new Date().toISOString(), attempts: 0 })
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
      delete data.looked[session]
      save()
    },
  }
}

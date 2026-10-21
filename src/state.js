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

  const save = () => {
    try {
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
     * How large a log was the last time it was read.
     *
     * A session still running cannot be settled — it will have more to say — so its log is
     * read without being marked extracted, and `/retro` would otherwise pay to re-read the
     * same bytes every time it is run. Size, not a clock: a log that has not grown has
     * nothing new in it, which also means a session abandoned by a crashed server is read
     * once and then left alone for good.
     */
    looked: (session) => data.looked[session] ?? 0,
    look(session, size) {
      data.looked[session] = size
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

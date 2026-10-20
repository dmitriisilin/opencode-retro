import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js"
import { slug } from "./contract.js"

/**
 * The lesson store (AGENTS.md decisions 6, 8).
 *
 * One Markdown file per lesson, frontmatter in the format documented in README, because
 * users open and edit these. Score is cost x recurrence x confidence; recurrence is what
 * matters most — a lesson seen in three sessions will be seen in a fourth.
 */

export const DEFAULT_CAP = 30
export const DEFAULT_HALF_LIFE = 10

/**
 * cost x recurrence x confidence x freshness.
 *
 * Freshness is measured in sessions since the problem last showed up, not in days: at one
 * session a day a wall-clock decay buries everything. Without `sessions` it is 1, so the
 * raw score stays available for comparison and for tests.
 */
export function score(lesson, { sessions = null, halfLife = DEFAULT_HALF_LIFE } = {}) {
  const raw = (lesson.cost ?? 0) * (lesson.recurrence ?? 1) * (lesson.confidence ?? 0)
  return raw * freshness(lesson, { sessions, halfLife })
}

export function freshness(lesson, { sessions = null, halfLife = DEFAULT_HALF_LIFE } = {}) {
  if (sessions == null || lesson.lastSeen == null || halfLife <= 0) return 1
  const stale = Math.max(0, sessions - lesson.lastSeen)
  return 0.5 ** (stale / halfLife)
}

export const staleSessions = (lesson, sessions) =>
  sessions == null || lesson.lastSeen == null ? null : Math.max(0, sessions - lesson.lastSeen)

export function createStore({ dir, archive, cap = DEFAULT_CAP, halfLife = DEFAULT_HALF_LIFE, sessions = () => null, onError }) {
  const ranked = (lessons) => lessons.sort((a, b) => score(b, ctxFor()) - score(a, ctxFor()))
  const ctxFor = () => ({ sessions: sessions(), halfLife })
  const ensure = (path) => {
    try {
      mkdirSync(path, { recursive: true })
      return true
    } catch (err) {
      onError?.("lessons.mkdir", err)
      return false
    }
  }

  function list() {
    let names = []
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".md"))
    } catch {
      return [] // no directory yet is the normal first-run state
    }
    const lessons = []
    for (const name of names) {
      try {
        const { data, body } = parseFrontmatter(readFileSync(join(dir, name), "utf8"))
        if (data?.id) lessons.push({ ...data, body, file: name })
      } catch (err) {
        onError?.(`lessons.read ${name}`, err)
      }
    }
    return ranked(lessons)
  }

  /** Closed lessons live here. Consulted on recurrence, so a problem that comes back says so. */
  function listArchive() {
    let names = []
    try {
      names = readdirSync(archive).filter((n) => n.endsWith(".md"))
    } catch {
      return []
    }
    const lessons = []
    for (const name of names) {
      try {
        const { data, body } = parseFrontmatter(readFileSync(join(archive, name), "utf8"))
        if (data?.id) lessons.push({ ...data, body, file: name })
      } catch (err) {
        onError?.(`lessons.archive.read ${name}`, err)
      }
    }
    return lessons
  }

  function write(lesson) {
    if (!ensure(dir)) return false
    const { body, file, ...data } = lesson
    try {
      writeFileSync(join(dir, file ?? `${data.id}.md`), stringifyFrontmatter(data, body ?? ""))
      return true
    } catch (err) {
      onError?.("lessons.write", err)
      return false
    }
  }

  return {
    list,
    listArchive,
    write,
    score: (lesson) => score(lesson, ctxFor()),
    freshness: (lesson) => freshness(lesson, ctxFor()),
    staleSessions: (lesson) => staleSessions(lesson, sessions()),

    /** Closing a lesson moves it out of the open set; nothing is ever deleted. */
    /**
     * `outcome` is what the work produced, which is not what the lesson said and not what
     * the proposal suggested: the files actually touched and anything discovered while
     * doing it. It only exists because the review happened, so it is recorded here or
     * nowhere.
     */
    close(id, status, outcome = {}) {
      const lesson = list().find((l) => l.id === id)
      if (!lesson) return null
      const { note, changed, discovered } = typeof outcome === "string" ? { note: outcome } : outcome
      const closed = {
        ...lesson,
        status,
        note: note ?? lesson.note,
        ...(changed?.length ? { changed } : {}),
        ...(discovered ? { discovered } : {}),
        closedAt: new Date().toISOString(),
      }
      if (!ensure(archive)) return null
      const { body, file, ...data } = closed
      try {
        writeFileSync(join(archive, file ?? `${data.id}.md`), stringifyFrontmatter(data, body ?? ""))
        rmSync(join(dir, file ?? `${data.id}.md`))
        return closed
      } catch (err) {
        onError?.(`lessons.close ${id}`, err)
        return null
      }
    },

    /**
     * Folds one extraction into the store. A lesson the extractor says `matches` an
     * existing id — or that lands on the same id — increments recurrence instead of
     * creating a near-duplicate.
     */
    record(extracted, { session, fingerprint = null }) {
      const existing = list()
      const byId = new Map(existing.map((l) => [l.id, l]))
      const archived = new Map(listArchive().map((l) => [l.id, l]))
      const seen = sessions()
      const result = { created: [], merged: [], reopened: [] }

      // Ids minted in this batch are taken, not merge targets: two lessons that collide
      // on a slug are two problems, and merging them would drop one statement. An explicit
      // `matches` still merges, because then the extractor meant it.
      const mintedNow = new Set()

      for (const lesson of extracted) {
        const explicit = lesson.matches ? byId.get(lesson.matches) : null
        const sameId = mintedNow.has(lesson.id) ? null : byId.get(lesson.id)

        // A problem that comes back after being closed is not a new problem — it is the
        // same one, plus the news that closing it did not work.
        const buried = !explicit && !sameId ? (archived.get(lesson.matches) ?? archived.get(lesson.id)) : null
        if (buried) {
          const reopened = {
            ...buried,
            evidence: [...asArray(buried.evidence), { session, steps: lesson.steps }],
            cost: (buried.cost ?? 0) + lesson.cost,
            recurrence: (buried.recurrence ?? 1) + 1,
            confidence: Math.max(buried.confidence ?? 0, lesson.confidence),
            status: "new",
            reopenedFrom: buried.status ?? "closed",
            closedAt: undefined,
            lastSeen: seen,
            targetFingerprint: fingerprint?.(buried.proposal?.target) ?? buried.targetFingerprint,
          }
          if (write(reopened)) {
            result.reopened.push(reopened.id)
            try {
              rmSync(join(archive, buried.file ?? `${buried.id}.md`))
            } catch (err) {
              onError?.(`lessons.reopen ${buried.id}`, err)
            }
          }
          byId.set(reopened.id, reopened)
          mintedNow.add(reopened.id)
          continue
        }

        const target = explicit ?? sameId
        if (target) {
          const evidence = [...(asArray(target.evidence) ?? [])]
          const already = evidence.some((e) => e?.session === session)
          if (!already) evidence.push({ session, steps: lesson.steps })

          const updated = {
            ...target,
            statement: target.statement ?? lesson.statement,
            evidence,
            cost: (target.cost ?? 0) + (already ? 0 : lesson.cost),
            recurrence: already ? (target.recurrence ?? 1) : (target.recurrence ?? 1) + 1,
            confidence: Math.max(target.confidence ?? 0, lesson.confidence),
            // A lesson the user already ruled on keeps that ruling; recurrence is the
            // argument for revisiting it, not grounds for silently reopening it.
            status: target.status ?? "new",
            proposal: target.proposal ?? lesson.proposal ?? undefined,
            lastSeen: already ? (target.lastSeen ?? seen) : seen,
            targetFingerprint:
              target.targetFingerprint ?? fingerprint?.(target.proposal?.target ?? lesson.proposal?.target) ?? undefined,
          }
          if (write(updated)) result.merged.push(updated.id)
          byId.set(updated.id, updated)
          continue
        }

        const created = {
          id: uniqueId(lesson.id, byId),
          statement: lesson.statement,
          evidence: [{ session, steps: lesson.steps }],
          cost: lesson.cost,
          recurrence: 1,
          confidence: lesson.confidence,
          proposal: lesson.proposal ?? undefined,
          ask: lesson.ask ?? undefined,
          status: "new",
          lastSeen: seen,
          recordedAt: new Date().toISOString(),
          targetFingerprint: fingerprint?.(lesson.proposal?.target) ?? undefined,
          body: lesson.why ?? "",
        }
        if (write(created)) result.created.push(created.id)
        byId.set(created.id, created)
        mintedNow.add(created.id)
      }

      result.archived = enforceCap()
      return result
    },

    /** Lowest-scoring lessons above the cap are archived, never deleted (decision 8). */
    enforceCap,
  }

  function enforceCap() {
    const all = list()
    if (all.length <= cap) return []
    if (!ensure(archive)) return []
    const archived = []
    for (const lesson of all.slice(cap)) {
      if (lesson.status === "later") continue // the user asked to come back to it
      try {
        renameSync(join(dir, lesson.file), join(archive, lesson.file))
        archived.push(lesson.id)
      } catch (err) {
        onError?.(`lessons.archive ${lesson.file}`, err)
      }
    }
    return archived
  }
}

function uniqueId(base, taken) {
  const id = slug(base)
  if (!taken.has(id)) return id
  for (let i = 2; i < 100; i++) {
    const candidate = `${id}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${id}-${Date.now()}`
}

/** A hand-edited file can turn a one-item list into a bare map. */
const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : [])

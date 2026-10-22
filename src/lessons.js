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

/**
 * Archived lessons this session was already *decided* on.
 *
 * The archive also holds open questions the cap evicted, and those were never concluded;
 * feeding one back as "already concluded" would tell the extractor not to re-derive the very
 * thing a later read is supposed to restore.
 */
export function concludedIn(lessons, sessionID) {
  return lessons
    .filter((l) => (l.status ?? "closed") !== "new")
    .filter((l) => asArray(l.evidence).some((e) => e?.session === sessionID))
    .map((l) => ({ id: l.id, status: l.status ?? "closed", statement: l.statement ?? "" }))
}

/**
 * Evidence a lesson carried when it left the open set. While it was decided or evicted, no
 * open lesson cited those logs, so decision 18 let them go — and a lesson that comes back
 * would otherwise send the reviewer to read steps in a file that is not there, under a
 * prompt that promises the log is on disk. Marked, not dropped: it is still the history of
 * the problem, and the human may want to know where it was seen before.
 */
const released = (evidence, except = null) =>
  evidence.map((e) => (e?.session === except || e?.released ? e : { ...e, released: true }))

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
    /**
     * Evidence follows the records. A delegation's log is folded into its root's with new step
     * numbers, and a lesson extracted from that log before the link was known still cites the
     * old session and the old numbers — a dead reference, which is the one thing evidence must
     * never be (decision 18). Rewritten here, in `lessons/` and `archive/` alike: a range maps
     * end to end, and an entry already citing the root is widened rather than duplicated.
     */
    remapEvidence(from, to, renumbered) {
      const at = (n) => renumbered?.get?.(n) ?? n
      let moved = 0
      for (const [where, lessons] of [[dir, list()], [archive, listArchive()]]) {
        for (const lesson of lessons) {
          const evidence = asArray(lesson.evidence) ?? []
          if (!evidence.some((e) => e?.session === from)) continue
          const kept = evidence.filter((e) => e?.session !== from && e?.session !== to)
          const ranges = evidence
            .filter((e) => e?.session === from || e?.session === to)
            .map((e) => (e.session === from && Array.isArray(e.steps) && e.steps.length ? e.steps.map(at) : e.steps))
            .filter((r) => Array.isArray(r) && r.length)
          const steps = ranges.length ? [Math.min(...ranges.flat()), Math.max(...ranges.flat())] : []
          const folded = [...kept, { session: to, ...(steps.length ? { steps } : {}) }]
          // Recurrence counts independent sessions (decision 8), and a delegation is not one:
          // when the child's evidence lands on a root the lesson already cited, two sessions
          // become one and the count has to say so. Found by the model test — a child analysed
          // as a session before its parent was known lifted a lesson to two sessions for good.
          const distinct = (list) => new Set(list.map((e) => e?.session).filter(Boolean)).size
          const recurrence = Math.max(1, (lesson.recurrence ?? 1) - (distinct(evidence) - distinct(folded)))
          const { file, body, ...data } = { ...lesson, evidence: folded, recurrence }
          try {
            writeFileSync(join(where, file ?? `${data.id}.md`), stringifyFrontmatter(data, body ?? ""))
            moved++
          } catch (err) {
            onError?.(`lessons.remap ${lesson.id}`, err)
          }
        }
      }
      return moved
    },

    close(id, status, outcome = {}) {
      const lesson = list().find((l) => l.id === id)
      if (!lesson) return null
      // Spread, not re-listed field by field. `decide` assembles the outcome and this used to
      // pick three names back out of it, so a fourth was silently dropped on the way to the
      // archive — `decidedIn` was, and the test for it failed with `undefined` while nothing
      // else noticed. `status` and `closedAt` come after, because they are ours to set.
      const fields = typeof outcome === "string" ? { note: outcome } : (outcome ?? {})
      const closed = {
        ...lesson,
        ...fields,
        note: fields.note ?? lesson.note,
        status,
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
     * Bring a lesson the cap evicted back into `lessons/`, because it was never decided.
     *
     * The archive holds two different things: answers the user gave, and open questions the
     * cap pushed out for room. Only the first is a decision. This moves the second back so a
     * stale hand-over can still be decided, and `record()` uses the same distinction when a
     * problem recurs.
     */
    restore(id) {
      const lesson = listArchive().find((l) => l.id === id)
      if (!lesson) return null
      if (!ensure(dir)) return null
      const { body, file, ...data } = {
        ...lesson,
        evidence: released(asArray(lesson.evidence) ?? []),
        status: "new",
        closedAt: undefined,
      }
      try {
        const name = file ?? `${data.id}.md`
        writeFileSync(join(dir, name), stringifyFrontmatter(data, body ?? ""))
        rmSync(join(archive, name))
        // Keep the name: a hand-renamed lesson restored without it would be written under
        // its id on the next save, leaving two files with the same id in `lessons/`.
        return { ...data, body, file: name }
      } catch (err) {
        onError?.(`lessons.restore ${id}`, err)
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
      const result = { created: [], merged: [], reopened: [], restored: [] }

      // Ids minted in this batch are taken, not merge targets: two lessons that collide
      // on a slug are two problems, and merging them would drop one statement. An explicit
      // `matches` still merges, because then the extractor meant it.
      const mintedNow = new Set()

      for (const lesson of extracted) {
        const explicit = lesson.matches ? byId.get(lesson.matches) : null
        const sameId = mintedNow.has(lesson.id) ? null : byId.get(lesson.id)

        // An explicit `matches` is the extractor saying "this is that problem", and that must
        // hold when the problem is in the archive too. It used to be consulted only when the
        // new id did not collide with an open lesson, so an unrelated open lesson sharing the
        // slug swallowed a deliberate match to an archived one.
        const explicitArchived = lesson.matches ? archived.get(lesson.matches) : null

        // A problem that comes back after being closed is not a new problem — it is the
        // same one, plus the news that closing it did not work.
        const buried = explicit ? null : (explicitArchived ?? (sameId ? null : archived.get(lesson.id)))

        // A problem the user rejected does not come back, whatever the extractor thinks.
        // `state.rejected` is told to the extractor and filters its answer, but that list is
        // one file away from being lost — it was, here — and the archive is the record of the
        // decision itself. "Do not propose this again" has to survive both.
        if (buried?.status === "rejected") continue

        // A lesson archived by the cap was never decided: it is an open question that
        // happened to be the lowest scorer when room was needed. It must not be reported as
        // a closed problem — "the fix did not hold" would be false — and a re-read of the
        // session that produced it must restore it rather than being swallowed by the rule
        // below, which exists to stop decisions being reopened by old evidence.
        const evicted = buried != null && buried.status === "new"
        const evidence = asArray(buried?.evidence)
        const already = evidence.some((e) => e?.session === session)

        // A second look at the same session does not reopen a decision. Recurrence is defined
        // as the number of *independent* sessions a problem appeared in (decision 8), and a
        // log that is read again — because the session was left open and returned to — is
        // one session, not two. Without this, an accepted lesson comes back marked "the fix
        // did not hold" when all that held is the old evidence.
        if (buried && !evicted && already) continue

        if (buried) {
          const updatedEvidence = already
            ? released(evidence, session).map((e) =>
                e?.session === session
                  ? { ...e, steps: lesson.steps?.length ? lesson.steps : e.steps }
                  : e,
              )
            : [...released(evidence), { session, steps: lesson.steps }]
          const back = {
            ...buried,
            evidence: updatedEvidence,
            // A re-read of the same session is not a second occurrence. A cap-evicted lesson
            // seen in a new session is, and counts like any other recurrence.
            cost: (buried.cost ?? 0) + (already ? 0 : lesson.cost),
            recurrence: (buried.recurrence ?? 1) + (already ? 0 : 1),
            confidence: Math.max(buried.confidence ?? 0, lesson.confidence),
            status: "new",
            // An evicted lesson has no closing decision to report. If it was decided in the
            // past and later evicted for space, that real history is still worth keeping.
            reopenedFrom: evicted ? buried.reopenedFrom : (buried.status ?? "closed"),
            closedAt: undefined,
            lastSeen: already ? (buried.lastSeen ?? seen) : seen,
            // The baseline is the one taken when the problem was first recorded. A recurrence
            // that moves it makes "changed since" compare the file with itself, and the review
            // after a reopen is exactly when the human needs to know the target moved.
            targetFingerprint: buried.targetFingerprint ?? fingerprint?.(buried.proposal?.target),
          }
          if (write(back)) {
            result[evicted ? "restored" : "reopened"].push(back.id)
            try {
              rmSync(join(archive, buried.file ?? `${buried.id}.md`))
            } catch (err) {
              onError?.(`lessons.${evicted ? "restore" : "reopen"} ${buried.id}`, err)
            }
          }
          byId.set(back.id, back)
          // Not `mintedNow`: the id came from the archive, so a second lesson in this same
          // batch with that id is the same problem and should merge. Treating it as newly
          // minted reopened the stale archive entry twice and counted one session twice.
          continue
        }

        const target = explicit ?? sameId
        if (target) {
          const evidence = [...(asArray(target.evidence) ?? [])]
          const at = evidence.findIndex((e) => e?.session === session)
          const already = at >= 0
          // The same session read twice is one session: recurrence and cost stay where they
          // are. Its step range does not — a live log is read while it grows, and the newer,
          // longer read is the one that knows where the problem actually is. An extractor
          // that omits `steps` must not erase the range the lesson already has: an empty
          // list is a missing answer, not a range of zero.
          if (already) evidence[at] = { ...evidence[at], steps: lesson.steps?.length ? lesson.steps : evidence[at].steps }
          else evidence.push({ session, steps: lesson.steps })

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
            // Only the baseline taken at creation, never a fresh one: a lesson whose target did
            // not exist then has no baseline, and filling it in later would present a check of
            // "changed since the recurrence" as "changed since the lesson was recorded".
            targetFingerprint: target.targetFingerprint ?? undefined,
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

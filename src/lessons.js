import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
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

export function score(lesson) {
  return (lesson.cost ?? 0) * (lesson.recurrence ?? 1) * (lesson.confidence ?? 0)
}

export function createStore({ dir, archive, cap = DEFAULT_CAP, onError }) {
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
    return lessons.sort((a, b) => score(b) - score(a))
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
    write,

    /**
     * Folds one extraction into the store. A lesson the extractor says `matches` an
     * existing id — or that lands on the same id — increments recurrence instead of
     * creating a near-duplicate.
     */
    record(extracted, { session }) {
      const existing = list()
      const byId = new Map(existing.map((l) => [l.id, l]))
      const result = { created: [], merged: [] }

      // Ids minted in this batch are taken, not merge targets: two lessons that collide
      // on a slug are two problems, and merging them would drop one statement. An explicit
      // `matches` still merges, because then the extractor meant it.
      const mintedNow = new Set()

      for (const lesson of extracted) {
        const explicit = lesson.matches ? byId.get(lesson.matches) : null
        const sameId = mintedNow.has(lesson.id) ? null : byId.get(lesson.id)
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

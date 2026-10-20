import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { commitsTouching } from "./git.js"

/**
 * Is a lesson still true?
 *
 * A lesson can sit for weeks before anyone reviews it, and in that time the thing it
 * complains about may have been fixed, moved or deleted. Proposing a fix for a problem
 * that no longer exists wastes the one resource this plugin is supposed to save.
 *
 * This is the cheap deterministic half: has the target file gone, or changed since we
 * recorded the lesson? It never decides on its own — a changed file is a reason to look,
 * not proof. The other half is the agent receiving the proposal, which is told to verify
 * the claims against the repository before relaying them.
 */

export function fingerprintOf(directory) {
  return (target) => {
    if (!target) return undefined
    const path = resolveTarget(directory, target)
    if (!path || !existsSync(path)) return undefined
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16)
    } catch {
      return undefined
    }
  }
}

export function assessCurrency(lesson, { directory, fingerprint = fingerprintOf(directory) } = {}) {
  const target = lesson?.proposal?.target
  if (!target) {
    return { state: "unverifiable", detail: "the lesson names no target file" }
  }

  const path = resolveTarget(directory, target)
  if (!path || !existsSync(path)) {
    return {
      state: "target-gone",
      detail: `\`${target}\` no longer exists`,
      warning:
        `**\`${target}\` no longer exists.** This lesson may already be settled — the file it ` +
        "is about is gone. Check before acting on it; if it is settled, say so and it will be closed.",
    }
  }

  const before = lesson.targetFingerprint
  if (!before) {
    return { state: "unknown", detail: "no fingerprint was recorded when the lesson was written" }
  }

  const now = fingerprint(target)
  if (now && now !== before) {
    return {
      state: "target-changed",
      target,
      detail: `\`${target}\` changed since the lesson was recorded`,
      warning:
        `**\`${target}\` has changed since this lesson was recorded.** It may already be ` +
        "fixed. Read it as it is now before relaying the proposal, and say so if the problem is gone.",
    }
  }
  return { state: "unchanged", detail: `\`${target}\` is unchanged since the lesson was recorded` }
}

/**
 * Names the commits that touched the target since the lesson was recorded. A commit
 * message is the cheapest explanation of why a file changed, and often settles the
 * question outright — "make lint conditional on a config" is the fix, visibly.
 */
export async function explainChange(currency, lesson, { directory }) {
  if (!currency?.target || !lesson?.baseCommit || !directory) return currency
  const commits = await commitsTouching(directory, currency.target, lesson.baseCommit)
  if (!commits.length) return currency
  return {
    ...currency,
    commits,
    warning:
      `${currency.warning}\n\nCommitted since the lesson was recorded:\n` +
      commits.map((c) => `- \`${c}\``).join("\n"),
  }
}

function resolveTarget(directory, target) {
  if (!target || typeof target !== "string") return null
  if (isAbsolute(target)) return target
  return directory ? resolve(directory, target) : null
}

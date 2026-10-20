import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

/**
 * Is a lesson still true?
 *
 * A lesson can sit for weeks before anyone reviews it, and in that time the thing it
 * complains about may have been fixed, moved or deleted. Proposing a fix for a problem
 * that no longer exists wastes the one resource this plugin is supposed to save.
 *
 * All this file does is notice that the target moved — a local file read and a hash, no
 * git, no subprocess, works in a project that is not a repository at all. It is a hint
 * that raises the question, never an answer.
 *
 * Answering is the agent's job, and the question is put to it plainly: *is this already
 * resolved in the workspace as it is now?* It has the repository, the harness, the history
 * and whatever skills this project carries; prescribing how to check would be us guessing
 * at a job it does better. We used to run `git log` here and paste commit lines in. That
 * was the plugin second-guessing the agent, with a subprocess and three failure modes
 * attached.
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
      hint: `\`${target}\` no longer exists.`,
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
      hint: `\`${target}\` has changed since this lesson was recorded.`,
    }
  }
  return { state: "unchanged", detail: `\`${target}\` is unchanged since the lesson was recorded` }
}

function resolveTarget(directory, target) {
  if (!target || typeof target !== "string") return null
  if (isAbsolute(target)) return target
  return directory ? resolve(directory, target) : null
}

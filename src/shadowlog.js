import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Append-only JSONL, one file per session, written as the session runs.
 *
 * Nothing here may throw into the user's session (AGENTS.md "Conventions"), so every
 * failure is handed to `onError` and swallowed. A broken log must degrade to no log.
 */
export function createShadowLog({ dir, onError }) {
  let ready = false

  function ensure() {
    if (ready) return true
    try {
      mkdirSync(dir, { recursive: true })
      ready = true
    } catch (err) {
      onError?.("shadowlog.mkdir", err)
    }
    return ready
  }

  return {
    path: (sessionID) => join(dir, `${sessionID}.jsonl`),

    write(sessionID, record) {
      if (!ensure()) return false
      try {
        appendFileSync(join(dir, `${sessionID}.jsonl`), JSON.stringify(record) + "\n")
        return true
      } catch (err) {
        onError?.("shadowlog.write", err)
        return false
      }
    },

    /** Session ids with a log still on disk. */
    list() {
      try {
        return readdirSync(dir)
          .filter((n) => n.endsWith(".jsonl"))
          .map((n) => n.slice(0, -".jsonl".length))
      } catch {
        return []
      }
    },

    remove(sessionID) {
      try {
        rmSync(join(dir, `${sessionID}.jsonl`))
        return true
      } catch (err) {
        if (err?.code !== "ENOENT") onError?.("shadowlog.remove", err)
        return false
      }
    },

    /** Used by the self-check: the log must exist and be non-empty. */
    stat(sessionID) {
      try {
        const s = statSync(join(dir, `${sessionID}.jsonl`))
        return { exists: true, size: s.size }
      } catch {
        return { exists: false, size: 0 }
      }
    },
  }
}

/** Parses a shadow log back into records. Bad lines are skipped, not fatal. */
export function parseShadowLog(text) {
  const records = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      /* a half-written final line is expected if we were killed mid-append */
    }
  }
  return records
}

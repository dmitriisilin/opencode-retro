import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
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

    /** Records already written for a session, for when a log has to be absorbed. */
    read(sessionID) {
      try {
        return parseShadowLog(readFileSync(join(dir, `${sessionID}.jsonl`), "utf8"))
      } catch {
        return []
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

    /**
     * The highest `n` already in a session's log, or 0.
     *
     * The counter lives in memory, so a second process appending to the same log used to
     * start again at 1 — measured on real logs here, three and four blocks of `n` restarting
     * at 1 inside one file. A lesson's evidence is a session id and a step range, and
     * decision 18 keeps the log on disk precisely so that range resolves; against duplicate
     * numbering it resolves to several records and the reviewer has to rebuild the file by
     * hand to see which. Reading the tail once per session per process is cheaper than that.
     */
    lastN(sessionID) {
      try {
        const lines = readFileSync(join(dir, `${sessionID}.jsonl`), "utf8").split("\n")
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim()
          if (!line) continue
          try {
            const n = JSON.parse(line)?.n
            if (Number.isFinite(n)) return n
          } catch {
            /* a half-written last line: keep looking back */
          }
        }
      } catch {
        /* no log yet, which is the normal case */
      }
      return 0
    },

    /**
     * Which log this is. Two files under one session id are two logs — a pruned log written
     * again, a file replaced by hand — and a mark is about exactly one of them. The first
     * record is written once and never changes, so its hash is the file's identity; `null`
     * when there is no file or no whole first line yet.
     */
    identity(sessionID) {
      try {
        return identityOf(readFileSync(join(dir, `${sessionID}.jsonl`), "utf8"))
      } catch {
        return null
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

/**
 * The identity of the log in `text`: a hash of its first whole record.
 *
 * Separate from `identity(sessionID)` because the mark must describe the bytes that were
 * actually read. Reading the file a second time to compute it opened a window in which the
 * log could be replaced: the old records would then be recorded against the new file's
 * identity, and the next read would filter the new log by the old step numbers.
 */
export function identityOf(text) {
  try {
    const first = String(text ?? "").split("\n").find((l) => l.trim())
    if (!first) return null
    JSON.parse(first) // a half-written first line is not an identity yet
    return createHash("sha256").update(first).digest("hex").slice(0, 12)
  } catch {
    return null
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

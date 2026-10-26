import { createHash } from "node:crypto"
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs"
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
        const path = join(dir, `${sessionID}.jsonl`)
        // A process killed mid-append leaves half a record with no newline, and the next
        // append used to land on the same line: the parser then skipped both, so the first
        // record after a crash — a resumed session's prompt, typically — was lost with the
        // half-record. Measured by the model test. Starting on a fresh line costs the half.
        const prefix = endsMidLine(path) ? "\n" : ""
        appendFileSync(path, prefix + JSON.stringify(record) + "\n")
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
      return this.last(sessionID)?.n ?? 0
    },

    /** The last whole record in the log, or null: what the numbering and the idle check read. */
    last(sessionID) {
      // From the tail, widening until a whole record is found: this is read at the start of
      // every turn, inside the first hook, and a log left open for weeks is large.
      let fd
      try {
        fd = openSync(join(dir, `${sessionID}.jsonl`), "r")
        const size = fstatSync(fd).size
        for (let span = 64 * 1024; ; span *= 4) {
          const start = Math.max(0, size - span)
          const buf = Buffer.alloc(size - start)
          let got = 0
          while (got < buf.length) {
            const k = readSync(fd, buf, got, buf.length - got, start + got)
            if (k === 0) break
            got += k
          }
          const lines = buf.subarray(0, got).toString("utf8").split("\n")
          // The first line of a tail read from the middle may be cut: never trusted.
          for (let i = lines.length - 1; i >= (start > 0 ? 1 : 0); i--) {
            const line = lines[i].trim()
            if (!line) continue
            try {
              const record = JSON.parse(line)
              if (Number.isFinite(record?.n)) return record
            } catch {
              /* a half-written last line: keep looking back */
            }
          }
          if (start === 0) break
        }
      } catch {
        /* no log yet, which is the normal case */
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
      return null
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

    /**
     * The file as it is on disk now — its identity, its size and when it was last written —
     * or `null` when there is none. Reads the first line only, because the state merge asks
     * this about every mark on every save, and a whole-file read there would cost the sum of
     * every log the project keeps.
     */
    probe(sessionID) {
      const path = join(dir, `${sessionID}.jsonl`)
      let fd
      let stat
      try {
        stat = statSync(path)
      } catch {
        return null
      }
      const { size, mtimeMs } = stat
      try {
        fd = openSync(path, "r")
        const chunks = []
        const buf = Buffer.alloc(65536)
        for (let pos = 0; pos < size; ) {
          const got = readSync(fd, buf, 0, buf.length, pos)
          if (!got) break
          const part = buf.subarray(0, got)
          const nl = part.indexOf(0x0a)
          chunks.push(Buffer.from(nl >= 0 ? part.subarray(0, nl + 1) : part))
          if (nl >= 0) break
          pos += got
        }
        return { id: identityOf(Buffer.concat(chunks).toString("utf8")), size, mtimeMs }
      } catch {
        // There, but not readable: still a file the marks may describe, with no identity.
        return { id: null, size, mtimeMs }
      } finally {
        if (fd !== undefined) closeSync(fd)
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

/** Whether the file exists and its last byte is not a newline. */
function endsMidLine(path) {
  let fd
  try {
    const { size } = statSync(path)
    if (!size) return false
    fd = openSync(path, "r")
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } catch {
    return false // no file yet
  } finally {
    if (fd !== undefined) closeSync(fd)
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

/**
 * Whether a mark describes a different file than the one just read.
 *
 * Identity is the first whole record, and an append never rewrites it — so a file whose first
 * record is gone cannot be the log the mark described, and a missing identity counts as
 * different whenever a file is there. Exported because the read has to make the same judgement
 * as the check before it: the log can be replaced in the window between the two, and a mark
 * that outlived its file would filter the new log's first steps away as already analysed.
 */
export function isReplacedLog(mark, identity, { exists = true } = {}) {
  if (!mark?.id) return false
  if (identity) return mark.id !== identity
  return Boolean(exists)
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

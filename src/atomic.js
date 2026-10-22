import { renameSync, rmSync, writeFileSync } from "node:fs"

/**
 * Write a whole file or nothing: into a temporary file beside it, then renamed over it.
 *
 * `writeFileSync` truncates first and writes after, so a process killed in between leaves a
 * file cut short — for `state.json` that is a state that starts clean, for a lesson a file
 * nobody can read. A rename is atomic on one filesystem, so a reader sees the old file or the
 * new one. What a crash can leave is the temporary file, which `.retro/.gitignore` ignores.
 */
export function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Read-only git, used for one job: turning "the target file changed" into "it changed in
 * these commits", which is the difference between a suspicion and evidence that the
 * problem was already fixed.
 *
 * `ctx.vcs` offers info/base/branches/status/diff but no history, and `ctx.shell` is a
 * hook with no way to execute, so this shells out itself. Everything here fails silent: no
 * git, a detached worktree, a timeout — the currency check simply falls back to the
 * content fingerprint, which never needed git in the first place.
 */
async function git(directory, args, timeout = 3000) {
  try {
    const { stdout } = await run("git", args, { cwd: directory, timeout, windowsHide: true })
    return stdout.trim()
  } catch {
    return null
  }
}

export async function headCommit(directory) {
  const out = await git(directory, ["rev-parse", "HEAD"])
  return out && /^[0-9a-f]{7,40}$/.test(out) ? out : null
}

/** Commits that touched `file` after `since`, newest first. */
export async function commitsTouching(directory, file, since, limit = 5) {
  if (!file || !since) return []
  const out = await git(directory, [
    "log",
    `--max-count=${limit}`,
    "--format=%h %s",
    `${since}..HEAD`,
    "--",
    file,
  ])
  if (!out) return []
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

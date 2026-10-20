import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * A `.gitignore` inside our own directory, so the user never edits theirs.
 *
 * Git applies a `.gitignore` to the directory containing it, which means everything here
 * can be decided without touching anything outside `.retro/` — the one rule this plugin
 * does not break. Seeded once and never rewritten: after the first run it is the user's
 * file, and they may well want different answers than these.
 *
 * What it ignores and what it does not is the design, not a convenience: lessons and the
 * archive are knowledge about the project and belong in review and in history. The rest is
 * machine state that would only make noise in a diff.
 */
export const GITIGNORE = `# Written once by opencode-retro. Yours to edit from here on.
#
# lessons/ and archive/ are deliberately NOT ignored: they are what this plugin
# produces, they are meant to be read, reviewed and kept with the project.
# Everything below is machine state.

sessions/
state.json
selfcheck.md
plugin.log
prompts/updates/
`

export function seedGitignore({ dir, onError }) {
  const path = join(dir, ".gitignore")
  if (existsSync(path)) return { seeded: false, path }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, GITIGNORE)
    return { seeded: true, path }
  } catch (err) {
    onError?.("gitignore.seed", err)
    return { seeded: false, path, error: String(err?.message ?? err) }
  }
}

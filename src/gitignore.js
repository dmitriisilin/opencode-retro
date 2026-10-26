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
# produces, they are meant to be read, reviewed and kept with the project. So is
# README.md, which says what this directory is to whoever opens it.
# Everything below is machine state.

sessions/
work/
state.json
selfcheck.md
plugin.log
prompts/updates/
updates-delivered
*.tmp
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

/**
 * A note at the top of our own directory, for whoever opens it — an agent, mostly. Measured on
 * the friction bench: an agent working on the project listed `.retro/`, read the self-check
 * and past sessions' logs as if they were the project's documentation, and spent steps on
 * them; the plugin then recorded that as friction of its own making. This says what the
 * directory is in the place an agent looks. It changes nothing in the agent's own harness,
 * which is the user's. Seeded once and never rewritten, like the `.gitignore`.
 */
export const README = `# .retro — opencode-retro's own data

Nothing in this directory describes this project. It belongs to the opencode-retro plugin:
recordings of past sessions, the plugin's work orders and state, and lessons waiting for a
person to decide on. An agent working on the project has no reason to read it — the
project's own instructions are where they always were.

A person can start with \`selfcheck.md\` (is the plugin working) and \`lessons/\` (what it
has learned).
`

export function seedReadme({ dir, onError }) {
  const path = join(dir, "README.md")
  if (existsSync(path)) return { seeded: false, path }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, README)
    return { seeded: true, path }
  } catch (err) {
    onError?.("readme.seed", err)
    return { seeded: false, path, error: String(err?.message ?? err) }
  }
}

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { parseFrontmatter } from "./frontmatter.js"

const packaged = resolve(dirname(fileURLToPath(import.meta.url)), "..", "prompts")

/**
 * Prompt resolution and seeding (AGENTS.md decisions 13 and 15).
 *
 * Three layers, first hit wins: the project, the user's global config, our default. The
 * project copy is seeded from the default so there is something concrete to edit, and
 * after that we never write to it again — a newer default arrives as a separate file in
 * `updates/`, headed by a note saying it is not in use. Nothing is applied on the user's
 * behalf, ever.
 */
export function createPrompts({ dir, updates, global = join(homedir(), ".config", "opencode", "retro", "prompts"), onError }) {
  function defaultFor(name) {
    try {
      return readFileSync(join(packaged, `${name}.md`), "utf8")
    } catch (err) {
      onError?.(`prompts.default ${name}`, err)
      return null
    }
  }

  return {
    /** Writes the default into the project if it is not there yet. Returns what it did. */
    seed(name) {
      const target = join(dir, `${name}.md`)
      if (existsSync(target)) return { seeded: false, path: target }
      const text = defaultFor(name)
      if (!text) return { seeded: false, path: target, error: "no packaged default" }
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(target, text)
        return { seeded: true, path: target }
      } catch (err) {
        onError?.(`prompts.seed ${name}`, err)
        return { seeded: false, path: target, error: String(err?.message ?? err) }
      }
    },

    /** The prompt that will actually run, and which layer it came from. */
    resolve(name) {
      for (const [layer, path] of [
        ["project", join(dir, `${name}.md`)],
        ["global", join(global, `${name}.md`)],
        ["packaged", join(packaged, `${name}.md`)],
      ]) {
        try {
          if (!existsSync(path)) continue
          const { data, body } = parseFrontmatter(readFileSync(path, "utf8"))
          return { layer, path, base: data?.base ?? null, text: body }
        } catch (err) {
          onError?.(`prompts.resolve ${path}`, err)
        }
      }
      return null
    },

    /**
     * If our default has moved past what the live file was seeded from, drop the new
     * default in `updates/` and return a note for selfcheck.md. The live file is never
     * touched — not even when it looks untouched (decision 15).
     */
    checkForUpdate(name) {
      const live = this.resolve(name)
      const text = defaultFor(name)
      if (!live || !text) return null

      const current = parseFrontmatter(text).data?.base ?? null
      if (current === null || live.base === null || current <= live.base) return null

      const file = join(updates, `${name}.v${current}.md`)
      if (existsSync(file)) return note(name, live, current, file)
      try {
        mkdirSync(updates, { recursive: true })
        writeFileSync(file, header(name, live, current) + text)
      } catch (err) {
        onError?.(`prompts.update ${name}`, err)
        return null
      }
      return note(name, live, current, file)
    },

    /** Updates sitting in the directory, so selfcheck.md can keep naming them. */
    pendingUpdates() {
      try {
        return readdirSync(updates).filter((n) => n.endsWith(".md"))
      } catch {
        return []
      }
    },
  }
}

const header = (name, live, version) => `<!--
This file is NOT in use. Nothing was changed for you.

What runs is ${live.path}, which you have adapted from version ${live.base}.
Below is version ${version} of the default ${name} prompt, for you to read.

If you want it, keep your own file and adapt it to what changed here — your version is the
one that works for this project. If you would rather start over from the default, replace
your file with the text below. Delete this file whenever you are done with it; the plugin
will not.
-->

`

const note = (name, live, version, file) =>
  `prompts/${name}.md is yours (base ${live.base}). A newer default, v${version}, is in ` +
  `${file.split("/").slice(-2).join("/")}. Nothing was changed for you.`

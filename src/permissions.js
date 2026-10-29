import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Whether OpenCode's permissions configuration hides the plugin's tools from the model.
 *
 * OpenCode builds each session's toolset by dropping every tool whose permission action — the
 * tool's own `permission` option, or its name when it declares none — is denied: the last rule
 * whose `action` matches decides, and a match with `resource: "*"` and `effect: "deny"` removes
 * the tool outright (read from 2.0.32's bundled source: `findLast` over the rules, then
 * `resource === "*" && effect === "deny"`). A "deny everything, allow a list" configuration is a
 * common way to harden a setup, and under it `retro_record`, `retro_propose` and `retro_decide`
 * reach no session at all, while the commands, the hooks and this report go on as if healthy
 * (issues #1 and #2). Nothing here changes a rule: it reads them, and says so.
 *
 * Read from the configuration files OpenCode reads — the global one and the project's — with the
 * global rules first and the project's after them, as a later rule wins. An agent's own
 * permissions, and a configuration supplied any other way, are not seen; this answers for the
 * files only, and says so.
 */
export const PLUGIN_TOOLS = ["retro_record", "retro_propose", "retro_decide"]

export function hiddenTools({ directory, home = homedir(), read = (p) => readFileSync(p, "utf8") } = {}) {
  const files = [
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
    ...(directory ? [join(directory, "opencode.json"), join(directory, "opencode.jsonc")] : []),
  ]
  const rules = []
  const from = []
  for (const file of files) {
    let text
    try {
      text = read(file)
    } catch {
      continue
    }
    let config
    try {
      config = JSON.parse(stripJsonc(text))
    } catch {
      continue
    }
    const list = Array.isArray(config?.permissions) ? config.permissions : Array.isArray(config?.permission) ? config.permission : []
    for (const rule of list) {
      if (rule && typeof rule.action === "string") {
        rules.push(rule)
        from.push(file)
      }
    }
  }
  const hidden = []
  const where = new Set()
  for (const tool of PLUGIN_TOOLS) {
    let at = -1
    for (let i = rules.length - 1; i >= 0 && at < 0; i--) if (matches(tool, rules[i].action)) at = i
    if (at >= 0 && rules[at].resource === "*" && rules[at].effect === "deny") {
      hidden.push(tool)
      where.add(from[at])
    }
  }
  return { hidden, files: [...where], rules: rules.length }
}

/** An `action` pattern against a name, `*` standing for anything. */
function matches(name, pattern) {
  if (pattern === "*") return true
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
  return re.test(name)
}

/** JSON with comments and trailing commas, as `opencode.jsonc` allows. */
function stripJsonc(text) {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\") out += text[++i] ?? ""
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

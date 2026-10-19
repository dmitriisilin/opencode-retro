import { isAbsolute, join, resolve } from "node:path"

/** Defaults live here so there is exactly one place to look them up. */
export const DEFAULTS = {
  dir: ".retro",
  prompts: "prompts",
  /** Per-entry cap on captured tool output. Head and tail are kept, the middle is elided. */
  maxOutput: 8000,
  /** Lower bound between heartbeat writes. See AGENTS.md "Three timestamps". */
  heartbeatMs: 60_000,
}

/**
 * Resolves the on-disk layout from the plugin context.
 * `options.dir` is relative to the project unless absolute.
 */
export function resolveConfig(ctx) {
  const options = ctx?.options ?? {}
  const directory = ctx?.location?.directory ?? process.cwd()
  const dir = isAbsolute(options.dir ?? "") ? options.dir : resolve(directory, options.dir ?? DEFAULTS.dir)
  return {
    directory,
    project: ctx?.location?.project?.id ?? null,
    dir,
    sessions: join(dir, "sessions"),
    lessons: join(dir, "lessons"),
    archive: join(dir, "archive"),
    prompts: isAbsolute(options.prompts ?? "") ? options.prompts : resolve(dir, options.prompts ?? DEFAULTS.prompts),
    updates: join(dir, DEFAULTS.prompts, "updates"),
    selfcheck: join(dir, "selfcheck.md"),
    state: join(dir, "state.json"),
    pluginLog: join(dir, "plugin.log"),
    model: options.model ?? null,
    maxOutput: options.maxOutput ?? DEFAULTS.maxOutput,
    heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
  }
}

/**
 * Keeps the head and tail of an oversized string and says how much went missing.
 * Returns the original when the elision notice would not actually save anything.
 */
export function clamp(text, max) {
  if (typeof text !== "string" || text.length <= max) return { text, truncated: false }
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  const clamped = text.slice(0, head) + `\n…[${text.length - max} characters elided]…\n` + text.slice(-tail)
  if (clamped.length >= text.length) return { text, truncated: false }
  return { text: clamped, truncated: true, originalLength: text.length }
}

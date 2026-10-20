import { isAbsolute, join, resolve } from "node:path"

/** Defaults live here so there is exactly one place to look them up. */
export const DEFAULTS = {
  dir: ".retro",
  prompts: "prompts",
  /** Per-entry cap on captured tool output. Head and tail are kept, the middle is elided. */
  maxOutput: 8000,
  /** Lower bound between heartbeat writes. See AGENTS.md "Three timestamps". */
  heartbeatMs: 60_000,
  /**
   * Sessions without a recurrence after which a lesson's score halves. Counted in sessions,
   * not days: one session a day would otherwise bury everything.
   */
  halfLife: 10,
  /** Keep the shadow log after a successful extraction. Off — the lesson carries the story. */
  keepSessions: false,
  /** Give up on a silent model call rather than wedging the queue behind it. */
  extractTimeoutMs: 90_000,
  /** Lessons carried by one `/retro auto`. Beyond this a plan stops being a plan. */
  autoLimit: 10,
  /**
   * Logs analysed by one `/retro`. Unlimited by default: leaving a backlog half-analysed
   * only moves the work, it does not avoid it. Set a number to cap one command's spend.
   */
  extractLimit: Infinity,
  /**
   * Analyse a finished session at the start of the next one, without being asked. Off:
   * a model call costs money, and nothing else in this plugin spends it unprompted.
   */
  autoExtract: false,
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
    halfLife: options.halfLife ?? DEFAULTS.halfLife,
    keepSessions: options.keepSessions ?? DEFAULTS.keepSessions,
    extractTimeoutMs: options.extractTimeoutMs ?? DEFAULTS.extractTimeoutMs,
    autoLimit: options.autoLimit ?? DEFAULTS.autoLimit,
    extractLimit: options.extractLimit ?? DEFAULTS.extractLimit,
    autoExtract: options.autoExtract ?? DEFAULTS.autoExtract,
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

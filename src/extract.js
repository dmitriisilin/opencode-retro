import { OUTPUT_CONTRACT, parseLessons } from "./contract.js"
import { project } from "./projection.js"

/**
 * One extraction: shadow log -> lessons (AGENTS.md decision 5).
 *
 * Runs with a clean context — one call through a session of its own, no agent, no tools and
 * no history —
 * because the agent that did the work would defend its own choices.
 *
 * There are no detectors in front of it. There used to be three, marking suspicious step
 * ranges; `fixtures/ab-anchors/` is the measurement that retired them — the model found the
 * same lessons without them. What they knew now lives as prose in `prompts/extract.md`,
 * where the user can read it and change it.
 */
export const DEFAULT_TIMEOUT_MS = 90_000

export async function extract({
  records,
  session,
  generate,
  model,
  prompts,
  store,
  state,
  fingerprint,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxInput = Infinity,
  /** The last step of this session already turned into lessons; 0 for a first look. */
  analysedUpTo = 0,
  /** Lessons already decided from this very session, so the same ground is not covered twice. */
  concluded = [],
}) {
  // Skip only a session that cannot contain evidence of anything: one instruction, one
  // answer, nothing done. Everything else is analysed.
  //
  // This used to require three tool calls, which was the wrong proxy and would have thrown
  // away the clearest lessons of all. An instruction file that is wrong produces a wrong
  // answer with no tool call at all; a correction is a second prompt and nothing more. Both
  // live in the text, which is why the projection keeps prompts and replies whole.
  const asked = records.filter((r) => r.k === "prompt").length
  const toolCalls = records.filter((r) => r.k === "tool").length
  if (asked <= 1 && toolCalls === 0) {
    return {
      ok: true,
      skipped: true,
      detail: "nothing to extract (one exchange, nothing done)",
      lessons: [],
    }
  }

  // Reaching here with no model means `options.model`, the session's own model and
  // `ctx.model.default()` all came up empty, so there is nothing to create the analysis
  // session with. Refusing with the remedy named beats an empty `lessons/` nobody can
  // account for. (Free-tier models are fine — see AGENTS.md Gotcha 10 — it is the absence
  // of any model that stops us.)
  if (!model?.providerID || !model?.id) {
    return {
      ok: false,
      detail: 'no model could be resolved — set options.model, e.g. { "providerID": "deepseek", "id": "deepseek-flash" }',
    }
  }

  const prompt = prompts.resolve("extract")
  if (!prompt) return { ok: false, detail: "no extract prompt could be resolved" }

  const existing = store.list().filter((l) => l.status !== "rejected")

  /**
   * A session that is left open and returned to is never "finished", so its log is read more
   * than once — and the second read must not cover the ground the first one did. Saying which
   * steps are new is what stops the same lessons being derived again from material that was
   * already turned into them and decided on.
   */
  const continued =
    analysedUpTo > 0
      ? `Steps up to ${analysedUpTo} of this session were analysed before and what came of them ` +
        `is below. What follows is the rest of it. The session's instructions are repeated in ` +
        `full, because they say what it was for; everything else is new since that analysis.`
      : null

  const compose = (log) =>
    [
      prompt.text,
      section("Session", `id: ${session}`),
      section("Log", [continued, log].filter(Boolean).join("\n\n")),
      section("Already concluded from this session", renderConcluded(concluded)),
      section("Lessons already recorded", renderExisting(existing)),
      section("Rejected — do not propose these again", renderRejected(state.rejected)),
      OUTPUT_CONTRACT,
    ]
      .filter(Boolean)
      .join("\n\n")

  /**
   * The log gets whatever the budget leaves after everything else.
   *
   * Measured, not guessed: on `deepseek/deepseek-flash` through `session.generate`, an input
   * of 39,518 characters came back with a parseable answer and the same input padded to
   * 41,029 came back **empty** — no error, no refusal, an empty string. Whatever the limit
   * is exactly, crossing it produces silence, and silence is the one failure this plugin
   * cannot afford: long sessions are where the friction lives, so without a budget the
   * sessions most worth reading are the ones that reliably yield nothing.
   *
   * It is a character count rather than a token count on purpose. Tokenisation is
   * model-specific and would need a dependency to estimate; characters are exact, and the
   * budget only has to be comfortably under a cliff, not next to it.
   */
  const overhead = compose("").length
  const budget = Number.isFinite(maxInput) ? Math.max(2000, maxInput - overhead) : Infinity

  const { from, ...ref } = model
  const ask = async (log) => {
    try {
      const result = await withTimeout(generate({ prompt: compose(log), model: ref }), timeoutMs)
      return { text: result?.text ?? "" }
    } catch (err) {
      const message = String(err?.message ?? err)
      const hint = /free tier/i.test(message)
        ? ". A plugin may not use OpenCode's own free tier; pin a different model in options.model."
        : ""
      return { failed: `model call failed: ${message}${hint}` }
    }
  }

  let log = project(records, { budget })
  let answer = await ask(log)
  if (answer.failed) return { ok: false, detail: answer.failed }

  /**
   * An empty reply is this model's way of declining, and it gets more likely as the input
   * grows. Measured on `deepseek/deepseek-flash` through `session.generate`, same content
   * each time: 26,034 characters answered, 32,034 answered, 40,254 came back as an empty
   * string — no error, no refusal, nothing to report. Near the top of that range it is not a
   * clean cliff either; one 39,518-character input was answered once and a 32,000 one was
   * not.
   *
   * So the second attempt is not the same attempt again. Retrying across `/retro` runs was
   * already possible and useless: three attempts sent the identical oversized input and got
   * the identical silence, then the log was retired. Halving the budget changes the one
   * thing that correlates, costs one extra call, and only happens when the first reply was
   * empty.
   */
  if (!answer.text.trim() && Number.isFinite(budget)) {
    const smaller = project(records, { budget: Math.max(1000, Math.floor(budget / 2)) })
    if (smaller !== log) {
      log = smaller
      answer = await ask(log)
      if (answer.failed) return { ok: false, detail: answer.failed }
    }
  }

  const reply = answer.text
  const elided = /\d+ steps? elided to fit the budget/.test(log)

  const parsed = parseLessons(reply)
  if (!parsed.ok) return { ok: false, detail: `unparseable reply: ${parsed.error}${excerpt(reply)}`, reply }

  const rejected = new Set(state.rejected.map((r) => r.id))
  const lessons = parsed.lessons.filter((l) => !rejected.has(l.id) && !rejected.has(l.matches))
  const recorded = store.record(lessons, { session, fingerprint })

  return {
    ok: true,
    lessons,
    recorded,
    // Said out loud: a lesson drawn from an excerpt is still a lesson, but the human should
    // know the extractor did not see the whole session.
    detail: summarise(recorded, lessons.length) + (elided ? " (from an excerpt: the log was over budget)" : ""),
  }
}

/**
 * What the model actually said, in one line.
 *
 * "unparseable reply" alone tells the human nothing: they cannot tell a model that
 * answered in prose from one that stopped half way through a JSON object, and those
 * have different remedies. The whole reply is kept for the plugin log; this is the part
 * that fits in a message.
 */
function excerpt(reply) {
  const text = String(reply ?? "").trim()
  if (!text) return " — the model returned nothing at all"
  const flat = text.replace(/\s+/g, " ")
  return ` — the model answered (${text.length} chars): ${flat.slice(0, 200)}${flat.length > 200 ? "…" : ""}`
}

/**
 * A generate call that never settles is not hypothetical — it is how `generate.text`
 * behaves outside a hook, and it has been seen from inside one too. Without a bound, one
 * hung call wedges the drain for the rest of the process and nothing says so.
 */
function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no reply after ${Math.round(ms / 1000)}s`)), ms)
    }),
  ])
}

const section = (title, body) => (body?.trim() ? `## ${title}\n\n${body.trim()}` : null)

function renderExisting(lessons) {
  if (!lessons.length) return "None yet."
  return lessons
    .map((l) => `- \`${l.id}\` (seen in ${l.recurrence ?? 1}): ${l.statement}`)
    .join("\n")
}

/**
 * What was already settled from this session. Without it the extractor re-derives a lesson
 * that was accepted and archived weeks ago, and the store then reopens it as though the fix
 * had not held — when all that happened is that the same log was read twice.
 */
function renderConcluded(concluded) {
  if (!concluded?.length) return null
  return concluded
    .map((l) => `- \`${l.id}\` (${l.status}): ${l.statement}`)
    .join("\n")
}

function renderRejected(rejected) {
  if (!rejected.length) return null
  return rejected.map((r) => `- \`${r.id}\`${r.reason ? ` — ${r.reason}` : ""}`).join("\n")
}

function summarise(recorded, lessons) {
  if (!lessons) return "nothing to learn"
  const parts = []
  if (recorded.created?.length) parts.push(`${recorded.created.length} new (${recorded.created.join(", ")})`)
  if (recorded.reopened?.length) parts.push(`${recorded.reopened.length} came back (${recorded.reopened.join(", ")})`)
  if (recorded.merged?.length) parts.push(`${recorded.merged.length} recurring (${recorded.merged.join(", ")})`)
  if (recorded.archived?.length) parts.push(`${recorded.archived.length} archived`)
  return parts.join(", ") || "no change"
}

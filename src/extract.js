import { OUTPUT_CONTRACT, parseLessons } from "./contract.js"
import { project } from "./projection.js"

/**
 * One extraction: shadow log -> lessons (AGENTS.md decision 5).
 *
 * Runs with a clean context — a single `ctx.generate.text` call, no session, no history —
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

  // Without an explicit model, generate.text resolves to OpenCode's free tier and fails
  // from inside a plugin (AGENTS.md Gotcha 10). Refusing up front beats hanging.
  if (!model?.providerID || !model?.id) {
    return {
      ok: false,
      detail: 'no model could be resolved — set options.model, e.g. { "providerID": "deepseek", "id": "deepseek-flash" }',
    }
  }

  const prompt = prompts.resolve("extract")
  if (!prompt) return { ok: false, detail: "no extract prompt could be resolved" }

  const existing = store.list().filter((l) => l.status !== "rejected")
  const input = [
    prompt.text,
    section("Session", `id: ${session}`),
    section("Log", project(records)),
    section("Lessons already recorded", renderExisting(existing)),
    section("Rejected — do not propose these again", renderRejected(state.rejected)),
    OUTPUT_CONTRACT,
  ]
    .filter(Boolean)
    .join("\n\n")

  let reply
  try {
    const { from, ...ref } = model
    const result = await withTimeout(generate({ prompt: input, model: ref }), timeoutMs)
    reply = result?.text ?? ""
  } catch (err) {
    const message = String(err?.message ?? err)
    const hint = /free tier/i.test(message)
      ? ". A plugin may not use OpenCode's own free tier; pin a different model in options.model."
      : ""
    return { ok: false, detail: `model call failed: ${message}${hint}` }
  }

  const parsed = parseLessons(reply)
  if (!parsed.ok) return { ok: false, detail: `unparseable reply: ${parsed.error}`, reply }

  const rejected = new Set(state.rejected.map((r) => r.id))
  const lessons = parsed.lessons.filter((l) => !rejected.has(l.id) && !rejected.has(l.matches))
  const recorded = store.record(lessons, { session, fingerprint })

  return {
    ok: true,
    lessons,
    recorded,
    detail: summarise(recorded, lessons.length),
  }
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

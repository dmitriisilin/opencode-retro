import { detectAnchors } from "./anchors.js"
import { OUTPUT_CONTRACT, parseLessons } from "./contract.js"
import { project } from "./projection.js"

/**
 * One extraction: shadow log -> lessons (AGENTS.md decision 5).
 *
 * Runs with a clean context — a single `ctx.generate.text` call, no session, no history —
 * because the agent that did the work would defend its own choices.
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
  baseCommit = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const anchors = detectAnchors(records)

  // No model call when there is demonstrably nothing to look at. Cheap, honest, and the
  // common case for short sessions.
  const toolCalls = records.filter((r) => r.k === "tool").length
  if (!anchors.length && toolCalls < 3) {
    return { ok: true, skipped: true, detail: `nothing to extract (${toolCalls} tool calls, no anchors)`, lessons: [] }
  }

  // Without an explicit model, generate.text resolves to OpenCode's free tier and fails
  // from inside a plugin (AGENTS.md Gotcha 10). Refusing up front beats hanging.
  if (!model?.providerID || !model?.id) {
    return {
      ok: false,
      detail: 'no model configured — set options.model, e.g. { "providerID": "deepseek", "id": "deepseek-flash" }',
    }
  }

  const prompt = prompts.resolve("extract")
  if (!prompt) return { ok: false, detail: "no extract prompt could be resolved" }

  const existing = store.list().filter((l) => l.status !== "rejected")
  const input = [
    prompt.text,
    section("Session", `id: ${session}`),
    section("Log", project(records)),
    section("Anchors", renderAnchors(anchors)),
    section("Lessons already recorded", renderExisting(existing)),
    section("Rejected — do not propose these again", renderRejected(state.rejected)),
    OUTPUT_CONTRACT,
  ]
    .filter(Boolean)
    .join("\n\n")

  let reply
  try {
    const result = await withTimeout(generate({ prompt: input, model }), timeoutMs)
    reply = result?.text ?? ""
  } catch (err) {
    return { ok: false, detail: `model call failed: ${String(err?.message ?? err)}` }
  }

  const parsed = parseLessons(reply)
  if (!parsed.ok) return { ok: false, detail: `unparseable reply: ${parsed.error}`, reply }

  const rejected = new Set(state.rejected.map((r) => r.id))
  const lessons = parsed.lessons.filter((l) => !rejected.has(l.id) && !rejected.has(l.matches))
  const recorded = store.record(lessons, { session, fingerprint, baseCommit })

  return {
    ok: true,
    lessons,
    anchors,
    recorded,
    detail: summarise(recorded, lessons.length, anchors.length),
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

function renderAnchors(anchors) {
  if (!anchors.length) return "None. A cheap detector found nothing; look anyway."
  return anchors.map((a) => `- **${a.kind}** steps ${a.from}–${a.to}: ${a.reason}`).join("\n")
}

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

function summarise(recorded, lessons, anchors) {
  if (!lessons) return `nothing to learn (${anchors} anchor${anchors === 1 ? "" : "s"} looked at)`
  const parts = []
  if (recorded.created?.length) parts.push(`${recorded.created.length} new (${recorded.created.join(", ")})`)
  if (recorded.reopened?.length) parts.push(`${recorded.reopened.length} came back (${recorded.reopened.join(", ")})`)
  if (recorded.merged?.length) parts.push(`${recorded.merged.length} recurring (${recorded.merged.join(", ")})`)
  if (recorded.archived?.length) parts.push(`${recorded.archived.length} archived`)
  return parts.join(", ") || "no change"
}

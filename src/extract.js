import { OUTPUT_CONTRACT, normaliseLessons } from "./contract.js"
import { projected } from "./projection.js"

/**
 * Extraction, the plugin's half: shadow log -> work order, and record -> lessons
 * (docs/concepts/analysis.md).
 *
 * The reading itself is done by a subagent the agent in the `/retro` session starts — on
 * that session's model and settings, with OpenCode's own agent loop, in a context of its own,
 * because the agent that did the work would defend its own choices. The plugin makes no
 * model call. It used to, through a session of its own and `session.generate`, and that is
 * how a reasoning model's empty replies went unexplained for weeks (AGENTS.md Gotcha 17).
 *
 * There are no detectors in front of it. There used to be three, marking suspicious step
 * ranges; `fixtures/ab-anchors/` is the measurement that retired them — the model found the
 * same lessons without them. What they knew now lives as prose in `prompts/extract.md`,
 * where the user can read it and change it.
 */

/** The first line of every work order, which is also how the plugin knows its own subagents. */
export const WORK_MARK = "opencode-retro work order"

/**
 * The work order for one log: what a subagent is asked to read. Returns `{ skipped }` for a
 * log that cannot hold evidence, `{ ok: false }` when there is nothing to write it from, and
 * otherwise `{ ok: true, text, through, elided }`.
 */
export function composeOrder({
  records,
  session,
  prompts,
  store,
  state,
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
  //
  // A re-read is a different case. Its slice carries the session's prompts and drops the tool
  // calls already turned into lessons, so a session that had done plenty could present as one
  // quiet exchange and its new material was settled as read without being read. On a re-read
  // the rule is therefore about what is *new*: a new reply is material even when it came with
  // no prompt and no tool call, while a re-read that is nothing but the prompts it carries
  // (the hand-over the plugin itself wrote, or an end marker) still proves nothing.
  //
  // And a reply to the plugin's own hand-over is not new either, when nothing was done with
  // it. `/retro` with nothing to review still resumes the agent, which answers; counted as
  // material, that answer cost a model call on the next command, whose own hand-over was
  // answered in turn — a call per `/retro`, spent on the plugin talking to itself. Found by a
  // stranger's run. Only replies to a person's prompt count; tool calls always do.
  const reread = analysedUpTo > 0
  const asked = records.filter((r) => r.k === "prompt" && (!reread || r.n > analysedUpTo)).length
  const toolCalls = records.filter((r) => r.k === "tool").length
  let answering = null
  let newReply = false
  for (const r of [...records].sort((a, b) => (a.n ?? 0) - (b.n ?? 0))) {
    if (r.k === "prompt" || r.k === "handover") answering = r.k
    else if (r.k === "text" && answering !== "handover") newReply = true
  }
  if (reread ? asked === 0 && toolCalls === 0 && !newReply : asked <= 1 && toolCalls === 0) {
    return { ok: true, skipped: true, detail: "nothing to extract (one exchange, nothing done)" }
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
      `<!-- ${WORK_MARK} -->`,
      prompt.text,
      section("Session", `id: ${session}`),
      section("Log", [continued, log].filter(Boolean).join("\n\n")),
      section("Already concluded from this session", renderConcluded(concluded)),
      section(
        "Lessons already recorded",
        existing.length
          ? "If this session ran into one of these again, list it again with `matches` set to its id: " +
              "that is how a problem that keeps happening is told from one that happened once.\n\n" +
              renderExisting(existing)
          : renderExisting(existing),
      ),
      section("Rejected — do not propose these again", renderRejected(state.rejected)),
      OUTPUT_CONTRACT,
    ]
      .filter(Boolean)
      .join("\n\n")

  /**
   * The log gets whatever the budget leaves after everything else.
   *
   * It bounds what one subagent is asked to read, which is what an analysis costs, and keeps
   * a work order within what a read tool returns in one call. It is a character count rather
   * than a token count on purpose. Tokenisation is
   * model-specific and would need a dependency to estimate; characters are exact, and the
   * budget only has to be comfortably under a cliff, not next to it.
   */
  const overhead = compose("").length
  // A non-empty Log section brings its heading, a separator and, on a re-read, the blank
  // line between the continuation note and the log. Measuring the composition with a
  // one-character log gives exactly that frame, whether or not the section already exists.
  // Without it the budget was a few characters too generous, and a projection that fitted
  // `budget` produced a prompt a few characters over `maxInput`.
  const frame = compose("x").length - overhead - 1
  const room = maxInput - overhead - frame
  // Spend only the room that is actually left. `max(2000, room)` used to ignore a positive
  // room smaller than 2,000 and send more than `maxInput` anyway; 2,000 is only a floor for
  // the case where the fixed part alone is over budget, where nothing can be honoured and a
  // small excerpt beats an empty one.
  const budget = Number.isFinite(maxInput) ? (room > 0 ? room : 2000) : Infinity

  const log = projected(records, { budget })
  return {
    ok: true,
    text: compose(log.text),
    // How far through the log this order goes. An excerpt covers only up to its first gap,
    // so the mark stops there and the elided middle is read next time rather than skipped.
    through: log.through,
    elided: /\d+ steps? elided to fit the budget/.test(log.text),
  }
}

/**
 * A record, folded into the store: the rejected filtered out, the rest recorded by problem.
 */
export function recordAnswer({ session, lessons: raw, store, state, fingerprint, elided = false }) {
  const rejected = new Set(state.rejected.map((r) => r.id))
  const lessons = normaliseLessons(raw).filter((l) => !rejected.has(l.id) && !rejected.has(l.matches))
  const recorded = store.record(lessons, { session, fingerprint })
  return {
    lessons,
    recorded,
    // Said out loud: a lesson drawn from an excerpt is still a lesson, but the human should
    // know the reader did not see the whole session.
    detail: summarise(recorded, lessons.length) + (elided ? " (from an excerpt: the log was over budget)" : ""),
  }
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
  if (recorded.restored?.length) parts.push(`${recorded.restored.length} restored (${recorded.restored.join(", ")})`)
  if (recorded.merged?.length) parts.push(`${recorded.merged.length} recurring (${recorded.merged.join(", ")})`)
  if (recorded.archived?.length) parts.push(`${recorded.archived.length} archived`)
  return parts.join(", ") || "no change"
}

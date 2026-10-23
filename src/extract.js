import { OUTPUT_CONTRACT, normaliseLessons } from "./contract.js"

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
 * The work order for one log: which log to read, what is new in it, and what the plugin
 * knows that the reader cannot. Returns `{ skipped }` for a log that cannot hold evidence,
 * `{ ok: false }` when there is nothing to write it from, and otherwise `{ ok: true, text }`.
 *
 * It does **not** contain the log. It used to, compressed to fit one model call, with a
 * budget, a drop order and a coverage rule to go with it — all of which existed because a
 * one-shot call had to be handed everything at once. A subagent has read tools and a context
 * of its own: it can open the file, read the head, skip to the end, or read the whole thing,
 * and it is better at deciding which than any rule we could write from out here. What is
 * ours is which log, which part of it is new, and the bookkeeping it cannot see.
 */
export function composeOrder({
  records,
  session,
  /** Where the log is, as the subagent will open it: absolute, so any cwd resolves it. */
  logPath,
  /** The last step in the log, so the order can say how much there is to read. */
  lastN = 0,
  prompts,
  store,
  state,
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
  // live in the text, which is why a conversation that ran no tools is still analysed.
  //
  // `records` is the slice of the log that is new, plus the session's prompts whatever their
  // step — the one thing this function still needs the records for, now that the order points
  // at the log instead of carrying it.
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
  // material, that answer cost an analysis on the next command, whose own hand-over was
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
  if (!logPath) return { ok: false, detail: "the log has no path to point an analysis at" }

  const existing = store.list().filter((l) => l.status !== "rejected")

  /**
   * A session that is left open and returned to is never "finished", so its log is read more
   * than once — and the second read must not cover the ground the first one did. Saying which
   * steps are new is what stops the same lessons being derived again from material that was
   * already turned into them and decided on.
   */
  const scope =
    analysedUpTo > 0
      ? [
          `Read \`${logPath}\`.`,
          "",
          `Steps up to ${analysedUpTo} were analysed before and what came of them is below, so the ` +
            `lessons from them already exist. What is new is step ${analysedUpTo + 1} onwards — that is ` +
            "what to report on. Read the earlier steps too if you need them for context: the " +
            "session's instructions are up there, and they say what it was for.",
        ].join("\n")
      : `Read \`${logPath}\`. All of it is new; nothing from this session has been analysed before.`

  const text = [
    `<!-- ${WORK_MARK} -->`,
    prompt.text,
    section("Session", [`id: ${session}`, `log: ${logPath}`, `steps: 1 to ${lastN || "?"}`].join("\n")),
    section("What to read", scope),
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

  return { ok: true, text, lastN }
}

/**
 * A record, folded into the store: the rejected filtered out, the rest recorded by problem.
 */
export function recordAnswer({ session, lessons: raw, store, state, fingerprint, partial = false }) {
  const rejected = new Set(state.rejected.map((r) => r.id))
  const lessons = normaliseLessons(raw).filter((l) => !rejected.has(l.id) && !rejected.has(l.matches))
  const recorded = store.record(lessons, { session, fingerprint })
  return {
    lessons,
    recorded,
    // Said out loud: a lesson from part of a log is still a lesson, but the human should know
    // the reader said it did not get to the end.
    detail: summarise(recorded, lessons.length) + (partial ? " (from part of the log; the rest is still owed)" : ""),
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

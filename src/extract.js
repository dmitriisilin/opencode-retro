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

/** Step ranges as an order names them: `step 4, steps 6–9`. One spelling, shared with the tests. */
export const formatRanges = (ranges) => ranges.map(([a, b]) => (a === b ? `step ${a}` : `steps ${a}–${b}`)).join(", ")

/** A hand-over asking for a round: a marker, holding nothing to read. */
// Only the person's session's: a delegated one's neither opens a round nor ends one.
const isWorkHandover = (r) => r.k === "handover" && r.about === "work" && !r.from

/** The plugin's own tools: a call to one is the plugin's work wherever it is (analysis.md). */
const OWN_TOOLS = new Set(["retro_record", "retro_propose"])

/**
 * Whether a text carries the line the hand-over prescribes for a reader, at its start or right
 * after its first line. Not only at the start of the text: OpenCode puts a line of its own ahead of a
 * subagent's prompt ("You are a subagent spawned by another session."), so a check anchored
 * there never matched a live reader at all — found in the first bench run without the path
 * matching that had been catching them instead. A person can type a path, but does not type
 * this line by accident.
 */
export function isWorkLine(text) {
  return typeof text === "string" && WORK_LINE.test(text)
}
// At the start, or after one line before it — OpenCode's — and no further: a person pasting the
// whole hand-over, where the line sits indented deep in it, is not a reader (thirty-third review).
const WORK_LINE = new RegExp(`^\\s*(?:[^\\n]*\\n\\s*)?${WORK_MARK}: read `)

/**
 * The plugin's own rounds in a log, as step ranges (analysis.md, "The plugin's own work").
 *
 * A round is answered by the turn its `handover` with `about: "work"` starts, and runs to the
 * next `handover` of another kind or the next `prompt`, whichever comes first — neither part of
 * it, and only the person's session's (no `from`) counts: a delegated one's opens nothing and
 * ends nothing.
 * A call to one of the plugin's own tools is the plugin's wherever it is. One definition,
 * read two ways: the order lists the rounds for its reader to leave out, and the plugin does
 * not count them as new material.
 */
export function ownRounds(records) {
  const sorted = [...records].sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
  // Only the person's session ends a round. A delegated session's hand-over should never be
  // written — `retro_propose` refuses them — but a reader that slips past the gate, before its
  // creation is known or after a reload, must not close the round for the rest (fortieth review).
  const ends = (r) => !r.from && (r.k === "prompt" || (r.k === "handover" && !isWorkHandover(r)))
  const steps = new Set()
  for (let i = 0; i < sorted.length; i++) {
    if (!isWorkHandover(sorted[i])) continue
    // Where it ends, and whether a turn starts before that: a hand-over delivered into a turn
    // still running waits for it, and what that turn does is the person's (thirty-second
    // review). With no turn start to go by, the round starts at the hand-over itself.
    let end = i + 1
    // A second `work` hand-over inside the round — a `/retro` run again while it reads — is
    // the same round going on (thirty-fifth review).
    while (end < sorted.length && !ends(sorted[end])) end++
    // Was a turn running when the hand-over landed? Then it waits for that turn, and with no
    // turn starting after it the round is empty: the rest is the person's (thirty-third review).
    let inTurn = false
    for (let j = i - 1; j >= 0; j--) {
      const r = sorted[j]
      if (r.k !== "session" || r.from) continue
      inTurn = r.event === "start"
      break
    }
    // Starts at the next turn start — or, landing in a running turn, after that turn's end:
    // the turn that follows may not be logged as starting at all, since the plugin stops
    // owning a session when its turn ends and a hand-over's resumed turn fires no hook first
    // (forty-second review, reproduced against the entry point).
    let from = inTurn ? end : i
    for (let j = i + 1; j < end; j++) {
      const r = sorted[j]
      if (r.from || r.k !== "session") continue
      if (r.event === "start") {
        from = j
        break
      }
      if (inTurn && r.event === "end") {
        from = j + 1
        break
      }
    }
    // A `work` hand-over is the plugin's own text, the opening one and any second one alike:
    // named with its round, so the order's ranges stay whole and no hand-over goes unnamed
    // (thirty-sixth and thirty-seventh reviews). It holds nothing to read either way.
    for (let j = i; j < end; j++) if (j >= from || isWorkHandover(sorted[j])) steps.add(sorted[j].n)
    i = end - 1
  }
  // A delegated session that began inside a round — a reader worded its own way — is ours in
  // full, including what it writes after the round has closed: an early `retro_propose` ends
  // the round while the reader is still reading (thirty-fourth review).
  const readers = new Set()
  for (const r of sorted) if (r.k === "prompt" && r.from && steps.has(r.n)) readers.add(r.from)
  for (const r of sorted) {
    if (r.from && readers.has(r.from)) steps.add(r.n)
    // And the delegation that started one, wherever it lands — after an early `retro_propose`.
    if (r.k === "tool" && r.tool === "subagent" && r.child && readers.has(r.child)) steps.add(r.n)
    if (r.k !== "tool") continue
    // Ours wherever they land: a delegation's after-hook is written when its reader is done,
    // which an early `retro_propose` puts after the round has closed (thirty-second review).
    if (OWN_TOOLS.has(r.tool) || (r.tool === "subagent" && isWorkLine(r.input?.prompt))) steps.add(r.n)
  }
  // The ranges the order names are the steps themselves, run by run, so a reader is told about
  // everything that is ours — a reworded reader's records after its round included, and a
  // stray call to the plugin's own tools — and not only the rounds (thirty-fifth review).
  const listed = []
  let run = null
  for (const r of sorted) {
    if (steps.has(r.n)) {
      if (run) run[1] = r.n
      else listed.push((run = [r.n, r.n]))
    } else run = null
  }
  return { steps, ranges: listed }
}

/**
 * The last step an analysis could read something in: not the plugin's own, not a step that holds
 * nothing. Reading up to it is reading all of it, whatever trails after (thirty-third review).
 */
export function lastReadable(records, own = ownRounds(records).steps) {
  const plugin = repliesToPlugin(records)
  let last = 0
  for (const r of records) if (readable(r, plugin) && !own.has(r.n) && (r.n ?? 0) > last) last = r.n
  return last
}

/** Texts that answer one of the plugin's own hand-overs (not `work`: that one has a round). */
export function repliesToPlugin(records) {
  const out = new Set()
  let answering = null
  for (const r of [...records].sort((a, b) => (a.n ?? 0) - (b.n ?? 0))) {
    // The person's session's steps only: a subagent's prompt or hand-over neither starts nor
    // ends a reply to the plugin (forty-second review).
    if (r.from) continue
    if (r.k === "prompt" || (r.k === "handover" && !isWorkHandover(r))) answering = r.k
    else if (r.k === "text" && answering === "handover") out.add(r.n)
  }
  return out
}

/** A step that could hold evidence: what someone said or did (log.md, "Owed"). */
function readable(r, plugin) {
  return r.k === "prompt" || r.k === "tool" || (r.k === "text" && !plugin.has(r.n)) || (r.k === "step" && r.files?.length > 0)
}

/**
 * Whether the records a log gained since its mark (`added`, out of `all` — the whole log, or a
 * function that reads it, called only when it is needed) hold nothing to read:
 * each is a step that cannot hold evidence — a hand-over, a turn's start or end, a reply to the
 * plugin's own hand-over — or part of the plugin's own work. A log grown by nothing else is not
 * owed for it (log.md, "Owed"): otherwise every `/retro` left its own session waiting, and the
 * next one paid a read to skip the round.
 */
export function nothingNew(all, added) {
  // The common cases, cheaply, before the whole log is needed: nothing added that could be
  // material at all, or the person speaking — which is always something, and never a round's.
  if (!added.some((r) => readable(r, new Set()))) return true
  if (added.some((r) => r.k === "prompt" && !r.from)) return false
  const records = typeof all === "function" ? all() : all
  const own = ownRounds(records).steps
  const plugin = repliesToPlugin(records)
  return added.every((r) => !readable(r, plugin) || own.has(r.n))
}

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
  /** Where the open lessons are, so a reader can see what was recorded since this was written. */
  lessonsDir = null,
  /** The last step in the log, so the order can say how much there is to read. */
  lastN = 0,
  prompts,
  store,
  state,
  /** The last step of this session already turned into lessons; 0 for a first look. */
  analysedUpTo = 0,
  /** Lessons already decided from this very session, so the same ground is not covered twice. */
  concluded = [],
  /** The plugin's own rounds in the log, `[first, last]` each, for the reader to leave out. */
  rounds = [],
  /** Texts that answer the plugin's hand-overs, from the whole log — one rule with `nothingNew`. */
  replies = null,
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
  // One rule with `nothingNew`: the `work` hand-over's replies are its round's, already left
  // out; the other hand-overs' replies are the plugin talking to itself.
  const plugin = replies ?? repliesToPlugin(records)
  const newReply = records.some((r) => r.k === "text" && !plugin.has(r.n))
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
    rounds.length
      ? section(
          "The plugin's own work — leave it out",
          "These steps are the plugin's own — its rounds and its own calls, as the rules below " +
            "describe: " +
            formatRanges(rounds) +
            ". So is any call to `retro_record` or `retro_propose`, and any `subagent` call whose " +
            "prompt is a work order's line, wherever it is.",
        )
      : null,
    section("Already concluded from this session", renderConcluded(concluded)),
    section("Already fixed", renderFixed(store.listArchive?.() ?? [])),
    section("Lessons already recorded", renderExisting(existing, lessonsDir)),
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
export function recordAnswer({
  session,
  lessons: raw,
  store,
  state,
  fingerprint,
  partial = false,
  unreported = false,
  /** When a cited range actually happened, from the log: `(steps) => epoch ms | null`. */
  dateOf = null,
}) {
  const rejected = new Set(state.rejected.map((r) => r.id))
  const lessons = normaliseLessons(raw)
    .filter((l) => !rejected.has(l.id) && !rejected.has(l.matches))
    // When the friction happened, not when it was read. A backlog is analysed after the fixes
    // taken from the logs ahead of it, so a decision must only be reopened by evidence from
    // after it was taken (lesson.md). The log is the only thing that knows.
    .map((l) => (dateOf ? { ...l, seenAt: dateOf(l.steps) } : l))
  const recorded = store.record(lessons, { session, fingerprint })
  return {
    lessons,
    recorded,
    // Said out loud: a lesson from part of a log is still a lesson, but the human should know
    // the reader said it did not get to the end.
    detail:
      summarise(recorded, lessons.length) +
      (unreported
        ? " (the analysis did not say how far it read, so the log counts as unread and is asked about again)"
        : partial
          ? " (from part of the log; the rest is still owed)"
          : ""),
  }
}

const section = (title, body) => (body?.trim() ? `## ${title}\n\n${body.trim()}` : null)

/**
 * What is already recorded, and where to find the current set.
 *
 * The list is a snapshot taken when the order was written, and in a round with several logs
 * that is not enough: measured on the friction bench, three sessions that hit the same two
 * traps produced five lessons with five ids and a recurrence of 1 apiece, because all three
 * orders were written before any of them recorded and so each one said "None yet". Recurrence
 * is the strongest signal in a lesson's score, and it never fired.
 *
 * So the directory is named as well. A reader that only skims the order still gets the
 * snapshot; one that reads the directory gets what the analysis before it recorded a moment
 * ago. The hand-over asks for them one at a time for the same reason.
 */
function renderExisting(lessons, dir) {
  const lines = []
  if (dir) {
    // First, before any list. Measured on the bench: with the list first and this after it,
    // an analysis anchored on a snapshot that read "None yet" and filed a problem another
    // analysis had recorded seconds earlier under a different id. A reader has no reason to
    // go looking once it has been told there is nothing there.
    lines.push(
      `**Read \`${dir}\` before you decide that anything is new.** One file per lesson, with`,
      "its `id` in the frontmatter. That directory is the current set; anything below is only",
      "what was there when this order was written, and an analysis of another session in this",
      "same round may have recorded something since.",
      "",
    )
  }
  lines.push(
    "If this session ran into a problem that is already recorded, report it again with " +
      "`matches` set to its id: that is how a problem that keeps happening is told from one " +
      "that happened once.",
    "",
  )
  lines.push(
    lessons.length
      ? lessons.map((l) => `- \`${l.id}\` (seen in ${l.recurrence ?? 1}): ${l.statement}`).join("\n")
      : dir
        ? "_Nothing was recorded when this order was written. That is not the same as nothing_\n" +
          "_being there now — see above._"
        : "None yet.",
  )
  return lines.join("\n")
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

/**
 * Problems a human accepted and fixed, with the date the decision was taken.
 *
 * A backlog is the normal case: `/retro`, accept, integrate — and the next command analyses
 * the logs that were waiting behind it, written before the fix and walking into the same
 * trap. Without this the reader spends an analysis re-deriving a problem that is answered,
 * and reports it as a recurrence; `record()` discards such evidence mechanically
 * (lesson.md), but spending the reading on it is a waste either way, and a reader that knows
 * can say something useful instead.
 *
 * Most recent first, and bounded: the archive grows for the life of the project, and this is
 * context, not a ledger.
 */
function renderFixed(archived) {
  const fixed = archived
    .filter((l) => l.status === "accepted" && l.closedAt)
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)))
    .slice(0, 10)
  if (!fixed.length) return null
  return [
    "These were accepted and fixed. If this session ran *before* the date given, friction from",
    "them is history and not worth reporting — the fix came later. Report one again only if it",
    "happened after that date, which is real news: the fix did not hold.",
    "",
    ...fixed.map((l) => {
      const when = String(l.closedAt).slice(0, 10)
      const changed = Array.isArray(l.changed) && l.changed.length ? ` — changed ${l.changed.join(", ")}` : ""
      return `- \`${l.id}\` (fixed ${when}): ${l.statement}${changed}`
    }),
  ].join("\n")
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
  // Said out loud, because the alternative is a lesson silently dropped: this one was already
  // decided, and the evidence for it is from before the decision (lesson.md).
  if (recorded.stale?.length) {
    parts.push(`${recorded.stale.length} already fixed before this session ran (${recorded.stale.join(", ")})`)
  }
  return parts.join(", ") || "no change"
}

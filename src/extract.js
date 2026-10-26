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
  if (typeof text !== "string") return false
  // At the very start, at the first column: nothing before it, not even blank lines or spaces —
  // a prompt that opens with the indented line pasted from the hand-over is a person's (rounds
  // 3 and 4 of 10).
  if (text.startsWith(WORK_LINE)) return true
  // Or on the line right after OpenCode's own (measured: "You are a subagent spawned by
  // another session.", then exactly one newline). There an indent is allowed: the hand-over
  // shows the line indented, and an agent copying it exactly passes the indent on — and only
  // a subagent's prompt ever starts with OpenCode's line (round 5). No regular expression:
  // one that backtracked over the first line took seconds on a long pasted prompt, inside
  // the prompt hook (round 5 of 10).
  const nl = text.indexOf("\n")
  if (nl < 0 || !text.startsWith(OPENCODE_SUBAGENT)) return false
  return isIndentedWorkLine(text.slice(nl + 1))
}
/** How a reader's prompt begins: the hand-over writes it from this, so the two cannot drift. */
export const WORK_LINE = `${WORK_MARK}: read `
const OPENCODE_SUBAGENT = "You are a subagent"
/** The line, after spaces or tabs: as an agent writes a delegation, never a person's prompt. */
function isIndentedWorkLine(text) {
  let i = 0
  while (text[i] === " " || text[i] === "\t") i++
  return text.startsWith(WORK_LINE, i)
}

/*
 * What in a log is the plugin's own (analysis.md, "The plugin's own work").
 *
 * Two kinds of knowing, kept apart on purpose. What the plugin knows for certain — its own
 * hand-overs, its own tools, the delegations that start its readers and everything those
 * readers do — is named to the reader as steps to leave out, and only that: none of it can be
 * the person's. Where a round of its own begins and ends in a turn, and which text answers a
 * hand-over of its, it can only guess from the order of the log, which OpenCode does not
 * guarantee — events lag hooks, arrive twice, a turn's start goes unlogged, a prompt is steered
 * into a running turn. Those guesses decided what a reader was told to skip for two dozen
 * review rounds, each finding the next ordering, and a wrong guess lost the person's work
 * unread. So a guess is now used only where being wrong costs a read and never a step: whether
 * a log that grew is worth an order. Wrong that way, the mark stays where it was and the
 * material is read with whatever comes next. The round itself is the reader's to recognise,
 * from the hand-overs it sees in the log and what the contract says about them.
 */

/** A delegation whose prompt is a work order's line: a reader's start. */
const isReaderCall = (r) =>
  r.k === "tool" && r.tool === "subagent" && typeof r.input?.prompt === "string" && isIndentedWorkLine(r.input.prompt)

/** Sent to start a turn. A `work` hand-over always is: `/retro` is its one writer, never a tool result. */
const isSent = (r) => Boolean(r.sent) || isWorkHandover(r)

const byStep = (records) => [...records].sort((a, b) => (a.n ?? 0) - (b.n ?? 0))

/** Steps of hand-overs a failed-send notice names: never delivered, so they started nothing. */
function undelivered(sorted) {
  const out = new Set()
  for (const r of sorted) if (r.k === "handover" && r.undelivered && Number.isFinite(r.of)) out.add(r.of)
  return out
}

/**
 * The steps that are the plugin's own for certain, as a set and as the ranges an order names:
 * every hand-over of its, every call to `retro_record` or `retro_propose`, every delegation whose
 * prompt is a work order's line, and everything a reader did — a session such a delegation
 * started, a delegated session that called `retro_record` (only a reader does), and whatever
 * those started, at any depth. Never decided by where a step sits in the log.
 */
export function ownSteps(records) {
  const sorted = byStep(records)
  const readers = new Set()
  for (const r of sorted) {
    if (isReaderCall(r) && r.child) readers.add(r.child)
    if (r.from && r.k === "tool" && r.tool === "retro_record") readers.add(r.from)
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const r of sorted) {
      if (r.k === "tool" && r.tool === "subagent" && r.child && r.from && readers.has(r.from) && !readers.has(r.child)) {
        readers.add(r.child)
        grew = true
      }
    }
  }
  const steps = new Set()
  for (const r of sorted) {
    const delegatesReader = r.k === "tool" && r.tool === "subagent" && r.child && readers.has(r.child)
    if (r.k === "handover" || (r.from && readers.has(r.from)) || isReaderCall(r) || delegatesReader || (r.k === "tool" && OWN_TOOLS.has(r.tool))) {
      steps.add(r.n)
    }
  }
  const ranges = []
  let run = null
  for (const r of sorted) {
    if (steps.has(r.n)) {
      if (run) run[1] = r.n
      else ranges.push((run = [r.n, r.n]))
    } else run = null
  }
  return { steps, ranges }
}

/**
 * The plugin's exchange, as far as the order of the log suggests — a guess, and used only to
 * decide whether growth is worth an order (`nothingNew`), never to tell a reader what to skip:
 * after a `work` hand-over that was delivered, what the agent does until the person next
 * speaks; after a hand-over of another kind, what the agent says until then. A subagent first
 * told something in such a stretch goes with it.
 */
export function pluginExchange(records) {
  const sorted = byStep(records)
  const lost = undelivered(sorted)
  const out = new Set()
  let mode = null // "work" | "reply" | null
  // Whether a turn has started since the hand-over: the stretch lasts to the end of that turn
  // at most — the one the hand-over is taken up in — and never into the turns after it, which
  // something else began (a form answered, a resume from elsewhere).
  let started = false
  const with_ = new Set()
  for (const r of sorted) {
    if (r.from) {
      if (r.k === "prompt" && mode) with_.add(r.from)
      if (with_.has(r.from) && (mode === "work" || r.k === "text" || r.k === "prompt")) out.add(r.n)
      continue
    }
    if (r.k === "prompt") {
      mode = null
      with_.clear()
    } else if (r.k === "handover" && !r.undelivered && !lost.has(r.n)) {
      mode = isWorkHandover(r) ? "work" : "reply"
      started = false
    } else if (r.k === "session") {
      if (r.event === "start") started = true
      else if (r.event === "end" && started) {
        mode = null
        with_.clear()
      }
    } else if (mode === "work") out.add(r.n)
    else if (mode === "reply" && r.k === "text") out.add(r.n)
  }
  return out
}

/**
 * How many of the plugin's hand-overs the latest turn of the person's session began with — 0 or
 * 1. A turn's input is the last input written before it began: the person's prompt, or a sent,
 * delivered hand-over — one sent into the turn before waits in the inbox (measured, cycle 9),
 * so the turn after is the first it can begin. Read back from the current turn's start to the
 * previous one's. The current turn is the last one logged as started, unless the log went on
 * after that turn ended: then this one's start is not logged, and it is what came after.
 */
export function turnHandovers(records) {
  const sorted = byStep(records)
  const lost = undelivered(sorted)
  const isStart = (r) => !r.from && r.k === "session" && r.event === "start"
  let last = -1
  for (let i = sorted.length - 1; i >= 0 && last < 0; i--) if (isStart(sorted[i])) last = i
  // Where the current turn begins, and how far back its input can lie: to the previous turn's
  // start — or, for a turn whose start is not logged, to the end of the turn before it.
  let from = last < 0 ? sorted.length : last
  let floor = -1
  let end = -1
  for (let i = last + 1; i < sorted.length; i++) {
    const r = sorted[i]
    if (r.from) continue
    if (r.k === "session" && r.event === "end") end = i
    else if (end >= 0 && r.k !== "prompt" && r.k !== "handover") {
      from = i
      floor = end
      end = -1
    }
  }
  for (let i = from - 1; i > floor; i--) {
    const r = sorted[i]
    if (r.from) continue
    if (isStart(r) || r.k === "prompt") return 0
    if (r.k === "handover" && isSent(r) && !r.undelivered && !lost.has(r.n)) return 1
  }
  return 0
}

/**
 * The last step an analysis could read something in: anything readable that is not the
 * plugin's for certain. Reading up to it is reading all of it. Not narrowed by a guess: a step
 * credited as read and wrongly taken for the plugin's would be lost.
 */
export function lastReadable(records, own = ownSteps(records).steps) {
  let last = 0
  for (const r of records) if (readable(r) && !own.has(r.n) && (r.n ?? 0) > last) last = r.n
  return last
}

/** A step that could hold evidence: what someone said or did (log.md, "Owed"). */
function readable(r, exchange = null) {
  if (exchange?.has(r.n)) return false
  return r.k === "prompt" || r.k === "tool" || r.k === "text" || (r.k === "step" && r.files?.length > 0)
}

/**
 * Whether the records a log gained since its mark (`added`, out of `all` — the whole log, or a
 * function that reads it, called only when it is needed) hold nothing worth an order: each is a
 * step that cannot hold evidence, the plugin's own for certain, or — the one place a guess is
 * allowed — the plugin's exchange as the log's order suggests it. Wrong, it delays a read; the
 * mark does not move, so nothing is lost (log.md, "Owed").
 */
export function nothingNew(all, added) {
  if (!added.some((r) => readable(r))) return true
  if (added.some((r) => r.k === "prompt" && !r.from)) return false
  const records = typeof all === "function" ? all() : all
  const own = ownSteps(records).steps
  const exchange = pluginExchange(records)
  return added.every((r) => !readable(r, exchange) || own.has(r.n))
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
  exchange = null,
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
  // The same guess as `nothingNew`'s, and for the same kind of decision — whether a read is
  // worth paying for. A skip moves no step mark, so a wrong one costs a read later, not a step.
  const plugin = exchange ?? pluginExchange(records)
  // On `readable`, the one rule `nothingNew` and `lastReadable` use too (forty-sixth review).
  const asked = records.filter((r) => r.k === "prompt" && readable(r, plugin) && (!reread || r.n > analysedUpTo)).length
  const toolCalls = records.filter((r) => r.k === "tool").length
  const newReply = records.some((r) => r.k === "text" && readable(r, plugin))
  if (reread ? asked === 0 && toolCalls === 0 && !newReply : asked <= 1 && toolCalls === 0) {
    return { ok: true, skipped: true, detail: "nothing to extract (one exchange, nothing done)" }
  }

  const prompt = prompts.resolve("extract")
  if (!prompt) return { ok: false, detail: "no extract prompt could be resolved" }
  if (!logPath) return { ok: false, detail: "the log has no path to point an analysis at" }

  const existing = currentLessons(store)

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
          "These steps are the plugin's own, for certain — its hand-overs, its own tool calls, " +
            "the delegations that started its readers and everything those readers did: " +
            // Every one, those before the mark included: the reader is invited to read the earlier
            // steps for context, and a reader there may quote another session's problems.
            formatRanges(rounds) +
            ". Leave them out. The round around them — the agent starting readers — is yours to " +
            "recognise, as the rules below say.",
        )
      : null,
    section("Already concluded from this session", renderConcluded(concluded)),
    section("Already fixed", renderFixed(store.listArchive?.() ?? [])),
    section("Lessons already recorded", lessonsBlock(existing, lessonsDir)),
    section("Rejected — do not propose these again", renderRejected(state.rejected)),
    OUTPUT_CONTRACT,
  ]
    .filter(Boolean)
    .join("\n\n")

  return { ok: true, text, lastN }
}

/**
 * A stored moment, to the minute, in UTC — from the moment rather than the string, which may have
 * been written by hand with an offset. One for every text that shows a decision's time.
 */
export function utcMinute(at) {
  const ms = Date.parse(at)
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : String(at)
}

/** The lessons an order lists as already recorded: the open set, the rejected aside. */
const currentLessons = (store) => store.list().filter((l) => l.status !== "rejected")

// Around the list, so it is found by marks of the plugin's own: a heading of that name in the
// person's prompt, which comes first in the order, or a "## " inside a lesson's statement would
// otherwise be taken for the section's bounds.
const LESSONS_OPEN = "<!-- lessons recorded -->"
const LESSONS_CLOSE = "<!-- /lessons recorded -->"

/**
 * A work order still waiting for its reader, with its list of recorded lessons brought up to
 * date. Measured on the bench: readers go one at a time, and the third reader filed both of a
 * session's problems under new ids although the first had recorded them a minute before —
 * it had looked with a file search, which does not look inside `.retro/`, and was told
 * nothing was there. An order rewritten after every record lists them whatever the reader
 * does (checks after the ten rounds). Returns the text unchanged when it has no such section.
 */
export function refreshLessons(text, block) {
  const start = text.lastIndexOf(LESSONS_OPEN)
  const end = text.lastIndexOf(LESSONS_CLOSE)
  if (start < 0 || end < start) return text
  return text.slice(0, start) + block + text.slice(end + LESSONS_CLOSE.length)
}

/** The list `refreshLessons` writes, built once for every order a record leaves waiting. */
export const recordedLessons = ({ store, lessonsDir }) => lessonsBlock(currentLessons(store), lessonsDir)

// A statement is the model's prose and may quote anything, the marks included (this repository
// runs the plugin on itself): inside the block a comment opener is broken, so the only marks
// there are the two around it.
const breakMarks = (text) => String(text).replaceAll("<!--", "<!\u200b--")
const lessonsBlock = (lessons, dir) => `${LESSONS_OPEN}\n${breakMarks(renderExisting(lessons, dir).trim())}\n${LESSONS_CLOSE}`

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
      "its `id` in the frontmatter. Open the directory itself with your read tool, by that path: a",
      "file search such as `glob` does not look inside `.retro/` and comes back empty when lessons",
      "are there (measured). That directory is the current set; the list below is what was",
      "there when this order was last brought up to date, and an analysis of another session in",
      "this same round may have recorded something since.",
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
        ? "_Nothing was recorded when this order was last brought up to date. That is not the_\n" +
          "_same as nothing being there now — see above._"
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
    // By time, not by text: a time written by hand with an offset sorts wrongly as a string.
    .sort((a, b) => (Date.parse(b.closedAt) || 0) - (Date.parse(a.closedAt) || 0))
    .slice(0, 10)
  if (!fixed.length) return null
  return [
    "These were accepted and fixed, at the time given — and as the log's own `t`, which is",
    "milliseconds since the epoch, so a step can be compared with it directly. If what this",
    "session ran into happened *before* that time, friction from them is history and not worth",
    "reporting — the fix came later. Report one again only if it happened after it, which is",
    "real news: the fix did not hold, or not all of it.",
    "",
    ...fixed.map((l) => {
      // To the minute: a backlog and its fix are often on the same day, and a date alone left
      // the reader to work out from raw timestamps which side of the fix a session was on.
      const ms = Date.parse(l.closedAt)
      const when = Number.isFinite(ms) ? `${utcMinute(l.closedAt)}, t ${ms}` : String(l.closedAt)
      const changed = Array.isArray(l.changed) && l.changed.length ? ` — changed ${l.changed.join(", ")}` : ""
      return `- \`${l.id}\` (fixed ${when}): ${l.statement}${changed}`
    }),
  ].join("\n")
}

function renderRejected(rejected) {
  if (!rejected.length) return null
  // A person's reason, written after the lesson list: a mark quoted in it would be taken for
  // the list's own (`refreshLessons`), so a comment opener in it is broken too.
  return rejected.map((r) => `- \`${r.id}\`${r.reason ? ` — ${breakMarks(r.reason)}` : ""}`).join("\n")
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

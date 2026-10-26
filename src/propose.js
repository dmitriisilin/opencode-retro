import { score, staleSessions } from "./lessons.js"
import { DEFAULTS } from "./config.js"
import { SET_ASIDE } from "./selfcheck.js"
import { WORK_LINE, utcMinute } from "./extract.js"

/**
 * `/retro` (AGENTS.md decision 9, as amended).
 *
 * One invocation delivers one proposal — the highest-scoring lesson still awaiting a
 * decision — into the session the user ran the command in. That is where the plugin's job
 * ends: the human and the agent already in that session work out whether they like it and
 * how to integrate it. We do not patch files, and we do not drive the conversation.
 */

export const OPEN = new Set(["new", "later", undefined, null])

/**
 * Where the evidence logs live, as the hand-over should say it. A bare `sessions/` is
 * relative to `.retro/`, not to the project — and a reader has no reason to know that. A
 * live review was told `sessions/`, went to the project root, found nothing, and wrote the
 * mistake into `discovered`; the prompt file was corrected then, and this footer was the
 * same mistake in source. The caller passes the real directory when `options.dir` moves it.
 */
const SESSIONS = `${DEFAULTS.dir}/sessions`

/** How many lessons one `/retro all` carries. Beyond this, a plan stops being a plan. */
export const PROPOSE_LIMIT = DEFAULTS.proposeLimit

export function pickLesson(lessons, ctx) {
  return pickOpen(lessons, ctx)[0] ?? null
}

export function pickOpen(lessons, ctx = {}) {
  return lessons.filter((l) => OPEN.has(l.status)).sort((a, b) => score(b, ctx) - score(a, ctx))
}

export function renderBatch(
  lessons,
  { sessions = null, halfLife, currencies = new Map(), limit = PROPOSE_LIMIT, leadIn = null, queued = 0 } = {},
) {
  const shown = lessons.slice(0, limit)
  const lines = [
    asLeadIn(leadIn),
    "",
    `# retro — ${shown.length} lesson${shown.length === 1 ? "" : "s"} waiting`,
    "",
  ]
  if (lessons.length > shown.length) {
    lines.push(`(${lessons.length - shown.length} more below the cut; run \`/retro all\` again after this round.)`, "")
  }
  if (queued > 0) lines.push(backlogLine(queued), "")

  shown.forEach((lesson, i) => {
    const stale = staleSessions(lesson, sessions)
    lines.push(
      `## ${i + 1}. \`${lesson.id}\` — score ${round(score(lesson, { sessions, halfLife }))}`,
      "",
      lesson.statement ?? "",
      "",
      `Seen in ${lesson.recurrence ?? 1} session${(lesson.recurrence ?? 1) === 1 ? "" : "s"}, ` +
        `${lesson.cost ?? 0} step${(lesson.cost ?? 0) === 1 ? "" : "s"} spent` +
        (stale ? `, last seen ${stale} session${stale === 1 ? "" : "s"} ago` : "") +
        ".",
      "",
    )
    if (lesson.reopenedFrom) {
      lines.push(`**Came back** after being closed as ${lesson.reopenedFrom}.`, ...previousLines(lesson), "")
    }
    const currency = currencies.get(lesson.id)
    for (const line of hintLines(lesson, currency)) lines.push(line, "")
    if (lesson.proposal?.change) {
      lines.push(
        `**Target:** ${lesson.proposal.target ?? "not named"}`,
        "",
        lesson.proposal.change.trim(),
        "",
      )
    } else {
      lines.push("**No proposal** — the problem is named, where it belongs is a judgement call.", "")
    }
    if (lesson.ask) lines.push(`**Needs a human call:** ${lesson.ask.trim()}`, "")
  })

  lines.push("---", "", "Nothing has been changed. The plan comes first.")
  return lines.join("\n")
}

/**
 * The semantic half of the hand-over lives in `prompts/propose.md`, seeded into the user's
 * project and editable there — it decides what the agent treats as its job when a lesson
 * arrives, which is exactly the kind of thing worth iterating on in practice (AGENTS.md
 * decision 13).
 *
 * **One rule, not one per command.** There used to be a second file for `/retro all`, and
 * it was the same rule rewritten shorter: currency, where the fix belongs, local or global,
 * change nothing before a decision, record the outcome. Two copies of a judgement is one
 * copy the user edits and one that silently disagrees with it. What a batch actually needs
 * is nothing from the rule and only the shape of its answer — one plan, grouped by file,
 * dropped ones named — so that is a conditional section at the end of the same file. The
 * batch path sends the same rule and lets that section apply.
 *
 * This constant is only the fallback for when no prompt layer resolves at all, so that a
 * missing file degrades to a terse hand-over rather than a silent one.
 */
export const LEAD_IN_FALLBACK =
  "_opencode-retro: is each lesson below already resolved in this workspace as it is now? " +
  "If so, say so and record it as accepted. Otherwise relay what still stands and change " +
  "nothing until the human has decided, then record it with `retro_decide`._"

/** Wraps a prompt body as the italic aside the agent reads first. */
export const asLeadIn = (text, fallback = LEAD_IN_FALLBACK) => {
  const body = typeof text === "string" ? text.trim() : ""
  return body ? `_opencode-retro — how to hand this over:_\n\n${body}` : fallback
}

export function renderProposal(
  lesson,
  {
    total = 0,
    remaining = 0,
    currency = null,
    sessions = null,
    halfLife,
    leadIn = null,
    queued = 0,
    logs = SESSIONS,
  } = {},
) {
  const lines = [
    asLeadIn(leadIn),
    "",
    `# retro — \`${lesson.id}\``,
    "",
    lesson.statement ?? "",
    "",
    `Seen in ${lesson.recurrence ?? 1} session${(lesson.recurrence ?? 1) === 1 ? "" : "s"}` +
      `, ${lesson.cost ?? 0} step${(lesson.cost ?? 0) === 1 ? "" : "s"} spent on it` +
      `, confidence ${lesson.confidence ?? "?"} → score ${round(score(lesson, { sessions, halfLife }))}.`,
    "",
  ]

  const stale = staleSessions(lesson, sessions)
  if (stale != null && stale > 0) {
    lines.push(`Last seen ${stale} session${stale === 1 ? "" : "s"} ago.`, "")
  }
  if (lesson.reopenedFrom) {
    lines.push(
      `**This came back.** It was closed as ${lesson.reopenedFrom}, and a session read since ran ` +
        "into it again — after the decision, unless its log could not say when, in which case " +
        "it may be older than the fix. What it says above is what was found then; what was " +
        "decided before is below. The earlier fix may have held for part of it — check which " +
        "part still stands.",
      ...previousLines(lesson),
      "",
    )
  }
  for (const line of hintLines(lesson, currency)) lines.push(line, "")

  if (lesson.proposal?.change) {
    lines.push("## Proposed change", "")
    if (lesson.proposal.target) lines.push(`**${lesson.proposal.target}**`, "")
    lines.push(lesson.proposal.change.trim(), "")
  } else {
    lines.push(
      "## No proposal",
      "",
      "The problem is named but the fix is not. Naming it is the useful part; where it",
      "belongs is a judgement call.",
      "",
    )
  }

  if (lesson.ask) lines.push("## It needs your call", "", lesson.ask.trim(), "")

  if (lesson.body?.trim()) lines.push("## Evidence", "", lesson.body.trim(), "")

  const evidence = Array.isArray(lesson.evidence) ? lesson.evidence : lesson.evidence ? [lesson.evidence] : []
  if (evidence.length) {
    const cite = (e) =>
      `\`${logs}/${e.session}.jsonl\`${Array.isArray(e.steps) && e.steps.length ? ` steps ${e.steps.join("–")}` : ""}`
    const current = evidence.filter((e) => !e?.released)
    const earlier = evidence.filter((e) => e?.released)
    if (current.length) lines.push("", "From " + current.map(cite).join(", ") + ".", "")
    // Not presented as something to read: these logs were released while the lesson was
    // closed, and the reviewer is told the log is on disk only where it is.
    if (earlier.length) {
      lines.push(
        "Seen before it was closed in " +
          earlier.map((e) => `\`${e.session}\``).join(", ") +
          " — those logs were released then and may no longer be on disk.",
        "",
      )
    }
  }

  lines.push(
    "---",
    "",
    "This is a proposal, not a change — nothing has been edited. If it is right, say so and",
    "we will make it here, in this session; if it is wrong for this project, say that" +
      (remaining > 0 ? " and the next one can come up." : " and it will not come back."),
  )

  if (remaining > 0) {
    lines.push("", `${remaining} more lesson${remaining === 1 ? "" : "s"} waiting of ${total}. Run \`/retro\` again.`)
  }
  // Said here too, not only when there is nothing to review: a proposal in hand is exactly
  // when someone assumes the backlog is done.
  if (queued > 0) lines.push("", backlogLine(queued))

  return lines.join("\n")
}

/** What was decided before a lesson came back: its history, oldest first, a few lines each. */
function previousLines(lesson) {
  const decisions = Array.isArray(lesson.decisions) ? lesson.decisions : []
  // Every line of a block indented under its item: a proposal or a discovery of several lines
  // otherwise broke out of the list and read as part of the current proposal.
  const item = (label, text) => `  ${label}: ${String(text).trim().replaceAll("\n", "\n    ")}`
  return decisions.flatMap((d) => [
    "",
    `- ${d.status ?? "closed"}${d.closedAt ? ` on ${utcMinute(d.closedAt)}` : ""}` +
      `${d.decidedIn ? ` in \`${d.decidedIn}\`` : ""}: ${String(d.statement ?? "").trim().replaceAll("\n", "\n  ")}`,
    ...(d.proposal?.change ? [item(`Proposed then${d.proposal.target ? ` (${d.proposal.target})` : ""}`, d.proposal.change)] : []),
    ...(d.note ? [item("Decided", d.note)] : []),
    ...(Array.isArray(d.changed) && d.changed.length ? [`  Changed: ${d.changed.join(", ")}`] : []),
    ...(d.discovered ? [item("Found on the way", d.discovered)] : []),
  ])
}

/**
 * What we can say about currency without doing the agent's job: when the lesson was
 * recorded, and whether its target has moved since. Both are facts to bound a check with,
 * not conclusions.
 */
export function hintLines(lesson, currency) {
  const facts = []
  if (lesson?.recordedAt) facts.push(`recorded ${String(lesson.recordedAt).slice(0, 10)}`)
  if (currency?.hint) facts.push(currency.hint)
  if (!facts.length) return []
  return [`_Worth knowing before you check: ${facts.join("; ")}_`]
}

/** One sentence for the backlog, so both messages say it the same way. */
export const backlogLine = (queued) =>
  `${queued} log${queued === 1 ? "" : "s"} not analysed yet. Run \`/retro\` again to pick ${
    queued === 1 ? "it" : "them"
  } up.`

/** A failed analysis used to leave nothing but a counter in state.json. */
/** The `retro_propose` tool's input. */
export const PROPOSE_INPUT = {
  type: "object",
  properties: {
    all: { type: "boolean", description: "Every waiting lesson as one plan, as `/retro all` asked; otherwise the top one." },
  },
  additionalProperties: false,
}

/**
 * The hand-over that asks for the analyses (analysis.md, "Analysis"). Addressed to the agent:
 * start one subagent per work order, let each record its answer, then ask for the proposal.
 * The prompt for each subagent is given verbatim and carries the mark that keeps the
 * plugin's own work out of the logs.
 */
export function renderWorkOrders(orders, { all = false, failures = [], left = 0 } = {}) {
  const n = orders.length
  const lines = [
    "_opencode-retro — the logs come first:_",
    "",
    `${n} session log${n === 1 ? " is" : "s are"} waiting to be analysed before anything can be proposed. ` +
      "Each has a work order — a file naming the log to read, with the criteria and how to answer:",
    "",
    ...orders.map((o) => `- \`${o.path}\``),
    "",
    // No agent is named on purpose: the only subagent names this project has actually
    // observed from OpenCode are `build` and `explore` (AGENTS.md, "Subagents run in
    // sessions of their own"), and naming one we have not verified would send the agent
    // after something that may not exist. It knows its own roster; the requirement is only
    // that the subagent can read a file and call a tool.
    "Start one subagent per work order, with whichever general-purpose agent you have; it " +
      "only needs to read a file and call a tool. Give each exactly this prompt, with its own " +
      "path filled in, and nothing else:",
    "",
    `    ${WORK_LINE}<path> and do what it says.`,
    "",
    ...(n > 1
      ? [
          "**One at a time, waiting for each to record before starting the next.** They are " +
            "not independent: a problem that appears in several of these sessions has to be " +
            "reported as one recurring problem rather than as several new ones, and the only " +
            "way an analysis can tell is by reading what the ones before it recorded. Run " +
            "them at once and you get one lesson per session for one problem, each looking " +
            "like it happened once. This is slower on purpose; nothing here is waiting on it.",
        ]
      : []),
    "",
    "Do not read the work orders yourself and do not analyse the logs here: each subagent reads one, " +
      "in a context of its own, and records what it found with `retro_record`. When every subagent " +
      `has finished, call \`retro_propose\`${all ? " with `all: true`" : ""} and follow what it returns.`,
  ]
  for (const f of failures) lines.push("", `_${failureLine(f)}_`)
  if (left > 0) lines.push("", backlogLine(left))
  return lines.join("\n")
}

/**
 * One line about one log the last round did not get an answer for, or could not read.
 *
 * One function, because there were three. The same failure was rendered by the work-order
 * hand-over, by the proposal and by the "nothing to review" message, each in its own words —
 * and when the words had to change, cycle 10 fixed two of the three and cycle 11 found the
 * third still saying "Could not analyse" about a log nobody had tried to analyse. Not "could
 * not analyse", either: the plugin may not have analysed anything — it asked, and the asking
 * is all it knows (analysis.md, "Unanswered"). A failure it saw itself says so in its detail.
 */
export function failureLine(f) {
  return `opencode-retro on \`${f.session}\`: ${f.detail}`
}

export function renderFailures(extracted) {
  const failures = extracted?.failures ?? []
  if (!failures.length) return ""
  return (
    failures
      .map((f) => `_${failureLine(f)}_`)
      .join("\n") + "\n\n"
  )
}

export function renderNothing({ queued = 0, extracted = null, dir = DEFAULTS.dir, decided = 0, evicted = 0 } = {}) {
  const failures = extracted?.failures ?? []
  const lines = ["# retro", "", "Nothing to review."]
  for (const f of failures) {
    lines.push("", failureLine(f))
  }
  if (extracted?.analysed) {
    lines.push("", `Analysed ${extracted.analysed} session log${extracted.analysed === 1 ? "" : "s"} just now, with nothing to learn from ${extracted.analysed === 1 ? "it" : "them"}.`)
  }
  if (queued) lines.push("", backlogLine(queued))
  // A failure is not a session that went straight. Ending every empty hand-over with the
  // same two lines made a log that could not be read look like a clean bill of health —
  // measured live, the message said "Could not analyse …" and, two lines later, "Either the
  // sessions have been going straight". It sent a stranger looking at the project instead
  // of at the failure.
  if (failures.length) {
    // A log set aside is not tried again, and saying it is sent the reader to a `/retro` that
    // would not touch it (fifth review).
    const aside = failures.filter((f) => f.setAside).length
    const next =
      aside === failures.length
        ? `nothing reads ${aside === 1 ? "it" : "them"} again unless ${aside === 1 ? "it grows" : "they grow"}.`
        : aside
          ? `the next \`/retro\` tries again, except for what was ${SET_ASIDE}, which is read again only if it grows.`
          : "the next `/retro` tries again."
    lines.push(
      "",
      `The log${failures.length === 1 ? "" : "s"} above ${failures.length === 1 ? "was" : "were"} not read, so this is not a clean result: ${next}`,
      `\`${dir}/plugin.log\` says why each read failed; \`${dir}/selfcheck.md\` says whether the plugin is still watching.`,
    )
  } else {
    lines.push(
      "",
      decided || evicted
        ? `Nothing is open. In \`${dir}/archive/\`: ` +
            [
              decided ? `${decided} decided` : null,
              evicted ? `${evicted} pushed out by the cap without being decided, which come${evicted === 1 ? "s" : ""} back if the problem recurs` : null,
            ]
              .filter(Boolean)
              .join("; ") +
            // Nothing said of what came up since: the plugin cannot know it of a log not read,
            // its caller's own included.
            "."
        : queued
          ? "Nothing is recorded yet; the logs above are what there is to read."
          : "Either the sessions have been going straight, or nothing is recorded yet.",
      `\`${dir}/selfcheck.md\` says whether the plugin is actually watching.`,
    )
  }
  return lines.join("\n")
}

const round = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(1)))

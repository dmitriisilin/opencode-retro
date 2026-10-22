import { score, staleSessions } from "./lessons.js"
import { DEFAULTS } from "./config.js"

/**
 * `/retro` (AGENTS.md decision 9, as amended).
 *
 * One invocation delivers one proposal — the highest-scoring lesson still awaiting a
 * decision — into the session the user ran the command in. That is where the plugin's job
 * ends: the human and the agent already in that session work out whether they like it and
 * how to integrate it. We do not patch files, and we do not drive the conversation.
 */

export const OPEN = new Set(["new", "later", undefined, null])

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
      lines.push(`**Came back** after being closed as ${lesson.reopenedFrom}.`, "")
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
  { total = 0, remaining = 0, currency = null, sessions = null, halfLife, leadIn = null, queued = 0 } = {},
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
      `**This came back.** It was closed as ${lesson.reopenedFrom} and the problem recurred, so` +
        " whatever was done about it did not hold.",
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
      `\`sessions/${e.session}.jsonl\`${Array.isArray(e.steps) && e.steps.length ? ` steps ${e.steps.join("–")}` : ""}`
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
export function renderFailures(extracted) {
  const failures = extracted?.failures ?? []
  if (!failures.length) return ""
  return (
    failures
      .map((f) => `_opencode-retro could not analyse \`${f.session}\`: ${f.detail}_`)
      .join("\n") + "\n\n"
  )
}

export function renderNothing({ queued = 0, extracted = null } = {}) {
  const lines = ["# retro", "", "Nothing to review."]
  for (const f of extracted?.failures ?? []) {
    lines.push("", `Could not analyse \`${f.session}\`: ${f.detail}`)
  }
  if (extracted?.analysed) {
    lines.push("", `Analysed ${extracted.analysed} session log${extracted.analysed === 1 ? "" : "s"} just now, with nothing to learn from ${extracted.analysed === 1 ? "it" : "them"}.`)
  }
  if (queued) lines.push("", backlogLine(queued))
  lines.push(
    "",
    "Either the sessions have been going straight, or nothing is recorded yet.",
    "`.retro/selfcheck.md` says whether the plugin is actually watching.",
  )
  return lines.join("\n")
}

const round = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(1)))

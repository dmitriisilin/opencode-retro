import { score, staleSessions } from "./lessons.js"

/**
 * `/retro` (AGENTS.md decision 9, as amended).
 *
 * One invocation delivers one proposal — the highest-scoring lesson still awaiting a
 * decision — into the session the user ran the command in. That is where the plugin's job
 * ends: the human and the agent already in that session work out whether they like it and
 * how to integrate it. We do not patch files, and we do not drive the conversation.
 */

export const OPEN = new Set(["new", "later", undefined, null])

/** How many lessons one `/retro all` will carry. Beyond this, a plan stops being a plan. */
export const AUTO_LIMIT = 10

export function pickLesson(lessons, ctx) {
  return pickOpen(lessons, ctx)[0] ?? null
}

export function pickOpen(lessons, ctx = {}) {
  return lessons.filter((l) => OPEN.has(l.status)).sort((a, b) => score(b, ctx) - score(a, ctx))
}

export function renderBatch(
  lessons,
  { sessions = null, halfLife, currencies = new Map(), limit = AUTO_LIMIT, leadIn = null, queued = 0 } = {},
) {
  const shown = lessons.slice(0, limit)
  const lines = [
    asLeadIn(leadIn, AUTO_LEAD_IN_FALLBACK),
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
 * The semantic half of the hand-off lives in `prompts/review.md` and
 * `prompts/review-auto.md`, seeded into the user's project and editable there — it decides
 * what the agent treats as its job when a lesson arrives, which is exactly the kind of
 * thing worth iterating on in practice (AGENTS.md decision 13).
 *
 * These constants are only the fallback for when no prompt layer resolves, so that a
 * missing file degrades to a terse hand-off rather than a silent one.
 */
export const LEAD_IN_FALLBACK =
  "_opencode-retro: is this already resolved in this workspace as it is now? If so, say so " +
  "and record it as accepted. Otherwise relay the proposal below and change nothing until " +
  "the human has decided, then record it with `retro_decide`._"

export const AUTO_LEAD_IN_FALLBACK =
  "_opencode-retro: for each lesson below, is it already resolved in this workspace as it is " +
  "now? Come back with one plan covering the ones that still stand. Change nothing until the " +
  "human approves it, then record each with `retro_decide`._"

/** Wraps a prompt body as the italic aside the agent reads first. */
export const asLeadIn = (text, fallback) => {
  const body = typeof text === "string" ? text.trim() : ""
  return body ? `_opencode-retro — how to hand this over:_\n\n${body}` : fallback
}

export function renderProposal(
  lesson,
  { total = 0, remaining = 0, currency = null, sessions = null, halfLife, leadIn = null, queued = 0 } = {},
) {
  const lines = [
    asLeadIn(leadIn, LEAD_IN_FALLBACK),
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
    lines.push(
      "",
      "From " +
        evidence
          .map((e) => `\`sessions/${e.session}.jsonl\`${Array.isArray(e.steps) ? ` steps ${e.steps.join("–")}` : ""}`)
          .join(", ") +
        ".",
      "",
    )
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
  if (extracted?.live) {
    lines.push(
      "",
      `Read ${extracted.live} log${extracted.live === 1 ? "" : "s"} of ${
        extracted.live === 1 ? "a session" : "sessions"
      } still working. Nothing is settled while a session can still add to it, so ${
        extracted.live === 1 ? "it" : "they"
      } will be read again when there is more.`,
    )
  }
  if (extracted?.analysed) {
    lines.push("", `Analysed ${extracted.analysed} finished session${extracted.analysed === 1 ? "" : "s"} just now, with nothing to learn from ${extracted.analysed === 1 ? "it" : "them"}.`)
  }
  if (queued) lines.push("", backlogLine(queued))
  lines.push(
    "",
    "Either the sessions have been going straight, or nothing is recorded yet.",
    "`.retro/selfcheck.md` says whether the plugin is actually watching.",
  )
  return lines.join("\n")
}

/** The decision tool's schema. Bookkeeping only — it never edits the harness. */
export const DECIDE_INPUT = {
  type: "object",
  properties: {
    id: { type: "string", description: "The lesson id, as shown in the proposal." },
    status: {
      type: "string",
      enum: ["accepted", "rejected", "later"],
      description:
        "accepted: the change was made, or the problem turned out to be already settled. " +
        "rejected: it is wrong for this project, do not propose it again. " +
        "later: keep it open, ask another time.",
    },
    note: { type: "string", description: "Why this was decided, in a line or two." },
    changed: {
      type: "array",
      items: { type: "string" },
      description:
        "Files actually changed, if any. Often not what the proposal named — record what was " +
        "really done, not what was suggested.",
    },
    discovered: {
      type: "string",
      description:
        "Anything that came out while doing it and is not in the lesson: a consequence the " +
        "proposal missed, a second place that needs the same fix, a reason the obvious fix " +
        "was wrong. This is the part that only exists because the work happened.",
    },
  },
  required: ["id", "status"],
  additionalProperties: false,
}

export function decide({ id, status, note, changed, discovered }, { store, state }) {
  const lesson = store.list().find((l) => l.id === id)

  if (!lesson) {
    // Idempotent on purpose. A decided lesson has moved to the archive, and a second call
    // used to answer "no lesson", which reads as a failure: in a live session that sent the
    // agent hunting the filesystem for a tool it already had, and calling it twice more.
    const closed = store.listArchive().find((l) => l.id === id)
    if (closed) {
      return { ok: true, already: true, detail: `\`${id}\` was already recorded as ${closed.status}` }
    }
    return {
      ok: false,
      detail: `no lesson \`${id}\` is open or archived. Open lessons: ${
        store.list().map((l) => l.id).join(", ") || "none"
      }`,
    }
  }

  // A rejection has to outlive the lesson file, or the extractor proposes it again.
  if (status === "rejected") state.reject(id, note)

  const outcome = {
    note: note ?? lesson.note,
    ...(changed?.length ? { changed } : {}),
    ...(discovered ? { discovered } : {}),
  }

  if (status === "later") {
    store.write({ ...lesson, status, ...outcome })
    return { ok: true, detail: `\`${id}\` kept for later` }
  }

  // Decided means closed: `lessons/` holds open questions, and nothing is deleted — a
  // closed lesson moves to `archive/`, where recurrence will find it if it comes back.
  const closed = store.close(id, status, outcome)
  if (!closed) return { ok: false, detail: `\`${id}\` could not be closed` }
  return { ok: true, detail: `\`${id}\` is ${status} and moved to archive/` }
}

const round = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(1)))

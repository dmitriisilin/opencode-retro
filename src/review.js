import { score } from "./lessons.js"

/**
 * `/retro` (AGENTS.md decision 9, as amended).
 *
 * One invocation delivers one proposal — the highest-scoring lesson still awaiting a
 * decision — into the session the user ran the command in. That is where the plugin's job
 * ends: the human and the agent already in that session work out whether they like it and
 * how to integrate it. We do not patch files, and we do not drive the conversation.
 */

export const OPEN = new Set(["new", "later", undefined, null])

export function pickLesson(lessons) {
  return lessons.filter((l) => OPEN.has(l.status)).sort((a, b) => score(b) - score(a))[0] ?? null
}

/** Addressed to the agent in the session, because that is who reads it first. */
export const LEAD_IN =
  "_opencode-retro: relay the proposal below to the human, answer questions about it, and " +
  "change nothing until they have decided. When they have, record it with `retro_decide`._"

export function renderProposal(lesson, { total = 0, remaining = 0 } = {}) {
  const lines = [
    LEAD_IN,
    "",
    `# retro — \`${lesson.id}\``,
    "",
    lesson.statement ?? "",
    "",
    `Seen in ${lesson.recurrence ?? 1} session${(lesson.recurrence ?? 1) === 1 ? "" : "s"}` +
      `, ${lesson.cost ?? 0} step${(lesson.cost ?? 0) === 1 ? "" : "s"} spent on it` +
      `, confidence ${lesson.confidence ?? "?"} → score ${round(score(lesson))}.`,
    "",
  ]

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

  return lines.join("\n")
}

export function renderNothing({ queued = 0, extracted = null } = {}) {
  const lines = [LEAD_IN.replace("the proposal below", "the note below"), "", "# retro", "", "Nothing to review."]
  if (extracted) lines.push("", `Just extracted from your last session: ${extracted}.`)
  if (queued) lines.push("", `${queued} session${queued === 1 ? "" : "s"} still queued for extraction.`)
  lines.push(
    "",
    "Either your sessions have been going straight, or there is nothing recorded yet.",
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
        "accepted: the change was made (by us, in this session). rejected: it is wrong for this project, " +
        "do not propose it again. later: keep it, ask another time.",
    },
    note: { type: "string", description: "Why, in one line. For rejected this is worth filling in." },
  },
  required: ["id", "status"],
  additionalProperties: false,
}

export function decide({ id, status, note }, { store, state }) {
  const lesson = store.list().find((l) => l.id === id)
  if (!lesson) return { ok: false, detail: `no lesson \`${id}\`` }

  store.write({ ...lesson, status, note: note ?? lesson.note })
  // A rejection has to outlive the lesson file, or the extractor proposes it again.
  if (status === "rejected") state.reject(id, note)
  return { ok: true, detail: `\`${id}\` is now ${status}` }
}

const round = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(1)))

/**
 * The third artifact: raw log, lesson, decision.
 *
 * `retro_decide` is bookkeeping and nothing else — it never edits the harness. What it
 * records is what actually happened, which is not the same as what was proposed, and that
 * difference is the only thing the accept/reject history can be learned from later.
 */

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

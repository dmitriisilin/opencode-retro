import { clamp } from "./config.js"

/**
 * The end of a turn. session.idle never fires outside the TUI (AGENTS.md Gotcha 2), so the end
 * of work is session.execution.*. One list; `index.js` asks through `isTurnEnd`.
 */
const TURN_ENDS = ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]
export const isTurnEnd = (event) => TURN_ENDS.includes(event?.type)

/**
 * Turns OpenCode hook and event payloads into shadow-log records.
 *
 * Deliberately free of any `ctx` dependency: the same handlers are driven by the live
 * plugin and by the payload fixtures in test/, which is the only way to iterate on the
 * record format without running OpenCode.
 *
 * Two facts from M0 shape this (AGENTS.md "What the payloads actually look like"):
 *   - tool calls run in parallel, so before/after are paired by call id, never by order;
 *   - hooks carry no `durable.seq`, only events do, so `n` — our own per-session counter,
 *     assigned at append time — is the step index, and `seq` is recorded when an event
 *     happens to supply it.
 *
 * A subagent runs in a session of its own, with its own execution events and its own tool
 * calls (measured: agent `explore`, its own sessionID, `parentID` on `session.created`).
 * Its work belongs to the task that delegated it, so its records are written into the
 * parent's log and it is never analysed on its own. Otherwise one delegation would become a
 * second log, a second model call and a second count against the same problem — and the
 * fragment would be read without the instruction that caused it.
 */
export function createIngest({
  emit,
  maxOutput,
  now = () => Date.now(),
  parentOf = () => null,
  // Where this session's numbering left off. The counter is in memory, so without this a new
  // process appending to an existing log starts again at 1 and a lesson's step range stops
  // resolving to one record. Measured on real logs: three and four such blocks in one file.
  startAt = () => 0,
}) {
  /**
   * sessionID -> { n, pending: Map<callID, started>, completed: Set<callID>,
   *                seq: Map<callID, number>, counts }
   *
   * `completed` exists because one call id can produce two after hooks: a tool invoked
   * through Code Mode's `execute` arrives as the inner tool and again as its wrapper, both
   * with the same id. Recording both made the extractor read one action as two — measured
   * live, it derived a lesson saying `retro_decide` had been called twice — so the first
   * record wins.
   */
  const sessions = new Map()

  const freshCounts = () => ({ prompts: 0, handovers: 0, toolHook: 0, toolEvents: 0, unfinished: 0, steps: 0, texts: 0, records: 0 })

  function session(id) {
    let s = sessions.get(id)
    if (!s) {
      s = {
        id,
        // Read at the first append, not here: a session created by a read — `counts`, `pending` —
        // would otherwise hold a number another process may have moved on from by then.
        n: null,
        pending: new Map(),
        completed: new Set(),
        seq: new Map(),
        counts: freshCounts(),
      }
      sessions.set(id, s)
    }
    return s
  }

  /**
   * The session whose log this work belongs to: a delegation's root, not the child.
   *
   * One level is not enough. A subagent can delegate to another, and `parentOf` gives one
   * link at a time, so the work of the deepest child would land in the middle session's log —
   * which is never analysed, because a session that is somebody's child is never queued. The
   * link may also be learned in either order, so this has to be resolved at write time.
   */
  const owner = (sessionID) => {
    let current = sessionID
    // A guard, not a depth limit: a malformed map must not hang the user's session.
    for (let i = 0; i < 64; i++) {
      const parent = parentOf(current)
      if (!parent || parent === current) return current
      current = parent
    }
    return current
  }

  /** sessionID -> the `durable.seq`s recently taken in, so a repeat is known (`event`). */
  const lastSeq = new Map()

  function append(sessionID, record) {
    const target = owner(sessionID)
    const s = session(target)
    s.counts.records++
    // A turn going on again — a start, or work being done — makes its end news; a prompt or a
    // hand-over written between turns does not, since neither is a turn yet.
    // Only the root's own turn: a delegation's start or end, folded in from a log it wrote before
    // its parent was known, says nothing about whether the root's turn has ended.
    if (target === sessionID) {
      if (record.k === "session") s.endWritten = record.event === "end"
      else if (record.k !== "prompt" && record.k !== "handover") s.endWritten = false
    }
    // A record of a delegation's own session says so: its prompt is the delegation's
    // instruction, not the person's, and the log alone could not tell the two apart.
    // Read from the file again after a turn ended: another process may have written the turns
    // in between, and numbering on from memory wrote its step numbers a second time.
    if (s.n === null) s.n = startAt(target) ?? 0
    emit(target, { v: 1, n: ++s.n, t: now(), ...(target !== sessionID ? { from: sessionID } : {}), ...record })
    return s.n
  }

  return {
    /**
     * Records written for a session before it was known to have a parent.
     *
     * A subagent's own instruction arrives through `session.prompt` before
     * `session.created` reaches the event stream, so it lands under the child's id and is
     * lost from the task it belongs to. Re-appending renumbers it into the parent's
     * sequence; the caller deletes the orphan log.
     */
    absorb(sessionID, records) {
      // Whatever a child did before the link was known was done for the parent, so the
      // parent is ours from that moment too.
      const target = owner(sessionID)
      const parent = session(target)
      parent.owned = true
      const child = sessions.get(sessionID)
      // Old step number -> new one. A lesson extracted from the orphan log before the link
      // was known cites the old numbers; this is what lets its evidence follow the records
      // into the root's log instead of pointing at a file that no longer exists.
      const renumbered = new Map()
      for (const { n, t, ...rest } of records) {
        append(sessionID, rest)
        if (Number.isFinite(n)) renumbered.set(n, parent.n)
      }
      parent.renumbered = renumbered
      if (child && target !== sessionID) {
        // The counters recorded before the link are part of the parent's evidence now. If the
        // prompt is not moved with it, the self-check reports the parent's prompt hook dead
        // because the only prompt it ever saw was the child's instruction.
        for (const key of ["prompts", "texts", "steps", "toolHook", "toolEvents"]) {
          parent.counts[key] += child.counts[key]
        }
        // And its calls still open, so the parent's end writes them as unfinished. Dropped, a
        // child interrupted mid-call lost the call from the log while its event still
        // counted — and the self-check called the tool hook dead (twelfth review).
        for (const [id, call] of child.pending) if (!parent.pending.has(id)) parent.pending.set(id, call)
        for (const [id, seq] of child.seq) if (!parent.seq.has(id)) parent.seq.set(id, seq)
        // And the calls it already recorded, so a Code Mode wrapper's after-hook arriving after
        // the adoption is still the same call, not a second record (thirteenth review).
        for (const id of child.completed) parent.completed.add(id)
        sessions.delete(sessionID)
      }
      return parent
    },

    /**
     * Whether this session is one we own: a hook fired for it, or for a session that
     * delegated to it. The event stream can only annotate; it may never open a session.
     */
    owned: (sessionID) => Boolean(sessions.get(owner(sessionID))?.owned),

    /** Per-session counters, read by the self-check. A child is read through its owner. */
    counts: (sessionID) => session(owner(sessionID)).counts,
    sessions: () => [...sessions.keys()],
    forget: (sessionID) => sessions.delete(sessionID),

    /**
     * Its log was pruned: the next one is read from its own start, so numbering starts again —
     * and the session stays the plugin's, or the next turn's start would be dropped (forty-
     * fourth and forty-fifth reviews).
     */
    restartNumbering(sessionID) {
      const s = sessions.get(owner(sessionID))
      // Read from the file again at the next append, as after a turn: none there means 0.
      if (s) s.n = null
    },

    /**
     * A turn ended: what was counted for it is reset, and the session stays ours. Forgetting
     * it outright, as the end of a turn used to, dropped the next turn's start whenever that
     * turn began with no hook — a hand-over's resumed turn — so its round could not be found
     * (forty-third review).
     */
    endTurn(sessionID) {
      const s = sessions.get(owner(sessionID))
      if (!s) return
      s.pending.clear()
      s.completed.clear()
      s.seq.clear()
      s.counts = freshCounts()
      s.countedHandovers = new Set()
      // The numbering too, as forgetting did: the next turn starts from what the file says.
      s.n = null
    },

    /** Unpaired calls, flushed when a session ends so an interrupt leaves no silent gap. */
    pending: (sessionID) => [...session(sessionID).pending.values()],

    prompt(p) {
      const s = session(owner(p.sessionID))
      s.owned = true
      s.counts.prompts++
      append(p.sessionID, {
        k: "prompt",
        message: p.messageID ?? null,
        delivery: p.delivery ?? null,
        text: p.prompt?.text ?? "",
        files: p.prompt?.files ?? [],
      })
    },

    toolBefore(p) {
      const before = session(owner(p.sessionID))
      before.owned = true
      // A second before with the same id is the `execute` wrapper around a tool we have
      // already been told about. Keep the inner call, which is the action itself.
      if (before.pending.has(p.id)) return
      before.pending.set(p.id, {
        id: p.id,
        // Whose call it is: written as unfinished at the root's end, a delegated one keeps `from`.
        session: p.sessionID,
        tool: p.tool,
        input: p.input,
        message: p.messageID ?? null,
        agent: p.agent ?? null,
        startedAt: now(),
      })
    },

    toolAfter(p) {
      const s = session(owner(p.sessionID))
      s.owned = true
      // The after-hook of a call the turn's end already wrote as unfinished — an interrupt, and
      // the aborted call reporting late: that call has its record, and this turn's counts are
      // not its (the review after the stranger's hour).
      // Not consumed: Code Mode reports a call twice, the inner tool and its wrapper.
      if (s.flushed?.has(p.id)) return
      s.counts.toolHook++
      const started = s.pending.get(p.id)
      s.pending.delete(p.id)
      // One call id is one record. Code Mode's `execute` reports its inner tool and the
      // wrapper separately, both under the same id; appending both made the extractor read
      // one action as two calls and invent a lesson about it (measured live).
      if (s.completed.has(p.id)) return
      s.completed.add(p.id)
      append(p.sessionID, {
        k: "tool",
        seq: s.seq.get(p.id) ?? null,
        id: p.id,
        tool: p.tool,
        agent: p.agent ?? started?.agent ?? null,
        message: p.messageID ?? started?.message ?? null,
        input: p.input ?? started?.input,
        status: p.status,
        ms: started ? now() - started.startedAt : null,
        ...detail(p, maxOutput),
      })
    },

    /**
     * What the plugin itself said to a session.
     *
     * A hand-over is delivered with `session.synthetic`, and that does **not** fire the
     * `session.prompt` hook — measured: every session whose only input arrived that way has
     * a log with tool calls, text and steps in it and not one prompt record. So the log of a
     * review session showed an agent reading files and editing them for no stated reason,
     * with the instruction that caused all of it missing. We are the sender, so we can write
     * it ourselves; it is not the user's prompt and does not pretend to be one.
     *
     * It also marks the session as ours, which it is: the command ran in it.
     */
    handover(sessionID, text, about = "lesson", { sent = false, undelivered = false, of } = {}) {
      const s = session(owner(sessionID))
      s.owned = true
      // Counted because a hand-over is the only input some sessions ever get. The self-check
      // reads `prompts` to decide whether the prompt hook worked, and a `/retro` review
      // session has none — see `assess`, which must not call that a dead hook.
      // Only one sent to start a turn, and delivered: a tool result, or a notice that a send
      // failed, started nothing — as `turnHandovers` reads the log, for when it cannot be read.
      // And one counted before its send failed is taken back by the notice that names it —
      // only that one, and only in the turn it was counted in.
      if (undelivered && s.countedHandovers?.delete(of)) s.counts.handovers--
      // `about` separates the two hand-overs the plugin writes: a lesson put to the human,
      // and a request for the analyses that have to run first. They read identically in a
      // log and mean different things — the extraction contract discounts work that reviews
      // a lesson it was handed, which would have swallowed real work done after a request
      // for an analysis.
      // `sent`: sent to start a turn, as `/retro`'s hand-overs are, notices included — not a tool
      // result the agent already holds; only a sent one can be what started a turn (forty-eighth).
      // Whether it resumes the session: sent to one this process knows to be idle — it wrote the
      // end of the last turn itself, and nothing has happened since. Known at the moment of
      // sending, not inferred from the log's order later; after a reload, or with a turn whose
      // start was never seen, it is not known, and not claimed (analysis.md).
      const resumes = sent && !undelivered && s.endWritten === true
      const n = append(sessionID, {
        k: "handover",
        about,
        ...(sent ? { sent: true } : {}),
        ...(resumes ? { resumes: true } : {}),
        // The hand-over it names by its step never arrived: it started nothing (round 2 of 10).
        // Named, not taken to be the one above: another can be written while the send is
        // awaited.
        ...(undelivered ? { undelivered: true, ...(Number.isFinite(of) ? { of } : {}) } : {}),
        text: text ?? "",
      })
      if (sent && !undelivered) {
        s.counts.handovers++
        ;(s.countedHandovers ??= new Set()).add(n)
      }
      return n
    },

    /**
     * Everything we take from the event stream rather than from a hook.
     *
     * An event may annotate a session we already own; it may never open one. The hooks fire
     * only for sessions belonging to this location, while `ctx.event.subscribe` reaches
     * every session in the project — including one running in a git worktree of it. Both
     * instances used to write a log for that session: two files under the same id, with
     * different contents, since the worktree's copy had the prompt and ours did not. Ours
     * then reported `BROKEN prompt hook — most likely renamed upstream` about a session
     * that was perfectly healthy, queued it for analysis, and counted it towards freshness.
     * A hook having fired is what makes a session ours, so that is the gate.
     */
    event(e) {
      const sessionID = e?.data?.sessionID
      if (!sessionID) return
      const s = sessions.get(owner(sessionID))
      if (!s?.owned) return
      const seq = e?.durable?.seq ?? null
      // An event delivered again, or late, is known by its own place in its session's sequence:
      // every event carries `durable.seq`, monotonic per session — the event's own session, a
      // subagent's having one of its own. One guard for every kind: a repeated start or end read
      // as a turn boundary that never happened, a repeated text as said twice.
      // Only the same event again: one that arrives out of order is still news, and dropped it
      // would lose a turn's end. The seqs kept are a session's recent ones, which is where a
      // repeat comes from.
      if (seq != null) {
        let seen = lastSeq.get(sessionID)
        if (!seen) lastSeq.set(sessionID, (seen = new Set()))
        if (seen.has(seq)) return "repeated"
        seen.add(seq)
        if (seen.size > 512) seen.delete(seen.values().next().value)
      }

      switch (e.type) {
        case "session.tool.called":
          s.counts.toolEvents++
          if (e.data.id != null && seq != null) s.seq.set(e.data.id, seq)
          return

        case "session.text.ended":
          s.counts.texts++
          append(sessionID, {
            k: "text",
            seq,
            message: e.data.assistantMessageID ?? null,
            text: e.data.text ?? "",
          })
          return

        case "session.step.ended":
          s.counts.steps++
          append(sessionID, {
            k: "step",
            seq,
            message: e.data.assistantMessageID ?? null,
            finish: e.data.finish ?? null,
            snapshot: e.data.snapshot ?? null,
            files: e.data.files ?? [],
            tokens: e.data.tokens ?? null,
            cost: e.data.cost ?? null,
          })
          return

        case "session.execution.started":
          if (parentOf(sessionID)) return // a delegation is a step, not a session
          append(sessionID, { k: "session", seq, event: "start" })
          return

        default:
          if (!isTurnEnd(e)) return
          if (parentOf(sessionID)) return // the parent is still working
          // A second end for the same turn — the event repeated, or a late one — writes nothing:
          // read in log order, it was a turn boundary that never happened, and cut the round
          // that follows a hand-over short at it (the review after the stranger's hour). The
          // session stays ours across turns, so nothing else stops it any more.
          // Known by the event's own place in the session's sequence where it has one — every
          // event carries `durable.seq`, monotonic per session — and only without it by whether
          // a turn has gone on since the last end written.
          // Without a `seq` to go by, a second end with no turn gone on since is taken for the same
          // one. Not with one: a real turn whose start went unlogged has nothing else to show for
          // itself, and judged by records it lost its end.
          if (seq == null && s.endWritten) return "repeated"
          // Kept past this end and the ends after it, so a late after-hook for one of them writes
          // nothing a second time; the oldest go first once there are many.
          s.flushed ??= new Set()
          for (const call of s.pending.values()) {
            // Counted, because it is the one honest reason an event has no after-hook: the turn
            // ended (an interrupt, usually) while the call was still running.
            s.counts.unfinished++
            s.flushed.add(call.id)
            if (s.flushed.size > 256) s.flushed.delete(s.flushed.values().next().value)
            append(call.session ?? sessionID, {
              k: "tool",
              seq: s.seq.get(call.id) ?? null,
              id: call.id,
              tool: call.tool,
              agent: call.agent,
              message: call.message,
              input: call.input,
              status: "unfinished",
              ms: now() - call.startedAt,
            })
          }
          s.pending.clear()
          append(sessionID, { k: "session", seq, event: "end", outcome: e.type.split(".").pop() })
          return "ended"
      }
    },
  }
}

/** Tool-specific fields worth keeping. Shapes verified in M0; see fixtures/payloads/. */
function detail(p, maxOutput) {
  const result = p.result ?? {}
  const meta = result.metadata ?? {}
  // The session a delegation started: what ties a `subagent` call to the steps whose `from` it
  // is, wherever in the log the call itself lands (forty-second review).
  const child = p.tool === "subagent" && typeof meta.sessionID === "string" ? { child: meta.sessionID } : {}
  if (p.status === "error") return { ...child, error: p.error ?? null }
  const out = result.output ?? {}
  const detail = { ...child }

  if (typeof out.exit === "number" || typeof meta.exit === "number") detail.exit = out.exit ?? meta.exit
  if (Array.isArray(meta.files)) {
    detail.files = meta.files.map((f) => ({
      file: f.file,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }))
  }
  if (p.tool === "skill" && meta.name) detail.skill = { name: meta.name, directory: meta.directory ?? null }

  const text = typeof out.output === "string" ? out.output : textOf(result.content)
  if (text) {
    const { text: kept, truncated, originalLength } = clamp(text, maxOutput)
    detail.output = kept
    if (truncated) detail.outputLength = originalLength
  }
  return detail
}

function textOf(content) {
  if (!Array.isArray(content)) return ""
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
}

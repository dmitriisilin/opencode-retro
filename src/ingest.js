import { clamp } from "./config.js"

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
  // A session whose start and end are a delegation's steps although no parent is known yet —
  // a child deferred until the delegation that started it says so (analysis.md).
  isStep = () => false,
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

  function session(id) {
    let s = sessions.get(id)
    if (!s) {
      s = {
        id,
        n: startAt(id) ?? 0,
        pending: new Map(),
        completed: new Set(),
        seq: new Map(),
        counts: { prompts: 0, handovers: 0, toolHook: 0, toolEvents: 0, ours: 0, unfinished: 0, steps: 0, texts: 0, records: 0 },
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

  function append(sessionID, record) {
    const target = owner(sessionID)
    const s = session(target)
    s.counts.records++
    emit(target, { v: 1, n: ++s.n, t: now(), ...record })
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
        for (const key of ["prompts", "texts", "steps", "toolHook", "toolEvents", "ours"]) {
          parent.counts[key] += child.counts[key]
        }
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
     * Take back a call's start: it turned out to be the plugin's own, after its first half —
     * a Code Mode wrapper reported ahead of what it wraps — was taken as the person's. Left
     * pending, it was flushed into their log as an unpaired call when the session ended.
     */
    unstart(sessionID, id) {
      sessions.get(owner(sessionID))?.pending.delete(id)
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
    handover(sessionID, text, about = "lesson") {
      const s = session(owner(sessionID))
      s.owned = true
      // Counted because a hand-over is the only input some sessions ever get. The self-check
      // reads `prompts` to decide whether the prompt hook worked, and a `/retro` review
      // session has none — see `assess`, which must not call that a dead hook.
      s.counts.handovers++
      // `about` separates the two hand-overs the plugin writes: a lesson put to the human,
      // and a request for the analyses that have to run first. They read identically in a
      // log and mean different things — the extraction contract discounts work that reviews
      // a lesson it was handed, which would have swallowed real work done after a request
      // for an analysis.
      append(sessionID, { k: "handover", about, text: text ?? "" })
    },

    /**
     * A tool call of the plugin's own, in the user's session: its own tools, and the
     * subagents it asks for. These are not written to any log (analysis.md), so their
     * `tool.execute.*` hooks are deliberately dropped — but the event stream counts them like
     * any other call, and the self-check compares the two. Counted here so the comparison can
     * account for the ones we skipped on purpose, the same way it accounts for a call the turn
     * ended in the middle of. Without it, a `/retro` reported BROKEN about a healthy tool hook
     * — measured on the first live run of the subagent path.
     */
    ownCall(sessionID) {
      const s = sessions.get(owner(sessionID))
      if (s?.owned) s.counts.ours++
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
          if (parentOf(sessionID) || isStep(sessionID)) return // a delegation is a step, not a session
          append(sessionID, { k: "session", seq, event: "start" })
          return

        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          if (parentOf(sessionID) || isStep(sessionID)) return // the parent is still working
          for (const call of s.pending.values()) {
            // Counted, because it is the one honest reason an event has no after-hook: the turn
            // ended (an interrupt, usually) while the call was still running.
            s.counts.unfinished++
            append(sessionID, {
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
          return
      }
    },
  }
}

/** Tool-specific fields worth keeping. Shapes verified in M0; see fixtures/payloads/. */
function detail(p, maxOutput) {
  if (p.status === "error") return { error: p.error ?? null }
  const result = p.result ?? {}
  const meta = result.metadata ?? {}
  const out = result.output ?? {}
  const detail = {}

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

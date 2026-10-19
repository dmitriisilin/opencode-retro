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
 */
export function createIngest({ emit, maxOutput, now = () => Date.now() }) {
  /** sessionID -> { n, pending: Map<callID, started>, seq: Map<callID, number>, counts } */
  const sessions = new Map()

  function session(id) {
    let s = sessions.get(id)
    if (!s) {
      s = {
        id,
        n: 0,
        pending: new Map(),
        seq: new Map(),
        counts: { prompts: 0, toolHook: 0, toolEvents: 0, steps: 0, texts: 0, records: 0 },
      }
      sessions.set(id, s)
    }
    return s
  }

  function append(sessionID, record) {
    const s = session(sessionID)
    s.counts.records++
    emit(sessionID, { v: 1, n: ++s.n, t: now(), ...record })
  }

  return {
    /** Per-session counters, read by the self-check. */
    counts: (sessionID) => session(sessionID).counts,
    sessions: () => [...sessions.keys()],
    forget: (sessionID) => sessions.delete(sessionID),

    /** Unpaired calls, flushed when a session ends so an interrupt leaves no silent gap. */
    pending: (sessionID) => [...session(sessionID).pending.values()],

    prompt(p) {
      const s = session(p.sessionID)
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
      session(p.sessionID).pending.set(p.id, {
        id: p.id,
        tool: p.tool,
        input: p.input,
        message: p.messageID ?? null,
        agent: p.agent ?? null,
        startedAt: now(),
      })
    },

    toolAfter(p) {
      const s = session(p.sessionID)
      s.counts.toolHook++
      const started = s.pending.get(p.id)
      s.pending.delete(p.id)
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

    /** Everything we take from the event stream rather than from a hook. */
    event(e) {
      const sessionID = e?.data?.sessionID
      if (!sessionID) return
      const s = session(sessionID)
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
          append(sessionID, { k: "session", seq, event: "start" })
          return

        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          for (const call of s.pending.values()) {
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

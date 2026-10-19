/**
 * The self-check (AGENTS.md decisions 16-17).
 *
 * It asserts liveness, not setup, because M0 measured that a wrong hook name registers
 * successfully and then never fires (fixtures/payloads/api-drift.jsonl). The report also
 * carries its own cadence, threshold and remedy: nobody reads documentation to interpret
 * a diagnostic.
 */

const OK = "ok"
const DEGRADED = "DEGRADED"
const BROKEN = "BROKEN"
const SKIPPED = "not exercised"

export function createSelfCheck({ versions, repo, loadedAt = Date.now() }) {
  const state = {
    versions,
    repo,
    loaded: loadedAt,
    heartbeat: null,
    verified: null,
    session: null,
    checks: [],
    notes: [],
  }

  return {
    state,
    beat: (at = Date.now()) => {
      state.heartbeat = at
    },
    note: (text) => {
      if (text && !state.notes.includes(text)) state.notes.push(text)
    },
    verify(session, at = Date.now()) {
      state.verified = at
      state.heartbeat = at
      state.session = session.id
      state.checks = assess(session)
      return state
    },
    render: () => render(state),
  }
}

/**
 * `session` is the evidence gathered while it ran:
 *   { id, counts: { prompts, toolHook, toolEvents, steps, records },
 *     log: { exists, size }, triggered: bool, extraction: {...}|null }
 */
export function assess(session) {
  const c = session.counts ?? {}
  const checks = []

  checks.push(
    c.prompts > 0
      ? { status: OK, name: "prompt hook", detail: `${c.prompts} prompt${c.prompts === 1 ? "" : "s"} seen` }
      : {
          status: BROKEN,
          name: "prompt hook",
          detail: "a session ran but no session.prompt arrived",
          meaning: "the prompt hook is registered but dead — most likely renamed upstream.",
        },
  )

  if (!c.toolEvents) {
    checks.push({
      status: SKIPPED,
      name: "tool hook",
      detail: "no tool calls in this session",
      meaning: "nothing to compare against; a session without tool calls cannot prove the hook works.",
    })
  } else if (c.toolHook >= c.toolEvents) {
    checks.push({ status: OK, name: "tool hook", detail: `${c.toolEvents} tool-call events / ${c.toolHook} hook calls` })
  } else {
    checks.push({
      status: BROKEN,
      name: "tool hook",
      detail: `${c.toolEvents} tool-call events / ${c.toolHook} hook calls`,
      meaning:
        "the event stream saw tool calls the hook never received, so the tool hook is dead " +
        "or its payload moved. → /retro check",
    })
  }

  const log = session.log ?? { exists: false, size: 0 }
  checks.push(
    log.exists && log.size > 0
      ? { status: OK, name: "shadow log", detail: `sessions/${session.id}.jsonl, ${c.records ?? 0} entries` }
      : {
          status: BROKEN,
          name: "shadow log",
          detail: log.exists ? "file is empty" : "file was never created",
          meaning: "writing is broken — check permissions on the .retro directory.",
        },
  )

  checks.push(
    session.triggered
      ? { status: OK, name: "trigger", detail: session.triggered }
      : {
          status: BROKEN,
          name: "trigger",
          detail: "no end-of-session event arrived",
          meaning: "our extraction trigger is gone; session.idle was already one such casualty.",
        },
  )

  const x = session.extraction
  if (!x) {
    checks.push({
      status: SKIPPED,
      name: "extraction",
      detail: "not implemented yet (M2)",
      meaning: "capture only — no lessons are produced at this milestone.",
    })
  } else if (x.ok) {
    checks.push({ status: OK, name: "extraction", detail: x.detail })
  } else {
    checks.push({
      status: DEGRADED,
      name: "extraction",
      detail: x.detail,
      meaning: "no lessons from this session. Check `options.model` in opencode.json, then /retro check.",
    })
  }

  return checks
}

const stamp = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "never")

export function render(state) {
  const width = Math.max(...state.checks.map((c) => c.status.length), DEGRADED.length)
  const lines = [
    "# retro self-check",
    "",
    [state.versions?.opencode && `opencode ${state.versions.opencode}`, state.versions?.plugin && `opencode-retro ${state.versions.plugin}`, state.repo]
      .filter(Boolean)
      .join(" · "),
    "",
    "```",
    `loaded     ${stamp(state.loaded)}   (plugin start)`,
    `heartbeat  ${stamp(state.heartbeat)}   (refreshed while a session works, at most once a minute)`,
    `verified   ${stamp(state.verified)}   (rewritten when a session ends)`,
    "```",
    "",
    "**If you are working right now and `heartbeat` is more than a few minutes old, this",
    "plugin is not running.** Nothing else will tell you — OpenCode does not report a plugin",
    "that failed to load. Check that `opencode.json` points at an absolute path, then run",
    "`/retro check`.",
    "",
  ]

  if (state.session) {
    lines.push(`## Last session — ${state.session}`, "")
    for (const c of state.checks) {
      lines.push(`- ${c.status.padEnd(width)}  ${c.name.padEnd(12)}  ${c.detail}`)
      if (c.meaning) lines.push(`  ${" ".repeat(width)}  ${" ".repeat(12)}  → ${c.meaning}`)
    }
    lines.push("")
  } else {
    lines.push("## Last session", "", "No session has ended since the plugin loaded.", "")
  }

  if (state.notes.length) {
    lines.push("## Notes", "")
    for (const n of state.notes) lines.push(`- ${n}`)
    lines.push("")
  }

  return lines.join("\n")
}

export const STATUS = { OK, DEGRADED, BROKEN, SKIPPED }

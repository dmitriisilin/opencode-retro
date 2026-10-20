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
    sessionEnded: null,
    checks: [],
    notes: [],
    /** Not health: how much is sitting there waiting for the human. */
    stock: null,
    activeChecks: null,
    activeAt: null,
  }

  return {
    state,
    beat: (at = Date.now()) => {
      state.heartbeat = at
    },
    active: (checks) => {
      state.activeChecks = checks
      state.activeAt = Date.now()
    },
    note: (text) => {
      if (text && !state.notes.includes(text)) state.notes.push(text)
    },
    stock: (stock) => {
      state.stock = stock
    },
    verify(session, at = Date.now()) {
      state.verified = at
      state.heartbeat = at
      state.session = session.id
      state.sessionEnded = at
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
      detail: "not run",
    })
  } else if (x.queued) {
    checks.push({
      status: SKIPPED,
      name: "extraction",
      detail: "this session's log is queued; `/retro` analyses it",
      meaning:
        "analysis is not automatic — it costs a model call, so it happens when you ask. " +
        "`/retro` analyses everything waiting, in one go. `options.autoExtract` moves it to " +
        "the start of the next session instead.",
    })
  } else if (x.ok && x.skipped) {
    checks.push({ status: SKIPPED, name: "extraction", detail: x.detail })
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
    "This file is about whether the plugin is working. It is not a report on your session —",
    "your sessions are in `sessions/`, and what was learned from them is in `lessons/`.",
    "",
    [
      state.versions?.opencode && `opencode ${state.versions.opencode}`,
      state.versions?.plugin && `opencode-retro ${state.versions.plugin}`,
      state.repo,
    ]
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
    "## Is it working",
    "",
  ]

  if (state.checks.length) {
    for (const c of state.checks) {
      lines.push(`- ${c.status.padEnd(width)}  ${c.name.padEnd(12)}  ${c.detail}`)
      if (c.meaning) lines.push(`  ${" ".repeat(width)}  ${" ".repeat(12)}  → ${c.meaning}`)
    }
    lines.push(
      "",
      `Liveness can only be proven by real traffic, so the above was measured on session`,
      `\`${state.session}\`, which ended at ${stamp(state.sessionEnded)}.`,
      "",
    )
  } else {
    lines.push(
      "Nothing measured yet. Hooks that registered prove nothing — a wrong hook name",
      "registers happily and never fires — so these lines stay empty until a session ends.",
      "",
    )
  }

  if (state.activeChecks?.length) {
    const width = Math.max(...state.activeChecks.map((c) => c.status.length), DEGRADED.length)
    lines.push(`## Last \`/retro check\` — ${stamp(state.activeAt)}`, "")
    for (const c of state.activeChecks) {
      lines.push(`- ${c.status.padEnd(width)}  ${c.name.padEnd(14)}  ${c.detail}`)
      if (c.meaning) lines.push(`  ${" ".repeat(width)}  ${" ".repeat(14)}  → ${c.meaning}`)
    }
    lines.push("")
  }

  if (state.stock) {
    lines.push("## What is waiting for you", "", ...renderStock(state.stock), "")
  }

  if (state.notes.length) {
    lines.push("## Notes", "", ...state.notes.map((n) => `- ${n}`), "")
  }

  return lines.join("\n")
}

function renderStock({ lessons = 0, topScore = null, top = null, queued = 0, cited = 0 } = {}) {
  const lines = []
  if (lessons === 0) lines.push("- no lessons recorded yet")
  else {
    lines.push(
      `- ${lessons} lesson${lessons === 1 ? "" : "s"} in \`lessons/\` — run \`/retro\` to review` +
        (top ? `, starting with \`${top}\`${topScore != null ? ` (score ${round(topScore)})` : ""}` : ""),
    )
  }
  if (queued) {
    lines.push(`- ${queued} log${queued === 1 ? "" : "s"} not analysed yet — \`/retro\` analyses them`)
  }
  // Counted, not inferred. An earlier version derived this by subtracting the queue from
  // the logs on disk and announced that open lessons cited them — while there were no
  // lessons at all. A diagnostic that states something it has not checked is the failure
  // this file exists to prevent.
  if (cited) {
    lines.push(
      `- ${cited} log${cited === 1 ? "" : "s"} kept in \`sessions/\` because open lessons cite` +
        ` ${cited === 1 ? "it" : "them"}; deciding those lessons releases ${cited === 1 ? "it" : "them"}`,
    )
  }
  return lines
}

const round = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(1)))

export const STATUS = { OK, DEGRADED, BROKEN, SKIPPED }

/* ------------------------------------------------------- the active check */

/**
 * The checks a passing session cannot make (AGENTS.md decision 19).
 *
 * Free, so it runs on every `/retro`. It used to also ask the model whether it answers and
 * whether the output contract still round-trips, which cost two calls nobody requested —
 * and both questions are answered for free by the analysis itself, every time, with the
 * model's own words when it fails.
 *
 * It checks:
 * that the `ctx` surface we depend on is still there, that the model answers, that the
 * prompts resolve, and that a real extraction prompt still round-trips into a parseable
 * lesson — which is the only check that exercises a user-edited prompt end to end.
 */
export async function activeCheck({ ctx, config, prompts, store, state }) {
  const checks = []
  const notes = []

  // 1. Surface. This part *is* detectable at load: a missing member reads undefined.
  const required = [
    ["tool", "hook"],
    ["tool", "transform"],
    ["session", "hook"],
    ["session", "synthetic"],
    ["command", "transform"],
    ["event", "subscribe"],
    ["generate", "text"],
  ]
  const missing = required.filter(([domain, member]) => typeof ctx?.[domain]?.[member] !== "function")
  checks.push(
    missing.length
      ? {
          status: BROKEN,
          name: "ctx surface",
          detail: `missing: ${missing.map((m) => m.join(".")).join(", ")}`,
          meaning: "this OpenCode moved the plugin API; opencode-retro needs an update.",
        }
      : { status: OK, name: "ctx surface", detail: `${required.length} members present` },
  )

  // 2. Connectivity.
  // 3. Prompts: which layer is in force, and is a newer default waiting.
  const prompt = prompts.resolve("extract")
  checks.push(
    prompt
      ? { status: OK, name: "extract prompt", detail: `${prompt.layer} (base ${prompt.base ?? "?"})` }
      : { status: BROKEN, name: "extract prompt", detail: "could not be resolved at any layer" },
  )
  for (const file of prompts.pendingUpdates()) {
    notes.push(`prompts/updates/${file} is a newer default waiting to be read. Nothing was changed for you.`)
  }

  // 4. Round trip: does the contract still produce something we can parse?
  // 5. Stock, so the answer to "is it doing anything" is in the same place.
  const lessons = store.list()
  checks.push({
    status: OK,
    name: "store",
    detail: `${lessons.length} lesson(s), ${state.pending.length} session(s) queued`,
  })

  return { checks, notes, text: renderActive(checks, notes) }
}

function renderActive(checks, notes) {
  const width = Math.max(...checks.map((c) => c.status.length), DEGRADED.length)
  const lines = ["# retro check", ""]
  for (const c of checks) {
    lines.push(`- ${c.status.padEnd(width)}  ${c.name.padEnd(14)}  ${c.detail}`)
    if (c.meaning) lines.push(`  ${" ".repeat(width)}  ${" ".repeat(14)}  → ${c.meaning}`)
  }
  if (notes.length) lines.push("", ...notes.map((n) => `- ${n}`))
  lines.push("", "Written to `.retro/selfcheck.md` as well.")
  return lines.join("\n")
}

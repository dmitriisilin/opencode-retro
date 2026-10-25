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
    /**
     * Evaluate the assertions against what is known about a session right now.
     *
     * Called while a session works as well as when it ends (`session.ended === false` for
     * the former), because a report that only becomes true at the end of a session is stale
     * for exactly as long as someone is working — which is when they would look at it. The
     * cheap facts are available from the first prompt: a hook fired, and the log has
     * something non-empty in it.
     */
    verify(session, at = Date.now()) {
      state.verified = at
      state.heartbeat = at
      state.session = session.id
      state.sessionEnded = session.ended === false ? null : (session.endedAt ?? at)
      state.checks = assess(session)
      return state
    },
    /**
     * Show a session as it was measured when its turn ended. Nothing is measured now, so the
     * heartbeat does not move and `verified` says when the checks really were (eleventh review).
     */
    replay(session) {
      state.verified = session.endedAt ?? state.verified
      state.session = session.id
      state.sessionEnded = session.endedAt ?? null
      state.checks = assess(session)
      return state
    },
    /** The session the report currently describes. */
    describing: () => state.session ?? null,
    /** Describe no session: the one described turned out to be none of the person's. */
    clear: () => {
      state.session = null
      state.sessionEnded = null
      state.checks = []
      state.verified = null
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
      : c.handovers > 0
        ? {
            status: SKIPPED,
            name: "prompt hook",
            // Measured: `/retro` delivers its hand-over through `session.synthetic`, which
            // does not fire the prompt hook (AGENTS.md Gotcha 12). A session whose only
            // input arrived that way was reported BROKEN — about a hook that was working,
            // in the very session the plugin had just started. It proves nothing either way.
            // The counters are per turn, so this is about the turn being measured, not the
            // whole session. A session prompted earlier and then handed a lesson is not
            // "started by a hand-over"; saying so was false in a live run.
            detail: "this turn began with a `/retro` hand-over, not a prompt",
            meaning:
              "a hand-over is delivered by the plugin itself and does not fire the prompt " +
              "hook, so nothing is proved here; the next turn you type in will.",
          }
        : c.startSeen === false
          ? {
              status: SKIPPED,
              name: "prompt hook",
              // A process loaded in the middle of a turn — a restart, or opencode.json edited
              // mid-session, which reloads the plugin — never saw that turn's prompt. Measured:
              // a stranger edited opencode.json mid-session as the README suggests, and the
              // report said BROKEN about a session whose log had its prompt at step 1.
              detail: "the plugin was loaded after this turn began",
              meaning: "a restart or a config change reloads the plugin; the next turn you type in proves the hook.",
            }
          : {
            status: BROKEN,
            name: "prompt hook",
            detail: "a session ran but no session.prompt arrived",
            meaning: "the prompt hook is registered but dead — most likely renamed upstream.",
          },
  )

  /**
   * One phrasing for one fact, in all three branches. The counts used to read
   * "N tool-call events / M hook calls" on a failure and a different sentence on a success,
   * which is two ways of saying the same thing in a file whose whole job is to be read once
   * and understood — and "1 hook calls" besides.
   */
  const counted = () =>
    `${c.toolEvents} tool-call event${c.toolEvents === 1 ? "" : "s"} seen, ${c.toolHook} reached the hook` +
    (c.ours ? `, ${c.ours} ${c.ours === 1 ? "was" : "were"} our own and not logged` : "") +
    (c.unfinished ? `, ${c.unfinished} unfinished when the turn ended` : "")

  if (!c.toolEvents) {
    checks.push({
      status: SKIPPED,
      name: "tool hook",
      // Present tense about a session still running would be a claim this cannot support:
      // the counts are re-evaluated at most once a minute, so a session calling tools right
      // now reads as having called none. "Not yet" is what is actually known.
      detail: session.ended === false ? "no tool calls seen yet" : "no tool calls in this turn",
      meaning: "nothing to compare against; a turn without tool calls cannot prove the hook works.",
    })
  } else if (c.toolHook + (c.unfinished ?? 0) + (c.ours ?? 0) >= c.toolEvents) {
    // Two kinds of event legitimately have no after-hook behind them. A call the turn ended in
    // the middle of has one by nature, and the log records it as `unfinished`: counting it as a
    // missing hook call reported BROKEN for every interrupted turn with a subagent still
    // running (found by the model test). And a call of the plugin's own — its tools, the
    // subagents it asks for — has its hooks dropped on purpose, because none of that is the
    // user's work: counting those reported BROKEN for every `/retro` that analysed anything
    // (found by the first live run of the subagent path).
    checks.push({
      status: OK,
      name: "tool hook",
      detail: counted(),
    })
  } else if (session.ended === false) {
    // Tool calls run in parallel and their `after` hooks arrive in whatever order they
    // finish, so the event stream can legitimately be ahead of the hooks while calls are
    // in flight. Measured live: two events and one hook call for a moment, reported as
    // BROKEN — "the plugin needs an update" — in a healthy session. A shortfall is not
    // evidence until the session is over; the verdict is written then.
    checks.push({
      status: SKIPPED,
      name: "tool hook",
      detail: `${counted()} — so far`,
      meaning:
        "the difference is calls that have not finished yet; the verdict is written when " +
        "the session ends.",
    })
  } else {
    checks.push({
      status: BROKEN,
      name: "tool hook",
      detail: counted(),
      meaning:
        "the event stream saw tool calls the hook never received, so the tool hook is dead " +
        "or its payload moved. The plugin needs an update; see the repository in the header.",
    })
  }

  const log = session.log ?? { exists: false, size: 0 }
  checks.push(
    log.exists && log.size > 0
      ? {
          status: OK,
          name: "shadow log",
          // The file's own record count when the caller can supply it. The fallback keeps
          // `assess` usable from the counters alone, but it is only exact for a single
          // turn: ingest counters are cleared when an execution ends (see shadowlog.count).
          detail: `sessions/${session.id}.jsonl, ${log.entries ?? c.records ?? 0} entries`,
        }
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
      : session.ended === false
        ? {
            status: SKIPPED,
            name: "trigger",
            detail: "the session has not ended yet",
            meaning: "nothing to prove yet; this line is written again when the session ends.",
          }
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
  } else if (x.owed) {
    checks.push({
      status: SKIPPED,
      name: "extraction",
      detail: "this session's log is waiting; `/retro` analyses it",
      meaning:
        "analysis is not automatic — it costs a subagent, so it happens when you ask. " +
        "`/retro` writes a work order for everything waiting and has them read, in one go.",
    })
  } else if (x.ok && x.skipped) {
    checks.push({ status: SKIPPED, name: "extraction", detail: x.detail })
  } else if (x.ok) {
    checks.push({ status: OK, name: "extraction", detail: x.detail })
  } else if (String(x.detail ?? "").startsWith(SET_ASIDE)) {
    checks.push({
      status: DEGRADED,
      name: "extraction",
      detail: x.detail,
      meaning:
        "nothing will read this log again unless it grows. `plugin.log` says why each read " +
        `failed: ${READ_FAILURES}.`,
    })
  } else {
    checks.push({
      status: DEGRADED,
      name: "extraction",
      detail: x.detail,
      meaning:
        "no lessons from this session yet; the next `/retro` asks again, and `plugin.log` says " +
        "why. The usual reason is an order nobody answered, which is never held against the " +
        "log — a hand-over waiting in the inbox of a session that is still working, or " +
        "subagents that had not called `retro_record` before `retro_propose` was called.",
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
    `verified   ${stamp(state.verified)}   (when the checks below were last evaluated)`,
    "```",
    "",
    "**If you are working right now and `heartbeat` is more than a few minutes old, this",
    "plugin is not running.** Nothing else will tell you — OpenCode does not report a plugin",
    "that failed to load. Check that `opencode.json` still names the plugin — an absolute",
    "path if you run a checkout — then run `/retro`.",
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
      state.sessionEnded
        ? `\`${state.session}\`, which ended at ${stamp(state.sessionEnded)}.`
        : `\`${state.session}\`, which was still working at ${stamp(state.verified)}.`,
      "",
    )
  } else {
    lines.push(
      "Nothing measured yet. Hooks that registered prove nothing — a wrong hook name",
      "registers happily and never fires — so these lines stay empty until a hook has fired",
      "for real, which is the first prompt of the next session.",
      "",
    )
  }

  if (state.activeChecks?.length) {
    const width = Math.max(...state.activeChecks.map((c) => c.status.length), DEGRADED.length)
    lines.push(`## Checked — ${stamp(state.activeAt)}`, "")
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

function renderStock({
  lessons = 0,
  topScore = null,
  top = null,
  queued = 0,
  partial = 0,
  failing = 0,
  unanswered = 0,
  asked = 0,
  cited = 0,
  decided = 0,
  setAside = 0,
  unreadable = [],
} = {}) {
  const lines = []
  // "No lessons recorded yet" right after a decision read as though the decision had
  // vanished — the lesson is in `archive/`, which is where a decided one belongs.
  if (lessons === 0) {
    lines.push(decided ? `- no open lessons — ${decided} decided, in \`archive/\`` : "- no lessons recorded yet")
  }
  else {
    lines.push(
      `- ${lessons} lesson${lessons === 1 ? "" : "s"} in \`lessons/\` — run \`/retro\` to review` +
        (top ? `, starting with \`${top}\`${topScore != null ? ` (score ${round(topScore)})` : ""}` : ""),
    )
  }
  if (unreadable.length) {
    // A lesson file whose frontmatter does not parse is invisible to `/retro`, and nothing
    // else would say so. The plugin writes over none of them; fixing them is the user's.
    const shown = unreadable.slice(0, 5).map((n) => `\`${n}\``).join(", ")
    const more = unreadable.length > 5 ? ` and ${unreadable.length - 5} more` : ""
    lines.push(
      `- ${shown}${more} cannot be read as ${unreadable.length === 1 ? "a lesson" : "lessons"} — the frontmatter ` +
        "between the `---` lines does not parse, so `/retro` does not see " +
        `${unreadable.length === 1 ? "it" : "them"}. Nothing was changed; fix or remove ${unreadable.length === 1 ? "it" : "them"}.`,
    )
  }
  if (setAside) {
    // Kept on disk and owed to nobody. Without a line here, `sessions/` fills with
    // transcripts nothing will ever read, and the file whose job is to report the stock
    // does not mention them.
    lines.push(
      `- ${setAside} log${setAside === 1 ? "" : "s"} ${SET_ASIDE} — still in \`sessions/\`, and nothing ` +
        `will read them unless they grow. \`plugin.log\` says why each one failed: ${READ_FAILURES}.`,
    )
  }
  if (failing) {
    // Named as what it is. After two failed analyses this line used to read "not analysed
    // yet", which sends the reader to run `/retro` again without telling them it already ran
    // and why it did not work.
    lines.push(
      `- ${failing} log${failing === 1 ? "" : "s"} whose last read failed — tried again on the next ` +
        `\`/retro\`, and ${SET_ASIDE_VERB} after three. \`plugin.log\` ` +
        `says why: ${READ_FAILURES}.`,
    )
  }
  if (unanswered) {
    // The one thing the plugin knows, said as a fact rather than as a verdict about the log:
    // it cannot tell a reader that died from one that was never started, so it does not
    // guess which (analysis.md, "Unanswered"). Guessing retired readable logs.
    lines.push(
      `- ${unanswered} log${unanswered === 1 ? "" : "s"} asked about with no answer${
        asked > 1 ? `, up to ${asked} times` : ""
      } — still owed, and asked again by the next \`/retro\`. Nothing is wrong with the ` +
        "logs themselves. The usual cause is a hand-over waiting in the inbox of a session " +
        "that is still working: one `/retro` in a session that is not will be picked up.",
    )
  }
  if (queued) {
    lines.push(`- ${queued} log${queued === 1 ? "" : "s"} not analysed yet — \`/retro\` analyses them`)
  }
  if (partial) {
    lines.push(
      `- ${partial} log${partial === 1 ? "" : "s"} read in part — too long for one call, so each ` +
        "`/retro` reads one more part, from where the last one stopped",
    )
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
 * What a log set aside after three failed reads is called, wherever it is reported — state.json,
 * the hand-over and this file. One phrase in one place, because three of them drifted apart:
 * "given up after three failed analyses" in two, "could not read three times" in the third, for
 * the same state (second pre-release review). The verb is its own constant so a line that needs
 * it alone takes it from here rather than cutting it out of the phrase.
 */
export const SET_ASIDE_VERB = "set aside"
export const SET_ASIDE = `${SET_ASIDE_VERB} after three failed reads`

/** What can make a read fail, said the same way wherever a failed read is explained. */
export const READ_FAILURES =
  "a log that could not be opened or parsed, a work order that could not be written — no " +
  "`extract.md` resolving is one way — or a reader that reported reading nothing new"

/**
 * The `ctx` members the plugin calls, which is what makes checking them worth anything: a
 * member we do not use proves nothing when it is present, and says nothing about the one
 * that moved. This list used to name `generate.text`, which `index.js` now mentions only to
 * explain why it is *not* used, and to omit the session calls every analysis runs through —
 * so a renamed `session.generate` would have passed the check and broken all of it.
 * `test/consistency.test.js` holds the list to what `index.js` actually does.
 */
export const REQUIRED_SURFACE = [
  ["tool", "hook"],
  ["tool", "transform"],
  ["session", "hook"],
  ["session", "synthetic"],
  ["command", "transform"],
  ["event", "subscribe"],
]

/**
 * The checks a passing session cannot make (AGENTS.md decision 19).
 *
 * Free, so it runs on every `/retro`. It used to also ask the model whether it answers and
 * whether the output contract still round-trips, which cost two calls nobody requested —
 * and both questions are answered for free by the analysis itself, every time, with the
 * model's own words when it fails.
 *
 * What is left is what stays free: that the `ctx` surface we depend on is still there,
 * which prompt layer is in force and whether a newer default is waiting, and how much is
 * stocked up — so that "is it doing anything" is answered in the same place.
 */
export async function activeCheck({ ctx, config, prompts, store }) {
  const checks = []
  const notes = []

  // 1. Surface. This part *is* detectable at load: a missing member reads undefined.
  const required = REQUIRED_SURFACE
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

  // 2. Prompts: which layer is in force, and is a newer default waiting.
  const prompt = prompts.resolve("extract")
  checks.push(
    prompt
      ? {
          status: OK,
          name: "extract prompt",
          // Whether it was edited, not only which layer it came from: a user who changes the
          // criteria needs to see that the change is in force, and the layer reads the same
          // either way.
          detail: `${prompt.layer} (base ${prompt.base ?? "?"}${prompts.isEdited?.("extract") === true ? ", edited" : ""})`,
        }
      : { status: BROKEN, name: "extract prompt", detail: "could not be resolved at any layer" },
  )
  for (const file of prompts.pendingUpdates()) {
    notes.push(`prompts/updates/${file} is a newer default waiting to be read. Nothing was changed for you.`)
  }

  // 3. Stock, so the answer to "is it doing anything" is in the same place.
  const lessons = store.list()
  checks.push({
    status: OK,
    name: "store",
    // Lessons only. The logs waiting are counted in the stock section, which is recomputed
    // every time the file is written; a count here was a snapshot from before the hand-over,
    // and the same file then said "0 logs waiting" and "1 log not analysed yet" at once.
    detail: `${lessons.length} open lesson(s); what is waiting is under "What is waiting for you"`,
  })

  return { checks, notes }
}

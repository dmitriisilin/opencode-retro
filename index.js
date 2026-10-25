import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative as relativePath, resolve as resolvePath, sep } from "node:path"
import { createIngest, isTurnEnd } from "./src/ingest.js"
import { createPrompts } from "./src/prompts.js"
import { SET_ASIDE, createSelfCheck } from "./src/selfcheck.js"
import { createShadowLog, identityOf, isReplacedLog, parseShadowLog } from "./src/shadowlog.js"
import { createState } from "./src/state.js"
import { concludedIn, createStore, score } from "./src/lessons.js"
import { assessCurrency, fingerprintOf } from "./src/currency.js"
import { WORK_MARK, composeOrder, recordAnswer } from "./src/extract.js"
import { RECORD_INPUT } from "./src/contract.js"
import {
  PROPOSE_INPUT,
  pickLesson,
  pickOpen,
  renderBatch,
  renderFailures,
  renderNothing,
  renderProposal,
  renderWorkOrders,
} from "./src/propose.js"
import { DECIDE_INPUT, DECIDE_OUTPUT, decide } from "./src/decide.js"
import { activeCheck } from "./src/selfcheck.js"
import { resolveConfig } from "./src/config.js"
import { seedGitignore } from "./src/gitignore.js"

const REPO = "github.com/dmitriisilin/opencode-retro"

/**
 * The version this build reports in `selfcheck.md`, read from the package it was installed
 * from rather than duplicated here. A second copy is a second thing to forget to bump on
 * release, and the artifact that would be wrong is the one already published: `npm version`
 * commits `package.json` and nothing else, so a constant in this file would stay behind.
 * `package.json` always travels with the package, and "unknown" is honest if it ever cannot
 * be read.
 */
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
})()

/**
 * opencode-retro — capture, extract, propose, decide.
 *
 * Writes a shadow log of every prompt and tool call. `/retro` turns whatever has been written
 * since the last time into a work order per log, and asks the agent in the session it was run
 * in to have each read by a subagent of its own — a context that was not in the session it
 * reads, and has nothing of its own to defend. Each subagent answers by calling
 * `retro_record`; `retro_propose` then hands the highest-scoring lesson to the session you
 * are in and stops there: you and the agent decide what to do with it. A self-check says
 * whether any of it worked.
 *
 * Everything it knows about a session is on disk: the log, and how far it was read. Nothing
 * depends on this process having seen a session start or end, so a restart, a crash or a
 * second instance on the project changes nothing about what is read or removed — and a log
 * is removed only once it has been quiet for a week (docs/concepts/session.md).
 *
 * Nothing is analysed until `/retro` asks for it: an analysis costs money, and nothing here
 * spends it unprompted. The plugin itself calls no model and chooses none — the work runs on
 * the model and settings of the session that asked for it (docs/concepts/analysis.md).
 *
 * The API facts this relies on are all verified against OpenCode 2.0.32; see AGENTS.md
 * "OpenCode v2 plugin API" and fixtures/payloads/.
 */
/** How long a log must go unwritten before it may be pruned (session.md, "Quiet"). */
const QUIET_MS = 7 * 24 * 60 * 60 * 1000

export default {
  id: "opencode-retro",

  async setup(ctx) {
    const config = resolveConfig(ctx)

    const onError = (where, err) => {
      try {
        mkdirSync(config.dir, { recursive: true })
        appendFileSync(config.pluginLog, `${new Date().toISOString()} ${where}: ${err?.stack ?? err}\n`)
      } catch {
        /* if we cannot even log, stay silent: never break the user's session */
      }
    }

    const log = createShadowLog({ dir: config.sessions, onError })
    /**
     * How the hand-over should name the log directory: relative to the project, so it reads
     * `.retro/sessions/...` rather than an absolute path, and still names the real one when
     * `options.dir` moves it.
     */
    const logDir = relativePath(config.directory, config.sessions).split(sep).join("/") || config.sessions
    const retroDir = relativePath(config.directory, config.dir).split(sep).join("/") || config.dir
    const state = createState({ path: config.state, onError, probe: (id) => log.probe(id) })
    const store = createStore({
      dir: config.lessons,
      archive: config.archive,
      halfLife: config.halfLife,
      sessions: () => state.sessions,
      onError,
    })
    const fingerprint = fingerprintOf(config.directory)
    const prompts = createPrompts({ dir: config.prompts, updates: config.updates, onError })
    const check = createSelfCheck({
      versions: { opencode: ctx?.app?.version ?? null, plugin: VERSION },
      repo: REPO,
    })

    /**
     * Sessions whose current turn has reported its end, so a stray late event cannot
     * re-verify. Only the self-check reads this; nothing about what is analysed or pruned does.
     */
    const ended = new Set()
    /**
     * Sessions whose current turn this process saw begin — its prompt, or its execution
     * starting. A process loaded in the middle of a turn (a restart, or `opencode.json` edited
     * mid-session, which reloads the plugin) has no prompt to count for that turn, and used to
     * report the prompt hook BROKEN about a session that had one. Only the self-check reads it.
     */
    const turnSeen = new Set()
    /** Evidence from each finished session, kept so a later extraction can complete its report. */
    const lastVerified = new Map()
    let lastBeat = 0
    /**
     * Sessions that are the plugin's own work — the subagents reading work orders. Nothing of
     * theirs is written to any log (analysis.md, "The plugin's own work").
     */
    const internal = new Set()
    /**
     * The last analysis of each session, whichever path ran it. The report used to learn of a
     * result only through `lastVerified`, which exists once a turn has ended — so a working
     * session analysed by `/retro` was described as `extraction: not run` a moment later, by
     * the very report that is supposed to claim only what happened.
     */
    const lastExtraction = new Map()
    /**
     * session the round was handed to -> the logs it asked about. Only so `retro_propose` can
     * say how many were analysed when there is nothing to propose: "Nothing to review" on its
     * own reads the same after five analyses as after none (pre-release review — the line that
     * said so had been left without anything to feed it). A message, not a decision input, so
     * it is fine for it to live in this process.
     */
    const rounds = new Map()
    /**
     * Which call and which session is the plugin's own, in three rules (fifteenth review, which
     * asked for the model decision 21 asks for, after thirteen rounds had grown a state machine):
     *
     * 1. A tool call is ours or the person's as decided when it starts, and that holds for both
     *    halves of a Code Mode pair until the call ends or its turn does.
     * 2. A child created while its parent runs a delegation of ours waits (`deferred`). The
     *    delegation that names it when it ends decides it; one nobody named by the parent's turn
     *    end is ours if a delegation of ours never named a child — still running then, or ended
     *    naming none — and the person's if every one of ours named its own (sixteenth and
     *    seventeenth reviews).
     * 3. Everything a session of ours does, or starts, is ours.
     *
     * The cost, stated: a person's subagent run beside ours and never named, in a turn where one
     * of ours never named its own either, is taken for ours (AGENTS.md, "Known").
     *
     * `calls`: `session\0id` -> { session, tool, ours, open, named }. Code Mode reports one call as its
     * inner tool and again as its `execute` wrapper under one id — inner before, wrapper before,
     * inner after, wrapper after (measured, `test/ingest.test.js`) — and the wrapper is whatever
     * it wraps; `open` counts the pairs still open, and the entry goes at zero or when the
     * session's turn ends (an interrupted call has no after-hook, measured) — except a
     * delegation of ours that ended naming no child, which stays until the turn ends: it is
     * unaccounted for, and rule 2 asks exactly that of whatever is in `calls` (eighteenth
     * review, which found a side set read at one decision point and not the other). Ids are
     * unique within a session as measured (`call_00_<random>`).
     */
    const calls = new Map()
    const deferred = new Map() // child -> the parent it appeared under (rule 2)
    const MAX_CALLS = 1000

    /**
     * Whether a log is a session of its own — the person's, read and reported as one. Not a
     * delegation (`parents`), not ours (`internal`), not waiting to be told which (`deferred`).
     * One predicate for every consumer, because each set added in review was checked by hand
     * in the places noticed and missed in the rest (tenth review).
     */
    const standsAlone = (id) => !parents.has(id) && !internal.has(id) && !deferred.has(id)
    const callKey = (p) => (p?.id != null ? `${p?.sessionID}\u0000${p.id}` : null)

    /**
     * What is waiting, as the marks say it is. A log whose last read failed is named as a
     * failure, not as something nobody has looked at; everything else owed is waiting.
     */
    function stockFacts() {
      let queued = 0
      let failing = 0
      let partial = 0
      // The most times any owed log has been asked about with nothing coming back. Reported
      // instead of a verdict: the plugin does not know whether anybody came (analysis.md).
      let asked = 0
      let unanswered = 0
      for (const id of log.list()) {
        if (!standsAlone(id) || !isOwed(id)) continue
        const mark = state.looked(id)
        // How many askings have actually gone unanswered — not counting one issued a moment ago
        // that nobody has had the chance to answer yet. Counting it made this line say "up to 2
        // times" about the same log state.json and the hand-over call "asked 1 time", in the
        // same moment (pre-release scan).
        const order = state.askedFor(id)
        const silent = order.done === null ? order.asked - 1 : order.done === "unanswered" ? order.asked : 0
        if (silent >= 1) {
          unanswered++
          asked = Math.max(asked, silent)
        }
        if (mark.failed) failing++
        // Read in part and nothing new since: a log too long for one call, which the next
        // command reads on from where this one stopped. Calling it "not analysed yet" right
        // after `/retro` read it made the command look as if it had not finished. An unread
        // gap outranks later growth: the log is still read in part whether or not something
        // wrote to it afterwards, and saying "not analysed yet" throws away that it was.
        else if (mark.open) partial++
        else queued++
      }
      return { queued, failing, partial, unanswered, asked }
    }

    const writeSelfCheck = () => {
      try {
        const lessons = store.list()
        check.stock({
          lessons: lessons.length,
          top: lessons[0]?.id ?? null,
          topScore: lessons.length ? store.score(lessons[0]) : null,
          ...stockFacts(),
          cited: log.list().filter((id) => citedSessions().has(id)).length,
          decided: store.listArchive().length,
          unreadable: store.unreadable(),
          // Logs that failed three analyses: still on disk until they are quiet, and nothing
          // will read them — but only while nothing owes them. A log that grows is owed afresh;
          // announcing it as beyond reading next to the line saying it will be tried again is
          // two contradictory claims in one report.
          setAside: log.list().filter((id) => !isOwed(id) && state.extractionOf(id)?.setAside).length,
        })
        mkdirSync(config.dir, { recursive: true })
        writeFileSync(config.selfcheck, check.render())
      } catch (err) {
        onError("selfcheck.write", err)
      }
    }

    /** Sessions whose checks have been written at least once, so the first one is immediate. */
    const observedSessions = new Set()

    /**
     * Re-evaluate the assertions from what is known right now, and write the report.
     *
     * The checks used to exist only once a session had ended, which made the file stale for
     * exactly as long as somebody was working — the one time they would open it. Nothing in
     * it needs the session to be over: a hook having fired and a log with something non-empty
     * in it are the facts, and both are true from the first prompt.
     *
     * The first observation of a session is written at once, since that is the one that makes
     * the file current. After that it is throttled to `heartbeatMs`, because a report is not
     * worth a file write per tool call.
     */
    function observe(sessionID, { force = false } = {}) {
      // Never about one of ours: a reader, or a reader's helper, has no log to measure, and a
      // report about it said BROKEN about a healthy plugin (seventh and eighth reviews).
      if (!sessionID || !standsAlone(sessionID)) return
      // A hook that arrives after the session's end belongs to that session, and its record is
      // written — but it is not news about liveness. Re-measuring here would recreate the
      // forgotten ingest counts and report `BROKEN prompt hook` about a session that was fine
      // and is over.
      if (ended.has(sessionID)) return
      const now = Date.now()
      const first = !observedSessions.has(sessionID)
      if (!first && !force && now - lastBeat < config.heartbeatMs) return
      // Re-inserted, so the set is in order of the latest observation (`handBack`).
      observedSessions.delete(sessionID)
      observedSessions.add(sessionID)
      lastBeat = now
      check.verify(
        {
          id: sessionID,
          counts: { ...ingest.counts(sessionID), startSeen: turnSeen.has(sessionID) },
          log: logFacts(sessionID),
          triggered: null,
          ended: false,
          // From disk when this process ran none: a reload must not unsay an analysis.
          extraction: lastExtraction.get(sessionID) ?? state.extractionOf(sessionID) ?? null,
        },
        now,
      )
      writeSelfCheck()
      return true
    }

    /**
     * Child session -> the session that delegated to it.
     *
     * A subagent announces itself on `session.created` with a `parentID`, and the parent's
     * own `subagent` tool call carries the child's id in its result metadata. Either is
     * enough; both are recorded because the second arrives even if the first is missed.
     */
    const parents = new Map()

    const ingest = createIngest({
      maxOutput: config.maxOutput,
      emit: (sessionID, record) => log.write(sessionID, record),
      parentOf: (sessionID) => parents.get(sessionID) ?? null,
      isStep: (sessionID) => deferred.has(sessionID),
      startAt: (sessionID) => log.lastN(sessionID),
    })

    // Hooks. Registration proving nothing is the whole reason the self-check exists:
    // a wrong name here would register happily and never fire (AGENTS.md Gotcha 8).
    const hook = async (domain, name, handler) => {
      try {
        await ctx[domain].hook(name, (payload) => {
          try {
            handler(payload)
          } catch (err) {
            onError(`${domain}.${name}`, err)
          }
        })
      } catch (err) {
        onError(`hook.register ${domain}.${name}`, err)
      }
    }

    await hook("session", "prompt", (p) => {
      // A subagent reading one of our work orders is the plugin's own work, not the user's. Only
      // ever a fresh session: one that already has a log is somebody's work, and is never
      // reclassified by what they happen to type.
      if (p?.sessionID && !log.probe(p.sessionID) && isWorkLine(p?.prompt?.text)) {
        // Fresh, so there is nothing written to take back — only what knew it as anything else.
        internal.add(p.sessionID)
        deferred.delete(p.sessionID)
        turnSeen.delete(p.sessionID)
        return
      }
      if (internal.has(p?.sessionID)) return
      if (p?.sessionID) {
        // A prompt starts a turn; one arriving after the last turn's end is a new turn.
        ended.delete(p.sessionID)
        sawTurn(p.sessionID)
      }
      ingest.prompt(p)
      observe(rootOf(p.sessionID))
    })

    /**
     * The plugin's own work, kept out of every log: its subagents, the calls that start them,
     * and the calls to the tools only that work uses. Otherwise the next analysis reads the
     * last one — a subagent reading another session's log, inside this one.
     */
    const ownWork = (p) =>
      internal.has(p?.sessionID) ||
      p?.tool === "retro_record" ||
      p?.tool === "retro_propose" ||
      (p?.tool === "subagent" && isWorkText(p?.input?.prompt))

    await hook("tool", "execute.before", (p) => {
      const key = callKey(p)
      const known = key ? calls.get(key) : undefined
      const ours = Boolean(known?.ours) || ownWork(p)
      if (key) {
        // Either half naming `subagent` makes it a delegation, whichever arrived first.
        const tool = known?.tool === "subagent" ? "subagent" : (p?.tool ?? known?.tool)
        calls.delete(key) // re-inserted last, so the oldest is first to go
        calls.set(key, { session: p?.sessionID, tool, ours, open: (known?.open ?? 0) + 1, named: Boolean(known?.named) })
        // Past the cap, the oldest call still open goes; never one kept as unaccounted for,
        // which rule 2 still needs and its turn's end removes (nineteenth review).
        if (calls.size > MAX_CALLS) {
          for (const [k, call] of calls) if (call.open > 0) { calls.delete(k); break }
        }
      }
      // Its first half was taken for the person's; it is ours, so that start is taken back.
      if (ours && known && !known.ours) ingest.unstart(p?.sessionID, p?.id)
      if (ours) {
        // A wrapper of a call already counted is the same call.
        if (known?.ours) return
        // Not logged, but counted: the event stream sees this call like any other, and the
        // self-check compares the two sides. See `ingest.ownCall`. Not for a call made *inside*
        // one of our own sessions, though: `handleEvent` drops those sessions' events, so
        // counting their calls added to one side only, and enough of them would cover a real
        // shortfall — the dead hook decision 19 exists to catch (pre-release review).
        if (!internal.has(p?.sessionID)) ingest.ownCall(p?.sessionID)
        return
      }
      ingest.toolBefore(p)
    })
    await hook("tool", "execute.after", (p) => {
      const child = p.tool === "subagent" ? p.result?.metadata?.sessionID : null
      // Decided at the start (`calls`). Only a call whose start this process never saw — it was
      // reloaded mid-call — is decided here, by what the call says, the only way left.
      const key = callKey(p)
      const known = key ? calls.get(key) : undefined
      if (known && child) known.named = true
      // Both halves of a Code Mode pair in. A delegation of ours that named no child stays, as
      // unaccounted for, until its turn ends (rule 2).
      if (known && --known.open <= 0 && !unaccounted(known)) calls.delete(key)
      // Everything a session of ours does is ours, including a call that started before the
      // session was known to be (ninth review).
      const ours = internal.has(p?.sessionID) || (known ? known.ours : ownWork(p))
      // The moment a child is known exactly: this call started it. Ours is claimed, the
      // person's adopted — whatever either was told (rule 2).
      if (child) deferred.delete(child)
      if (child && !internal.has(child)) (ours ? claimReader : adopt)(child, p.sessionID)
      if (ours) return
      ingest.toolAfter(p)
      // Measured on the parent, never on the child: the child's records are written into
      // the parent's log, so the self-check would otherwise look for sessions/<child>.jsonl,
      // not find it, and report BROKEN about a healthy session.
      observe(rootOf(p.sessionID))
    })

    // Commands. A command's execute is a context where generate.text returns (Gotcha 9),
    // so /retro settles the extraction debt before it looks for something to show.
    /** A command that throws surfaces as an HTTP 500 the user never sees. Log it too. */
    const command = (name, run) => async (invocation) => {
      try {
        await run(invocation)
      } catch (err) {
        onError(`command.${name}`, err)
        await say(invocation.sessionID, `_opencode-retro: \`/${name}\` failed: ${err?.message ?? err}. See .retro/plugin.log._`, "notice")
      }
    }

    try {
      await ctx.command.transform((cmds) => {
        cmds.add({
          name: "retro",
          description: "Propose what the last sessions should have taught this project",
          execute: command("retro", ({ sessionID, prompt }) => {
            const text = String(prompt?.text ?? "").trim().toLowerCase()
            return retro(sessionID, text.startsWith("all"))
          }),
        })
        cmds.add({
          name: "retro-all",
          description: "Propose everything waiting at once, as one plan",
          execute: command("retro-all", ({ sessionID }) => retro(sessionID, true)),
        })
      })
    } catch (err) {
      onError("command.register", err)
    }

    try {
      await ctx.tool.transform((tools) => {
        tools.add({
          name: "retro_decide",
          description:
            "Record the human's decision on a retro lesson. This tool is already available " +
            "in this session — there is nothing to install, locate or configure. Call it once " +
            "the human has decided and any change has been made. It only records the outcome; " +
            "it never edits the harness itself. Calling it twice for the same lesson is safe " +
            "and reports that the decision was already recorded.",
          input: DECIDE_INPUT,
          output: DECIDE_OUTPUT,
          execute: async (input, context) => {
            const result = decide(input, { store, state, session: context?.sessionID ?? null })
            pruneLogs()
            writeSelfCheck()
            return { output: result, content: result.detail }
          },
        })
        tools.add({
          name: "retro_record",
          description:
            "Record what one opencode-retro work order found. Call it exactly once per work " +
            "order, with the session id named in the order, the lessons — an empty list when " +
            "the session went straight — and `through`, the last step number you actually read. " +
            "It only records; it changes no file in the project.",
          input: RECORD_INPUT,
          output: DECIDE_OUTPUT,
          execute: async (input) => {
            const result = applyRecord({
              session: String(input?.session ?? ""),
              lessons: input?.lessons,
              through: Number(input?.through),
            })
            return { output: { ok: result.ok, detail: result.detail }, content: result.detail }
          },
        })
        tools.add({
          name: "retro_propose",
          description:
            "Hand over what the opencode-retro analyses found, once every work order has been " +
            "answered: the top lesson, or with `all` every waiting lesson as one plan. Returns " +
            "the text to put to the human, with what to do.",
          input: PROPOSE_INPUT,
          output: DECIDE_OUTPUT,
          execute: async (input, context) => {
            /**
             * Calling this is how the agent says the analyses are done, so an order still
             * open now is one nobody answered — the plugin cannot tell a subagent that died
             * from one still reading, and will not guess with a clock.
             *
             * Calling it too early is therefore possible, and must not destroy the work:
             * `applyRecord` accepts a record that arrives after its order was settled this
             * way, so a subagent that finishes late is still recorded.
             */
            const failures = settleUnanswered()
            // Logs still owed beyond what this round asked for, so the hand-over can say so.
            const left = owedLogs().filter((id) => id !== context?.sessionID).length
            const asked = rounds.get(context?.sessionID) ?? []
            rounds.delete(context?.sessionID)
            const analysed = asked.filter((s) => state.askedFor(s).done === "answered").length
            const { text, about } = await proposalText(Boolean(input?.all), { failures, left, analysed })
            // Logged, not sent: the agent asked for this and has it as the tool's result.
            noteHandover(context?.sessionID, text, about)
            return { output: { ok: true, detail: text }, content: text }
          },
        })
      })
    } catch (err) {
      onError("tool.register", err)
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            handleEvent(event)
          } catch (err) {
            onError("event", err)
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) onError("event.subscribe", err)
      }
    })()

    /**
     * Sessions that belong to another checkout of this project, by their own account.
     *
     * `ctx.event.subscribe` reaches every session in the project, and a git worktree is the
     * same project in a different directory — so a session running there arrives here in
     * full. `session.created` carries `location.directory`, which settles whose it is.
     * Measured: a worktree session reached this instance with the worktree's directory and
     * the shared projectID.
     *
     * We do not see `session.created` for our own first session, because plugins load
     * lazily per location (Gotcha 7) and the event has already gone by. That asymmetry is
     * the right way round: a directory we are told about and that is not ours means foreign,
     * and silence means ours — so a hook that genuinely stopped firing still reports BROKEN
     * instead of being excused as somebody else's session.
     */
    const foreign = new Set()

    function handleEvent(event) {
      const sessionID = event?.data?.sessionID

      if (event.type === "session.created" && sessionID) {
        // A directory that names the same place two ways is still ours. Comparing raw
        // strings made a trailing slash, or a relative path, look like another checkout —
        // and then the whole session was ignored by the event stream that decides when it
        // is over.
        if (isForeign(event)) return
        if (internal.has(sessionID)) return
        // Anything a reader of ours starts is ours, since every call of a session of ours is
        // (eighth review). A child of a parent with a delegation of ours in flight waits for a
        // delegation to end and say which it started (`deferred`).
        if (event.data?.parentID && internal.has(event.data.parentID)) {
          claimReader(sessionID, event.data.parentID)
          return
        }
        if (event.data?.parentID && !parents.has(sessionID) && oursInFlight(event.data.parentID)) {
          deferred.set(sessionID, event.data.parentID)
          handBack(sessionID)
          return
        }
        if (event.data?.parentID) adopt(sessionID, event.data.parentID)
      }
      // Before the gates: a reader's own turn ends behind them.
      if (sessionID && isTurnEnd(event)) {
        // A delegation cannot outlive the turn it runs in. Whatever is still deferred under this
        // session was named by nobody: ours if one of ours never named a child, theirs if every
        // one of ours named its own (rule 2) — never a session of its own, which a delegation
        // must not become.
        // A session of ours starts nothing of the person's (rule 3).
        const ours = internal.has(sessionID) || oursInFlight(sessionID)
        for (const [child, parent] of deferred) {
          if (parent !== sessionID) continue
          deferred.delete(child)
          if (!internal.has(child)) (ours ? claimReader : adopt)(child, parent)
        }
        // The turn's calls go with it, an interrupted one included (rule 1).
        for (const [key, call] of calls) if (call.session === sessionID) calls.delete(key)
      }

      // Whose events are taken in at all. A deferred session's are — its text, its steps, the
      // seq of its calls — and only its start and end are dropped, as a step's (`isStep`).
      if (sessionID && (foreign.has(sessionID) || internal.has(sessionID))) return
      ingest.event(event)

      if (event.type === "session.execution.started" && sessionID) {
        // An execution is one turn, not the life of the session: a session left open and
        // prompted again starts another one, and its end must not be dropped as a duplicate of
        // the previous turn's. Before the ownership gate on purpose: the start event arrives
        // before the turn's first hook.
        ended.delete(sessionID)
        sawTurn(sessionID)
      }

      // Only a session a hook has fired for is ours. `ctx.event.subscribe` reaches every
      // session in the project, including one in another checkout whose hooks never come
      // here, and we may not have seen its `session.created` (plugins load lazily). Without
      // this gate its end event still counted it towards freshness, queued a log that does
      // not exist, and rewrote selfcheck.md as BROKEN prompt hook / missing log — about a
      // session that is perfectly healthy somewhere else.
      if (!sessionID || !ingest.owned(sessionID)) return

      if (!isTurnEnd(event)) return

      if (ended.has(sessionID)) return
      // A subagent finishing is a step in its parent's task, not a session to analyse.
      if (parents.has(sessionID) || deferred.has(sessionID)) return
      ended.add(sessionID)
      observedSessions.delete(sessionID)

      const verified = {
        id: sessionID,
        counts: { ...ingest.counts(sessionID), startSeen: turnSeen.has(sessionID) },
        log: logFacts(sessionID),
        triggered: event.type,
        extraction: null,
        // Kept with the snapshot, so a report replayed from it later says when it really ended.
        endedAt: Date.now(),
      }
      check.verify(verified)
      writeSelfCheck()
      ingest.forget(sessionID)
      turnSeen.delete(sessionID)

      // No order is written here: nothing is analysed unasked, and there is no session to ask
      // in — a work order is read by a subagent of the session that ran `/retro`. The log is
      // owed because it grew; the next `/retro` asks about it.
      state.countSession(sessionID)
      lastVerified.delete(sessionID) // re-inserted: the map is in order of the latest end
      lastVerified.set(sessionID, verified)
      check.verify({ ...verified, extraction: { owed: true } })
      writeSelfCheck()
    }

    // Decide what git sees from inside our own directory, so the user never has to edit
    // theirs. Seeded once; after that the file is theirs.
    seedGitignore({ dir: config.dir, onError })

    // Seed the editable prompts, then look for a newer default. Neither touches a file
    // the user owns (AGENTS.md decisions 13 and 15).
    for (const name of ["extract", "propose"]) {
      prompts.seed(name)
      const update = prompts.checkForUpdate(name)
      if (update) check.note(update)
    }

    writeSelfCheck()

    return () => controller.abort()

    async function say(sessionID, text, about = "lesson") {
      try {
        // The synthetic goes to the session's inbox; without `resume` it sits there until
        // the user happens to type something, and they never see what they asked for.
        await ctx.session.synthetic({ sessionID, text, description: "opencode-retro", resume: true })
        noteHandover(sessionID, text, about)
      } catch (err) {
        onError("session.synthetic", err)
      }
    }

    /**
     * Our own text, written into the session's log (Gotcha 12).
     *
     * Separate from `say` because the two ways a hand-over reaches a session need different
     * halves of this. A synthetic does not fire the prompt hook, so it has to be logged or the
     * session's log shows the work with the instruction behind it missing. A hand-over the
     * agent *asked* for — `retro_propose` returns the text as a tool result — is already in
     * front of the agent and must not be sent again, but it still has to be logged, and for
     * the same reason: measured live, a review session showed the work-order hand-over, then
     * the agent reading files and running commands to check a lesson, then its verdict — with
     * nothing saying a lesson had been handed over at all. The contract tells an analysis that
     * work following a `handover` with `about: "lesson"` is the review of that lesson and not
     * the problem happening again; with no such record, that rule can never fire, and the
     * review is read as friction of its own. The bench had already caught that once, from the
     * other end, when the review added a session and 19 steps of cost to the lesson it was
     * checking.
     */
    function noteHandover(sessionID, text, about = "lesson") {
      try {
        const owner = rootOf(sessionID)
        const before = log.stat(owner).size
        const mark = state.looked(owner)
        ingest.handover(sessionID, text, about)
        // Our own text is not material (analysis.md), so a log read to its end is not owed for
        // it: otherwise every `/retro` left its own session "not analysed yet" in the report,
        // and the next command paid a read to skip it. It is still in the log, and the next
        // read carries it along with whatever the agent does after it.
        if (before > 0 && before === mark.size && !mark.open && !mark.failed) {
          state.look(owner, { size: log.stat(owner).size })
        }
      } catch (err) {
        onError("handover.log", err)
      }
    }

    /**
     * Whether this log still has to be read: it grew past its mark, or the last read stopped
     * at a gap, or it failed with attempts left (log.md, "Owed"). Computed from the file and
     * the mark every time, so there is nothing to fall out of step with them.
     */
    function isOwed(id) {
      const mark = markOf(id)
      if (log.stat(id).size > mark.size) return true
      if (mark.open) return true
      return Boolean(mark.failed && (mark.attempts ?? 0) < 3)
    }

    /** Unwritten for a week (session.md, "Quiet"): the only place the plugin reads a clock. */
    function isQuiet(id) {
      const file = log.probe(id)
      return Boolean(file) && Date.now() - file.mtimeMs >= QUIET_MS
    }

    /**
     * What the self-check is allowed to say about the log: it exists, how big it is, and how
     * many records are really in it. The ingest counters reset at every turn end, so they
     * cannot answer the last question for a session that was prompted again.
     */
    function logFacts(id) {
      return { ...log.stat(id), entries: log.count(id) }
    }

    /**
     * The session a chain of delegations ends at. A subagent's work belongs to the root that
     * asked for it, and a subagent may itself delegate: one level would measure the middle
     * session, which has no log of its own.
     */
    function rootOf(id) {
      let current = id
      for (let i = 0; i < 64; i++) {
        const parent = parents.get(current)
        if (!parent || parent === current) return current
        current = parent
      }
      return current
    }

    /**
     * Where this session's log has been read to, after making sure the mark describes the
     * file that is actually there.
     *
     * `looked.size` never goes backwards — that is what stops the same bytes being paid for
     * twice — so a log that was pruned and then written again under the same id would stay
     * "already read" for ever. A mark larger than the file is the one safe signal that the
     * file was replaced, and it is checked here rather than trusted.
     */
    function markOf(id) {
      const mark = state.looked(id)
      // Two files under one session id are two logs. A mark that names a different file than
      // the one on disk is void, whatever the sizes and step numbers say — this is what makes
      // "a replaced log is read from its own start" true for a longer replacement too, which
      // the size check cannot see.
      const file = log.probe(id)
      // A file that exists but has no whole first record is not the log the mark described:
      // the first record was whole when the mark was made and an append never rewrites it, so
      // this one was replaced or truncated. Treating the missing identity as "same file" let a
      // longer replacement keep the old step mark and its early steps were filtered away.
      const replaced = isReplacedLog(mark, file?.id ?? null, { exists: Boolean(file) }) || (file?.size ?? 0) < mark.size
      if (replaced && (mark.size || mark.n)) state.forget(id)
      return state.looked(id)
    }

    /**
     * Whether a session from `session.created` belongs to another checkout of this project.
     *
     * A git worktree is the same project in a different directory, so its sessions reach
     * this instance through the event stream while its hooks fire somewhere else. Comparing
     * resolved paths, not raw strings: `<dir>` and `<dir>/` are the same place, and treating
     * the second as foreign would silently discard a session of our own.
     */
    function isForeign(event) {
      const sessionID = event?.data?.sessionID
      const directory = event?.data?.location?.directory
      if (!sessionID || !directory || !ctx.location?.directory) return false
      if (resolvePath(directory) === resolvePath(ctx.location.directory)) return false
      foreign.add(sessionID)
      return true
    }

    /**
     * What this session has already been concluded to mean. Told to the extractor so it does
     * not re-derive a lesson that was accepted and archived — which the store would then
     * reopen as though the fix had not held, when all that happened is a second read.
     */
    function concludedFrom(sessionID) {
      return concludedIn(store.listArchive(), sessionID)
    }

    /**
     * A log goes when nothing can ask about it any more: it has been quiet for a week, nothing
     * is owed for it, and no open lesson cites it (log.md, "Pruned"). The week is what makes
     * this safe without knowing whether a session is working: a session that writes keeps its
     * log, and one picked up after a week of silence starts a new log, read from its start.
     * A log nobody has read is owed, so it is never pruned however old it is.
     *
     * Growth is bounded by the number of open lessons, which is capped, and by a week of
     * sessions, rather than by how long the project has existed. `keepSessions` keeps
     * everything.
     */
    function pruneLogs() {
      if (config.keepSessions) return
      const cited = citedSessions()
      for (const id of log.list()) {
        if (cited.has(id) || isOwed(id) || !isQuiet(id)) continue
        if (log.remove(id)) state.forget(id)
      }
    }

    /**
     * Learn that a session is a delegation, and claim anything already written under it.
     *
     * The child's own instruction reaches `session.prompt` before `session.created` reaches
     * the event stream, so by the time we know, a record or two may already sit in a log of
     * the child's own. Those are the delegation's instructions — the most useful part — so
     * they are moved into the parent's sequence and the orphan log is removed.
     */
    function adopt(child, parent) {
      if (parents.get(child) === parent) return
      parents.set(child, parent)
      ended.delete(child)
      turnSeen.delete(child)
      observedSessions.delete(child)
      const stray = log.read(child)
      const absorbed = ingest.absorb(child, stray)
      // A lesson may already cite the child: `/retro` can run between the child's end and the
      // moment the link is learned. Its evidence names a log that is about to be removed, so it
      // moves with the records — same root, renumbered steps.
      if (stray.length) store.remapEvidence(child, rootOf(parent), absorbed?.renumbered)
      // Unconditionally: this log belongs to a delegation now, whether or not its records
      // could be parsed. Leaving an unreadable orphan behind lets `analyseOwed` treat the
      // child as a session of its own — the one thing a delegation must never become.
      log.remove(child)
      // Its end may already have been processed, before the link was known: a delegation is a
      // step in its parent's task, so there is nothing of its own to analyse — and if that end
      // was counted before we knew, the count has to come back out, or freshness moves for
      // work that is never a session. `uncountSession` keeps the id, so a writer holding the
      // old count cannot put it back.
      state.uncountSession(child)
      // The self-check may have been measuring the child's log, which no longer exists — and
      // when the root is not measured (one deferred, or one of ours) the report goes back.
      observe(rootOf(parent), { force: true })
      handBack(child)
    }

    /**
     * When the stretch a lesson cites actually happened, from the log itself.
     *
     * A record is folded in long after the work it is about: a backlog is analysed after the
     * fixes taken from the logs ahead of it. So "is this problem back?" and "was this written
     * before the fix?" are different questions, and only the log can answer the second.
     *
     * The date is the latest record **inside the cited range** `[first, last]`, or inside the
     * whole log when the lesson cites no steps — in both cases no further than the order
     * covered (`upTo`). Both halves were found by review, from opposite
     * sides: dating by the newest record reached past the cited stretch into work done after a
     * fix and reopened accepted lessons on pre-fix evidence; reading `steps` as two separate
     * numbers then missed a recurrence inside the range, and left step-less evidence undated.
     * Nothing inside the range — or a log that cannot be read — is no date at all, and the
     * store reopens undated evidence, because that is the cheaper way to be wrong.
     */
    function datesIn(sessionID, upTo = Infinity) {
      let records = null
      return (steps) => {
        if (records === null) {
          try {
            records = parseShadowLog(readFileSync(log.path(sessionID), "utf8"))
          } catch {
            records = []
          }
        }
        if (!records.length) return null
        const cited = Array.isArray(steps) ? steps.map(Number).filter(Number.isFinite) : []
        const first = cited.length ? Math.min(...cited) : -Infinity
        // Never past what the order covered: records written after it — the session working on
        // while it was read — would date old evidence as new (third pre-release review).
        const last = Math.min(cited.length ? Math.max(...cited) : Infinity, upTo)
        const at = records.filter((r) => r.n >= first && r.n <= last && Number.isFinite(r.t)).map((r) => r.t)
        return at.length ? Math.max(...at) : null
      }
    }

    /** Sessions an open lesson points at. The reason a log is still on disk. */
    function citedSessions() {
      const cited = new Set()
      for (const lesson of store.list()) {
        const evidence = Array.isArray(lesson.evidence) ? lesson.evidence : [lesson.evidence].filter(Boolean)
        for (const e of evidence) if (e?.session) cited.add(e.session)
      }
      return cited
    }

    /**
     * A hint for the agent's own check, not a verdict.
     * A declaration, not a `const`: everything in here sits after setup's `return`, and
     * only declarations are hoisted. A `const` here is undefined when a command calls it.
     */
    function currencyOf(lesson) {
      return assessCurrency(lesson, { directory: config.directory, fingerprint })
    }

    /**
     * Both commands begin the same way: settle what the last round left unanswered, then
     * write a work order for every owed log. With orders out, the hand-over asks the agent to
     * have them read and to call `retro_propose` when they are in; with none, there is nothing
     * to wait for and the proposal goes straight out.
     */
    async function retro(sessionID, all) {
      const extracted = analyseOwed(sessionID)
      if (extracted.orders.length) {
        rounds.set(sessionID, extracted.orders.map((o) => o.session))
        await diagnose()
        writeSelfCheck()
        return say(
          sessionID,
          // Absolute, like the log path inside the order: the subagent's working directory is not
          // ours to assume, and `options.dir` outside the project made the relative form `../x/…`.
          renderWorkOrders(extracted.orders.map((o) => ({ ...o, path: workPath(o.session) })), {
            all,
            failures: extracted.failures,
            left: extracted.left,
          }),
          "work",
        )
      }
      const handed = await proposalText(all, extracted)
      return say(sessionID, handed.text, handed.about)
    }

    /**
     * What to put to the human — one lesson, every lesson as a plan, or that there is none — and
     * whether it is a lesson. `about` is what the hand-over is
     * logged as (handover.md): only a lesson makes the work after it a review, and "nothing to
     * review" logged as one had the next analysis discount real friction as the review of a
     * lesson nobody was handed.
     */
    async function proposalText(all, { failures = [], left = 0, analysed = 0 } = {}) {
      pruneLogs()
      const present = new Set(log.list())
      state.compact((id) => present.has(id))
      const extracted = { failures, left, analysed }
      const lessons = store.list()
      await diagnose()
      writeSelfCheck()

      if (all) {
        const open = pickOpen(lessons, { sessions: state.sessions, halfLife: config.halfLife })
        if (!open.length) return { text: renderNothing({ queued: left, extracted, dir: retroDir }), about: "notice" }
        const currencies = new Map()
        for (const lesson of open.slice(0, config.proposeLimit)) currencies.set(lesson.id, currencyOf(lesson))
        // A failed analysis is news in a batch exactly as it is in a single hand-over.
        const text =
          renderFailures(extracted) +
          renderBatch(open, {
            sessions: state.sessions,
            halfLife: config.halfLife,
            currencies,
            limit: config.proposeLimit,
            leadIn: prompts.resolve("propose")?.text,
            queued: left,
          })
        return { text, about: "lesson" }
      }

      // One invocation, one lesson: the top of the list. Deciding is the user's business, in
      // this session, with the agent that is already here.
      const lesson = pickLesson(lessons, { sessions: state.sessions, halfLife: config.halfLife })
      if (!lesson) return { text: renderNothing({ queued: left, extracted, dir: retroDir }), about: "notice" }
      const open = lessons.filter((l) => ["new", "later", undefined, null].includes(l.status)).length
      const text =
        renderFailures(extracted) +
        renderProposal(lesson, {
          total: open,
          remaining: open - 1,
          currency: currencyOf(lesson),
          sessions: state.sessions,
          halfLife: config.halfLife,
          leadIn: prompts.resolve("propose")?.text,
          queued: left,
          logs: logDir,
        })
      return { text, about: "lesson" }
    }

    /**
     * Every owed log, oldest first, so the session the command runs in comes last.
     *
     * "Everything accumulated" includes sessions still working — this one among them. Their
     * friction is the most recent there is, and reading a log does not settle anything a
     * session can still add to: the mark says how far it was read, and whatever it writes
     * next is simply owed.
     */
    function owedLogs(skip = new Set()) {
      return log
        .list()
        .filter((id) => !skip.has(id) && standsAlone(id) && isOwed(id))
        .map((id) => ({ id, at: log.probe(id)?.mtimeMs ?? 0 }))
        .sort((a, b) => a.at - b.at)
        .map((x) => x.id)
    }

    function analyseOwed(sessionID) {
      // What the last round left unanswered is settled first — reported and asked again, not
      // held against the log — so a round whose agent never called `retro_propose` ends here.
      const failures = settleUnanswered()

      // A mark at three failed attempts with no outcome to say so — a state written by a
      // process that died mid-retirement — is not owed and would be reported by nothing.
      for (const id of log.list()) {
        const mark = state.looked(id)
        if (!mark.failed || (mark.attempts ?? 0) < 3) continue
        const detail = SET_ASIDE
        state.markExtracted(id, { ok: false, detail, setAside: true })
        state.look(id, { open: false, failed: false, attempts: 0 })
        failures.push({ session: id, detail, setAside: true })
      }

      // One order per log per command, whatever happens to it. The cap counts orders: an
      // order is what costs a subagent. A skipped log takes none.
      const skip = new Set()
      const orders = []
      while (orders.length < config.extractLimit) {
        const [id] = owedLogs(skip)
        if (!id) break
        skip.add(id)
        const result = issueOrder(id)
        if (result?.order) orders.push(result.order)
        else if (!result?.ok && !result?.skipped) {
          failures.push({ session: id, detail: result?.detail ?? "unknown failure", setAside: Boolean(result?.setAside) })
        }
      }

      const ordered = new Set(orders.map((o) => o.session))
      const left = owedLogs().filter((id) => id !== sessionID && !ordered.has(id)).length
      return { orders, failures, left }
    }

    /**
     * The checks a session cannot make for itself, folded into every proposal instead of
     * hiding behind a command of its own.
     *
     * Free: a few property reads. It used to also ask the model whether it answers, which
     * was a call nobody requested, and which the analysis itself answers every time.
     */
    async function diagnose() {
      try {
        const report = await activeCheck({
          ctx,
          config,
          prompts,
          store,
        })
        for (const note of report.notes) check.note(note)
        check.active(report.checks)
        return report
      } catch (err) {
        onError("diagnose", err)
        return null
      }
    }

    /**
     * Where a session's work order is written, and how a hand-over names it. Declarations,
     * not bindings: everything here sits after setup's `return` (AGENTS.md Gotcha 13).
     */
    function workPath(session) {
      return join(config.work, `${session}.md`)
    }
    function workName(session) {
      return `${retroDir}/work/${session}.md`
    }

    /**
     * Whether a prompt is the exact line the hand-over prescribes for a reader. The only thing
     * that makes a *session* ours: a session is never reclassified by anything less, because a
     * session taken for ours is not logged again, and a person can type a path but does not type
     * this line by accident.
     */
    function isWorkLine(text) {
      return typeof text === "string" && text.trimStart().startsWith(`${WORK_MARK}: read `)
    }

    /** A turn seen to start, kept in order of the latest start (`handBack`). */
    function sawTurn(sessionID) {
      turnSeen.delete(sessionID)
      turnSeen.add(sessionID)
    }

    /**
     * Take a session for one of our readers: nothing of it is logged from now on, whatever it
     * already wrote goes, and the report — which its first prompt may have made about it — goes
     * back to the session that delegated it. One helper for both ways a reader is recognised,
     * because the two copies had already drifted (sixth review).
     */
    function claimReader(child, parent) {
      internal.add(child)
      log.remove(child)
      state.uncountSession(child)
      ingest.forget(child)
      observedSessions.delete(child)
      turnSeen.delete(child)
      ended.delete(child)
      deferred.delete(child)
      // What it started before it was known to be ours went its parent's way (ninth review), or
      // is waiting to be told whose it is (rule 3, nineteenth).
      for (const [grandchild, of] of parents) if (of === child && !internal.has(grandchild)) claimReader(grandchild)
      for (const [grandchild, of] of deferred) if (of === child && !internal.has(grandchild)) claimReader(grandchild)
      if (parent) observe(rootOf(parent), { force: true })
      handBack(child)
    }

    /**
     * A report about a session that turned out to be none of the person's goes back to the
     * person's session observed most recently — or to no session at all, rather than stay
     * about one of ours (eighth and ninth reviews).
     */
    function handBack(sessionID) {
      if (check.describing() !== sessionID) return
      // Working: observed most recently, or — a session resumed by a hand-over, which fires no
      // prompt hook — with a turn started and not observed yet. Only sessions we own.
      const working = (s) => s !== sessionID && standsAlone(s) && !ended.has(s) && ingest.owned(s)
      const person = [...observedSessions].reverse().find(working) ?? [...turnSeen].reverse().find(working)
      if (person) return observe(person, { force: true })
      // None working: the last one that ended, as it was measured then (tenth and eleventh).
      const last = [...lastVerified.keys()].reverse().find((s) => s !== sessionID && standsAlone(s) && ended.has(s))
      if (last) {
        // A log grown since its last analysis is waiting, as the end of its turn put it; a failed
        // or partial read says so itself (thirteenth review). Owed first: it settles the mark
        // against the file, which may void one describing a log since replaced (fourteenth).
        const owed = isOwed(last)
        const mark = state.looked(last)
        const grown = owed && !mark.failed && !mark.open
        const extraction = grown ? { owed: true } : (lastExtraction.get(last) ?? state.extractionOf(last) ?? (owed ? { owed: true } : null))
        check.replay({ ...lastVerified.get(last), extraction })
      } else check.clear()
      writeSelfCheck()
    }

    /**
     * A delegation of ours that has not named its child — running, or ended naming none. One that
     * named it is accounted for even while its Code Mode wrapper is still to finish (nineteenth).
     */
    function unaccounted(call) {
      return call.ours && call.tool === "subagent" && !call.named
    }

    /** Whether `parent` has a delegation of ours unaccounted for (rule 2). */
    function oursInFlight(parent) {
      for (const call of calls.values()) if (call.session === parent && unaccounted(call)) return true
      return false
    }

    /**
     * Whether a prompt is the plugin asking a subagent to read one of its work orders.
     *
     * Strict on purpose. This used to match any text containing the mark or `.retro/work/`, and
     * a match marks a session as the plugin's own **for good** — every later prompt, tool call
     * and event of it left out of the log. So a person who asked their own agent "what is in
     * `.retro/work/`?" silently stopped being logged from that moment, which in this repository,
     * where the plugin runs on itself, is not a far-fetched thing to type (pre-release review).
     *
     * For a *delegation* — the `subagent` call an agent makes in answer to our hand-over —
     * two ways in, both about an order we actually issued: the exact line, or the exact path of
     * an order that is still open, for an agent that worded it its own way. Decided once, when
     * the call starts (`calls`). What is left: a person's own agent delegating a subagent
     * with a prompt that names an open order's exact path is taken for ours, and that
     * subagent's work is not logged. A session a person types into is never taken for ours by
     * a path — see `isWorkLine`.
     */
    function isWorkText(text) {
      if (typeof text !== "string") return false
      if (isWorkLine(text)) return true
      return state.openOrders().some((o) => text.includes(workPath(o.session)) || text.includes(workName(o.session)))
    }

    /**
     * Read a log and write its work order (analysis.md, "Work order").
     *
     * Returns `{ skipped }` for a log that cannot hold evidence — settled at once, no order;
     * `{ ok: false, detail }` for one that cannot be ordered, charged as a failed attempt; and
     * `{ ok: true, order }` otherwise.
     */
    function issueOrder(sessionID) {
      // The mark is checked against the file that is actually there first: a log that was
      // pruned and written again is smaller than the mark that described the old one.
      let mark = markOf(sessionID)

      let raw = null
      try {
        raw = readFileSync(log.path(sessionID))
      } catch (err) {
        onError("extract.read", err)
      }
      const text = raw == null ? null : raw.toString("utf8")
      const records = text == null ? null : parseShadowLog(text)
      const lastN = records?.length ? Math.max(...records.map((r) => r.n ?? 0)) : 0

      // Which log this is, from the bytes that were actually read. A log can be replaced
      // between `markOf` and the read, and the old mark must not filter the new log's first
      // steps away as already analysed.
      const identity = identityOf(text)
      if (raw != null && isReplacedLog(mark, identity, { exists: true })) {
        state.forget(sessionID)
        mark = { n: 0, size: 0 }
      }
      // A log whose numbering ends before the mark does was replaced, not appended to.
      if (lastN > 0 && lastN < mark.n) {
        state.forget(sessionID)
        mark = { n: 0, size: 0 }
      }

      /** How much was actually read, not how large the file is by the time it is answered. */
      const readSize = raw == null ? log.stat(sessionID).size : raw.length
      const failed = (detail) => fail(sessionID, { size: readSize, id: identity }, detail)

      // A log we could not read is a failure like any other: reported, retried, never called
      // a clean analysis. A file that exists but yields no record was corrupted or truncated.
      if (raw == null) return failed("shadow log could not be read")
      if (records.length === 0) return failed("shadow log could not be parsed: no line is a record")

      /**
       * Only the part that has not been turned into lessons yet, with the prompts kept
       * whatever their step: they say what the session was for.
       */
      const fresh = mark.n > 0 ? records.filter((r) => r.n > mark.n || r.k === "prompt") : records
      const composed = composeOrder({
        records: fresh,
        analysedUpTo: mark.n,
        concluded: concludedFrom(sessionID),
        session: sessionID,
        // Absolute, because the subagent's working directory is not ours to assume.
        logPath: log.path(sessionID),
        lessonsDir: config.lessons,
        lastN,
        prompts,
        store,
        state,
      })

      if (composed.skipped) {
        // A skip covers nothing: the size moves, so nothing is asked again until the log
        // grows, and the step mark does not, so when it grows it is read from the start.
        state.look(sessionID, { size: readSize, open: false, failed: false, attempts: 0, id: identity })
        state.markExtracted(sessionID, { ok: true, detail: composed.detail })
        lastExtraction.set(sessionID, composed)
        return composed
      }
      if (!composed.ok) return failed(composed.detail)

      try {
        mkdirSync(config.work, { recursive: true })
        writeFileSync(workPath(sessionID), composed.text)
      } catch (err) {
        onError("extract.order", err)
        return failed(`the work order could not be written: ${err?.message ?? err}`)
      }
      // The order asks for everything up to `lastN`. How far the reader actually got is the
      // reader's to report (`through` on the record, required); unreported, the log counts as
      // unread (`applyRecord`).
      // `asked` counts the askings for this log, and only resets when the log grows: new
      // material has not been asked about yet (analysis.md, "Asked").
      // Against the previous order's size, not the mark: an unanswered order leaves the mark
      // where it was on purpose, so the mark cannot say whether this is new material.
      const previous = state.askedFor(sessionID)
      const asked = (readSize > previous.size ? 0 : previous.asked) + 1
      const order = { id: identity, size: readSize, lastN, n: mark.n, asked }
      state.issue(sessionID, order)
      return { ok: true, order: { session: sessionID, ...order } }
    }

    /**
     * A failed attempt (analysis.md, "Attempt"). The step mark does not move — a failure must
     * not skip the material it failed on — and the bytes are recorded as read. Attempts
     * belong to the input they were spent on, and three on one input retire the log.
     */
    function fail(sessionID, { size, id }, detail) {
      const mark = state.looked(sessionID)
      const attempts = (size > mark.size ? 0 : (mark.attempts ?? 0)) + 1
      onError(`extract.${sessionID}`, detail)
      let result = { ok: false, detail }
      if (attempts >= 3) {
        // The outcome first: a crash between the two writes then leaves a mark still owed
        // (one more attempt) rather than a log nobody owes and nothing reports.
        // Said by a flag as well as in words: three places act on it, and sniffing the prose
        // for a prefix let any rewording turn them back into "tries again" (fifteenth review).
        result = { ok: false, detail: `${SET_ASIDE}: ${detail}`, setAside: true }
        state.markExtracted(sessionID, result)
        state.look(sessionID, { size, open: false, failed: false, attempts: 0, id })
      } else {
        state.look(sessionID, { size, open: false, failed: true, attempts, id })
      }
      lastExtraction.set(sessionID, result)
      return result
    }

    /**
     * Orders nobody answered. Called when `retro_propose` is — the agent says the analyses
     * are done — and at the start of every `/retro`, for a round that never got that far.
     */
    function settleUnanswered() {
      const failures = []
      for (const order of state.openOrders()) {
        /**
         * Reported and asked again, and **not held against the log** (analysis.md).
         *
         * There are two causes and the plugin cannot tell them apart: nobody came — a
         * hand-over into a session that is still working waits in its inbox, so nothing was
         * started and nothing spent — or a reader tried and could not record. Guessing picked
         * the wrong one: three rounds of nobody-came retired a readable log under the words
         * "given up after three failed analyses", when no analysis had been attempted at all.
         *
         * So nothing is concluded. The mark is left exactly as it was, which is what keeps the
         * log owed, and what is reported is the one thing we know: how many times we asked.
         */
        const asked = order.asked ?? 1
        const detail =
          `asked ${asked} time${asked === 1 ? "" : "s"} and no record came back. Nothing is owed ` +
          "of the log itself; the next `/retro` asks again. If this keeps happening, the " +
          "hand-over is probably waiting in the inbox of a session that is still working — one " +
          "`/retro` in a session that is not will be picked up."
        state.close(order.session, "unanswered")
        removeWork(order.session)
        state.markExtracted(order.session, { ok: false, detail })
        lastExtraction.set(order.session, { ok: false, detail })
        onError(`extract.${order.session}`, detail)
        failures.push({ session: order.session, detail, asked })
      }
      return failures
    }

    /**
     * An analysis's outcome, on the session's own line of the report — only when the report is
     * about that session, since an old snapshot of it would otherwise replace the session
     * somebody is working in (fourth review). A session working again is measured afresh, not
     * replayed from the end of its last turn (fifth). The stock section says what became of
     * every log either way.
     */
    function reportOutcome(sessionID, result) {
      if (check.describing() === sessionID) {
        if (!ended.has(sessionID)) {
          if (observe(sessionID, { force: true })) return
        } else {
          const verified = lastVerified.get(sessionID)
          if (verified) check.verify({ ...verified, extraction: result })
        }
      }
      // Once per record: observing writes the report itself (nineteenth review).
      writeSelfCheck()
    }

    function removeWork(sessionID) {
      try {
        rmSync(workPath(sessionID), { force: true })
      } catch (err) {
        onError("extract.order.remove", err)
      }
    }

    /**
     * A subagent's answer, through `retro_record`: applied to the order it answers, and to
     * nothing else (analysis.md, "Record").
     */
    function applyRecord({ session, lessons, through }) {
      /**
       * An answer that arrives after its order was settled as unanswered is still accepted —
       * the reading happened, only the reporting was late. That is what makes calling
       * `retro_propose` early a mistake with no cost: the round is closed, the attempt is
       * charged, and then the record comes in, is applied, and gives the attempt back.
       *
       * Only `unanswered` reopens. An order already answered must not be answered twice
       * (recurrence counts sessions, not records), and one voided because the log was
       * replaced is about a session that no longer exists.
       */
      const late = !state.orderOf(session) && state.unansweredOrder(session)
      const order = state.orderOf(session) ?? late
      if (!order) {
        return {
          ok: false,
          detail: `no work order is open for \`${session}\` — it was answered already, or never issued. Nothing was recorded.`,
        }
      }
      const file = log.probe(session)
      if (!file || (order.id && file.id && order.id !== file.id)) {
        state.close(session, "void")
        removeWork(session)
        return { ok: false, detail: `the log of \`${session}\` was replaced since its order was written; it will be asked for again.` }
      }
      /**
       * How far the log was read, as the reader reports it. Reported and not measured: the
       * plugin does not render what is read, so it cannot know, and `through` is required by
       * the schema for exactly that reason — whoever read it is the only one who can say.
       *
       * Unreported, the log counts as unread: the lessons are kept, because they are real,
       * but the step mark does not move and the log is left owed so the next command reads
       * it again. The alternative — assuming it was read in full — is the one failure that
       * loses material silently, and silence is what this plugin exists to end. (OpenCode
       * enforces the schema, so this is a backstop, not a path.)
       *
       * It is clamped to the order's own range: a `through` past `lastN` would mark steps as
       * read that were not in the log when the order was written, and one at or below the old
       * mark says nothing new was read at all, which is a failed attempt rather than a
       * settled log.
       */
      const reported = Number.isFinite(through)
      const claimed = reported ? Math.min(Math.trunc(through), order.lastN) : order.n
      if (reported && claimed <= order.n && order.lastN > order.n) {
        const failed = fail(session, order, "the analysis reported reading nothing new")
        // Said as it is: the third such read sets the log aside, and the reply used to promise
        // another ask regardless (fifth review).
        const detail =
          `\`${session}\` was read only as far as step ${claimed}, which is no further than the ` +
          `${order.n} already analysed. Nothing was recorded; ` +
          (failed.setAside
            ? `the log is now ${SET_ASIDE}, and is not asked about again unless it grows.`
            : "the log will be asked about again.")
        // Closed as `empty`, not `unanswered`: an answer came back, it just covered nothing new.
        // As "unanswered" the self-check reported no record about a log whose reader had
        // answered, while counting the same read as failed (second pre-release review).
        state.close(session, "empty")
        removeWork(session)
        // The report is rewritten here too, the session's own line with it, which still said the
        // log was waiting (third pre-release review) — after the order is closed, so it never
        // shows the order as still open (nineteenth).
        reportOutcome(session, failed)
        return { ok: false, detail }
      }
      const partial = claimed < order.lastN
      const answered = recordAnswer({
        session,
        lessons,
        store,
        state,
        fingerprint,
        partial,
        unreported: !reported,
        // Bounded by what the order covered, not by how far the reader says it got: every step up
        // to `lastN` went out with the order, and what the cap is for is the session's work
        // after it (third review). Bounding by `through` made citing one more step flip the
        // outcome (sixteenth and seventeenth reviews).
        dateOf: datesIn(session, order.lastN),
      })
      // `open` is what makes a partial read useful: the next command reads on from the mark
      // without waiting for the log to grow.
      state.look(session, {
        size: order.size,
        ...(claimed > 0 ? { n: claimed } : {}),
        open: partial,
        failed: false,
        attempts: 0,
        id: order.id,
      })
      const result = {
        ok: true,
        detail: answered.detail + (late ? " (recorded after the round was closed, and applied anyway)" : ""),
        through: claimed,
      }
      state.markExtracted(session, { ok: true, detail: answered.detail })
      state.close(session, "answered")
      removeWork(session)
      lastExtraction.set(session, result)
      reportOutcome(session, result)
      return result
    }
  },
}

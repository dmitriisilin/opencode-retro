import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, relative as relativePath, resolve as resolvePath, sep } from "node:path"
import { createIngest } from "./src/ingest.js"
import { createPrompts } from "./src/prompts.js"
import { createSelfCheck } from "./src/selfcheck.js"
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
     * What is waiting, as the marks say it is. A log whose last read failed is named as a
     * failure, not as something nobody has looked at; everything else owed is waiting.
     */
    function stockFacts() {
      let queued = 0
      let failing = 0
      let partial = 0
      for (const id of log.list()) {
        if (parents.has(id) || !isOwed(id)) continue
        const mark = state.looked(id)
        if (mark.failed) failing++
        // Read in part and nothing new since: a log too long for one call, which the next
        // command reads on from where this one stopped. Calling it "not analysed yet" right
        // after `/retro` read it made the command look as if it had not finished. An unread
        // gap outranks later growth: the log is still read in part whether or not something
        // wrote to it afterwards, and saying "not analysed yet" throws away that it was.
        else if (mark.open) partial++
        else queued++
      }
      return { queued, failing, partial }
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
          setAside: log.list().filter((id) => !isOwed(id) && state.extractionOf(id)?.ok === false).length,
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
      if (!sessionID) return
      // A hook that arrives after the session's end belongs to that session, and its record is
      // written — but it is not news about liveness. Re-measuring here would recreate the
      // forgotten ingest counts and report `BROKEN prompt hook` about a session that was fine
      // and is over.
      if (ended.has(sessionID)) return
      const now = Date.now()
      const first = !observedSessions.has(sessionID)
      if (!first && !force && now - lastBeat < config.heartbeatMs) return
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
      // A subagent reading one of our work orders is the plugin's own work, not the user's.
      if (isWorkText(p?.prompt?.text)) {
        if (p?.sessionID) internal.add(p.sessionID)
        return
      }
      if (internal.has(p?.sessionID)) return
      if (p?.sessionID) {
        // A prompt starts a turn; one arriving after the last turn's end is a new turn.
        ended.delete(p.sessionID)
        turnSeen.add(p.sessionID)
      }
      ingest.prompt(p)
      observe(rootOf(p.sessionID))
    })

    /**
     * The plugin's own work, kept out of every log: its subagents, the calls that start them,
     * and the calls to the tools only that work uses. Otherwise the next analysis reads the
     * last one — a work order's projection of another session inside this one.
     */
    const ownWork = (p) =>
      internal.has(p?.sessionID) ||
      p?.tool === "retro_record" ||
      p?.tool === "retro_propose" ||
      (p?.tool === "subagent" && isWorkText(p?.input?.prompt))

    await hook("tool", "execute.before", (p) => {
      if (ownWork(p)) {
        // Not logged, but counted: the event stream sees this call like any other, and the
        // self-check compares the two sides. See `ingest.ownCall`.
        ingest.ownCall(p?.sessionID)
        return
      }
      ingest.toolBefore(p)
    })
    await hook("tool", "execute.after", (p) => {
      const child = p.tool === "subagent" ? p.result?.metadata?.sessionID : null
      if (child && (isWorkText(p.input?.prompt) || internal.has(child))) {
        // One of ours. If its own prompt did not carry the mark (the agent may have worded the
        // delegation its own way), whatever it wrote before the link was known goes now.
        internal.add(child)
        log.remove(child)
        state.uncountSession(child)
      } else if (child) {
        adopt(child, p.sessionID)
      }
      if (ownWork(p)) return
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
        await say(invocation.sessionID, `_opencode-retro: \`/${name}\` failed: ${err?.message ?? err}. See .retro/plugin.log._`)
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
            "order, with the session id named in the order and the lessons — an empty list when " +
            "the session went straight. It only records; it changes no file in the project.",
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
             * way, so a subagent that finishes late is still recorded and the attempt it
             * was charged is given back.
             */
            const failures = settleUnanswered()
            // Logs still owed beyond what this round asked for, so the hand-over can say so.
            const left = owedLogs().filter((id) => id !== context?.sessionID).length
            const text = await proposalText(Boolean(input?.all), { failures, left })
            // Logged, not sent: the agent asked for this and has it as the tool's result.
            noteHandover(context?.sessionID, text, "lesson")
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
        if (event.data?.parentID) adopt(sessionID, event.data.parentID)
      }
      if (sessionID && (foreign.has(sessionID) || internal.has(sessionID))) return
      ingest.event(event)

      if (event.type === "session.execution.started" && sessionID) {
        // An execution is one turn, not the life of the session: a session left open and
        // prompted again starts another one, and its end must not be dropped as a duplicate of
        // the previous turn's. Before the ownership gate on purpose: the start event arrives
        // before the turn's first hook.
        ended.delete(sessionID)
        turnSeen.add(sessionID)
      }

      // Only a session a hook has fired for is ours. `ctx.event.subscribe` reaches every
      // session in the project, including one in another checkout whose hooks never come
      // here, and we may not have seen its `session.created` (plugins load lazily). Without
      // this gate its end event still counted it towards freshness, queued a log that does
      // not exist, and rewrote selfcheck.md as BROKEN prompt hook / missing log — about a
      // session that is perfectly healthy somewhere else.
      if (!sessionID || !ingest.owned(sessionID)) return

      // session.idle never fires outside the TUI (AGENTS.md Gotcha 2), so the end of work
      // is session.execution.*.
      const done =
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      if (!done) return

      if (ended.has(sessionID)) return
      // A subagent finishing is a step in its parent's task, not a session to analyse.
      if (parents.has(sessionID)) return
      ended.add(sessionID)
      observedSessions.delete(sessionID)

      const verified = {
        id: sessionID,
        counts: { ...ingest.counts(sessionID), startSeen: turnSeen.has(sessionID) },
        log: logFacts(sessionID),
        triggered: event.type,
        extraction: null,
      }
      check.verify(verified)
      writeSelfCheck()
      ingest.forget(sessionID)
      turnSeen.delete(sessionID)

      // No order is written here: nothing is analysed unasked, and there is no session to ask
      // in — a work order is read by a subagent of the session that ran `/retro`. The log is
      // owed because it grew; the next `/retro` asks about it.
      state.countSession(sessionID)
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
      // The self-check may have been measuring the child's log, which no longer exists.
      observe(rootOf(parent), { force: true })
    }

    /**
     * When the steps a lesson cites actually happened, from the log itself.
     *
     * A record is folded in long after the work it is about: a backlog is analysed after the
     * fixes taken from the logs ahead of it. So "is this problem back?" and "was this written
     * before the fix?" are different questions, and only the log can answer the second.
     * Falls back to the newest record, and to nothing at all if the log cannot be read — in
     * which case the store treats the evidence as undated and reopens as it always did.
     */
    function datesIn(sessionID) {
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
        const cited = Array.isArray(steps) && steps.length ? Math.max(...steps) : null
        const at = cited == null ? null : records.find((r) => r.n === cited)?.t
        if (Number.isFinite(at)) return at
        const newest = records.reduce((max, r) => (Number.isFinite(r.t) && r.t > max ? r.t : max), 0)
        return newest > 0 ? newest : null
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
        await diagnose()
        writeSelfCheck()
        return say(
          sessionID,
          renderWorkOrders(extracted.orders.map((o) => ({ ...o, path: workName(o.session) })), {
            all,
            failures: extracted.failures,
            left: extracted.left,
          }),
          "work",
        )
      }
      return say(sessionID, await proposalText(all, extracted))
    }

    /** What to put to the human: one lesson, every lesson as a plan, or that there is none. */
    async function proposalText(all, { failures = [], left = 0 } = {}) {
      pruneLogs()
      const present = new Set(log.list())
      state.compact((id) => present.has(id))
      const extracted = { failures, left }
      const lessons = store.list()
      await diagnose()
      writeSelfCheck()

      if (all) {
        const open = pickOpen(lessons, { sessions: state.sessions, halfLife: config.halfLife })
        if (!open.length) return renderNothing({ queued: left, extracted, dir: retroDir })
        const currencies = new Map()
        for (const lesson of open.slice(0, config.proposeLimit)) currencies.set(lesson.id, currencyOf(lesson))
        // A failed analysis is news in a batch exactly as it is in a single hand-over.
        return (
          renderFailures(extracted) +
          renderBatch(open, {
            sessions: state.sessions,
            halfLife: config.halfLife,
            currencies,
            limit: config.proposeLimit,
            leadIn: prompts.resolve("propose")?.text,
            queued: left,
          })
        )
      }

      // One invocation, one lesson: the top of the list. Deciding is the user's business, in
      // this session, with the agent that is already here.
      const lesson = pickLesson(lessons, { sessions: state.sessions, halfLife: config.halfLife })
      if (!lesson) return renderNothing({ queued: left, extracted, dir: retroDir })
      const open = lessons.filter((l) => ["new", "later", undefined, null].includes(l.status)).length
      return (
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
      )
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
        .filter((id) => !skip.has(id) && !parents.has(id) && !internal.has(id) && isOwed(id))
        .map((id) => ({ id, at: log.probe(id)?.mtimeMs ?? 0 }))
        .sort((a, b) => a.at - b.at)
        .map((x) => x.id)
    }

    function analyseOwed(sessionID) {
      // What the last round left unanswered is a failed attempt, decided before anything new
      // is asked for — a round whose agent never called `retro_propose` ends here.
      const failures = settleUnanswered()

      // A mark at three failed attempts with no outcome to say so — a state written by a
      // process that died mid-retirement — is not owed and would be reported by nothing.
      for (const id of log.list()) {
        const mark = state.looked(id)
        if (!mark.failed || (mark.attempts ?? 0) < 3) continue
        const detail = "given up after three failed analyses"
        state.markExtracted(id, { ok: false, detail })
        state.look(id, { open: false, failed: false, attempts: 0 })
        failures.push({ session: id, detail })
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
        else if (!result?.ok && !result?.skipped) failures.push({ session: id, detail: result?.detail ?? "unknown failure" })
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

    /** Whether a prompt is one of the plugin's own work orders being handed to a subagent. */
    function isWorkText(text) {
      return typeof text === "string" && (text.includes(WORK_MARK) || text.includes(`${retroDir}/work/`))
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
      // reader's to report (`through` on the record); unreported, the order was answered in
      // full, which is what the contract asks for.
      const order = { id: identity, size: readSize, lastN, n: mark.n }
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
        result = { ok: false, detail: `given up after three failed analyses: ${detail}` }
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
        const result = fail(order.session, order, "no record came back from its analysis")
        state.close(order.session, "unanswered")
        removeWork(order.session)
        failures.push({ session: order.session, detail: result.detail })
      }
      return failures
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
        const detail =
          `\`${session}\` was read only as far as step ${claimed}, which is no further than the ` +
          `${order.n} already analysed. Nothing was recorded; the log will be asked about again.`
        fail(session, order, "the analysis reported reading nothing new")
        state.close(session, "unanswered")
        removeWork(session)
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
        dateOf: datesIn(session),
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
        detail: answered.detail + (late ? " (recorded after the round was closed; the failed attempt is given back)" : ""),
        through: claimed,
      }
      state.markExtracted(session, { ok: true, detail: answered.detail })
      state.close(session, "answered")
      removeWork(session)
      lastExtraction.set(session, result)
      const verified = lastVerified.get(session)
      if (verified) check.verify({ ...verified, extraction: result })
      writeSelfCheck()
      return result
    }
  },
}

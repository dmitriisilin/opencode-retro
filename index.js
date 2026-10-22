import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { relative as relativePath, resolve as resolvePath, sep } from "node:path"
import { createIngest } from "./src/ingest.js"
import { createPrompts } from "./src/prompts.js"
import { createSelfCheck } from "./src/selfcheck.js"
import { createShadowLog, identityOf, isReplacedLog, parseShadowLog } from "./src/shadowlog.js"
import { createState } from "./src/state.js"
import { concludedIn, createStore, score } from "./src/lessons.js"
import { assessCurrency, fingerprintOf } from "./src/currency.js"
import { extract } from "./src/extract.js"
import { pickLesson, pickOpen, renderBatch, renderFailures, renderNothing, renderProposal } from "./src/propose.js"
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
 * Writes a shadow log of every prompt and tool call. `/retro` reads whatever has been written
 * since the last time — one clean-context model call per log — turns it into lessons, hands
 * the highest-scoring one to the session you are in, and stops there: you and the agent
 * decide what to do with it. A self-check says whether any of it worked.
 *
 * Everything it knows about a session is on disk: the log, and how far it was read. Nothing
 * depends on this process having seen a session start or end, so a restart, a crash or a
 * second instance on the project changes nothing about what is read or removed — and a log
 * is removed only once it has been quiet for a week (docs/concepts/session.md).
 *
 * Nothing is analysed until `/retro` asks for it: a model call costs money, and nothing
 * here spends it unprompted. The analysis goes through a session of its own rather than
 * `generate.text`, which refuses OpenCode's free-tier models — see `analyse`.
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
    let draining = false
    /** Learned from session.model.request; see resolveModel. */
    let lastSessionModel = null
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
      if (p?.sessionID) {
        // A prompt starts a turn; one arriving after the last turn's end is a new turn.
        ended.delete(p.sessionID)
        turnSeen.add(p.sessionID)
      }
      ingest.prompt(p)
      observe(rootOf(p.sessionID))
      // Analysis is what `/retro` does, not something a new session triggers: a model call
      // costs money and nothing here spends it unprompted. `autoExtract` restores the old
      // behaviour for anyone who wants lessons ready before they ask.
      if (config.autoExtract) void drainOne(p.sessionID)
    })

    // The model the user actually works with, so extraction can default to it instead of
    // demanding configuration. `model.request` carries only session and telemetry headers;
    // never hook http.request, which carries the provider credential (AGENTS.md Gotcha 5).
    await hook("session", "model.request", (p) => {
      if (p?.kind === "primary" && p.model?.providerID && p.model?.id) {
        lastSessionModel = { providerID: p.model.providerID, id: p.model.id }
      }
    })

    await hook("tool", "execute.before", (p) => {
      ingest.toolBefore(p)
    })
    await hook("tool", "execute.after", (p) => {
      if (p.tool === "subagent" && p.result?.metadata?.sessionID) {
        adopt(p.result.metadata.sessionID, p.sessionID)
      }
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
            return text.startsWith("all") ? proposeAll(sessionID) : proposeOne(sessionID)
          }),
        })
        cmds.add({
          name: "retro-all",
          description: "Propose everything waiting at once, as one plan",
          execute: command("retro-all", ({ sessionID }) => proposeAll(sessionID)),
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
        if (event.data?.parentID) adopt(sessionID, event.data.parentID)
      }
      if (sessionID && foreign.has(sessionID)) return
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

      // Not extracted here: a model call from the event stream never returns, and nothing is
      // analysed unasked. The log is owed because it grew; `/retro` reads it.
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

    async function say(sessionID, text) {
      try {
        // The synthetic goes to the session's inbox; without `resume` it sits there until
        // the user happens to type something, and they never see what they asked for.
        await ctx.session.synthetic({ sessionID, text, description: "opencode-retro", resume: true })
        // Written to the log ourselves, because a synthetic does not fire the prompt hook:
        // without this the session's own log shows the work and not the instruction behind it.
        const owner = rootOf(sessionID)
        const before = log.stat(owner).size
        const mark = state.looked(owner)
        ingest.handover(sessionID, text)
        // Our own text is not material (analysis.md), so a log read to its end is not owed for
        // it: otherwise every `/retro` left its own session "not analysed yet" in the report,
        // and the next command paid a read to skip it. It is still in the log, and the next
        // read carries it along with whatever the agent does after it.
        if (before > 0 && before === mark.size && !mark.open && !mark.failed) {
          state.look(owner, { size: log.stat(owner).size })
        }
      } catch (err) {
        onError("session.synthetic", err)
      }
    }

    /**
     * One analysis call, through a session of our own.
     *
     * Not `ctx.generate.text`: that endpoint refuses OpenCode's own free-tier models with
     * "can only be used from within OpenCode", from a command's execute as much as from
     * anywhere else. A session is within OpenCode, and `session.generate` on the very same
     * free model returns normally — measured. So this path works whatever the user runs on,
     * including with no configuration at all.
     *
     * The session is created for the call and removed after it, so it does not pile up in
     * the user's session list. `generate` is its own request kind: no agent loop, no tools,
     * no history — the clean context extraction needs.
     */
    async function analyse({ prompt, model }) {
      const session = await ctx.session.create({
        title: "opencode-retro analysis",
        location: ctx.location,
        ...(model?.providerID && model?.id ? { model: { providerID: model.providerID, id: model.id } } : {}),
      })
      try {
        return await ctx.session.generate({ sessionID: session.id, prompt })
      } finally {
        try {
          await ctx.session.remove({ sessionID: session.id })
        } catch (err) {
          onError("session.remove", err)
        }
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

    async function proposeAll(sessionID) {
      const extracted = await analyseOwed(sessionID)

      const open = pickOpen(store.list(), { sessions: state.sessions, halfLife: config.halfLife })
      await diagnose()
      writeSelfCheck()
      if (!open.length) return say(sessionID, renderNothing({ queued: extracted.left, extracted, dir: retroDir }))

      const shown = open.slice(0, config.proposeLimit)
      const currencies = new Map()
      for (const lesson of shown) currencies.set(lesson.id, currencyOf(lesson))

      // A failed analysis is news in a batch exactly as it is in a single hand-over. The
      // batch path used to drop it, so `/retro all` showed a plan and said nothing about the
      // log it could not read — the one kind of silence this plugin exists to prevent.
      return say(
        sessionID,
        renderFailures(extracted) +
          renderBatch(open, {
            sessions: state.sessions,
            halfLife: config.halfLife,
            currencies,
            limit: config.proposeLimit,
            leadIn: prompts.resolve("propose")?.text,
            queued: extracted.left,
          }),
      )
    }

    /**
     * Both proposal modes analyse what has accumulated before they propose anything: one
     * `/retro` reads every owed log, turns it into lessons, and only then looks for something
     * to hand over.
     *
     * "Everything accumulated" includes sessions still working — this one among them. Their
     * friction is the most recent there is, and reading a log does not settle anything a
     * session can still add to: the mark says how far it was read, and whatever it writes
     * next is simply owed. Oldest first, so the session the command runs in comes last.
     */
    function owedLogs(skip = new Set()) {
      return log
        .list()
        .filter((id) => !skip.has(id) && !parents.has(id) && isOwed(id))
        .map((id) => ({ id, at: log.probe(id)?.mtimeMs ?? 0 }))
        .sort((a, b) => a.at - b.at)
        .map((x) => x.id)
    }

    async function analyseOwed(sessionID) {
      const done = []
      const failures = []
      // One command reads each log at most once, whatever the outcome. A failure set aside for
      // this run rather than ending it: stopping at the first failure meant one unreadable
      // reply hid every log behind it. And termination should not depend on every rule
      // elsewhere being right.
      const skip = new Set()

      // The cap counts attempts, not successes: an attempt is what costs a model call, so a
      // backlog of failing logs could otherwise spend without limit under a limit that only
      // ever counted the ones that worked.
      let attempted = 0

      // A mark at three failed attempts with no outcome to say so — a state written by a
      // process that died mid-retirement — is not owed and would be reported by nothing.
      // Retired here, so it reaches the stock section and the message instead.
      for (const id of log.list()) {
        const mark = state.looked(id)
        if (!mark.failed || (mark.attempts ?? 0) < 3) continue
        const detail = "given up after three failed analyses"
        state.markExtracted(id, { ok: false, detail })
        state.look(id, { open: false, failed: false, attempts: 0 })
        failures.push({ session: id, detail })
      }

      while (attempted < config.extractLimit) {
        const [id] = owedLogs(skip)
        if (!id) break
        skip.add(id)
        attempted++
        const result = await runExtraction(id)
        // A skipped log — one exchange, nothing done — never reached the model, so it is not
        // an attempt against a limit whose reason to exist is the model call it costs.
        if (result?.skipped) attempted--
        if (!result?.ok) failures.push({ session: id, detail: result?.detail ?? "unknown failure" })
        else if (!result.skipped) done.push(id)
      }

      pruneLogs()
      // Bookkeeping about a session is dropped once its log is gone. Once per command is often
      // enough, and cheap.
      const present = new Set(log.list())
      state.compact((id) => present.has(id))

      const left = owedLogs().filter((id) => id !== sessionID).length
      return { analysed: done.length, left, failures }
    }

    async function proposeOne(sessionID) {
      // One invocation, one lesson: the top of the list. Deciding is the user's business,
      // in this session, with the agent that is already here.
      const extracted = await analyseOwed(sessionID)

      const lessons = store.list()
      const lesson = pickLesson(lessons, { sessions: state.sessions, halfLife: config.halfLife })
      await diagnose()
      writeSelfCheck()

      if (!lesson) {
        return say(sessionID, renderNothing({ queued: extracted.left, extracted, dir: retroDir }))
      }
      const open = lessons.filter((l) => ["new", "later", undefined, null].includes(l.status)).length
      return say(
        sessionID,
        renderFailures(extracted) +
          renderProposal(lesson, {
          total: open,
          remaining: open - 1,
          currency: currencyOf(lesson),
          sessions: state.sessions,
          halfLife: config.halfLife,
          leadIn: prompts.resolve("propose")?.text,
          queued: extracted.left,
          logs: logDir,
        }),
      )
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
     * `autoExtract`: one owed log per prompt, never the session that was just prompted, and
     * one at a time — a prompt that arrives while an analysis is in flight does not start a
     * second.
     */
    async function drainOne(currentSession) {
      if (draining) return
      const [id] = owedLogs(new Set([currentSession]))
      if (!id) return
      draining = true
      try {
        await runExtraction(id)
      } catch (err) {
        onError("drain", err)
      } finally {
        draining = false
      }
    }

    /**
     * Which model analyses the logs, in order of preference:
     *   1. `options.model`, when the user has pinned one;
     *   2. the model their own sessions run on, learned from `session.model.request`;
     *   3. this workspace's default, from `ctx.model.default()`.
     *
     * Measured: a plugin may not call OpenCode's own free tier, and both 2 and 3 can hand
     * one back. That failure is reported with its remedy rather than swallowed.
     */
    async function resolveModel() {
      if (config.model?.providerID && config.model?.id) return { ...config.model, from: "options.model" }
      if (lastSessionModel) return { ...lastSessionModel, from: "your session's model" }
      try {
        const fallback = (await ctx.model.default())?.data
        if (fallback?.providerID && fallback?.modelID) {
          return { providerID: fallback.providerID, id: fallback.modelID, from: "this workspace's default model" }
        }
      } catch (err) {
        onError("model.default", err)
      }
      return null
    }

    async function runExtraction(sessionID) {
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

      // Which log this is, from the bytes that were actually read. `markOf` asked a moment
      // earlier, and a log can be replaced in between — a pruned file written again under the
      // same id, which starts at its own step 1. The old mark must not filter the new log's
      // first steps away as already analysed; that is the same rule as `markOf`, applied to
      // the bytes in hand instead of a second look at the file.
      const identity = identityOf(text)
      if (raw != null && isReplacedLog(mark, identity, { exists: true })) {
        state.forget(sessionID)
        mark = { n: 0, size: 0 }
      }

      // A log whose numbering ends before the mark does is not the log the mark described,
      // even if it is longer: the file was replaced rather than appended to. Starting over
      // is the only reading that makes the step references resolve.
      if (lastN > 0 && lastN < mark.n) {
        state.forget(sessionID)
        mark = { n: 0, size: 0 }
      }

      /**
       * How much was actually read, not how large the file is now.
       *
       * The session may be working while the model answers, and the earlier version recorded
       * `stat` size on success — so every record appended during the call was marked as sent
       * without ever being sent, and the growth gate then skipped it for good.
       */
      const readSize = raw == null ? log.stat(sessionID).size : raw.length

      // Nothing is written to the mark until the answer is in. Marking the bytes before the
      // call looked tidy — "already sent, do not pay twice" — but a process that died during
      // the call left a log that was neither read nor owed: `size` said sent, no failure had
      // been recorded, and nothing would ever look at it again. The debt that started the read
      // (growth, an unread excerpt, a previous failure) is still in the mark, so leaving it
      // alone is what makes the crash recoverable.

      // A log we could not read is a failure like any other, and it reaches the same retry
      // policy below. It used to be marked extracted here and returned early, which did two
      // wrong things at once: the log was never retried although the brief says a failed
      // extraction keeps its log, and the command —
      // counted it as analysed. `/retro` then reported "analysed 1 session, nothing to learn
      // from it" about a log it had not read.
      /**
       * Only the part that has not been turned into lessons yet.
       *
       * Sessions here are left open and returned to rather than finished, so a log is read
       * more than once — and without a mark, `/retro` a fortnight later re-reads all of it,
       * pays for all of it, and re-derives the lessons that were already integrated. The
       * prompts are kept whatever their step, because they say what the session was for and
       * an excerpt without them is a list of commands with no account of why.
       */
      const fresh = mark.n > 0 && records ? records.filter((r) => r.n > mark.n || r.k === "prompt") : records

      let result = { ok: false, detail: "shadow log could not be read" }
      // A file that exists but yields no record is not an empty session: the log is only
      // created by writing a record to it, so a present file with nothing parseable in it was
      // corrupted, truncated or written by something else. Feeding the extractor an empty
      // record list made it answer "one exchange, nothing done" and settle the log as read —
      // a clean report about material nobody could read.
      if (raw != null && records.length === 0) {
        result = { ok: false, detail: "shadow log could not be parsed: no line is a record" }
      } else if (records) {
        try {
          result = await extract({
            records: fresh,
            analysedUpTo: mark.n,
            concluded: concludedFrom(sessionID),
            session: sessionID,
            generate: analyse,
            model: await resolveModel(),
            prompts,
            store,
            state,
            fingerprint,
            timeoutMs: config.extractTimeoutMs,
            maxInput: config.maxInput,
          })
        } catch (err) {
          onError("extract", err)
          result = { ok: false, detail: `threw: ${String(err?.message ?? err)}` }
        }
      }

      // Nothing is settled for a session that is still working: not marked extracted, so the
      // rest of it is still analysed when it ends, and not pruned, because it is being
      // written to as we read it.
      // The step mark moves only on success: a failed analysis must not skip the material it
      // failed on. The size was already recorded above, so nothing is paid twice.
      // Only as far as the analysis actually went. An excerpt covers up to its first gap, so
      // marking the last step *seen* would jump over the elided middle and nothing would ever
      // read it — the silent kind of loss this plugin exists to avoid.
      const through = Math.min(result.through ?? lastN, lastN)
      // An excerpt covers only its unbroken prefix, and on a re-read that prefix can end
      // before the mark: the prompts are re-sent from step 1, so a tight budget may leave
      // them as the only thing that fits before the first gap. Then no new step was covered
      // at all, and settling it would record the whole file as read while the elided new
      // material was never analysed — the next command would see "nothing new" for ever.
      // That is a failure, and it spends one of the three attempts, rather than a success.
      if (result.ok && lastN > mark.n && through <= mark.n) {
        result = {
          ...result,
          ok: false,
          detail:
            `${result.detail}; the excerpt could not reach past step ${mark.n} of the log within ` +
            "maxInput, so nothing new was analysed — raise maxInput or shorten the prompts",
        }
      }

      // A transient model failure is worth one more go on the next prompt; a third
      // attempt would just keep charging for the same answer.
      // The whole reply goes to plugin.log on a failure: the message carries an excerpt, and
      // the difference between prose and truncated JSON is only visible in the rest of it.
      // Only a failure spends the retry budget. A successful excerpt is progress, and
      // charging it against the budget of three would retire the rest of the log.
      // The step mark moves only on success: a failed analysis must not skip the material it
      // failed on. The bytes were read either way, so nothing is paid for twice. Attempts
      // belong to the input they were spent on: a read of a larger log starts the count again.
      if (!result.ok) {
        const attempts = (readSize > mark.size ? 0 : (mark.attempts ?? 0)) + 1
        onError(`extract.${sessionID}`, result.reply ? `${result.detail}\n--- reply ---\n${result.reply}` : result.detail)
        if (attempts >= 3) {
          // Retired: three failures on the same input. Nothing is owed any more, so neither
          // flag may outlive it; the outcome says why, the self-check names it, and the log
          // stays until it is quiet. Growth makes it owed again, with attempts of its own.
          // The outcome first: a crash between the two writes then leaves a mark still owed
          // (one more attempt) rather than a log nobody owes and nothing reports.
          const detail = `given up after three failed analyses: ${result.detail}`
          state.markExtracted(sessionID, { ok: false, detail })
          state.look(sessionID, { size: readSize, open: false, failed: false, attempts: 0, id: identity })
          result = { ...result, detail }
        } else {
          // `open` is cleared so a failed retry falls back to the attempt budget instead of
          // re-reading the same excerpt on every command for ever.
          state.look(sessionID, { size: readSize, open: false, failed: true, attempts, id: identity })
        }
      }
      // `open` is the other half of the coverage rule. Stopping the mark at the gap is only
      // useful if the next command actually reads from there; the size gate would otherwise
      // call a log whose bytes were all sent "already read" and the gap would never be visited.
      const open = Boolean(result.ok && through < lastN && through > mark.n)
      if (result.ok) {
        state.look(sessionID, {
          size: readSize,
          // A skip covers nothing. "One prompt, one answer, nothing done" means there is
          // nothing to analyse *yet* — not that these steps were turned into lessons. Moving
          // `n` on a skip claimed they were, so when the session later did real work the
          // re-read started after the mark and the earlier reply never reached a model.
          // Found by the model test in five actions. The size still moves: there is nothing
          // to pay for until the log grows, and when it does it is read from the start.
          ...(through > 0 && !result.skipped ? { n: through } : {}),
          open,
          failed: false,
          attempts: 0,
          id: identity,
        })
        state.markExtracted(sessionID, { ok: true, detail: result.detail })
      }

      lastExtraction.set(sessionID, result)
      const verified = lastVerified.get(sessionID)
      if (verified) {
        check.verify({ ...verified, extraction: result })
        writeSelfCheck()
      }
      return result
    }
  },
}

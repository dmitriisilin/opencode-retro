import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { createIngest } from "./src/ingest.js"
import { createPrompts } from "./src/prompts.js"
import { createSelfCheck } from "./src/selfcheck.js"
import { createShadowLog, parseShadowLog } from "./src/shadowlog.js"
import { createState } from "./src/state.js"
import { concludedIn, createStore, score } from "./src/lessons.js"
import { assessCurrency, fingerprintOf } from "./src/currency.js"
import { extract } from "./src/extract.js"
import { pickLesson, pickOpen, renderBatch, renderFailures, renderNothing, renderProposal } from "./src/propose.js"
import { DECIDE_INPUT, decide } from "./src/decide.js"
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
 * Writes a shadow log of every prompt and tool call. When a session ends it is queued for
 * extraction, and the next session's first prompt pays that debt: one clean-context model
 * call turns the log into lessons. `/retro` hands the highest-scoring one to the session
 * you are in and stops there — you and the agent decide what to do with it. A self-check
 * says whether any of it worked.
 *
 * Nothing is analysed until `/retro` asks for it: a model call costs money, and nothing
 * here spends it unprompted. The analysis goes through a session of its own rather than
 * `generate.text`, which refuses OpenCode's free-tier models — see `analyse`.
 *
 * The API facts this relies on are all verified against OpenCode 2.0.32; see AGENTS.md
 * "OpenCode v2 plugin API" and fixtures/payloads/.
 */
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
    const state = createState({ path: config.state, onError })
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

    /** Sessions we have seen an end event for, so a stray late event cannot re-verify. */
    const ended = new Set()
    /**
     * Sessions working right now, so that `/retro` can read their logs without touching
     * them. A session that started and has not ended still has something to add, so its log
     * is not ours to settle or to delete — see `processQueue`.
     */
    const started = new Set()
    /** Evidence from each finished session, kept so a later extraction can complete its report. */
    const lastVerified = new Map()
    let lastBeat = 0
    let draining = false
    /** Learned from session.model.request; see resolveModel. */
    let lastSessionModel = null

    const writeSelfCheck = () => {
      try {
        const lessons = store.list()
        check.stock({
          lessons: lessons.length,
          top: lessons[0]?.id ?? null,
          topScore: lessons.length ? store.score(lessons[0]) : null,
          queued: state.pending.length,
          cited: log.list().filter((id) => citedSessions().has(id)).length,
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
      const now = Date.now()
      const first = !observedSessions.has(sessionID)
      if (!first && !force && now - lastBeat < config.heartbeatMs) return
      observedSessions.add(sessionID)
      lastBeat = now
      check.verify(
        {
          id: sessionID,
          counts: ingest.counts(sessionID),
          log: log.stat(sessionID),
          triggered: null,
          ended: false,
          extraction: null,
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
      ingest.prompt(p)
      touch(p.sessionID)
      observe(rootOf(p.sessionID))
      // Analysis is what `/retro` does, not something a new session triggers: a model call
      // costs money and nothing here spends it unprompted. `autoExtract` restores the old
      // behaviour for anyone who wants lessons ready before they ask.
      if (config.autoExtract) void drainQueue(p.sessionID)
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
      touch(p.sessionID)
      ingest.toolBefore(p)
    })
    await hook("tool", "execute.after", (p) => {
      if (p.tool === "subagent" && p.result?.metadata?.sessionID) {
        adopt(p.result.metadata.sessionID, p.sessionID)
      }
      ingest.toolAfter(p)
      touch(p.sessionID)
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
          execute: async (input, context) => {
            const result = decide(input, { store, state, session: context?.sessionID ?? null })
            pruneLogs(context?.sessionID ?? null)
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
        // prompted again starts another one. Keeping the previous end here made the second
        // turn look finished — never live, so another `/retro` could settle it mid-work, and
        // its own end was dropped as a duplicate, so nothing was ever queued.
        //
        // This runs before the ownership gate on purpose. The start event arrives before the
        // turn's first hook, and the previous end dropped the session from the ingest map, so
        // an owned-only check here would skip exactly the event that says the session is
        // working again. Marking liveness is safe for a session that never turns out to be
        // ours: with no log, nothing reads or prunes it.
        ended.delete(sessionID)
        // A subagent's execution is a step in its parent's task, not a session.
        if (!parents.has(sessionID)) started.add(sessionID)
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
      started.delete(sessionID)
      observedSessions.delete(sessionID)

      const verified = {
        id: sessionID,
        counts: ingest.counts(sessionID),
        log: log.stat(sessionID),
        triggered: event.type,
        extraction: null,
      }
      check.verify(verified)
      writeSelfCheck()
      ingest.forget(sessionID)

      // Not extracted here: a model call from the event stream never returns. Queued, and
      // drained from the next session's prompt hook — or by `/retro`, which settles it.
      state.countSession(sessionID)
      state.queue(sessionID, log.stat(sessionID).size)
      lastVerified.set(sessionID, verified)
      check.verify({ ...verified, extraction: { queued: true } })
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
     * A log lives as long as an open lesson cites it.
     *
     * Lessons carry `evidence` as a session id and a step range, and during review the
     * human may well ask what actually happened at those steps. A summary cannot answer
     * that; the log can. So the reference has to be real. Once every lesson citing a log
     * has been decided and archived, nothing will ask about it again and it goes.
     *
     * Growth is bounded by the number of open lessons, which is capped, rather than by how
     * long the project has existed. `keepSessions` keeps everything.
     */
    /**
     * A session that started and has not ended is still writing its log.
     *
     * A function declaration, not a `const`: everything from here down sits after `setup`
     * has returned, where a `const` is never initialised and every use throws
     * "Cannot access 'isLive' before initialization" — which is how `/retro` once shipped
     * broken for a commit (AGENTS.md Gotcha 13). Declarations hoist; bindings do not.
     */
    function isLive(id, invoking = null) {
      return id === invoking || (started.has(id) && !ended.has(id))
    }

    /**
     * A session is live from its first hook until its execution ends.
     *
     * `started` only knows about sessions whose `session.execution.started` this process
     * saw. A hook firing is the older fact and the more reliable one: after a restart in the
     * middle of a session, the start event has already gone by, and the session would look
     * finished — queued, settled and possibly pruned while it is still writing. A hook that
     * arrives after the end does not resurrect it: the next turn starts with an execution
     * event, which clears the mark deliberately.
     */
    function touch(id) {
      if (!id || ended.has(id) || parents.has(id)) return
      started.add(id)
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
      if (log.stat(id).size < state.looked(id).size) state.rebase(id)
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

    function pruneLogs(invoking = null) {
      if (config.keepSessions) return
      const cited = citedSessions()
      const owed = new Set(state.pending.map((p) => p.session))
      for (const id of log.list()) {
        // Never a session that is working. Its log is the only record of what is happening
        // right now, it is still being appended to, and nothing about it is settled. The
        // session the command is running in counts as working even if a restart meant its
        // start event was never seen: deleting the log under the session that asked is the
        // worst possible answer.
        if (isLive(id, invoking)) continue
        if (!cited.has(id) && !owed.has(id) && log.remove(id)) {
          // The mark described a file that no longer exists. Leaving it would make the next
          // log written under this id look already read, because size only moves forward.
          state.rebase(id)
        }
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
      started.delete(child)
      ended.delete(child)
      observedSessions.delete(child)
      const stray = log.read(child)
      ingest.absorb(child, stray)
      if (stray.length) log.remove(child)
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
      const extracted = await processQueue(sessionID)

      const open = pickOpen(store.list(), { sessions: state.sessions, halfLife: config.halfLife })
      await diagnose()
      writeSelfCheck()
      if (!open.length) return say(sessionID, renderNothing({ queued: extracted.left, extracted }))

      const shown = open.slice(0, config.proposeLimit)
      const currencies = new Map()
      for (const lesson of shown) currencies.set(lesson.id, currencyOf(lesson))

      return say(
        sessionID,
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
     * `/retro` compresses the raw logs, turns them into lessons, and only then looks for
     * something to hand over. Bounded, so a long backlog cannot bill in one command.
     */
    async function processQueue(sessionID) {
      const done = []
      const reread = []
      const failures = []
      // A log that fails is set aside for this run rather than ending it. Stopping at the
      // first failure meant one unreadable reply hid every log behind it, and the message
      // said to run `/retro` again — which would fail on the same log.
      const skip = new Set()
      // The cap counts attempts, not successes: an attempt is what costs a model call, so a
      // queue of failing logs could otherwise spend without limit under a limit that only
      // ever counted the ones that worked.
      let attempted = 0

      // "Everything accumulated to now" has to mean everything. A log whose session is over
      // but whose end never reached us — a server that stops takes its sessions with it, and
      // no event arrives — would otherwise sit on disk for ever, never analysed and never
      // removed. It is not live, so it is finished, so it joins the queue.
      //
      // Being settled is not permanent. A session left open and prompted again produces
      // another execution, and this loop must pick that up too: the question is whether the
      // log has grown since it was last read, not whether it was ever extracted. `extracted`
      // records the outcome of the last settle; the byte mark is what decides the cost.
      for (const id of log.list()) {
        if (isLive(id, sessionID) || state.isPending(id)) continue
        const size = log.stat(id).size
        if (size <= markOf(id).size) continue
        state.queue(id, size)
      }

      while (attempted < config.extractLimit) {
        const owed = nextToSettle(sessionID, skip)
        if (!owed) break
        attempted++
        const result = await runExtraction(owed.session, { invoking: sessionID })
        if (!result?.ok) {
          failures.push({ session: owed.session, detail: result?.detail ?? "unknown failure" })
          skip.add(owed.session)
          continue
        }
        done.push(owed.session)
      }

      /**
       * Then the sessions still working, this one included.
       *
       * They are read and never settled: a session that has not finished will have more to
       * say, so marking its log extracted would throw away everything after this moment, and
       * deleting it would take the only record of what is happening right now. Lessons it
       * produces are recorded normally — `record()` keys evidence by session, so when the
       * session ends and is analysed in full, recurrence does not move for having read it
       * twice.
       *
       * The gate is growth, not a clock: a log no larger than when we last read it has
       * nothing new in it. That also settles the abandoned case — a log nobody will ever
       * append to again is read once and then left alone, at no further cost.
       */
      for (const id of log.list()) {
        if (attempted >= config.extractLimit) break
        if (!isLive(id, sessionID)) continue
        const size = log.stat(id).size
        if (size <= markOf(id).size) continue
        attempted++
        const result = await runExtraction(id, { settle: false })
        if (!result?.ok) failures.push({ session: id, detail: result?.detail ?? "unknown failure" })
        else if (!result.skipped) reread.push(id)
      }

      const left = state.pending.filter((p) => p.session !== sessionID).length
      return { analysed: done.length, live: reread.length, left, failures }
    }

    async function proposeOne(sessionID) {
      // One invocation, one lesson: the top of the list. Deciding is the user's business,
      // in this session, with the agent that is already here.
      const extracted = await processQueue(sessionID)

      const lessons = store.list()
      const lesson = pickLesson(lessons, { sessions: state.sessions, halfLife: config.halfLife })
      await diagnose()
      writeSelfCheck()

      if (!lesson) {
        return say(sessionID, renderNothing({ queued: extracted.left, extracted }))
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
          state,
          log,
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
     * The oldest owed session that is not one somebody is working in.
     *
     * A session queued when one execution ended may have been picked up again before the
     * queue was drained. Settling it now would settle material still being written and
     * could delete a log that is still growing; the live pass reads it instead, and it is
     * settled when the execution it is in now ends. `skip` is the caller's own, so a session
     * set aside for this run is not picked again by the same loop.
     */
    function nextToSettle(exclude, skip) {
      let owed = state.nextPending(exclude, skip)
      while (owed && isLive(owed.session, exclude)) {
        skip.add(owed.session)
        owed = state.nextPending(exclude, skip)
      }
      return owed
    }

    async function drainQueue(currentSession) {
      if (draining) return
      const owed = nextToSettle(currentSession, new Set())
      if (!owed) return
      draining = true
      try {
        await runExtraction(owed.session, { invoking: currentSession })
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

    async function runExtraction(sessionID, { settle = true, invoking = null } = {}) {
      if (settle) state.attempt(sessionID)

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

      // A log whose numbering ends before the mark does is not the log the mark described,
      // even if it is longer: the file was replaced rather than appended to. Starting over
      // is the only reading that makes the step references resolve.
      if (lastN > 0 && lastN < mark.n) {
        state.rebase(sessionID)
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

      // These bytes have been read, or were there to be read: either way a failure must not
      // pay for the same material twice. The step mark below still moves only on success.
      if (readSize > 0) state.look(sessionID, { size: readSize })

      // A log we could not read is a failure like any other, and it reaches the same retry
      // policy below. It used to be marked extracted here and returned early, which did two
      // wrong things at once: the log was never retried although the brief says a failed
      // extraction keeps its log, and `processQueue` — which reads success off the queue —
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
      if (records) {
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

      // A transient model failure is worth one more go on the next prompt; a third
      // attempt would just keep charging for the same answer.
      // The whole reply goes to plugin.log on a failure: the message carries an excerpt, and
      // the difference between prose and truncated JSON is only visible in the rest of it.
      if (!result.ok) {
        onError(`extract.${sessionID}`, result.reply ? `${result.detail}\n--- reply ---\n${result.reply}` : result.detail)
      }

      // Nothing is settled for a session that is still working: not marked extracted, so the
      // rest of it is still analysed when it ends, and not pruned, because it is being
      // written to as we read it.
      // The step mark moves only on success: a failed analysis must not skip the material it
      // failed on. The size was already recorded above, so nothing is paid twice.
      if (result.ok && lastN > 0) state.look(sessionID, { n: lastN })

      if (settle && (result.ok || state.pending.find((p) => p.session === sessionID)?.attempts >= 3)) {
        // `size` is what this settle actually covered, so a queue entry for later material
        // is not mistaken for one this extraction already answered.
        state.markExtracted(sessionID, { ok: result.ok, detail: result.detail, size: readSize })
        if (result.ok) pruneLogs(invoking)
      }

      const verified = lastVerified.get(sessionID)
      if (verified) {
        check.verify({ ...verified, extraction: result })
        writeSelfCheck()
      }
      return result
    }
  },
}

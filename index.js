import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createIngest } from "./src/ingest.js"
import { createPrompts } from "./src/prompts.js"
import { createSelfCheck } from "./src/selfcheck.js"
import { createShadowLog, parseShadowLog } from "./src/shadowlog.js"
import { createState } from "./src/state.js"
import { createStore, score } from "./src/lessons.js"
import { assessCurrency, fingerprintOf } from "./src/currency.js"
import { extract } from "./src/extract.js"
import { DECIDE_INPUT, decide, pickLesson, pickOpen, renderBatch, renderFailures, renderNothing, renderProposal } from "./src/review.js"
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
 * opencode-retro — M3: capture, extract, review.
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

    const beat = () => {
      const now = Date.now()
      if (now - lastBeat < config.heartbeatMs) return
      lastBeat = now
      check.beat(now)
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
      beat()
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

    await hook("tool", "execute.before", (p) => ingest.toolBefore(p))
    await hook("tool", "execute.after", (p) => {
      if (p.tool === "subagent" && p.result?.metadata?.sessionID) {
        adopt(p.result.metadata.sessionID, p.sessionID)
      }
      ingest.toolAfter(p)
      beat()
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
          description: "Review what the last sessions should have taught this project",
          execute: command("retro", ({ sessionID, prompt }) => {
            const text = String(prompt?.text ?? "").trim().toLowerCase()
            return text.startsWith("all") ? runAll(sessionID) : runReview(sessionID)
          }),
        })
        cmds.add({
          name: "retro-all",
          description: "Review everything waiting at once, as one plan",
          execute: command("retro-all", ({ sessionID }) => runAll(sessionID)),
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
          execute: async (input) => {
            const result = decide(input, { store, state })
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
      if (event.type === "session.created" && event.data?.sessionID) {
        const directory = event.data?.location?.directory
        if (directory && ctx.location?.directory && directory !== ctx.location.directory) {
          foreign.add(event.data.sessionID)
        }
        if (event.data?.parentID) adopt(event.data.sessionID, event.data.parentID)
      }
      if (foreign.has(event?.data?.sessionID)) return
      ingest.event(event)

      // session.idle never fires outside the TUI (AGENTS.md Gotcha 2), so the end of work
      // is session.execution.*.
      const done =
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted"
      if (!done) return

      const sessionID = event?.data?.sessionID
      if (!sessionID || ended.has(sessionID)) return
      // A subagent finishing is a step in its parent's task, not a session to analyse.
      if (parents.has(sessionID)) return
      ended.add(sessionID)

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
      // drained from the next session's prompt hook.
      state.countSession()
      state.queue(sessionID)
      lastVerified.set(sessionID, verified)
      check.verify({ ...verified, extraction: { queued: true } })
      writeSelfCheck()
    }

    // Decide what git sees from inside our own directory, so the user never has to edit
    // theirs. Seeded once; after that the file is theirs.
    seedGitignore({ dir: config.dir, onError })

    // Seed the editable prompts, then look for a newer default. Neither touches a file
    // the user owns (AGENTS.md decisions 13 and 15).
    for (const name of ["extract", "review", "review-auto"]) {
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
    function pruneLogs() {
      if (config.keepSessions) return
      const cited = citedSessions()
      const owed = new Set(state.pending.map((p) => p.session))
      for (const id of log.list()) {
        if (!cited.has(id) && !owed.has(id)) log.remove(id)
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
      const stray = log.read(child)
      if (!stray.length) return
      ingest.absorb(child, stray)
      log.remove(child)
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

    async function runAll(sessionID) {
      const extracted = await processQueue(sessionID)

      const open = pickOpen(store.list(), { sessions: state.sessions, halfLife: config.halfLife })
      await diagnose()
      writeSelfCheck()
      if (!open.length) return say(sessionID, renderNothing({ queued: extracted.left, extracted }))

      const shown = open.slice(0, config.autoLimit)
      const currencies = new Map()
      for (const lesson of shown) currencies.set(lesson.id, currencyOf(lesson))

      return say(
        sessionID,
        renderBatch(open, {
          sessions: state.sessions,
          halfLife: config.halfLife,
          currencies,
          limit: config.autoLimit,
          leadIn: prompts.resolve("review-auto")?.text,
          queued: extracted.left,
        }),
      )
    }

    /**
     * Both review modes analyse what has accumulated before they propose anything: one
     * `/retro` compresses the raw logs, turns them into lessons, and only then looks for
     * something to hand over. Bounded, so a long backlog cannot bill in one command.
     */
    async function processQueue(sessionID) {
      const done = []
      const failures = []
      // A log that fails is set aside for this run rather than ending it. Stopping at the
      // first failure meant one unreadable reply hid every log behind it, and the message
      // said to run `/retro` again — which would fail on the same log.
      const skip = new Set()
      // The cap counts attempts, not successes: an attempt is what costs a model call, so a
      // queue of failing logs could otherwise spend without limit under a limit that only
      // ever counted the ones that worked.
      let attempted = 0
      while (attempted < config.extractLimit) {
        const owed = state.nextPending(sessionID, skip)
        if (!owed) break
        attempted++
        const result = await runExtraction(owed.session)
        if (!result?.ok) {
          failures.push({ session: owed.session, detail: result?.detail ?? "unknown failure" })
          skip.add(owed.session)
          continue
        }
        done.push(owed.session)
      }
      const left = state.pending.filter((p) => p.session !== sessionID).length
      return { analysed: done.length, left, failures }
    }

    async function runReview(sessionID) {
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
          leadIn: prompts.resolve("review")?.text,
          queued: extracted.left,
        }),
      )
    }

    /**
     * The checks a session cannot make for itself, folded into every review instead of
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

    async function drainQueue(currentSession) {
      if (draining) return
      const owed = state.nextPending(currentSession)
      if (!owed) return
      draining = true
      try {
        await runExtraction(owed.session)
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
      if (state.wasExtracted(sessionID)) return { ok: true, already: true }
      state.attempt(sessionID)

      let records = null
      try {
        records = parseShadowLog(readFileSync(log.path(sessionID), "utf8"))
      } catch (err) {
        onError("extract.read", err)
      }

      // A log we could not read is a failure like any other, and it reaches the same retry
      // policy below. It used to be marked extracted here and returned early, which did two
      // wrong things at once: the log was never retried although the brief says a failed
      // extraction keeps its log, and `processQueue` — which reads success off the queue —
      // counted it as analysed. `/retro` then reported "analysed 1 session, nothing to learn
      // from it" about a log it had not read.
      let result = { ok: false, detail: "shadow log could not be read" }
      if (records) {
        try {
          result = await extract({
            records,
            session: sessionID,
            generate: analyse,
            model: await resolveModel(),
            prompts,
            store,
            state,
            fingerprint,
            timeoutMs: config.extractTimeoutMs,
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

      if (result.ok || state.pending.find((p) => p.session === sessionID)?.attempts >= 3) {
        state.markExtracted(sessionID, { ok: result.ok, detail: result.detail })
        if (result.ok) pruneLogs()
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

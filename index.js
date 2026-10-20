import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

const REPO = "github.com/dmitriisilin/opencode-retro"
const VERSION = "0.0.3"

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

    const ingest = createIngest({
      maxOutput: config.maxOutput,
      emit: (sessionID, record) => log.write(sessionID, record),
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
            if (text.startsWith("check")) return runCheck(sessionID)
            if (text.startsWith("auto") || text.startsWith("all")) return runAuto(sessionID)
            return runReview(sessionID)
          }),
        })
        cmds.add({
          name: "retro-auto",
          description: "Plan every waiting lesson at once, for approval in one go",
          execute: command("retro-auto", ({ sessionID }) => runAuto(sessionID)),
        })
        cmds.add({
          name: "retro-check",
          description: "Check that opencode-retro is actually working",
          execute: command("retro-check", ({ sessionID }) => runCheck(sessionID)),
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

    function handleEvent(event) {
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
     * A hint for the agent's own check, not a verdict.
     * A declaration, not a `const`: everything in here sits after setup's `return`, and
     * only declarations are hoisted. A `const` here is undefined when a command calls it.
     */
    function currencyOf(lesson) {
      return assessCurrency(lesson, { directory: config.directory, fingerprint })
    }

    async function runAuto(sessionID) {
      const extracted = await processQueue(sessionID)

      const open = pickOpen(store.list(), { sessions: state.sessions, halfLife: config.halfLife })
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
      while (done.length < config.extractLimit) {
        const owed = state.nextPending(sessionID)
        if (!owed) break
        const result = await runExtraction(owed.session)
        if (state.pending.some((p) => p.session === owed.session)) {
          // Still queued means the analysis failed. Say why: it used to vanish, leaving
          // only an incremented attempt count in state.json for anyone who went looking.
          failures.push({ session: owed.session, detail: result?.detail ?? "unknown failure" })
          break
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
        }),
      )
    }

    async function runCheck(sessionID) {
      const report = await activeCheck({
        ctx,
        config,
        prompts,
        store,
        state,
        log,
        generate: analyse,
        model: await resolveModel(),
      })
      for (const note of report.notes) check.note(note)
      check.active(report.checks)
      writeSelfCheck()
      return say(sessionID, report.text)
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

      let records
      try {
        records = parseShadowLog(readFileSync(log.path(sessionID), "utf8"))
      } catch (err) {
        onError("extract.read", err)
        const detail = "shadow log could not be read"
        state.markExtracted(sessionID, { ok: false, detail })
        return { ok: false, detail }
      }

      let result
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

      // A transient model failure is worth one more go on the next prompt; a third
      // attempt would just keep charging for the same answer.
      if (result.ok || state.pending.find((p) => p.session === sessionID)?.attempts >= 3) {
        state.markExtracted(sessionID, { ok: result.ok, detail: result.detail })
        // The lesson carries the story; the raw log has nothing left to give. Keeping it
        // would mean a project accumulating ~28 KB a session forever.
        if (result.ok && !config.keepSessions) {
          try {
            rmSync(log.path(sessionID))
          } catch (err) {
            if (err?.code !== "ENOENT") onError("sessions.prune", err)
          }
        }
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

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createIngest } from "./src/ingest.js"
import { createPrompts } from "./src/prompts.js"
import { createSelfCheck } from "./src/selfcheck.js"
import { createShadowLog, parseShadowLog } from "./src/shadowlog.js"
import { createState } from "./src/state.js"
import { createStore, score } from "./src/lessons.js"
import { assessCurrency, fingerprintOf } from "./src/currency.js"
import { extract } from "./src/extract.js"
import { DECIDE_INPUT, decide, pickLesson, pickOpen, renderBatch, renderNothing, renderProposal } from "./src/review.js"
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
 * The queue is not a scheduling preference. `ctx.generate.text` hangs when called from the
 * event stream or from setup, and returns only from inside a hook callback — measured, see
 * AGENTS.md "Gotchas". So extraction has to run where a hook is running.
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
      // A hook callback is the one context where ctx.generate.text returns; from the event
      // stream it hangs forever (AGENTS.md "Gotchas"). So the extraction owed by the last
      // session is paid here, at the start of the next one, without blocking this prompt.
      void drainQueue(p.sessionID)
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
            "Record the human's decision on a retro lesson. Call this once they have decided, " +
            "after any change has been made. It only records — it never edits the harness itself.",
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
     * A hint for the agent's own check, not a verdict.
     * A declaration, not a `const`: everything in here sits after setup's `return`, and
     * only declarations are hoisted. A `const` here is undefined when a command calls it.
     */
    function currencyOf(lesson) {
      return assessCurrency(lesson, { directory: config.directory, fingerprint })
    }

    async function runAuto(sessionID) {
      await settleDebt(sessionID)

      const open = pickOpen(store.list(), { sessions: state.sessions, halfLife: config.halfLife })
      writeSelfCheck()
      if (!open.length) return say(sessionID, renderNothing({ queued: state.pending.length }))

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

    /** Both review modes pay the extraction debt first, so you review what just happened. */
    async function settleDebt(sessionID) {
      const owed = state.nextPending(sessionID)
      if (!owed) return null
      await runExtraction(owed.session)
      return state.pending.some((p) => p.session === owed.session) ? null : "done"
    }

    async function runReview(sessionID) {
      // One invocation, one lesson: the top of the list. Deciding is the user's business,
      // in this session, with the agent that is already here.
      const extracted = await settleDebt(sessionID)

      const lessons = store.list()
      const lesson = pickLesson(lessons, { sessions: state.sessions, halfLife: config.halfLife })
      writeSelfCheck()

      if (!lesson) {
        return say(sessionID, renderNothing({ queued: state.pending.length, extracted }))
      }
      const open = lessons.filter((l) => ["new", "later", undefined, null].includes(l.status)).length
      return say(
        sessionID,
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
        generate: (input) => ctx.generate.text(input),
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

    async function runExtraction(sessionID) {
      if (state.wasExtracted(sessionID)) return
      state.attempt(sessionID)

      let records
      try {
        records = parseShadowLog(readFileSync(log.path(sessionID), "utf8"))
      } catch (err) {
        onError("extract.read", err)
        state.markExtracted(sessionID, { ok: false, detail: "shadow log could not be read" })
        return
      }

      let result
      try {
        result = await extract({
          records,
          session: sessionID,
          generate: (input) => ctx.generate.text(input),
          model: config.model,
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
    }
  },
}

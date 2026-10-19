import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { createIngest } from "./src/ingest.js"
import { createSelfCheck } from "./src/selfcheck.js"
import { createShadowLog } from "./src/shadowlog.js"
import { resolveConfig } from "./src/config.js"

const REPO = "github.com/dmitriisilin/opencode-retro"
const VERSION = "0.0.2"

/**
 * opencode-retro — M1: capture only.
 *
 * Writes a shadow log of every prompt and tool call, and a self-check that says whether
 * it is actually doing so. No model is called at this milestone.
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
    const check = createSelfCheck({
      versions: { opencode: ctx?.app?.version ?? null, plugin: VERSION },
      repo: REPO,
    })

    /** Sessions we have seen an end event for, so a stray late event cannot re-verify. */
    const ended = new Set()
    let lastBeat = 0

    const writeSelfCheck = () => {
      try {
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
    })
    await hook("tool", "execute.before", (p) => ingest.toolBefore(p))
    await hook("tool", "execute.after", (p) => {
      ingest.toolAfter(p)
      beat()
    })

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

      check.verify({
        id: sessionID,
        counts: ingest.counts(sessionID),
        log: log.stat(sessionID),
        triggered: event.type,
        extraction: null, // M2
      })
      writeSelfCheck()
      ingest.forget(sessionID)
    }

    writeSelfCheck()
    return () => controller.abort()
  },
}

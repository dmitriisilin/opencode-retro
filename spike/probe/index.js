// M0 spike: dump real OpenCode v2 plugin payloads to disk.
// Not part of the shipped plugin — throwaway instrumentation.

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const MAX_STRING = 2000

function safe(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === "undefined") return value
  const t = typeof value
  if (t === "string") return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + `…[+${value.length - MAX_STRING}]` : value
  if (t === "number" || t === "boolean") return value
  if (t === "bigint") return `[bigint ${value}]`
  if (t === "function") return `[function ${value.name || "anonymous"}]`
  if (t === "symbol") return `[symbol ${String(value)}]`
  if (depth > 6) return "[depth]"
  if (seen.has(value)) return "[circular]"
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => safe(v, depth + 1, seen))
  const out = {}
  for (const key of Object.keys(value)) {
    try {
      out[key] = safe(value[key], depth + 1, seen)
    } catch (err) {
      out[key] = `[throw ${err?.message}]`
    }
  }
  return out
}

function shape(value, depth = 0) {
  if (value === null) return "null"
  const t = typeof value
  if (t !== "object") return t
  if (Array.isArray(value)) return depth > 3 ? "array" : [shape(value[0], depth + 1)]
  if (depth > 3) return "object"
  const out = {}
  for (const key of Object.keys(value)) out[key] = shape(value[key], depth + 1)
  return out
}

export default {
  id: "opencode-retro-probe",
  async setup(ctx) {
    const dir =
      process.env.RETRO_PROBE_DIR ?? join(ctx?.location?.directory ?? process.cwd(), ".opencode", "retro-probe")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "payloads.jsonl")

    const write = (kind, payload, extra) => {
      try {
        appendFileSync(
          file,
          JSON.stringify({ at: new Date().toISOString(), kind, ...extra, payload: safe(payload), shape: shape(safe(payload)) }) + "\n",
        )
      } catch (err) {
        try {
          appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, error: String(err) }) + "\n")
        } catch {}
      }
    }

    write("setup", {
      ctxKeys: Object.keys(ctx ?? {}).sort(),
      location: ctx?.location,
      app: ctx?.app,
      options: ctx?.options,
      domainKeys: Object.fromEntries(
        Object.entries(ctx ?? {})
          .filter(([, v]) => v && typeof v === "object")
          .map(([k, v]) => [k, Object.keys(v).sort()]),
      ),
      runtime: { node: process.version, execPath: process.execPath, bun: typeof globalThis.Bun !== "undefined" },
    })

    const hook = async (domain, name) => {
      try {
        await ctx[domain].hook(name, (input) => {
          write(`${domain}.${name}`, input)
        })
        write("hook.registered", { domain, name })
      } catch (err) {
        write("hook.failed", { domain, name, error: String(err?.message ?? err) })
      }
    }

    for (const name of ["execute.before", "execute.after"]) await hook("tool", name)
    for (const name of ["prompt", "context", "compaction", "generate", "title", "model.request", "retry"])
      await hook("session", name)

    try {
      await ctx.command.transform((cmds) => {
        cmds.add({
          name: "retro-probe",
          description: "M0 spike: write a marker into the probe log",
          execute: async (invocation) => {
            write("command.execute", invocation)
            // Open question 2: can a plugin call a model with a clean context?
            try {
              const result = await ctx.generate.text({
                prompt: "Reply with exactly one word: extracted",
                model: {
                  providerID: process.env.RETRO_PROBE_PROVIDER ?? "deepseek",
                  id: process.env.RETRO_PROBE_MODEL ?? "deepseek-flash",
                },
              })
              write("generate.text.ok", result)
            } catch (err) {
              write("generate.text.failed", { error: String(err?.message ?? err), name: err?.name })
            }
            try {
              const hidden = await ctx.session.create({
                title: "retro-probe hidden session",
                location: ctx.location,
              })
              write("session.create.ok", hidden)
            } catch (err) {
              write("session.create.failed", { error: String(err?.message ?? err) })
            }
          },
        })
      })
      write("command.registered", { name: "retro-probe" })
    } catch (err) {
      write("command.failed", { error: String(err?.message ?? err) })
    }

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          write("event", event, { eventType: event?.type })
        }
      } catch (err) {
        if (!controller.signal.aborted) write("event.stream.failed", { error: String(err?.message ?? err) })
      }
    })()

    return () => {
      write("cleanup", {})
      controller.abort()
    }
  },
}

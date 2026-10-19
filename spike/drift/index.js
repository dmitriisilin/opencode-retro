// Can a plugin detect that the OpenCode API moved under it?
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export default {
  id: "opencode-retro-drift",
  async setup(ctx) {
    const dir = process.env.RETRO_PROBE_DIR ?? join(ctx.location.directory, ".retro-drift")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "drift.jsonl")
    const write = (o) => appendFileSync(file, JSON.stringify(o) + "\n")
    write({ probe: "setup.entered" })

    // 1. does an unknown hook name throw, or register silently?
    for (const [domain, name] of [
      ["tool", "execute.after"],
      ["tool", "execute.nonsense"],
      ["tool", "before"],
      ["session", "prompt"],
      ["session", "promptz"],
      ["session", "idle"],
    ]) {
      try {
        const reg = await ctx[domain].hook(name, () => {})
        write({ probe: "hook", domain, name, result: "registered", hasDispose: typeof reg?.dispose })
      } catch (err) {
        write({ probe: "hook", domain, name, result: "threw", error: String(err?.message ?? err) })
      }
    }

    // 2. does a missing ctx domain / method surface as undefined?
    for (const path of ["tool.hook", "tool.nosuch", "session.hook", "nosuchdomain", "generate.text", "storage.set"]) {
      const [a, b] = path.split(".")
      const v = b ? ctx?.[a]?.[b] : ctx?.[a]
      write({ probe: "surface", path, type: typeof v })
    }

    // 3. does a bad model fail loudly?
    try {
      const r = await ctx.generate.text({ prompt: "hi", model: { providerID: "nope", id: "nope" } })
      write({ probe: "generate", model: "bogus", result: "resolved", value: r })
    } catch (err) {
      write({ probe: "generate", model: "bogus", result: "threw", error: String(err?.message ?? err).slice(0, 300) })
    }

    // 4. does subscribing to an unknown event type fail?
    try {
      const ac = new AbortController()
      const it = ctx.event.subscribe({ signal: ac.signal })
      write({ probe: "event.subscribe", result: "ok", type: typeof it?.[Symbol.asyncIterator] })
      ac.abort()
    } catch (err) {
      write({ probe: "event.subscribe", result: "threw", error: String(err?.message ?? err) })
    }
  },
}

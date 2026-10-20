// Can a plugin reach OpenCode's free tier at all, and if not via generate.text, via a session?
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export default {
  id: "opencode-retro-drift",
  async setup(ctx) {
    const dir = process.env.RETRO_PROBE_DIR ?? join(ctx.location.directory, ".retro-drift")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "drift.jsonl")
    const write = (o) => appendFileSync(file, JSON.stringify(o) + "\n")

    await ctx.command.transform((cmds) => {
      cmds.add({
        name: "freetier",
        description: "probe the free tier from a command context",
        execute: async () => {
          const d = (await ctx.model.default())?.data
          const model = { providerID: d?.providerID, id: d?.modelID }
          write({ probe: "default model", model })

          // 1. generate.text with the free-tier model named explicitly, from a command.
          try {
            const r = await ctx.generate.text({ prompt: "Reply with one word: ok", model })
            write({ probe: "generate.text + free model", result: "returned", value: r })
          } catch (err) {
            write({ probe: "generate.text + free model", result: "threw", error: String(err?.message ?? err).slice(0, 160) })
          }

          // 2. a session of our own, on the workspace default, then session.generate.
          try {
            const s = await ctx.session.create({ title: "retro probe", location: ctx.location })
            write({ probe: "session.create", id: s?.id, model: s?.model ?? null })
            const r = await ctx.session.generate({ sessionID: s.id, prompt: "Reply with one word: ok" })
            write({ probe: "session.generate", result: "returned", value: r })
          } catch (err) {
            write({ probe: "session.generate", result: "threw", error: String(err?.message ?? err).slice(0, 160) })
          }
        },
      })
    })
  },
}

// Do anchors earn their place? Same log, same prompt, one difference: the Anchors section.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { parseShadowLog } from "../../src/shadowlog.js"
import { detectAnchors } from "../../src/anchors.js"
import { project } from "../../src/projection.js"
import { OUTPUT_CONTRACT, parseLessons } from "../../src/contract.js"
import { createPrompts } from "../../src/prompts.js"

const FIXTURE = new URL("../../fixtures/sessions/lint-trap-live.jsonl", import.meta.url).pathname
const OUT = process.env.AB_OUT ?? "/tmp/ab"
const MODEL = { providerID: "deepseek", id: "deepseek-flash" }

export default {
  id: "opencode-retro-anchors-ab",
  async setup(ctx) {
    await ctx.command.transform((cmds) => {
      cmds.add({
        name: "ab",
        description: "A/B the anchors section",
        execute: async () => {
          mkdirSync(OUT, { recursive: true })
          const records = parseShadowLog(readFileSync(FIXTURE, "utf8"))
          const anchors = detectAnchors(records)
          const prompts = createPrompts({ dir: join(OUT, "prompts"), updates: join(OUT, "u") })
          prompts.seed("extract")
          const instructions = prompts.resolve("extract").text
          const log = project(records)

          const build = (withAnchors) =>
            [
              instructions,
              `## Session\n\nid: ses_fixture`,
              `## Log\n\n${log}`,
              withAnchors
                ? `## Anchors\n\n${anchors.map((a) => `- **${a.kind}** steps ${a.from}–${a.to}: ${a.reason}`).join("\n")}`
                : null,
              OUTPUT_CONTRACT,
            ]
              .filter(Boolean)
              .join("\n\n")

          for (const [label, withAnchors] of [["with", true], ["without", false]]) {
            const prompt = build(withAnchors)
            writeFileSync(join(OUT, `prompt-${label}.txt`), prompt)
            try {
              const { text } = await ctx.generate.text({ prompt, model: MODEL })
              const parsed = parseLessons(text)
              writeFileSync(
                join(OUT, `reply-${label}.json`),
                JSON.stringify({ ok: parsed.ok, lessons: parsed.lessons, raw: text }, null, 2),
              )
            } catch (err) {
              writeFileSync(join(OUT, `reply-${label}.json`), JSON.stringify({ error: String(err?.message ?? err) }))
            }
          }
          writeFileSync(join(OUT, "anchors.json"), JSON.stringify(anchors, null, 2))
        },
      })
    })
  },
}

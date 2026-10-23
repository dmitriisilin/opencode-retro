import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.js"
import { fakeOpenCode } from "./fake-opencode.js"

/**
 * Work orders and records (docs/concepts/analysis.md). The plugin makes no model call:
 * `/retro` writes a work order per owed log and asks the agent in its session to have each
 * read by a subagent, which answers through `retro_record`. Here the test plays that agent
 * itself (`agent: false`), so every step of the exchange is visible.
 */

const LESSON = { id: "lint-skill-no-config", statement: "The lint skill assumes eslint.", steps: [2, 3], cost: 2, confidence: 0.8, why: "eslint exited 2" }

const sandbox = () => mkdtempSync(join(tmpdir(), "retro-orders-"))
const logOf = (dir, s) => join(dir, ".retro", "sessions", `${s}.jsonl`)
const state = (dir) => JSON.parse(readFileSync(join(dir, ".retro", "state.json"), "utf8"))

async function work(fake, session) {
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do a thing" } })
  for (const id of ["c1", "c2"]) {
    await fake.hooks.get("tool.execute.before")({ sessionID: session, id, tool: "shell", input: { command: "npx eslint ." } })
    await fake.hooks.get("tool.execute.after")({
      sessionID: session, id, tool: "shell", input: { command: "npx eslint ." }, status: "completed",
      result: { output: { exit: 2, output: "no config" }, metadata: { exit: 2 } },
    })
  }
}

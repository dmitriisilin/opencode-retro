import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { parseLessons } from "../src/contract.js"

/**
 * A fake OpenCode, shared by the tests that drive the real plugin entry point.
 *
 * One stand, not two: `plugin.test.js` and `model.test.js` exercise the same plugin through
 * the same surface, and two copies of a fake drift exactly the way two copies of a prompt
 * did.
 *
 * The plugin makes no model call (docs/concepts/analysis.md): `/retro` hands work orders to
 * the agent in its session, which starts a subagent per order. With `agent` on (the default)
 * this fake plays that agent when a work-order hand-over arrives: each order is read, `reply`
 * is asked what the subagent found — a string or a function of `{ prompt }`, as a model's
 * answer would be — and a parseable answer is recorded through `retro_record`. An answer that
 * does not parse is a subagent that never recorded anything. Then `retro_propose` is called
 * and what it returns is what the human sees, in `synthetic`. With `agent: false` the test
 * plays the agent itself; work-order hand-overs are in `orders` either way.
 */
export function fakeOpenCode({ options = {}, directory, reply, defaultReply = "", agent = true } = {}) {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()
  const synthetic = []
  const orders = []
  const generated = []

  // A push-driven event stream, so the end-of-session trigger can actually be fired.
  // Before this the iterator never yielded and handleEvent was only ever tested by writing
  // state.json by hand — which is exactly the part of the plugin that is not under test.
  const queue = []
  let wake = null
  const emit = (event) => {
    if (wake) {
      const resolve = wake
      wake = null
      resolve({ value: event, done: false })
    } else queue.push(event)
  }

  /** The paths of the work orders a hand-over lists. */
  const ordersIn = (text) => [...String(text).matchAll(/^- `([^`]+\/work\/[^`]+\.md)`$/gm)].map((m) => m[1])

  /** What the agent in the session does with a work-order hand-over. */
  async function playAgent(input) {
    for (const path of ordersIn(input.text)) {
      const prompt = readFileSync(isAbsolute(path) ? path : join(directory, path), "utf8")
      const session = (prompt.match(/^id: (\S+)$/m) ?? [])[1]
      generated.push({ prompt, session })
      // `reply` may be a function, so a test can answer one log badly and another well.
      const answer = typeof reply === "function" ? await reply({ prompt }) : (reply ?? defaultReply)
      const parsed = parseLessons(answer)
      if (!parsed.ok) continue
      await tools.get("retro_record").execute({ session, lessons: parsed.lessons }, { sessionID: `${input.sessionID}_sub` })
    }
    const all = /`retro_propose` with `all: true`/.test(input.text)
    const result = await tools.get("retro_propose").execute({ all }, { sessionID: input.sessionID })
    synthetic.push({ sessionID: input.sessionID, text: result.content, via: "retro_propose" })
  }

  const ctx = {
    app: { version: "2.0.32" },
    location: { directory, project: { id: "proj" } },
    options,
    tool: {
      hook: async (name, fn) => (hooks.set(`tool.${name}`, fn), { dispose: async () => {} }),
      transform: async (fn) => fn({ add: (t) => tools.set(t.name, t) }),
    },
    session: {
      hook: async (name, fn) => (hooks.set(`session.${name}`, fn), { dispose: async () => {} }),
      synthetic: async (input) => {
        if (ordersIn(input.text).length) {
          orders.push(input)
          if (agent) await playAgent(input)
          return
        }
        synthetic.push(input)
      },
    },
    command: { transform: async (fn) => fn({ add: (c) => commands.set(c.name, c) }) },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            queue.length
              ? Promise.resolve({ value: queue.shift(), done: false })
              : new Promise((resolve) => {
                  wake = resolve
                }),
          return: () => Promise.resolve({ value: undefined, done: true }),
        }),
      }),
    },
    // The plugin makes no model call of its own. Anything here that it did call would be a
    // regression, and fails loudly rather than answering.
    generate: {
      text: async () => {
        throw new Error("the plugin must not call a model itself")
      },
    },
  }
  return { ctx, commands, tools, hooks, synthetic, orders, generated, emit }
}

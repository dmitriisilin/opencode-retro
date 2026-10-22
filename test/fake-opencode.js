/**
 * A fake OpenCode, shared by the tests that drive the real plugin entry point.
 *
 * One stand, not two: `plugin.test.js` and `model.test.js` exercise the same plugin through
 * the same surface, and two copies of a fake drift exactly the way two copies of a prompt
 * did. `reply` may be a string or a function, and the function may return a promise — which
 * is how a model that hangs mid-answer is simulated.
 */
export function fakeOpenCode({ options = {}, directory, reply, defaultReply = "" } = {}) {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()
  const synthetic = []
  const generated = []
  const live = new Set()
  const sessions = []
  let created = 0

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

  const ctx = {
    app: { version: "2.0.32" },
    location: { directory, project: { id: "proj" } },
    options,
    tool: {
      hook: async (name, fn) => (hooks.set(`tool.${name}`, fn), { dispose: async () => {} }),
      transform: async (fn) => fn({ add: (t) => tools.set(t.name, t) }),
    },
    // Analysis runs through a session of our own, because generate.text refuses OpenCode's
    // free-tier models. The fake tracks the lifecycle so a leaked session shows up here.
    session: {
      hook: async (name, fn) => (hooks.set(`session.${name}`, fn), { dispose: async () => {} }),
      synthetic: async (input) => synthetic.push(input),
      create: async (input) => {
        const session = { id: `ses_analysis_${++created}`, ...input }
        sessions.push(input)
        live.add(session.id)
        return session
      },
      generate: async (input) => {
        generated.push(input)
        // `reply` may be a function, so a test can answer one log badly and another well.
        return { text: typeof reply === "function" ? await reply(input) : (reply ?? defaultReply) }
      },
      remove: async ({ sessionID }) => void live.delete(sessionID),
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
    model: { default: async () => ({ data: { providerID: "fake", modelID: "fake-model" } }) },
    generate: {
      text: async () => {
        throw new Error("generate.text must not be used: it refuses OpenCode's free tier")
      },
    },
  }
  return { ctx, commands, tools, hooks, synthetic, generated, live, sessions, emit }
}

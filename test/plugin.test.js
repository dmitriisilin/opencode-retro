import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.js"

/**
 * Drives the real plugin against a fake OpenCode.
 *
 * This exists because of a bug the unit tests could not see: a helper written as a `const`
 * after setup's `return` is never initialised, so `/retro` died with "currencyOf is not
 * defined" — registered, listed, and broken. Nothing short of running the command catches
 * that.
 */
function fakeOpenCode({ options = {}, directory, reply } = {}) {
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
        return { text: typeof reply === "function" ? reply(input) : (reply ?? REPLY) }
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

const sandbox = () => {
  const directory = mkdtempSync(join(tmpdir(), "retro-plugin-"))
  writeFileSync(join(directory, "AGENTS.md"), "always run the lint skill\n")
  return directory
}

/** A session that did some work, so its shadow log has something to extract. */
async function workSession(fake, session) {
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do a thing" } })
  for (const id of ["c1", "c2", "c3"]) {
    await fake.hooks.get("tool.execute.before")({
      sessionID: session,
      id,
      tool: "shell",
      input: { command: "npx eslint ." },
    })
    await fake.hooks.get("tool.execute.after")({
      sessionID: session,
      id,
      tool: "shell",
      input: { command: "npx eslint ." },
      status: "completed",
      result: { output: { exit: 2, output: "no config" }, metadata: { exit: 2 } },
    })
  }
}

/** state.json only exists once something changed it, so a missing file is a clean state. */
const savedState = (directory) => {
  try {
    return JSON.parse(readFileSync(join(directory, ".retro", "state.json"), "utf8"))
  } catch {
    return { sessions: 0, pending: [], rejected: [], extracted: {} }
  }
}

/** The sessions whose logs a command was asked to analyse, in order. */
const analysed = (fake) => fake.generated.map((g) => (g.prompt.match(/id: (ses_\w+)/) ?? [])[1])

const queue = (directory, sessions) =>
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({
      version: 1,
      rejected: [],
      extracted: {},
      sessions: sessions.length,
      pending: sessions.map((session) => ({ session, queuedAt: "now", attempts: 0 })),
    }),
  )

const MODEL = { providerID: "deepseek", id: "deepseek-flash" }

/** The event loop is a promise chain, not a callback, so give it a turn to run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

const REPLY = JSON.stringify({
  lessons: [
    {
      id: "lint-skill-no-config",
      statement: "The lint skill prescribes eslint, which this project cannot run.",
      steps: [9, 18],
      cost: 9,
      confidence: 0.9,
      proposal: { target: "AGENTS.md", change: "Make it conditional." },
      why: "step 9 then 18",
    },
  ],
})

test("setup registers the commands and the decision tool, and seeds the prompts", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  // Two commands, and that is the whole surface: one lesson, or all of them.
  assert.deepEqual([...fake.commands.keys()].sort(), ["retro", "retro-all"])
  assert.deepEqual([...fake.tools.keys()], ["retro_decide"])
  assert.ok(fake.hooks.has("session.prompt"))
  assert.ok(fake.hooks.has("tool.execute.before"))
  assert.ok(fake.hooks.has("tool.execute.after"))

  for (const name of ["extract", "review", "review-auto"]) {
    assert.ok(existsSync(join(directory, ".retro", "prompts", `${name}.md`)), `${name}.md was not seeded`)
  }
  assert.ok(existsSync(join(directory, ".retro", "selfcheck.md")))
  await cleanup?.()
})

test("/retro runs, and says there is nothing when the store is empty", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.commands.get("retro").execute({ sessionID: "ses_x", prompt: { text: "" } })

  assert.equal(fake.synthetic.length, 1, "the command must put something in the session")
  assert.match(fake.synthetic[0].text, /Nothing to review/)
  assert.doesNotMatch(fake.synthetic[0].text, /failed/, "and must not fail doing it")
  assert.ok(!existsSync(join(directory, ".retro", "plugin.log")), "a clean run logs no errors")
  await cleanup?.()
})

test("a prompt, a tool call and a session end produce a lesson, then /retro hands it over", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  const session = "ses_work"
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "add a thing" } })
  for (const id of ["c1", "c2", "c3"]) {
    await fake.hooks.get("tool.execute.before")({ sessionID: session, id, tool: "shell", input: { command: "npx eslint ." } })
    await fake.hooks.get("tool.execute.after")({
      sessionID: session,
      id,
      tool: "shell",
      input: { command: "npx eslint ." },
      status: "completed",
      result: { output: { exit: 2, output: "no config" }, metadata: { exit: 2 } },
    })
  }

  // /retro settles the extraction debt itself, so queue the session and ask for it.
  const state = join(directory, ".retro", "state.json")
  writeFileSync(
    state,
    JSON.stringify({ version: 1, rejected: [], extracted: {}, sessions: 1, pending: [{ session, queuedAt: "now", attempts: 0 }] }),
  )

  const fresh = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fresh.generated.length, 1, "extraction ran")
  assert.match(fresh.generated[0].prompt, /shorter and straighter/, "through the seeded prompt")

  // The model is chosen when the analysis session is created, not per call: session.generate
  // takes no model. And the session must not be left behind in the user's list.
  assert.equal(fresh.sessions.length, 1)
  assert.deepEqual(fresh.sessions[0].model, MODEL)
  assert.equal(fresh.live.size, 0, "the analysis session was removed afterwards")

  const [delivered] = fresh.synthetic
  assert.match(delivered.text, /# retro — `lint-skill-no-config`/)
  assert.match(delivered.text, /how to hand this over/, "the lead-in comes from the prompt file")
  assert.equal(delivered.resume, true, "or the user never sees it")

  await cleanup?.()
  await cleanup2?.()
})

test("with no model configured, the workspace default is used", async () => {
  // This is the bug a live run caught and every other test missed: the resolution chain
  // existed but was not wired into extraction, and both the unit tests (which pass a model
  // explicitly) and this file (which configured one) were blind to it.
  const directory = sandbox()
  const session = "ses_nomodel"
  const fake = fakeOpenCode({ directory, options: {} })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do a thing" } })
  for (const id of ["c1", "c2", "c3"]) {
    await fake.hooks.get("tool.execute.before")({ sessionID: session, id, tool: "shell", input: { command: "x" } })
    await fake.hooks.get("tool.execute.after")({
      sessionID: session,
      id,
      tool: "shell",
      input: { command: "x" },
      status: "completed",
      result: { output: { exit: 1, output: "no" }, metadata: { exit: 1 } },
    })
  }
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({ version: 1, rejected: [], extracted: {}, sessions: 1, pending: [{ session, queuedAt: "now", attempts: 0 }] }),
  )

  const fresh = fakeOpenCode({ directory, options: {} })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fresh.generated.length, 1, "the analysis ran without options.model")
  assert.deepEqual(fresh.sessions[0].model, { providerID: "fake", id: "fake-model" }, "from ctx.model.default()")
  assert.doesNotMatch(fresh.synthetic[0].text, /could not analyse/, "and did not report a failure")

  await cleanup?.()
  await cleanup2?.()
})

test("an edited review prompt is what reaches the agent", async () => {
  const directory = sandbox()
  const first = fakeOpenCode({ directory, options: { model: MODEL } })
  const seeded = await plugin.setup(first.ctx)
  await seeded?.()

  writeFileSync(join(directory, ".retro", "prompts", "review.md"), "---\nprompt: review\nbase: 1\n---\n\nMY OWN WORDING.\n")
  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "lessons", "l.md"),
    "---\nid: l\nstatement: something\ncost: 5\nrecurrence: 1\nconfidence: 1\nstatus: new\n---\n\nbody\n",
  )

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_x", prompt: { text: "" } })

  assert.match(fake.synthetic[0].text, /MY OWN WORDING\./)
  await cleanup?.()
})

test("a command that throws reports itself instead of vanishing into a 500", async () => {
  // Gotcha 14: a throwing command body surfaces as an HTTP 500 and nowhere else. This
  // drives the wrapper itself, which the unit tests over exports can never reach. A
  // hand-edited lesson with a non-string `change` is enough to make the renderer throw.
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "lessons", "broken.md"),
    "---\nid: broken\nstatement: something\ncost: 5\nrecurrence: 1\nconfidence: 1\nstatus: new\nproposal:\n  target: AGENTS.md\n  change: 42\n---\n\nbody\n",
  )

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_x", prompt: { text: "" } })

  const log = readFileSync(join(directory, ".retro", "plugin.log"), "utf8")
  assert.match(log, /command\.retro:/, "the failure reaches the log, where it can be read later")
  assert.equal(fake.synthetic.length, 1, "and the session is told, rather than shown a 500")
  assert.match(fake.synthetic[0].text, /`\/retro` failed/)
  assert.match(fake.synthetic[0].text, /plugin\.log/, "with where to look next")
  await cleanup?.()
})

test("deciding on a lesson that does not exist fails clearly through the registered tool", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  const result = await fake.tools.get("retro_decide").execute({ id: "nope", status: "accepted" })
  assert.equal(result.output.ok, false)
  assert.match(result.content, /no lesson/)
  await cleanup?.()
})

test("a log survives while a lesson cites it, and goes once that lesson is decided", async () => {
  const directory = sandbox()
  const session = "ses_cited"
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do it" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "c1", tool: "shell", input: { command: "x" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session,
    id: "c1",
    tool: "shell",
    input: { command: "x" },
    status: "completed",
    result: { output: { exit: 1, output: "no" }, metadata: { exit: 1 } },
  })
  const logPath = join(directory, ".retro", "sessions", `${session}.jsonl`)
  assert.ok(existsSync(logPath), "the log is written as the session runs")

  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({ version: 1, rejected: [], extracted: {}, sessions: 1, pending: [{ session, queuedAt: "now", attempts: 0 }] }),
  )

  const fresh = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  // The lesson's evidence points at this log, and review may ask what happened at those
  // steps, so the reference has to still resolve.
  assert.ok(existsSync(logPath), "the log outlives extraction while a lesson cites it")
  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /1 log kept in `sessions\/` because open lessons cite it/, "the report says why it is still there")

  await fresh.tools.get("retro_decide").execute({ id: "lint-skill-no-config", status: "accepted" })
  assert.ok(!existsSync(logPath), "and goes once nothing open refers to it")
  assert.doesNotMatch(
    readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8"),
    /because open lessons cite/,
    "and the report is recomputed rather than left stale",
  )

  await cleanup?.()
  await cleanup2?.()
})

test("autoExtract analyses at the start of the next session, and is off by default", async () => {
  const directory = sandbox()
  const session = "ses_auto"

  const work = async (fake) => {
    await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do it" } })
    await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "c1", tool: "shell", input: { command: "x" } })
    await fake.hooks.get("tool.execute.after")({
      sessionID: session,
      id: "c1",
      tool: "shell",
      input: { command: "x" },
      status: "completed",
      result: { output: { exit: 1, output: "no" }, metadata: { exit: 1 } },
    })
    writeFileSync(
      join(directory, ".retro", "state.json"),
      JSON.stringify({ version: 1, rejected: [], extracted: {}, sessions: 1, pending: [{ session, queuedAt: "now", attempts: 0 }] }),
    )
  }

  const off = fakeOpenCode({ directory, options: { model: MODEL } })
  const stop = await plugin.setup(off.ctx)
  await work(off)
  const quiet = fakeOpenCode({ directory, options: { model: MODEL } })
  const stop2 = await plugin.setup(quiet.ctx)
  await quiet.hooks.get("session.prompt")({ sessionID: "ses_later", messageID: "m2", prompt: { text: "next" } })
  assert.equal(quiet.generated.length, 0, "by default a new session analyses nothing")

  const on = fakeOpenCode({ directory, options: { model: MODEL, autoExtract: true } })
  const stop3 = await plugin.setup(on.ctx)
  await on.hooks.get("session.prompt")({ sessionID: "ses_later2", messageID: "m3", prompt: { text: "next" } })
  await new Promise((r) => setTimeout(r, 50)) // the drain is deliberately not awaited
  assert.equal(on.generated.length, 1, "with autoExtract the queue is analysed unprompted")

  await stop?.()
  await stop2?.()
  await stop3?.()
})

test("/retro all delivers every waiting lesson as one plan", async () => {
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  for (const [id, cost] of [["a", 20], ["b", 5]]) {
    writeFileSync(
      join(directory, ".retro", "lessons", `${id}.md`),
      `---\nid: ${id}\nstatement: problem ${id}\ncost: ${cost}\nrecurrence: 1\nconfidence: 1\nstatus: new\n---\n\nbody\n`,
    )
  }

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro-all").execute({ sessionID: "ses_x", prompt: { text: "" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /2 lessons waiting/)
  assert.match(delivered.text, /## 1\. `a`/, "highest score first")
  assert.match(delivered.text, /## 2\. `b`/)
  assert.match(delivered.text, /one plan/)
  await cleanup?.()
})

test("a log the model could not answer does not hold up the logs behind it", async () => {
  // This is what a live run hit: one log came back as prose, and the queue stopped there.
  // The other logs were never read, and the message said to run `/retro` again — which
  // would have failed on the same log again.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await workSession(fake, "ses_bad")
  await workSession(fake, "ses_good")
  queue(directory, ["ses_bad", "ses_good"])

  const fresh = fakeOpenCode({
    directory,
    options: { model: MODEL },
    reply: (input) => (input.prompt.includes("id: ses_bad") ? "I could not do this one." : REPLY),
  })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.deepEqual(analysed(fresh), ["ses_bad", "ses_good"], "the log behind the failure was read too")
  assert.equal(analysed(fresh).filter((s) => s === "ses_bad").length, 1, "and the failed one is not retried in the same command")

  const [delivered] = fresh.synthetic
  assert.match(delivered.text, /could not analyse `ses_bad`/)
  assert.match(delivered.text, /the model answered/, "the message says what the model said")
  assert.match(delivered.text, /lint-skill-no-config/, "and the lesson from the log that worked is still delivered")

  await cleanup?.()
  await cleanup2?.()
})

test("a reply that could not be read is kept, because the analysis session is transient", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await workSession(fake, "ses_bad")
  queue(directory, ["ses_bad"])

  const fresh = fakeOpenCode({
    directory,
    options: { model: MODEL },
    reply: "Sure! Here are the two problems I found:\n\n1. the lint skill",
  })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const pluginLog = readFileSync(join(directory, ".retro", "plugin.log"), "utf8")
  assert.match(pluginLog, /extract\.ses_bad/, "the failure names the log")
  assert.match(pluginLog, /the lint skill/, "and the model's own words are in it")

  await cleanup?.()
  await cleanup2?.()
})

test("a log that failed stays queued, and is tried again on the next command", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await workSession(fake, "ses_bad")
  queue(directory, ["ses_bad"])

  const broken = fakeOpenCode({ directory, options: { model: MODEL }, reply: "not json at all" })
  const cleanup2 = await plugin.setup(broken.ctx)
  await broken.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  await cleanup2?.()

  const state = JSON.parse(readFileSync(join(directory, ".retro", "state.json"), "utf8"))
  assert.equal(state.pending.length, 1, "still owed")
  assert.equal(state.pending[0].attempts, 1, "and counted")

  const again = fakeOpenCode({ directory, options: { model: MODEL }, reply: "not json at all" })
  const cleanup3 = await plugin.setup(again.ctx)
  await again.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  await cleanup3?.()

  const after = JSON.parse(readFileSync(join(directory, ".retro", "state.json"), "utf8"))
  assert.equal(after.pending[0].attempts, 2, "one more go, then it is given up on")

  await cleanup?.()
})

test("a session still working is read, and nothing about it is settled", async () => {
  // `/retro` looks at everything accumulated to the moment it is run, which includes the
  // sessions that have not finished -- their friction is the most recent there is. But an
  // unfinished session will have more to say, so marking its log extracted would discard
  // everything after this moment and deleting it would take the only record of what is
  // happening right now.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_working"

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.deepEqual(analysed(fake), [session], "it was read")
  const state = savedState(directory)
  assert.equal(state.extracted[session], undefined, "and not settled: the session is not over")
  assert.deepEqual(state.pending, [], "nor queued as though it were finished")
  assert.ok(state.looked[session] > 0, "how much of it was read is remembered")
  assert.equal(
    existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)),
    true,
    "and the log is still there, because it is still being written to",
  )

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /# retro — `lint-skill-no-config`/, "the lesson is handed over as any other")

  await cleanup?.()
})

test("a working session is not read again until its log has grown", async () => {
  // The gate is size, not a clock. Re-reading the same bytes costs the same money for the
  // same answer, and it also settles the abandoned case: a log nobody will append to again
  // is read once and then left alone.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL }, reply: "nothing to learn here" })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_growing"

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "read once")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "nothing new in it, so nothing paid for")

  // The session says something more.
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m9", prompt: { text: "try again" } })
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "it grew, so it is read again")

  assert.equal(
    existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)),
    true,
    "and no lesson cites it, yet it is never pruned while the session is working",
  )

  await cleanup?.()
})

test("a log left behind by a server that stopped is finished, and is treated as such", async () => {
  // A server that stops takes its sessions with it, so no end event ever arrives and the log
  // is neither queued nor live. It used to sit on disk for ever: never analysed, never
  // removed. It is not live, so it is over.
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "sessions", "ses_orphan.jsonl"),
    [
      JSON.stringify({ v: 1, n: 1, t: 1, k: "prompt", text: "fix the lint skill" }),
      JSON.stringify({ v: 1, n: 2, t: 2, k: "tool", id: "c1", tool: "shell", input: { command: "npx eslint ." }, status: "completed", exit: 2 }),
    ].join("\n") + "\n",
  )

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.deepEqual(analysed(fake), ["ses_orphan"], "picked up without being asked twice")
  const state = savedState(directory)
  assert.equal(state.extracted.ses_orphan?.ok, true, "and settled, so it is not paid for again")

  await cleanup?.()
})

test("a session from another checkout of this project is not ours", async () => {
  // A git worktree is the same project in a different directory, and the event stream
  // reaches every session in the project. Measured: both instances wrote a log under the
  // same session id with different contents -- ours had no prompt in it, because the hooks
  // fire only for the location the session belongs to. Ours then reported `BROKEN prompt
  // hook, most likely renamed upstream` about a healthy session, queued its partial log for
  // analysis, and counted it towards freshness.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_in_a_worktree"

  fake.emit({
    type: "session.created",
    durable: { seq: 0 },
    data: { sessionID: session, location: { directory: `${directory}-worktree` }, projectID: "proj" },
  })
  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  fake.emit({
    type: "session.text.ended",
    durable: { seq: 4 },
    data: { sessionID: session, assistantMessageID: "m1", text: "done" },
  })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 7 }, data: { sessionID: session } })
  await tick()

  assert.equal(existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)), false, "no log of our own")
  const state = savedState(directory)
  assert.deepEqual(state.pending, [], "nothing to analyse: the log is the other checkout's")
  assert.equal(state.sessions, 0, "and it is not counted, so freshness is not moved twice")

  await cleanup?.()
})

test("a log that cannot be read is reported as a failure, not as a clean analysis", async () => {
  // It used to be marked extracted the moment the read threw, which took it out of
  // `pending` — and `pending` was how processQueue decided whether a log had worked. So
  // `/retro` said it had analysed a session and found nothing to learn, about a log it had
  // never opened, and the log was closed for good instead of retried.
  const directory = sandbox()
  mkdirSync(join(directory, ".retro"), { recursive: true })
  queue(directory, ["ses_vanished"])

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /Could not analyse `ses_vanished`/)
  assert.match(delivered.text, /shadow log could not be read/, "with the reason, not a shrug")
  assert.doesNotMatch(delivered.text, /nothing to learn/, "it learned nothing because it read nothing")
  assert.equal(fake.generated.length, 0, "and spent nothing on a log that was not there")

  const state = savedState(directory)
  assert.equal(state.pending.length, 1, "kept queued — a failed extraction keeps its log")
  assert.equal(state.pending[0].attempts, 1, "and the attempt is counted towards the cap")
  assert.equal(state.extracted.ses_vanished, undefined, "nothing claims it is done")

  await cleanup?.()
})

test("`/retro all` is reachable as an argument to the one command", async () => {
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "lessons", "a.md"),
    "---\nid: a\nstatement: problem a\ncost: 5\nrecurrence: 1\nconfidence: 1\nstatus: new\n---\n\nbody\n",
  )

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_x", prompt: { text: "all" } })

  assert.match(fake.synthetic[0].text, /lesson waiting/, "typing `/retro all` reviews everything")
  await cleanup?.()
})

test("a review costs nothing beyond the analysis itself", async () => {
  // The free checks run every time; asking the model whether it answers is a call nobody
  // requested, and the analysis answers that question on its own.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.commands.get("retro").execute({ sessionID: "ses_x", prompt: { text: "" } })
  assert.equal(fake.generated.length, 0, "nothing queued, nothing to analyse, nothing spent")

  const text = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(text, /ctx surface/, "and the free diagnostic still ran")
  await cleanup?.()
})

test("a subagent's work lands in the parent's log, and is not analysed on its own", async () => {
  // Measured in a live run: a subagent gets its own session, its own execution events and
  // its own tool calls. Analysing it separately would mean a second model call and a second
  // count against the same problem, from a fragment with no instruction behind it.
  const directory = sandbox()
  const parent = "ses_parent"
  const child = "ses_child"
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: parent, messageID: "m1", prompt: { text: "find the exports" } })

  // The parent delegates; the child announces itself with a parentID.
  await fake.hooks.get("tool.execute.before")({ sessionID: parent, id: "d1", tool: "subagent", input: { agent: "explore" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: parent,
    id: "d1",
    tool: "subagent",
    input: { agent: "explore" },
    status: "completed",
    result: { output: { output: "done" }, metadata: { sessionID: child, status: "completed" } },
  })

  // The child does the work and finishes.
  await fake.hooks.get("tool.execute.before")({ sessionID: child, id: "c1", tool: "read", input: { path: "src/sum.js" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: child,
    id: "c1",
    tool: "read",
    agent: "explore",
    input: { path: "src/sum.js" },
    status: "completed",
    result: { output: { output: "export function sum" } },
  })

  assert.ok(!existsSync(join(directory, ".retro", "sessions", `${child}.jsonl`)), "the child has no log of its own")

  const records = readFileSync(join(directory, ".retro", "sessions", `${parent}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
  const read = records.find((r) => r.tool === "read")
  assert.ok(read, "the delegated tool call is in the parent's log")
  assert.equal(read.agent, "explore", "and says which agent did it")
  assert.ok(records.find((r) => r.tool === "subagent"), "alongside the delegation itself")

  const ns = records.map((r) => r.n)
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b), "one step sequence, not two interleaved")
  await cleanup?.()
})

test("the subagent's own instruction is not lost to the race that reveals its parent", async () => {
  // session.prompt for the child arrives before session.created tells us it has a parent,
  // so the instruction lands in a log of the child's own. A live run left it there.
  const directory = sandbox()
  const parent = "ses_parent"
  const child = "ses_child"
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: parent, messageID: "m1", prompt: { text: "find the exports" } })
  await fake.hooks.get("session.prompt")({
    sessionID: child,
    messageID: "m2",
    prompt: { text: "You are a subagent spawned by another session.\nLook at src/sum.js." },
  })
  assert.ok(existsSync(join(directory, ".retro", "sessions", `${child}.jsonl`)), "it starts out in the wrong place")

  // Then the parent link arrives, by either route.
  await fake.hooks.get("tool.execute.after")({
    sessionID: parent,
    id: "d1",
    tool: "subagent",
    input: { agent: "explore", description: "look", prompt: "Look at src/sum.js." },
    status: "completed",
    result: { output: { output: "done" }, metadata: { sessionID: child } },
  })

  assert.ok(!existsSync(join(directory, ".retro", "sessions", `${child}.jsonl`)), "the orphan log is gone")
  const records = readFileSync(join(directory, ".retro", "sessions", `${parent}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))

  const prompts = records.filter((r) => r.k === "prompt")
  assert.equal(prompts.length, 2, "both instructions are in the parent's log")
  assert.match(prompts[1].text, /subagent spawned/)
  const ns = records.map((r) => r.n)
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b), "renumbered into one sequence")
  await cleanup?.()
})

test("keepSessions keeps a log that nothing cites, because losing it is not recoverable", async () => {
  const directory = sandbox()
  const session = "ses_kept"
  const fake = fakeOpenCode({ directory, options: { model: MODEL, keepSessions: true } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do it" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "c1", tool: "shell", input: { command: "x" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session,
    id: "c1",
    tool: "shell",
    input: { command: "x" },
    status: "completed",
    result: { output: { exit: 1, output: "no" }, metadata: { exit: 1 } },
  })
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({ version: 1, rejected: [], extracted: {}, sessions: 1, pending: [{ session, queuedAt: "now", attempts: 0 }] }),
  )

  const fresh = fakeOpenCode({ directory, options: { model: MODEL, keepSessions: true } })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  await fresh.tools.get("retro_decide").execute({ id: "lint-skill-no-config", status: "accepted" })

  assert.ok(
    existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)),
    "decided and uncited, and still kept because the option says so",
  )
  await cleanup?.()
  await cleanup2?.()
})

test("autoLimit caps one plan and says what it left out", async () => {
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  for (const [id, cost] of [["a", 30], ["b", 20], ["c", 10]]) {
    writeFileSync(
      join(directory, ".retro", "lessons", `${id}.md`),
      `---\nid: ${id}\nstatement: problem ${id}\ncost: ${cost}\nrecurrence: 1\nconfidence: 1\nstatus: new\n---\n\nbody\n`,
    )
  }

  const fake = fakeOpenCode({ directory, options: { model: MODEL, autoLimit: 2 } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_x", prompt: { text: "all" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /## 1\. `a`/)
  assert.match(delivered.text, /## 2\. `b`/)
  assert.doesNotMatch(delivered.text, /## 3\./, "the cap holds")
  assert.match(delivered.text, /1 more below the cut/, "and the remainder is named")
  await cleanup?.()
})

test("extractLimit caps what one command analyses and leaves the rest queued", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL, extractLimit: 1 } })
  const cleanup = await plugin.setup(fake.ctx)

  await workSession(fake, "ses_one")
  await workSession(fake, "ses_two")
  queue(directory, ["ses_one", "ses_two"])

  const fresh = fakeOpenCode({ directory, options: { model: MODEL, extractLimit: 1 } })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fresh.generated.length, 1, "one log, one call")
  const state = JSON.parse(readFileSync(join(directory, ".retro", "state.json"), "utf8"))
  assert.equal(state.pending.length, 1, "the other is still owed")
  assert.match(fresh.synthetic[0].text, /1 log not analysed yet/, "said even when a proposal was found")

  await cleanup?.()
  await cleanup2?.()
})

test("a finished session is queued by the event stream, and the report proves the hooks ran", async () => {
  // The end-of-session trigger is the plugin's whole capture pipeline: verify the hooks,
  // count the session, queue the log. Until now every test wrote state.json by hand, so
  // handleEvent — the one function that turns traffic into work — was never executed.
  const directory = sandbox()
  const session = "ses_ended"
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do it" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "c1", tool: "shell", input: { command: "x" } })
  fake.emit({
    type: "session.tool.called",
    durable: { seq: 4 },
    data: { sessionID: session, id: "c1", input: { command: "x" } },
  })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session,
    id: "c1",
    tool: "shell",
    input: { command: "x" },
    status: "completed",
    result: { output: { exit: 1, output: "no" }, metadata: { exit: 1 } },
  })

  fake.emit({ type: "session.execution.succeeded", durable: { seq: 7 }, data: { sessionID: session } })
  await tick()

  const state = savedState(directory)
  assert.deepEqual(state.pending.map((p) => p.session), [session], "the finished session is owed an analysis")
  assert.equal(state.sessions, 1, "and the session counter moved, which freshness is measured against")

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /verified\s+\d{4}-\d{2}-\d{2}/, "the end-of-session trigger is proven, not assumed")
  assert.match(report, /ok\s+prompt hook\s+1 prompt seen/)
  assert.match(report, /ok\s+tool hook\s+1 tool-call events \/ 1 hook calls/)
  assert.match(report, /ok\s+shadow log\s+sessions\/ses_ended\.jsonl, \d+ entries/)
  assert.match(report, /ok\s+trigger\s+session\.execution\.succeeded/)
  assert.match(report, /queued; `\/retro` analyses it/)

  // A duplicate end event must not count the same session twice.
  fake.emit({ type: "session.execution.succeeded", data: { sessionID: session } })
  await tick()
  const again = savedState(directory)
  assert.equal(again.sessions, 1)
  assert.equal(again.pending.length, 1)
  await cleanup?.()
})

test("events the hooks never received are reported as a dead hook, with numbers", async () => {
  // Decision 19's measured failure: a renamed hook registers happily and never fires. The
  // event stream and the hook are two independent paths to the same fact, and only the
  // comparison can name which one broke.
  const directory = sandbox()
  const session = "ses_drift"
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do it" } })
  for (const id of ["c1", "c2"]) {
    fake.emit({
      type: "session.tool.called",
      durable: { seq: 3 },
      data: { sessionID: session, id, input: { command: "x" } },
    })
  }
  // Only one of the two calls ever reached the hook.
  await fake.hooks.get("tool.execute.after")({
    sessionID: session,
    id: "c1",
    tool: "shell",
    input: { command: "x" },
    status: "completed",
    result: { output: { exit: 1, output: "no" }, metadata: { exit: 1 } },
  })

  fake.emit({ type: "session.execution.succeeded", data: { sessionID: session } })
  await tick()

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /BROKEN\s+tool hook\s+2 tool-call events \/ 1 hook calls/)
  assert.match(report, /the tool hook is dead/)
  assert.match(report, /needs an update/)
  await cleanup?.()
})

test("a subagent's own instruction is absorbed when session.created reveals the parent", async () => {
  // The other route to the same fact. The instruction lands under the child's id first, and
  // the child's end event must not be counted as a session of its own.
  const directory = sandbox()
  const parent = "ses_parent"
  const child = "ses_child"
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({
    sessionID: child,
    messageID: "m1",
    prompt: { text: "You are a subagent spawned by another session.\nLook at src/sum.js." },
  })
  assert.ok(existsSync(join(directory, ".retro", "sessions", `${child}.jsonl`)), "it starts out in the wrong place")

  fake.emit({
    type: "session.created",
    durable: { seq: 0 },
    data: { sessionID: child, parentID: parent, agent: "explore", title: "look" },
  })
  await tick()

  assert.ok(!existsSync(join(directory, ".retro", "sessions", `${child}.jsonl`)), "the orphan log is gone")
  const records = readFileSync(join(directory, ".retro", "sessions", `${parent}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.match(records.find((r) => r.k === "prompt").text, /subagent spawned/)

  fake.emit({ type: "session.execution.succeeded", data: { sessionID: child } })
  await tick()

  const state = savedState(directory)
  assert.equal(state.sessions, 0, "a delegation is a step, not a session")
  assert.deepEqual(state.pending, [], "and it is never queued for its own analysis")
  await cleanup?.()
})

test("the model the user is actually working with is the one used for analysis", async () => {
  // The middle rung of resolveModel. It existed and was untested: the suite covered a
  // pinned `options.model` and the workspace default, and nothing in between.
  const directory = sandbox()
  const session = "ses_work"
  mkdirSync(join(directory, ".retro"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({ version: 1, rejected: [], extracted: {}, sessions: 1, pending: [{ session, queuedAt: "now", attempts: 0 }] }),
  )

  const fake = fakeOpenCode({ directory, options: {} })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.hooks.get("session.model.request")({
    kind: "primary",
    sessionID: "ses_current",
    model: { providerID: "anthropic", id: "claude-sonnet" },
  })
  await workSession(fake, session)
  // The queue above is already loaded; this only writes the log the command will read.
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 1)
  assert.deepEqual(fake.sessions[0].model, { providerID: "anthropic", id: "claude-sonnet" })
  await cleanup?.()
})

test("a workspace default that cannot be read refuses with the remedy, not a hang", async () => {
  const directory = sandbox()
  const session = "ses_nomodel"
  mkdirSync(join(directory, ".retro"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({ version: 1, rejected: [], extracted: {}, sessions: 1, pending: [{ session, queuedAt: "now", attempts: 0 }] }),
  )

  const fake = fakeOpenCode({ directory, options: {} })
  fake.ctx.model.default = async () => {
    throw new Error("no default model in this workspace")
  }
  const cleanup = await plugin.setup(fake.ctx)
  await workSession(fake, session)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 0, "no model, no call")
  assert.equal(fake.sessions.length, 0, "and no analysis session was left behind")
  assert.match(fake.synthetic[0].text, /could not analyse `ses_nomodel`/i)
  assert.match(fake.synthetic[0].text, /options\.model/, "the message names the way out")
  await cleanup?.()
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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
function fakeOpenCode({ options = {}, directory } = {}) {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()
  const synthetic = []
  const generated = []
  const live = new Set()
  const sessions = []
  let created = 0

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
        return { text: REPLY }
      },
      remove: async ({ sessionID }) => void live.delete(sessionID),
    },
    command: { transform: async (fn) => fn({ add: (c) => commands.set(c.name, c) }) },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) },
    model: { default: async () => ({ data: { providerID: "fake", modelID: "fake-model" } }) },
    generate: {
      text: async () => {
        throw new Error("generate.text must not be used: it refuses OpenCode's free tier")
      },
    },
  }
  return { ctx, commands, tools, hooks, synthetic, generated, live, sessions }
}

const sandbox = () => {
  const directory = mkdtempSync(join(tmpdir(), "retro-plugin-"))
  writeFileSync(join(directory, "AGENTS.md"), "always run the lint skill\n")
  return directory
}

const MODEL = { providerID: "deepseek", id: "deepseek-flash" }

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

  assert.deepEqual([...fake.commands.keys()].sort(), ["retro", "retro-auto", "retro-check"])
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
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  // retro_decide on a lesson that is not there is the cheapest reachable failure.
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

  await fresh.tools.get("retro_decide").execute({ id: "lint-skill-no-config", status: "accepted" })
  assert.ok(!existsSync(logPath), "and goes once nothing open refers to it")

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

test("/retro auto delivers every waiting lesson as one plan", async () => {
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
  await fake.commands.get("retro-auto").execute({ sessionID: "ses_x", prompt: { text: "" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /2 lessons waiting/)
  assert.match(delivered.text, /## 1\. `a`/, "highest score first")
  assert.match(delivered.text, /## 2\. `b`/)
  assert.match(delivered.text, /one plan/)
  await cleanup?.()
})

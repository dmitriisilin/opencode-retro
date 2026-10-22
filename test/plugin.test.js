import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import plugin from "../index.js"
import { parseShadowLog } from "../src/shadowlog.js"
import { parseFrontmatter } from "../src/frontmatter.js"

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

  for (const name of ["extract", "propose"]) {
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

test("an edited propose prompt is what reaches the agent", async () => {
  const directory = sandbox()
  const first = fakeOpenCode({ directory, options: { model: MODEL } })
  const seeded = await plugin.setup(first.ctx)
  await seeded?.()

  writeFileSync(join(directory, ".retro", "prompts", "propose.md"), "---\nprompt: propose\nbase: 1\n---\n\nMY OWN WORDING.\n")
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

  const tool = fake.tools.get("retro_decide")
  // OpenCode warns a live agent with "Tool result declared output without an output schema"
  // when a tool returns `output` and declares no shape for it. The agent then doubted the
  // decision had registered, which is the one thing this tool must never cause.
  assert.ok(tool.output, "the tool declares the shape of what it returns")

  const result = await tool.execute({ id: "nope", status: "accepted" })
  assert.equal(result.output.ok, false)
  assert.match(result.content, /no lesson/)
  assert.equal(typeof result.output.detail, "string")
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

test("one invocation delivers exactly one lesson, the top of the open set", async () => {
  // One invocation, one lesson. The picker is unit-tested for order; what was never checked
  // is that the command actually hands over one message with one lesson in it when several
  // are waiting — the deliverable a user gets, not the function that chose it.
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
  await fake.commands.get("retro").execute({ sessionID: "ses_x", prompt: { text: "" } })

  assert.equal(fake.synthetic.length, 1, "one message")
  const [delivered] = fake.synthetic
  assert.match(delivered.text, /# retro — `a`/, "and it carries the top of the open set")
  assert.doesNotMatch(delivered.text, /# retro — `b`/, "not the one underneath it")
  assert.match(delivered.text, /1 more lesson waiting/, "which is named as still waiting")

  await cleanup?.()
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

test("the report is written from the first prompt, not once the session is over", async () => {
  // It used to say "Nothing measured yet" until a session ended, which made it stale for
  // exactly as long as somebody was working — the one time they would open it. Nothing in
  // the checks needs the session to be over: a hook fired, and the log has something
  // non-empty in it.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_underway"

  const fresh = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(fresh, /Nothing measured yet/, "before any traffic there is nothing to assert")

  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "go" } })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /ok\s+prompt hook\s+1 prompt seen/, "the hook fired, and that is the fact")
  assert.match(report, /ok\s+shadow log\s+sessions\/ses_underway\.jsonl, \d+ entries/)
  assert.match(report, /not exercised\s+trigger\s+the session has not ended yet/, "not BROKEN: it is still working")
  assert.match(
    report,
    /not exercised\s+tool hook\s+no tool calls seen yet/,
    "and not 'none in this session', which the counts cannot support while it runs",
  )
  assert.doesNotMatch(report, /no end-of-session event arrived/)
  assert.match(report, /was still working at \d{4}-\d{2}-\d{2}/, "and the file says which session it measured")
  assert.match(report, /verified\s+\d{4}-\d{2}-\d{2}[^(]*\(when the checks below were last evaluated\)/)

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
  assert.ok(state.looked[session].size > 0, "how much of it was read is remembered")
  assert.ok(state.looked[session].n > 0, "and how far the lessons got, so the next read starts there")
  assert.equal(
    existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)),
    true,
    "and the log is still there, because it is still being written to",
  )

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /# retro — `lint-skill-no-config`/, "the lesson is handed over as any other")

  await cleanup?.()
})

test("a second look at a session reads only what is new since the first", async () => {
  // This is how these sessions are actually used: left open and returned to, never finished.
  // So a log is read more than once, and without a mark `/retro` a fortnight later re-reads
  // all of it, pays for all of it, and re-derives the lessons that were already integrated.
  const directory = sandbox()
  // A parseable reply, because the mark only moves on success: a failed analysis must not
  // skip the material it failed on.
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_returned_to"

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "the original instruction" } })
  for (const id of ["early-1", "early-2"]) {
    await fake.hooks.get("tool.execute.before")({ sessionID: session, id, tool: "shell", input: { command: `old ${id}` } })
    await fake.hooks.get("tool.execute.after")({
      sessionID: session, id, tool: "shell", input: { command: `old ${id}` },
      status: "completed", result: { output: { exit: 0, output: "ok" }, metadata: { exit: 0 } },
    })
  }

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  const first = fake.generated.at(-1).prompt
  assert.match(first, /old early-1/, "the whole session, the first time")
  assert.doesNotMatch(first, /Steps up to/, "and no claim that anything came before")

  const markAfterFirst = savedState(directory).looked[session].n
  assert.ok(markAfterFirst > 0, "how far the lessons got is remembered")

  // The session is picked up again, days later as far as the plugin is concerned.
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m2", prompt: { text: "and now this" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "late-1", tool: "shell", input: { command: "new late-1" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session, id: "late-1", tool: "shell", input: { command: "new late-1" },
    status: "completed", result: { output: { exit: 2, output: "no config" }, metadata: { exit: 2 } },
  })

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  const second = fake.generated.at(-1).prompt

  assert.match(second, new RegExp(`Steps up to ${markAfterFirst} of this session were analysed before`))
  assert.match(second, /new late-1/, "the new work is there")
  assert.doesNotMatch(second, /old early-1/, "and the material already turned into lessons is not")
  assert.match(second, /the original instruction/, "but the instructions stay, or the excerpt says nothing about why")
  assert.match(second, /and now this/)
  assert.ok(savedState(directory).looked[session].n > markAfterFirst, "and the mark moved on")

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

test("an excerpted log is read again without growing, and is not pruned first", async () => {
  // `through` stops at the first gap so the elided middle is not skipped. But the growth gate
  // compared bytes sent, not steps covered: the whole file had been read and sent, so the log
  // looked finished, and a successful extraction then pruned a file whose middle had never
  // been analysed. The next command must read it again even though nothing was appended.
  const directory = sandbox()
  const session = "ses_excerpt"
  const logPath = join(directory, ".retro", "sessions", `${session}.jsonl`)
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })

  const records = [{ v: 1, n: 1, t: 1, k: "prompt", text: "fix the lint trap" }]
  for (let i = 0; i < 100; i++) {
    records.push({
      v: 1,
      n: i + 2,
      t: i + 2,
      k: "tool",
      id: `c${i}`,
      tool: "shell",
      input: { command: `step-${i}` },
      status: "completed",
      exit: 0,
      output: "x".repeat(300),
    })
  }
  records.push({ v: 1, n: 102, t: 102, k: "text", text: "the end of the session" })
  writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n")

  const fake = fakeOpenCode({
    directory,
    options: { model: MODEL, maxInput: 9000 },
    reply: JSON.stringify({ lessons: [] }),
  })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 1, "the log was read")
  const first = fake.generated[0].prompt
  assert.match(first, /steps elided to fit the budget/, "as an excerpt")
  const mark = savedState(directory).looked[session]
  assert.equal(mark.open, true, "and the gap is remembered")
  assert.ok(mark.n < 102, "the mark stops at the gap, not at the end that was also sent")
  assert.ok(existsSync(logPath), "a log with an unread gap is not pruned as finished work")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 2, "read again without a single byte being appended")
  assert.ok(
    savedState(directory).looked[session].n > mark.n,
    "and it got further than the first read, so the gap is being worked through",
  )

  // And it keeps working through the gap, command after command, until the whole log has
  // been covered. This also crosses the failure-retry budget, which a successful excerpt
  // must not spend: the log is being read, just not in one piece.
  for (let i = 0; i < 40 && existsSync(logPath); i++) {
    await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  }
  assert.ok(!existsSync(logPath), "the excerpt was finished and only then pruned")

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

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, new RegExp(session), "and it is not cited as evidence in the report")
  assert.doesNotMatch(report, /BROKEN/, "nor described as a dead hook of ours")

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

test("an unreadable orphan log for a child is removed, not analysed as a session", async () => {
  // `adopt` used to remove the orphan only when it had parsed records. A half-written or
  // corrupt log parsed to nothing, so it stayed on disk — and `processQueue` would later
  // read the child as a session of its own, with no delegation instruction behind it.
  const directory = sandbox()
  const parent = "ses_parent"
  const child = "ses_child_unreadable"
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  const logPath = join(directory, ".retro", "sessions", `${child}.jsonl`)
  writeFileSync(logPath, "this line is not a shadow-log record\n")

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: parent, messageID: "m1", prompt: { text: "delegate" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: parent,
    id: "d1",
    tool: "subagent",
    input: { agent: "explore", description: "look", prompt: "go" },
    status: "completed",
    result: { output: { output: "done" }, metadata: { sessionID: child } },
  })

  assert.ok(!existsSync(logPath), "the child's log is gone even though nothing in it parsed")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.ok(!analysed(fake).includes(child), "and it was never analysed on its own")

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

test("proposeLimit caps one plan and says what it left out", async () => {
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  for (const [id, cost] of [["a", 30], ["b", 20], ["c", 10]]) {
    writeFileSync(
      join(directory, ".retro", "lessons", `${id}.md`),
      `---\nid: ${id}\nstatement: problem ${id}\ncost: ${cost}\nrecurrence: 1\nconfidence: 1\nstatus: new\n---\n\nbody\n`,
    )
  }

  const fake = fakeOpenCode({ directory, options: { model: MODEL, proposeLimit: 2 } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_x", prompt: { text: "all" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /## 1\. `a`/)
  assert.match(delivered.text, /## 2\. `b`/)
  assert.doesNotMatch(delivered.text, /## 3\./, "the cap holds")
  assert.match(delivered.text, /1 more below the cut/, "and the remainder is named")
  await cleanup?.()
})

test("a log skipped as one exchange does not spend the command's limit", async () => {
  // The limit exists to bound model calls, and a skip makes none. It was incremented before
  // the answer was known, so a quiet log at the head of the queue used up a limit of one and
  // the session behind it — the one with something to read — was never looked at.
  const directory = sandbox()
  const writer = fakeOpenCode({ directory, options: { model: MODEL } })
  const stopWriter = await plugin.setup(writer.ctx)
  await writer.hooks.get("session.prompt")({ sessionID: "ses_quiet", messageID: "m1", prompt: { text: "hello" } })
  await workSession(writer, "ses_busy")
  await stopWriter?.()
  queue(directory, ["ses_quiet", "ses_busy"])

  const fake = fakeOpenCode({ directory, options: { model: MODEL, extractLimit: 1 } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 1, "one model call, as the limit says")
  assert.deepEqual(analysed(fake), ["ses_busy"], "and it was spent on the session with something in it")
  assert.equal(
    existsSync(join(directory, ".retro", "sessions", "ses_quiet.jsonl")),
    false,
    "the quiet one was settled without a call, and released",
  )

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

test("a delegation inside a delegation is folded into the root when the links arrive out of order", async () => {
  // A subagent can spawn one of its own. The leaf's link to the middle may be learned before
  // the middle is known to be a child of the root, so the leaf is absorbed into the middle's
  // log first and has to move again when the middle is adopted. Neither the middle nor the
  // leaf is a session: no log of its own is left, neither is queued, and neither moves the
  // freshness counter even though both ends were processed before the links were known.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const root = "ses_root"
  const middle = "ses_middle"
  const leaf = "ses_leaf"

  await fake.hooks.get("session.prompt")({ sessionID: root, messageID: "m0", prompt: { text: "the task" } })
  await fake.hooks.get("session.prompt")({
    sessionID: middle,
    messageID: "m1",
    prompt: { text: "You are a subagent spawned by another session.\nMiddle task" },
  })
  await fake.hooks.get("session.prompt")({
    sessionID: leaf,
    messageID: "m2",
    prompt: { text: "You are a subagent spawned by another session.\nLeaf task" },
  })
  await fake.hooks.get("tool.execute.before")({ sessionID: leaf, id: "l1", tool: "read", input: { path: "src/sum.js" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: leaf,
    id: "l1",
    tool: "read",
    agent: "explore",
    input: { path: "src/sum.js" },
    status: "completed",
    result: { output: { output: "export function sum" } },
  })

  // Both ends are processed while each still looks like a session of its own.
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 5 }, data: { sessionID: leaf } })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 6 }, data: { sessionID: middle } })
  await tick()
  assert.deepEqual(savedState(directory).pending.map((p) => p.session).sort(), [leaf, middle])
  assert.equal(savedState(directory).sessions, 2)

  // Leaf -> middle is learned first, before middle -> root.
  await fake.hooks.get("tool.execute.after")({
    sessionID: middle,
    id: "d-leaf",
    tool: "subagent",
    input: { agent: "explore", description: "look", prompt: "go" },
    status: "completed",
    result: { output: { output: "done" }, metadata: { sessionID: leaf } },
  })
  assert.ok(!existsSync(join(directory, ".retro", "sessions", `${leaf}.jsonl`)), "the leaf log moved into the middle")

  await fake.hooks.get("tool.execute.after")({
    sessionID: root,
    id: "d-middle",
    tool: "subagent",
    input: { agent: "explore", description: "middle", prompt: "go" },
    status: "completed",
    result: { output: { output: "done" }, metadata: { sessionID: middle } },
  })

  for (const id of [middle, leaf]) {
    assert.ok(!existsSync(join(directory, ".retro", "sessions", `${id}.jsonl`)), `${id} has no log of its own`)
  }
  const records = readFileSync(join(directory, ".retro", "sessions", `${root}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const texts = records.filter((r) => r.k === "prompt").map((r) => r.text)
  assert.ok(texts.some((t) => /Middle task/.test(t)), "the middle's instruction reached the root")
  assert.ok(texts.some((t) => /Leaf task/.test(t)), "and so did the leaf's")
  assert.ok(records.some((r) => r.tool === "read"), "the leaf's work is in the root's log")

  const state = savedState(directory)
  assert.deepEqual(state.pending, [], "neither delegation is owed an analysis")
  assert.equal(state.sessions, 0, "and neither ages a lesson")

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

/* ------------------------------------- the session lifecycle: more than one turn */

/**
 * One turn of a session, as OpenCode emits it: execution started, a prompt and a tool call
 * through the hooks, then the execution succeeded. Measured shape — an execution is a turn,
 * not the life of the session.
 */
async function turn(fake, session, n, command) {
  fake.emit({ type: "session.execution.started", durable: { seq: n }, data: { sessionID: session } })
  await tick()
  await fake.hooks.get("session.prompt")({
    sessionID: session,
    messageID: `m${n}`,
    prompt: { text: `the instruction for turn ${n}` },
  })
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: `c${n}`, tool: "shell", input: { command } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session,
    id: `c${n}`,
    tool: "shell",
    input: { command },
    status: "completed",
    result: { output: { exit: 2, output: "no config" }, metadata: { exit: 2 } },
  })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: n + 10 }, data: { sessionID: session } })
  await tick()
}

test("a session that runs again is owed a second analysis, from where the first stopped", async () => {
  // An execution is one turn. `ended` used to be permanent, so the second turn of any
  // session was invisible: not live while it ran (another `/retro` could settle it mid-work)
  // and its own end was dropped as a duplicate, so nothing was queued. `extracted` was
  // permanent too, so even a queued second turn would have answered "already done".
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_twice"

  await turn(fake, session, 1, "first-command")
  assert.deepEqual(savedState(directory).pending.map((p) => p.session), [session])

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1)
  const mark = savedState(directory).looked[session].n
  assert.ok(mark > 0, "the first turn was turned into lessons")

  await turn(fake, session, 2, "second-command")
  const after = savedState(directory)
  assert.deepEqual(after.pending.map((p) => p.session), [session], "the second turn is owed an analysis too")
  assert.equal(after.sessions, 1, "but a second turn is not a second session")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "and it was read")

  const second = fake.generated.at(-1).prompt
  assert.match(second, new RegExp(`Steps up to ${mark} of this session were analysed before`))
  assert.match(second, /second-command/, "the new work is there")
  assert.doesNotMatch(second, /first-command/, "and the material already turned into lessons is not")
  assert.match(second, /the instruction for turn 1/, "prompts stay, because they say what it was for")

  await cleanup?.()
})

test("a session picked up again is read, never settled, while its second turn is running", async () => {
  // A session queued when one execution ended may be prompted again before `/retro` runs.
  // Settling it then marks the rest of it extracted and can prune a log that is still being
  // written; the live pass reads it instead, and it is settled when this turn ends.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_back_at_it"

  await turn(fake, session, 1, "first-command")
  fake.emit({ type: "session.execution.started", durable: { seq: 20 }, data: { sessionID: session } })
  await tick()
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m20", prompt: { text: "carry on" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "c20", tool: "shell", input: { command: "still-working" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session,
    id: "c20",
    tool: "shell",
    input: { command: "still-working" },
    status: "completed",
    result: { output: { exit: 0, output: "ok" }, metadata: { exit: 0 } },
  })

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 1, "it is live, so it is read")
  const state = savedState(directory)
  assert.equal(state.extracted[session], undefined, "and nothing about it is settled mid-turn")
  assert.deepEqual(state.pending.map((p) => p.session), [session], "its end is still owed")
  assert.ok(
    existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)),
    "and its log is still there, because it is still being written to",
  )

  await cleanup?.()
})

test("a log smaller than its mark is read again, not mistaken for already read", async () => {
  // A pruned log that the session writes again starts at step 1 and is shorter. `size` only
  // ever moves forward, so without an explicit rebase the new file looked like the old one
  // and was never read again.
  const directory = sandbox()
  const session = "ses_recycled"
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  const logPath = join(directory, ".retro", "sessions", `${session}.jsonl`)
  const write = (lines) => writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  write([
    { v: 1, n: 1, t: 1, k: "prompt", text: "old instruction" },
    { v: 1, n: 2, t: 2, k: "tool", id: "old", tool: "shell", input: { command: "old-command" }, status: "completed", exit: 2 },
    { v: 1, n: 3, t: 3, k: "session", event: "end", outcome: "succeeded" },
  ])

  const fake = fakeOpenCode({ directory, options: { model: MODEL }, reply: JSON.stringify({ lessons: [] }) })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "the orphan log was read")
  assert.ok(!existsSync(logPath), "and pruned, because nothing cites it")

  // The same session is written again, with a shorter log and its own numbering.
  write([
    { v: 1, n: 1, t: 9, k: "prompt", text: "new instruction" },
    { v: 1, n: 2, t: 10, k: "tool", id: "new", tool: "shell", input: { command: "new-command" }, status: "completed", exit: 2 },
  ])

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "a log shorter than the mark is new material, not old news")
  assert.match(fake.generated.at(-1).prompt, /new-command/)
  assert.doesNotMatch(fake.generated.at(-1).prompt, /old-command/)

  await cleanup?.()
})

test("bytes appended while the model is thinking are not marked as read", async () => {
  // The size used to be `stat` after the call, so a record the session wrote while `/retro`
  // waited was recorded as sent without ever being sent — and the growth gate then skipped
  // it for good. The mark has to be the bytes that were read.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_writing_while_read"
  const logPath = join(directory, ".retro", "sessions", `${session}.jsonl`)

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)

  const before = statSync(logPath).size
  const original = fake.ctx.session.generate
  let appended = false
  fake.ctx.session.generate = async (input) => {
    if (!appended) {
      appended = true
      // A record written by the session while the model is answering. The last `n` in the
      // file is 4 (prompt + three tool calls).
      appendFileSync(
        logPath,
        JSON.stringify({ v: 1, n: 5, t: Date.now(), k: "tool", id: "late", tool: "shell", input: { command: "late-append" }, status: "completed" }) + "\n",
      )
    }
    return original(input)
  }

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1)
  assert.equal(savedState(directory).looked[session].size, before, "only the bytes that were actually sent are marked")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "so the appended record is read on the next pass")
  assert.match(fake.generated.at(-1).prompt, /late-append/)

  await cleanup?.()
})

test("a log whose numbering starts over is read from its own start, even if it is longer", async () => {
  // Size is not enough: a replaced log can be longer than the old one and still have lower
  // step numbers. Filtering by the old mark then drops the new work, and the step references
  // in a lesson would point at records that are no longer there.
  const directory = sandbox()
  const session = "ses_renumbered"
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  const logPath = join(directory, ".retro", "sessions", `${session}.jsonl`)
  const write = (lines) => writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")

  write([
    { v: 1, n: 1, t: 1, k: "prompt", text: "old instruction" },
    { v: 1, n: 2, t: 2, k: "tool", id: "old-1", tool: "shell", input: { command: "old-command" }, status: "completed", exit: 2 },
    { v: 1, n: 3, t: 3, k: "tool", id: "old-2", tool: "shell", input: { command: "old-command-2" }, status: "completed", exit: 2 },
    { v: 1, n: 4, t: 4, k: "session", event: "end", outcome: "succeeded" },
  ])

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1)
  assert.equal(savedState(directory).looked[session].n, 4)
  assert.ok(existsSync(logPath), "a lesson cites it, so the log is kept")

  // Same session id, a different log: longer, but its steps start at 1 again.
  write([
    { v: 1, n: 1, t: 9, k: "prompt", text: "the replacement instruction ".repeat(80) },
    { v: 1, n: 2, t: 10, k: "tool", id: "new-1", tool: "shell", input: { command: "new-command" }, status: "completed", exit: 2 },
  ])

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "the new log is read, not filtered away by the old step mark")
  assert.match(fake.generated.at(-1).prompt, /new-command/)

  await cleanup?.()
})

test("a failed retry on a resumed session is not silently dropped from the queue", async () => {
  // The size mark moves on a failed attempt (so the same bytes are not paid for twice), but
  // the extraction never covered them. If the queue's staleness check compared against the
  // current mark, the entry would look answered by the *earlier* settle and vanish — no
  // retry, no message, the second turn never read.
  const directory = sandbox()
  const session = "ses_retried"
  let calls = 0
  const fake = fakeOpenCode({
    directory,
    options: { model: MODEL },
    reply: () => (++calls === 1 ? REPLY : "I cannot answer that."),
  })
  const cleanup = await plugin.setup(fake.ctx)

  await turn(fake, session, 1, "first-command")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "the first turn was analysed")

  await turn(fake, session, 2, "second-command")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "the second turn was tried")

  const after = savedState(directory)
  assert.equal(after.pending.length, 1, "and the failure is still owed")
  assert.equal(after.pending[0].attempts, 1)

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 3, "the retry happens rather than the entry disappearing")

  await cleanup?.()
})

test("a session whose creation we never saw is not counted, queued or reported on", async () => {
  // The event stream reaches every session in the project, and plugins load lazily: a
  // worktree session created before this instance started still reaches us when it ends.
  // The ingest refuses to open a log without a hook, but the end branch did not, so it
  // queued a log that does not exist, moved the freshness counter, and rewrote
  // selfcheck.md as BROKEN prompt hook about somebody else's healthy session.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const elsewhere = "ses_another_checkout"

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: elsewhere } })
  fake.emit({ type: "session.text.ended", durable: { seq: 2 }, data: { sessionID: elsewhere, text: "done" } })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 3 }, data: { sessionID: elsewhere } })
  await tick()

  const state = savedState(directory)
  assert.deepEqual(state.pending, [], "nothing to analyse: no hook fired for it")
  assert.equal(state.sessions, 0, "and it is not a session this workspace had")

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /BROKEN\s+prompt hook/, "it is not our prompt hook that is missing")
  assert.doesNotMatch(report, /file was never created/, "nor our shadow log")
  assert.match(report, /Nothing measured yet/, "there is simply nothing of ours to measure")

  await cleanup?.()
})

test("a session created with the same directory spelled differently is still ours", async () => {
  // `<dir>` and `<dir>/` name one place. Treating the second as a foreign checkout silently
  // discarded the session's end event, so it was never queued and another `/retro` would
  // eventually settle it while it was still running.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_trailing_slash"

  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do it" } })
  fake.emit({
    type: "session.created",
    durable: { seq: 0 },
    data: { sessionID: session, location: { directory: `${directory}/` }, projectID: "proj" },
  })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 7 }, data: { sessionID: session } })
  await tick()

  assert.deepEqual(savedState(directory).pending.map((p) => p.session), [session], "its end still reaches us")
  await cleanup?.()
})

test("a subagent's tool call does not make the self-check measure its missing log", async () => {
  // A child's hooks fire like the parent's, but its records are written into the parent's
  // log and its own log is removed when the link is learned. `observe(child)` looked for
  // sessions/<child>.jsonl, did not find it, and wrote BROKEN shadow log plus BROKEN prompt
  // hook about a healthy session — the exact false alarm the ownership gate exists to avoid.
  const directory = sandbox()
  const parent = "ses_parent_report"
  const child = "ses_child_report"
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: parent, messageID: "m1", prompt: { text: "find the exports" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: parent, id: "d1", tool: "subagent", input: { agent: "explore" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: parent,
    id: "d1",
    tool: "subagent",
    input: { agent: "explore", description: "look" },
    status: "completed",
    result: { output: { output: "done" }, metadata: { sessionID: child } },
  })
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

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /file was never created/)
  assert.match(report, new RegExp(`sessions/${parent}\\.jsonl`), "measured on the parent, whose log holds the work")
  assert.doesNotMatch(report, new RegExp(child), "and never on the child")

  await cleanup?.()
})

test("deciding a lesson never prunes the log of the session it was decided in", async () => {
  // `retro_decide` prunes uncited logs, and the session running the review is uncited until
  // the decision is made. It is not in `started` if the plugin loaded after this turn's
  // start event, so it looked finished and its log was deleted under it.
  const directory = sandbox()
  const deciding = "ses_deciding_here"
  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  writeFileSync(join(directory, ".retro", "sessions", `${deciding}.jsonl`), JSON.stringify({ v: 1, n: 1, k: "prompt", text: "decide" }) + "\n")
  writeFileSync(
    join(directory, ".retro", "lessons", "a.md"),
    "---\nid: a\nstatement: problem a\ncost: 5\nrecurrence: 1\nconfidence: 1\nstatus: new\n---\n\nbody\n",
  )

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const result = await fake.tools.get("retro_decide").execute({ id: "a", status: "accepted" }, { sessionID: deciding })

  assert.equal(result.output.ok, true)
  assert.ok(
    existsSync(join(directory, ".retro", "sessions", `${deciding}.jsonl`)),
    "the session that asked still has its log",
  )
  await cleanup?.()
})


test("the hand-over the plugin delivers is in the session's own log", async () => {
  // Measured: `session.synthetic` does not fire the `session.prompt` hook, so every session
  // whose only input arrived that way had a log of tool calls, text and steps with not one
  // prompt record in it. The log of a review session therefore showed an agent reading and
  // editing for no stated reason, with the instruction that caused all of it missing. We are
  // the sender, so we write it — as a hand-over, not as the user's prompt.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "lessons", "lint-skill-no-config.md"),
    "---\nid: lint-skill-no-config\nstatement: eslint is not configured here\ncost: 9\nrecurrence: 2\nconfidence: 0.9\nstatus: new\n---\n\nbody\n",
  )

  await fake.commands.get("retro").execute({ sessionID: "ses_reviewer", prompt: { text: "" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /lint-skill-no-config/, "it was handed over")

  const log = readFileSync(join(directory, ".retro", "sessions", "ses_reviewer.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
  const handover = log.find((r) => r.k === "handover")
  assert.ok(handover, "and the session's own log says so")
  assert.match(handover.text, /lint-skill-no-config/)
  assert.equal(log.some((r) => r.k === "prompt"), false, "without pretending the user typed it")
})

test("a review session driven by a hand-over is not reported as a dead prompt hook", async () => {
  // Live: `/retro` delivered into a session that had never seen a prompt, the agent there
  // started working, and selfcheck.md said BROKEN prompt hook / "renamed upstream" — about a
  // working hook, in the session the plugin had just started. The hand-over is delivered by
  // `session.synthetic`, which does not fire the prompt hook (Gotcha 12), so it proves
  // nothing; saying so is not the same as saying the hook is dead.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.commands.get("retro").execute({ sessionID: "ses_reviewer", prompt: { text: "" } })

  // The agent in that session starts working, which is what re-evaluates the report.
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reviewer", id: "c1", tool: "read", input: { path: "a.js" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: "ses_reviewer",
    id: "c1",
    tool: "read",
    status: "completed",
    result: { output: { output: "x" } },
  })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /BROKEN\s+prompt hook/, "a working hook must not be called dead")
  assert.match(report, /not exercised\s+prompt hook\s+this turn began with a `\/retro` hand-over/)

  await cleanup?.()
})

test("a running session with calls still in flight is not reported as a broken tool hook", async () => {
  // Parallel tool calls mean events can arrive before their `after` hooks. Live: two events
  // and one hook call for a moment, and the file said BROKEN "the plugin needs an update".
  // The comparison only settles when the session does.
  const directory = sandbox()
  // heartbeatMs 0 so the report is re-evaluated on the tool hook rather than throttled.
  const fake = fakeOpenCode({ directory, options: { model: MODEL, heartbeatMs: 0 } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.hooks.get("session.prompt")({ sessionID: "ses_live", prompt: { text: "go" } })
  fake.emit({ type: "session.tool.called", durable: { seq: 1 }, data: { sessionID: "ses_live", id: "c1" } })
  fake.emit({ type: "session.tool.called", durable: { seq: 2 }, data: { sessionID: "ses_live", id: "c2" } })
  await tick()

  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_live", id: "c1", tool: "read", input: { path: "a.js" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: "ses_live",
    id: "c1",
    tool: "read",
    status: "completed",
    result: { output: { output: "x" } },
  })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /BROKEN\s+tool hook/)
  assert.match(report, /not exercised\s+tool hook\s+2 tool-call events \/ 1 hook calls so far/)

  await cleanup?.()
})

test("a two-turn session is one session with two executions", () => {
  // The fixture that settles what an execution is, saved from a real run rather than argued
  // about: `opencode run -s <id>` twice, one log, two start/end pairs. The liveness rules read
  // an execution as a session before this was measured.
  const records = parseShadowLog(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sessions", "two-turns.jsonl"), "utf8"),
  )

  assert.equal(records.filter((r) => r.k === "prompt").length, 2, "two prompts")
  assert.equal(records.filter((r) => r.k === "session" && r.event === "start").length, 2, "and two executions")
  assert.equal(records.filter((r) => r.k === "session" && r.event === "end").length, 2)
  assert.deepEqual(
    records.map((r) => r.n),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    "numbered once through, not restarted per turn",
  )
})

test("a session that turns out to be a subagent leaves the queue", async () => {
  // Its end can be processed before the link is known: `session.created` is missed when the
  // plugin loads lazily, leaving the parent's `subagent` result as the only route. A
  // delegation is a step in its parent's task, so there is nothing of its own to analyse.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const child = "ses_child"
  const parent = "ses_parent"

  await fake.hooks.get("session.prompt")({ sessionID: child, messageID: "m1", prompt: { text: "you are a subagent" } })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 5 }, data: { sessionID: child } })
  await tick()
  assert.deepEqual(savedState(directory).pending.map((p) => p.session), [child], "queued, as far as we knew")

  // The parent's own tool result reveals the link.
  await fake.hooks.get("tool.execute.after")({
    sessionID: parent,
    id: "c1",
    tool: "subagent",
    input: { agent: "explore", description: "look around", prompt: "go" },
    status: "completed",
    result: { output: "done", metadata: { sessionID: child } },
  })

  assert.deepEqual(savedState(directory).pending, [], "and then it is not a session to analyse")
  assert.equal(savedState(directory).sessions, 0, "nor a session freshness should age by")
  assert.equal(existsSync(join(directory, ".retro", "sessions", `${child}.jsonl`)), false, "its log went to the parent")

  await cleanup?.()
})

test("a failed read of a live session is owed, not forgotten", async () => {
  // The size mark alone hid it: the next command saw "nothing new", and if the plugin
  // restarted before the session's end event, nothing ever looked at the log again. `open`
  // could not express it either — an excerpt is owed *now*, a failure is owed *later*, and
  // one flag made a failing live session either loop every command or vanish.
  const directory = sandbox()
  const session = "ses_live_failed"
  const fake = fakeOpenCode({ directory, options: { model: MODEL }, reply: "not json at all" })
  const cleanup = await plugin.setup(fake.ctx)

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "it was read")
  const mark = savedState(directory).looked[session]
  assert.ok(mark.size > 0, "and the bytes are not paid for twice")
  assert.equal(mark.failed, true, "but the debt is recorded")
  assert.equal(mark.open, undefined, "and it is not the kind that re-reads at once")

  // Still live: the same bytes are not sent again.
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "nothing new in it, so nothing spent")

  // The plugin restarts, so nothing is live and no end event was ever seen for it.
  await cleanup?.()
  const after = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup2 = await plugin.setup(after.ctx)
  await after.commands.get("retro").execute({ sessionID: "ses_review2", prompt: { text: "" } })

  assert.equal(after.generated.length, 1, "the session is over now, so the log is read")
  assert.equal(savedState(directory).extracted[session]?.ok, true, "and settled")

  await cleanup2?.()
})

test("a mark belongs to one log: a replaced file is read from its own start, whatever its size or numbering", async () => {
  // Size caught a shorter replacement and `lastN < mark.n` caught a renumbered one. A
  // replacement that is longer *and* numbers past the old mark passed both, and its first
  // steps were silently skipped. The mark now names the file it is about.
  const directory = sandbox()
  const session = "ses_replaced"
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  const logPath = join(directory, ".retro", "sessions", `${session}.jsonl`)
  const write = (lines) => writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  const tool = (n, id) => ({ v: 1, n, t: n, k: "tool", id, tool: "shell", input: { command: id }, status: "completed", exit: 2 })

  write([
    { v: 1, n: 1, t: 1, k: "prompt", text: "old instruction" },
    tool(2, "old-1"),
    tool(3, "old-2"),
    { v: 1, n: 4, t: 4, k: "session", event: "end", outcome: "succeeded" },
  ])
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(savedState(directory).looked[session].n, 4)

  // Longer in bytes, numbered past the old mark, and a different log.
  write([
    { v: 1, n: 1, t: 9, k: "prompt", text: "the replacement instruction, which is not the old one" },
    tool(2, "new-1"),
    tool(3, "new-2"),
    tool(4, "new-3"),
    tool(5, "new-4"),
    tool(6, "new-5"),
    { v: 1, n: 7, t: 16, k: "session", event: "end", outcome: "succeeded" },
  ])
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 2, "the replacement is read")
  const sent = fake.generated.at(-1).prompt
  assert.match(sent, /new-1/, "from its own start")
  assert.doesNotMatch(sent, /Steps up to/, "with no claim that any of it was analysed before")

  await cleanup?.()
})

test("lessons extracted from an orphan child keep their evidence when the child is folded into its parent", async () => {
  // `/retro` can run between a delegation's end and the moment its parent is learned. The
  // lesson it extracts cites the child's log, which is then folded into the root's with new
  // step numbers and removed — a dead reference, the one thing evidence must never be.
  const directory = sandbox()
  const reply =
    "```json\n" +
    JSON.stringify({ lessons: [{ id: "child-lesson", statement: "the child kept retrying", steps: [1, 3], cost: 3, confidence: 0.8, why: "x" }] }) +
    "\n```"
  const fake = fakeOpenCode({ directory, options: { model: MODEL }, reply })
  const cleanup = await plugin.setup(fake.ctx)
  const parent = "ses_root"
  const child = "ses_child"

  // The parent has a record of its own first, so the child's steps really do move.
  await fake.hooks.get("session.prompt")({ sessionID: parent, messageID: "p1", prompt: { text: "delegate this" } })
  await fake.hooks.get("session.prompt")({ sessionID: child, messageID: "c1", prompt: { text: "you are a subagent" } })
  for (const id of ["c-1", "c-2"]) {
    await fake.hooks.get("tool.execute.before")({ sessionID: child, id, tool: "shell", input: { command: id } })
    await fake.hooks.get("tool.execute.after")({
      sessionID: child, id, tool: "shell", input: { command: id },
      status: "completed", result: { output: { exit: 2, output: "no" }, metadata: { exit: 2 } },
    })
  }
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 9 }, data: { sessionID: child } })
  await tick()

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  const before = parseFrontmatter(readFileSync(join(directory, ".retro", "lessons", "child-lesson.md"), "utf8")).data
  assert.deepEqual(before.evidence, [{ session: child, steps: [1, 3] }], "extracted while the child looked like a session")

  // The parent's own tool result reveals the link.
  await fake.hooks.get("tool.execute.after")({
    sessionID: parent, id: "d1", tool: "subagent",
    input: { agent: "explore", description: "look", prompt: "go" },
    status: "completed", result: { output: "done", metadata: { sessionID: child } },
  })

  const after = parseFrontmatter(readFileSync(join(directory, ".retro", "lessons", "child-lesson.md"), "utf8")).data
  assert.deepEqual(after.evidence, [{ session: parent, steps: [2, 4] }], "same records, now in the root's log, renumbered")
  assert.equal(existsSync(join(directory, ".retro", "sessions", `${child}.jsonl`)), false, "the child's log is gone")
  assert.equal(existsSync(join(directory, ".retro", "sessions", `${parent}.jsonl`)), true, "and the root's holds its steps")

  await cleanup?.()
})

test("a hook that arrives after a session's end does not report the session as broken", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_late"

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 9 }, data: { sessionID: session } })
  await tick()
  const ended = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(ended, /ok\s+prompt hook/)

  // A tool result that finished after the turn was declared over.
  await fake.hooks.get("tool.execute.after")({
    sessionID: session, id: "late", tool: "shell", input: { command: "x" },
    status: "completed", result: { output: { exit: 0, output: "ok" }, metadata: { exit: 0 } },
  })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /BROKEN/, "a late hook is not news about liveness")
  assert.match(report, /which ended at/, "the end-of-session report stands")

  await cleanup?.()
})

test("an entry that used its three attempts is retired and reported, not skipped for ever", async () => {
  // A crash between attempt() and markExtracted() left an entry at three attempts with no
  // outcome. nextPending skipped it, every command, and nothing ever said so.
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  // The log is still there — it was owed, and the crash came before anything settled it.
  // Its size was recorded by the attempts that did run, so nothing about it has grown.
  const line = JSON.stringify({ v: 1, n: 1, t: 1, k: "prompt", text: "do the thing" }) + "\n"
  writeFileSync(join(directory, ".retro", "sessions", "ses_crashed.jsonl"), line)
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({
      version: 1,
      rejected: [],
      extracted: {},
      sessions: 1,
      pending: [{ session: "ses_crashed", queuedAt: "now", attempts: 3, size: line.length }],
      looked: { ses_crashed: { n: 0, size: line.length } },
    }),
  )
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const state = savedState(directory)
  assert.deepEqual(state.pending, [], "out of the queue")
  assert.equal(state.extracted.ses_crashed?.ok, false, "with its failure recorded")
  assert.match(fake.synthetic[0].text, /ses_crashed.*given up after three failed analyses/, "and said out loud")
  assert.equal(fake.generated.length, 0, "without spending anything on it")
  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /1 log given up on after three failed analyses/, "and the stock section names it")

  await cleanup?.()
})

test("an excerpt that cannot reach past the mark is reported, not settled as done", async () => {
  const directory = sandbox()
  const session = "ses_stuck_excerpt"
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  const logPath = join(directory, ".retro", "sessions", `${session}.jsonl`)
  const write = (lines) => writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  write([
    { v: 1, n: 1, t: 1, k: "prompt", text: "fix the lint trap" },
    { v: 1, n: 2, t: 2, k: "tool", id: "c1", tool: "shell", input: { command: "npx eslint ." }, status: "completed", exit: 2 },
    { v: 1, n: 3, t: 3, k: "tool", id: "c2", tool: "shell", input: { command: "npx eslint --fix ." }, status: "completed", exit: 2 },
  ])

  const first = fakeOpenCode({ directory, options: { model: MODEL }, reply: REPLY })
  const cleanup = await plugin.setup(first.ctx)
  await first.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(first.generated.length, 1, "first read")
  assert.equal(savedState(directory).looked[session].n, 3)
  assert.deepEqual(savedState(directory).pending, [])
  assert.ok(existsSync(logPath), "a lesson cites it, so it is kept")

  appendFileSync(logPath, JSON.stringify({ v: 1, n: 4, t: 4, k: "tool", id: "huge", tool: "shell", input: { command: "x".repeat(100_000) }, status: "completed", exit: 2 }) + "\n")
  appendFileSync(logPath, JSON.stringify({ v: 1, n: 5, t: 5, k: "text", text: "THE NEW MATERIAL" }) + "\n")

  const small = fakeOpenCode({ directory, options: { model: MODEL, maxInput: 8000 }, reply: REPLY })
  const cleanup2 = await plugin.setup(small.ctx)
  await small.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const state = savedState(directory)
  assert.equal(state.pending.length, 1, "the unread material stays owed")
  assert.equal(state.pending[0].attempts, 1, "the attempt is counted, so it cannot loop for ever")
  assert.match(small.synthetic[0].text, /could not reach past step 3/, "and the failure is said out loud")
  assert.equal(state.looked[session].open, undefined, "it was not mistaken for an excerpt owed now")
  assert.ok(existsSync(logPath), "and the log is kept for the retry")
  await cleanup?.()
  await cleanup2?.()
})

test("/retro all reports a log it could not analyse, as well as the plan", async () => {
  // The single hand-over has always carried the failure; the batch path built its message
  // from the open lessons alone, so a log that failed simply vanished from the one command
  // most likely to be used on a backlog. Silence about a failure is the failure this plugin
  // exists to prevent, so both commands say it.
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
  await fresh.commands.get("retro-all").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.deepEqual(analysed(fresh), ["ses_bad", "ses_good"], "the good log is analysed too")
  const [delivered] = fresh.synthetic
  assert.match(delivered.text, /could not analyse `ses_bad`/, "the failure is named")
  assert.match(delivered.text, /the model answered/, "with what the model actually said")
  assert.match(delivered.text, /lint-skill-no-config/, "and the plan still arrives")

  await cleanup?.()
  await cleanup2?.()
})

test("evidence remapped into a middle delegation follows it into the root", async () => {
  // The two-level case the concepts call out: a lesson extracted from an orphan leaf is
  // remapped to the middle session, and the middle is itself folded into the root later.
  // A remap that only knows one level leaves the evidence citing a log that no longer
  // exists — the dead reference decision 18 keeps the log to avoid.
  const directory = sandbox()
  const reply =
    "```json\n" +
    JSON.stringify({ lessons: [{ id: "leaf-lesson", statement: "the leaf kept retrying", steps: [1, 2], cost: 2, confidence: 0.8, why: "x" }] }) +
    "\n```"
  const fake = fakeOpenCode({ directory, options: { model: MODEL }, reply })
  const cleanup = await plugin.setup(fake.ctx)
  const root = "ses_root2"
  const middle = "ses_middle2"
  const leaf = "ses_leaf2"

  await fake.hooks.get("session.prompt")({ sessionID: root, messageID: "r", prompt: { text: "root task" } })
  await fake.hooks.get("session.prompt")({ sessionID: leaf, messageID: "l", prompt: { text: "leaf task" } })
  for (const id of ["l-1", "l-2"]) {
    await fake.hooks.get("tool.execute.before")({ sessionID: leaf, id, tool: "shell", input: { command: id } })
    await fake.hooks.get("tool.execute.after")({
      sessionID: leaf, id, tool: "shell", input: { command: id },
      status: "completed", result: { output: { exit: 2, output: "no" }, metadata: { exit: 2 } },
    })
  }
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 9 }, data: { sessionID: leaf } })
  await tick()

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.deepEqual(
    parseFrontmatter(readFileSync(join(directory, ".retro", "lessons", "leaf-lesson.md"), "utf8")).data.evidence,
    [{ session: leaf, steps: [1, 2] }],
  )

  // Leaf -> middle first, then middle -> root.
  await fake.hooks.get("tool.execute.after")({
    sessionID: middle, id: "d-leaf", tool: "subagent",
    input: { agent: "explore", description: "leaf", prompt: "go" },
    status: "completed", result: { output: { output: "done" }, metadata: { sessionID: leaf } },
  })
  const between = parseFrontmatter(readFileSync(join(directory, ".retro", "lessons", "leaf-lesson.md"), "utf8")).data
  assert.equal(between.evidence[0].session, middle, "first fold points at the middle")

  await fake.hooks.get("tool.execute.after")({
    sessionID: root, id: "d-middle", tool: "subagent",
    input: { agent: "explore", description: "middle", prompt: "go" },
    status: "completed", result: { output: { output: "done" }, metadata: { sessionID: middle } },
  })
  const after = parseFrontmatter(readFileSync(join(directory, ".retro", "lessons", "leaf-lesson.md"), "utf8")).data
  assert.equal(after.evidence[0].session, root, "and the second fold follows it into the root")
  assert.ok(existsSync(join(directory, ".retro", "sessions", `${root}.jsonl`)), "where the records now are")
  for (const id of [leaf, middle]) {
    assert.equal(existsSync(join(directory, ".retro", "sessions", `${id}.jsonl`)), false, `${id} has no log left`)
  }

  await cleanup?.()
})

test("a session whose start event this process never saw is live from its first hook", async () => {
  // After a restart in the middle of a session, the execution.started event has already gone
  // by. A hook firing is the older and more reliable fact: without it the session looks
  // finished, gets queued, settled and possibly pruned while it is still writing.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_started_before_us"

  await workSession(fake, session)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.deepEqual(analysed(fake), [session], "it is read, like any live session")
  const state = savedState(directory)
  assert.equal(state.extracted[session], undefined, "nothing about it is settled")
  assert.deepEqual(state.pending, [], "and it is not queued while it can still add to itself")
  assert.ok(state.looked[session].n > 0, "what was read is still remembered")
  assert.ok(existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)), "and its log is kept")

  await cleanup?.()
})

test("a log with no parseable record is reported as a failure, not as a clean analysis", async () => {
  // The log is only created by writing a record to it, so a present file with nothing
  // parseable in it was corrupted, truncated or written by something else. It used to reach
  // the extractor as an empty record list, which answered "one exchange, nothing done" and
  // settled the log: a clean report about material nobody could read.
  const directory = sandbox()
  const session = "ses_garbled"
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  writeFileSync(join(directory, ".retro", "sessions", `${session}.jsonl`), "this is not a shadow log\nnor is this\n")
  queue(directory, [session])

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /Could not analyse `ses_garbled`/)
  assert.match(delivered.text, /could not be parsed/, "with the reason")
  assert.doesNotMatch(delivered.text, /nothing to learn/, "not a clean analysis of a file it could not read")
  assert.equal(fake.generated.length, 0, "and no model call is spent on it")

  const state = savedState(directory)
  assert.equal(state.pending[0].attempts, 1, "it stays queued and counted")
  assert.ok(existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)), "and the log is kept")

  await cleanup?.()
})

test("a replaced log whose first record cannot be read is still a different log", async () => {
  // The identity is a hash of the first whole record, and an append never rewrites it. So a
  // file that exists but has no whole first record cannot be the log the mark described: it
  // was replaced or truncated. Treating the missing identity as "same file" let a longer
  // replacement keep the old step mark, and its early steps were filtered away as already
  // analysed.
  const directory = sandbox()
  const session = "ses_replaced_unreadable"
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  const logPath = join(directory, ".retro", "sessions", `${session}.jsonl`)
  const write = (text) => writeFileSync(logPath, text)
  const line = (r) => JSON.stringify(r) + "\n"

  write(
    line({ v: 1, n: 1, t: 1, k: "prompt", text: "old instruction" }) +
      line({ v: 1, n: 2, t: 2, k: "tool", id: "old", tool: "shell", input: { command: "old-command" }, status: "completed", exit: 2 }) +
      line({ v: 1, n: 3, t: 3, k: "session", event: "end", outcome: "succeeded" }),
  )
  const fake = fakeOpenCode({ directory, options: { model: MODEL }, reply: REPLY })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(savedState(directory).looked[session].n, 3)

  // A longer replacement whose first line is corrupt, numbered past the old mark.
  let replacement = "this line is not a record\n"
  for (let n = 2; n <= 10; n++) {
    replacement += line({ v: 1, n, t: n, k: "tool", id: `new-${n}`, tool: "shell", input: { command: `new-command-${n}` }, status: "completed", exit: 2 })
  }
  write(replacement)

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  const sent = fake.generated.at(-1).prompt
  assert.match(sent, /new-command-2/, "the replacement is read from its own start")
  assert.doesNotMatch(sent, /Steps up to/, "with no claim that any of it was analysed before")

  await cleanup?.()
})

test("a working session read by /retro is reported as read, not as unanalysed", async () => {
  // Measured live: a session that ended a turn (queued), was prompted again, and was then read
  // by `/retro` while working. The report said `extraction: not run` and `1 log not analysed
  // yet` — both false, in the file whose one job is to claim only what happened.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_returned"

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 9 }, data: { sessionID: session } })
  await tick()
  fake.emit({ type: "session.execution.started", durable: { seq: 10 }, data: { sessionID: session } })
  await tick()
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m2", prompt: { text: "and again" } })

  await fake.commands.get("retro").execute({ sessionID: session, prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "it was read")

  // The hand-over turn: a hook fires in the same session and the report is rewritten.
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "h1", tool: "read", input: { path: "x" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session, id: "h1", tool: "read", input: { path: "x" },
    status: "completed", result: { output: "x", metadata: {} },
  })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /extraction\s+not run/, "the analysis that just ran is not denied")
  assert.match(report, /ok\s+extraction/)
  assert.doesNotMatch(report, /not analysed yet/, "and a log read to its end is not called unanalysed")
  assert.match(report, /still working, read as far as they go/)

  await cleanup?.()
})

test("a log whose analysis failed is named as failed, not as not analysed yet", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await workSession(fake, "ses_bad")
  queue(directory, ["ses_bad"])

  const broken = fakeOpenCode({ directory, options: { model: MODEL }, reply: "not json at all" })
  const cleanup2 = await plugin.setup(broken.ctx)
  await broken.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /1 log whose analysis failed — tried again on the next `\/retro`/)
  assert.doesNotMatch(report, /not analysed yet/, "it was analysed; it failed")

  await cleanup2?.()
  await cleanup?.()
})

test("a successful read clears the failure the mark was carrying", async () => {
  // `failed` means "the last read of this log did not succeed and nothing settled it". A
  // settled failure, a live failure and a successful read after either used three different
  // views of that: only the live one set it, and a success never cleared it. The result was
  // one report saying `extraction: ok` and `1 log whose analysis failed` about the same log,
  // and the stock section crediting a failure that had already been recovered from.
  const directory = sandbox()
  const session = "ses_recovered"
  let calls = 0
  const fake = fakeOpenCode({
    directory,
    options: { model: MODEL },
    reply: () => (++calls === 1 ? "not json at all" : REPLY),
  })
  const cleanup = await plugin.setup(fake.ctx)

  await turn(fake, session, 1, "first-command")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 1, "the ended turn was read")
  assert.equal(savedState(directory).looked[session].failed, true, "and the failure is on the mark, not only in the counter")
  assert.match(readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8"), /analysis failed/)

  // The session is picked up again; the next read succeeds while it works.
  fake.emit({ type: "session.execution.started", durable: { seq: 40 }, data: { sessionID: session } })
  await tick()
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m40", prompt: { text: "carry on" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "c40", tool: "shell", input: { command: "again" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session,
    id: "c40",
    tool: "shell",
    input: { command: "again" },
    status: "completed",
    result: { output: { exit: 2, output: "no" }, metadata: { exit: 2 } },
  })

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "the new material was read")

  const mark = savedState(directory).looked[session]
  assert.equal(mark.failed, undefined, "a successful read is not still a failure")
  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /whose analysis failed/, "the report describes the last read, not the first")
  assert.match(report, /still working, read as far as they go/, "and the working session reads as read")

  await cleanup?.()
})

test("a log given up on after three attempts is not retried in the same command", async () => {
  // A live read increments the attempt count when the session already has a queue entry.
  // The third failure can therefore land on a live session, which sets `failed` and is never
  // retired by the settle branch (that branch only runs for an ended session). The next
  // command retires the entry — and then the queue scan saw the `failed` flag it had just
  // left behind, queued the session again, and spent a fourth model call on a log the same
  // report called "given up on".
  const directory = sandbox()
  const session = "ses_retired_twice"
  const writer = fakeOpenCode({ directory, options: { model: MODEL } })
  const stopWriter = await plugin.setup(writer.ctx)
  await workSession(writer, session)
  await stopWriter?.()
  const line = readFileSync(join(directory, ".retro", "sessions", `${session}.jsonl`), "utf8")
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({
      version: 1,
      rejected: [],
      extracted: {},
      sessions: 1,
      pending: [{ session, queuedAt: "now", attempts: 3, size: line.length }],
      looked: { [session]: { n: 0, size: line.length, failed: true } },
    }),
  )

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 0, "a retired entry costs nothing more")
  const state = savedState(directory)
  assert.deepEqual(state.pending, [], "it is out of the queue")
  assert.equal(state.extracted[session]?.ok, false, "with the failure recorded")
  assert.equal(state.looked[session]?.failed, undefined, "and no outstanding failure left to re-queue it")
  assert.match(fake.synthetic[0].text, /given up after three failed analyses/)

  await cleanup?.()
})

test("a read that never returns leaves the log owed, not marked as read", async () => {
  // Nothing is written to the mark until the answer is in. The bytes used to be recorded as
  // sent when the read started, so a process that died while the model was thinking left a
  // log that was neither read nor owed: `size` said sent, nothing had failed, and every later
  // command skipped it. The debt that started the read is still in the mark; leaving it alone
  // is what makes the crash recoverable.
  const directory = sandbox()
  const session = "ses_crash_read"
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  const statePath = join(directory, ".retro", "state.json")

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)

  const original = fake.ctx.session.generate
  let midway = null
  fake.ctx.session.generate = async (input) => {
    // What the process would leave behind if it stopped here.
    midway = existsSync(statePath) ? readFileSync(statePath, "utf8") : null
    return original(input)
  }

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1)
  assert.equal(
    midway === null ? 0 : (JSON.parse(midway).looked?.[session]?.size ?? 0),
    0,
    "the bytes are not marked as read until the answer arrives",
  )

  // The process died before the answer arrived.
  if (midway === null) rmSync(statePath, { force: true })
  else writeFileSync(statePath, midway)
  await cleanup?.()

  const after = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup2 = await plugin.setup(after.ctx)
  await after.commands.get("retro").execute({ sessionID: "ses_review2", prompt: { text: "" } })

  assert.equal(after.generated.length, 1, "the log the crash lost is read again, without it growing")
  await cleanup2?.()
})

test("a log that is still owed is not pruned by a decision", async () => {
  // Pruning is defined by three facts: nothing cites the log, nothing is owed for it, and the
  // session is not live. It consulted only citations and the queue — so a log whose mark said
  // "failed", or which had simply grown since it was last read, was deleted as though it had
  // been analysed. The next `/retro` would have read it; a `retro_decide` in another session
  // removed it first.
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "lessons", "a.md"),
    "---\nid: a\nstatement: problem a\ncost: 5\nrecurrence: 1\nconfidence: 1\nstatus: new\n---\n\nbody\n",
  )
  const record = (n) => JSON.stringify({ v: 1, n, t: n, k: "tool", id: `c${n}`, tool: "shell", input: { command: `c${n}` }, status: "completed" }) + "\n"
  const failed = join(directory, ".retro", "sessions", "ses_failed.jsonl")
  const grown = join(directory, ".retro", "sessions", "ses_grown.jsonl")
  const unread = join(directory, ".retro", "sessions", "ses_unread.jsonl")
  writeFileSync(failed, record(1))
  writeFileSync(grown, record(1) + record(2))
  writeFileSync(unread, record(1) + record(2) + record(3))
  const failedSize = statSync(failed).size
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({
      version: 1,
      rejected: [],
      extracted: {},
      sessions: 0,
      pending: [],
      looked: {
        ses_failed: { n: 0, size: failedSize, failed: true },
        ses_grown: { n: 0, size: 1 },
      },
    }),
  )

  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.tools.get("retro_decide").execute({ id: "a", status: "accepted" }, { sessionID: "ses_review" })

  for (const [path, why] of [
    [failed, "its last read failed"],
    [grown, "it has grown since it was read"],
    [unread, "nothing has ever read it"],
  ]) {
    assert.ok(existsSync(path), `${path.split("/").pop()} is still owed: ${why}`)
  }
  await cleanup?.()
})

test("a working session read by /retro is reported as read even when it was never queued", async () => {
  // The stock section only looked at the queue, so the most common live read — `/retro` in
  // the session it is running in, which has never ended and is therefore never queued — was
  // missing from the one line that is supposed to account for logs of working sessions.
  const directory = sandbox()
  const session = "ses_review_here"
  const fake = fakeOpenCode({ directory, options: { model: MODEL } })
  const cleanup = await plugin.setup(fake.ctx)

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)

  await fake.commands.get("retro").execute({ sessionID: session, prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "the invoking session's own log was read")
  assert.deepEqual(savedState(directory).pending, [], "and it was never queued, because it never ended")

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /still working, read as far as they go/, "the report accounts for it")
  assert.doesNotMatch(report, /not analysed yet/, "it was read")

  await cleanup?.()
})

test("a log given up on and then queued again is not reported as beyond reading", async () => {
  // A session kept open can be prompted again after its log was given up on, and its end
  // queues it again. The stock section looked only at the old outcome and announced that
  // "nothing will read" a log the queue was holding, next to the line saying it would be
  // tried again.
  const directory = sandbox()
  const session = "ses_revived"
  const writer = fakeOpenCode({ directory, options: { model: MODEL } })
  const stopWriter = await plugin.setup(writer.ctx)
  await workSession(writer, session)
  await stopWriter?.()
  const logSize = statSync(join(directory, ".retro", "sessions", `${session}.jsonl`)).size
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({
      version: 1,
      rejected: [],
      extracted: { [session]: { ok: false, detail: "given up after three failed analyses", size: logSize - 1 } },
      sessions: 1,
      pending: [{ session, queuedAt: "now", attempts: 0, size: logSize }],
      looked: {},
    }),
  )

  const fake = fakeOpenCode({ directory, options: { model: MODEL }, reply: "not json at all" })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /given up on after three failed analyses/, "it is queued, not given up on")
  assert.match(report, /whose analysis failed/, "what is true is that the latest attempt failed")
  await cleanup?.()
})

test("a re-read of a session that did work is analysed even when the new material is a reply alone", async () => {
  // A resumed turn, or a hand-over the user never typed, can produce an assistant reply with
  // no prompt of its own. The re-read slice keeps the session's old prompt and drops its old
  // tool calls, so it looked like one quiet exchange: the reply was settled as read without
  // being read. Whether the session ever did anything is a fact about the whole log.
  const directory = sandbox()
  const session = "ses_reply_only"
  const fake = fakeOpenCode({
    directory,
    options: { model: MODEL },
    reply: () => JSON.stringify({ lessons: [] }),
  })
  const cleanup = await plugin.setup(fake.ctx)

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)
  await fake.commands.get("retro").execute({ sessionID: session, prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "the whole session, the first time")

  fake.emit({
    type: "session.text.ended",
    durable: { seq: 30 },
    data: {
      sessionID: session,
      assistantMessageID: "m30",
      text: "I could not do that: the command does not exist in this repository.",
    },
  })
  await tick()

  await fake.commands.get("retro").execute({ sessionID: session, prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "the new reply is read, not skipped as one quiet exchange")
  assert.match(fake.generated.at(-1).prompt, /the command does not exist in this repository/)

  await cleanup?.()
})

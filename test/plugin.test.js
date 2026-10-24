import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import plugin from "../index.js"
import { fakeOpenCode as sharedFake } from "./fake-opencode.js"
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
function fakeOpenCode(options = {}) {
  return sharedFake({ defaultReply: REPLY, ...options })
}

const sandbox = () => {
  const directory = mkdtempSync(join(tmpdir(), "retro-plugin-"))
  writeFileSync(join(directory, "AGENTS.md"), "always run the lint skill\n")
  return directory
}

/** A session that did some work, so its shadow log has something to extract. */
/**
 * A log the plugin itself cannot read: lines that are not records.
 *
 * This is the failure the attempt counter is for — one the plugin *observes*, rather than
 * infers from silence. An order nobody answered is not one of these (analysis.md): the plugin
 * cannot tell a reader that died from one that was never started, so it reports the asking
 * and asks again instead of concluding anything about the log.
 */
function brokenLog(directory, session) {
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  writeFileSync(join(directory, ".retro", "sessions", `${session}.jsonl`), "this is not a record\nnor is this\n")
}

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

/**
 * The logs the plugin owes an analysis, computed the way it does (log.md, "Owed"): grown past
 * the mark, stopped at a gap, or failed with attempts left. There is no queue to read.
 */
const owed = (directory) => {
  const dir = join(directory, ".retro", "sessions")
  if (!existsSync(dir)) return []
  const looked = savedState(directory).looked ?? {}
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -6))
    .filter((id) => {
      const m = typeof looked[id] === "number" ? { size: looked[id] } : (looked[id] ?? {})
      return statSync(join(dir, `${id}.jsonl`)).size > (m.size ?? 0) || m.open || (m.failed && (m.attempts ?? 0) < 3)
    })
    .sort()
}

/** Make a log look unwritten for `days`, so the week-of-silence rule can be exercised. */
const age = (directory, session, days = 8) => {
  const t = Date.now() / 1000 - days * 86400
  utimesSync(join(directory, ".retro", "sessions", `${session}.jsonl`), t, t)
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
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)

  // Two commands, and that is the whole surface: one lesson, or all of them.
  assert.deepEqual([...fake.commands.keys()].sort(), ["retro", "retro-all"])
  assert.deepEqual([...fake.tools.keys()], ["retro_decide", "retro_record", "retro_propose"])
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
  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory })
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

  const fresh = fakeOpenCode({ directory })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fresh.generated.length, 1, "extraction ran")
  assert.match(fresh.generated[0].prompt, /shorter and straighter/, "through the seeded prompt")


  const [delivered] = fresh.synthetic
  assert.match(delivered.text, /# retro — `lint-skill-no-config`/)
  assert.match(delivered.text, /how to hand this over/, "the lead-in comes from the prompt file")
  assert.equal(fresh.orders[0].resume, true, "the work orders reach the agent, or nobody ever reads them")

  await cleanup?.()
  await cleanup2?.()
})

test("an edited propose prompt is what reaches the agent", async () => {
  const directory = sandbox()
  const first = fakeOpenCode({ directory })
  const seeded = await plugin.setup(first.ctx)
  await seeded?.()

  writeFileSync(join(directory, ".retro", "prompts", "propose.md"), "---\nprompt: propose\nbase: 1\n---\n\nMY OWN WORDING.\n")
  mkdirSync(join(directory, ".retro", "lessons"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "lessons", "l.md"),
    "---\nid: l\nstatement: something\ncost: 5\nrecurrence: 1\nconfidence: 1\nstatus: new\n---\n\nbody\n",
  )

  const fake = fakeOpenCode({ directory })
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

  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory })
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

  const fresh = fakeOpenCode({ directory })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  // The lesson's evidence points at this log, and review may ask what happened at those
  // steps, so the reference has to still resolve.
  assert.ok(existsSync(logPath), "the log outlives extraction while a lesson cites it")
  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /1 log kept in `sessions\/` because open lessons cite it/, "the report says why it is still there")

  await fresh.tools.get("retro_decide").execute({ id: "lint-skill-no-config", status: "accepted" })
  // Written moments ago, so the decision alone does not remove it: a log goes once nothing
  // open refers to it *and* it has been quiet for a week.
  assert.ok(existsSync(logPath), "a log written in the last week stays, decided or not")
  age(directory, session)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.ok(!existsSync(logPath), "and goes once nothing open refers to it and it has been quiet for a week")
  assert.doesNotMatch(
    readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8"),
    /because open lessons cite/,
    "and the report is recomputed rather than left stale",
  )

  await cleanup?.()
  await cleanup2?.()
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

  const fake = fakeOpenCode({ directory })
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

  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro-all").execute({ sessionID: "ses_x", prompt: { text: "" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /2 lessons waiting/)
  assert.match(delivered.text, /## 1\. `a`/, "highest score first")
  assert.match(delivered.text, /## 2\. `b`/)
  assert.match(delivered.text, /one plan/)
  await cleanup?.()
})

test("a log nobody could analyse does not hold up the logs behind it", async () => {
  // This is what a live run hit: one log came back as prose, and the queue stopped there.
  // The other logs were never read, and the message said to run `/retro` again — which
  // would have failed on the same log again.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)

  await workSession(fake, "ses_good")
  // A log the plugin cannot read at all, ahead of a good one.
  brokenLog(directory, "ses_bad")
  queue(directory, ["ses_bad", "ses_good"])

  const fresh = fakeOpenCode({ directory, reply: REPLY })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.deepEqual(analysed(fresh), ["ses_good"], "the log behind the failure was read")
  assert.equal(savedState(directory).looked.ses_bad.attempts, 1, "and the one that could not be read is counted")

  // Told once, in whichever hand-over the round produced: a failure found while the orders
  // are being written is reported with them, as soon as it is known.
  const told = [...fresh.orders, ...fresh.synthetic].map((d) => d.text).join("\n")
  assert.match(told, /`ses_bad`[^\n]*shadow log could not be parsed/)
  assert.match(told, /could not be parsed/, "the message says what went wrong")
  assert.match(told, /lint-skill-no-config/, "and the lesson from the log that worked is still delivered")

  await cleanup?.()
  await cleanup2?.()
})

/** One `/retro` by a fresh instance whose model answers with `reply`. */
async function retroWith(directory, reply, invoker = "ses_review") {
  const fake = fakeOpenCode({ directory, ...(reply === undefined ? {} : { reply }) })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: invoker, prompt: { text: "" } })
  await cleanup?.()
  return fake
}

test("a log that failed stays owed, and is tried again on the next command", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  brokenLog(directory, "ses_bad")

  await retroWith(directory)
  assert.ok(owed(directory).includes("ses_bad"), "still owed")
  assert.equal(savedState(directory).looked.ses_bad.attempts, 1, "and counted")

  await retroWith(directory)
  assert.equal(savedState(directory).looked.ses_bad.attempts, 2, "one more go, then it is given up on")

  await cleanup?.()
})

test("a session is given up on after three attempts, not billed forever", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  brokenLog(directory, "ses_bad")

  for (let i = 0; i < 3; i++) await retroWith(directory)
  assert.ok(!owed(directory).includes("ses_bad"), "not owed any more")
  assert.equal(savedState(directory).extracted.ses_bad.ok, false, "and the outcome says it failed")
  assert.match(savedState(directory).extracted.ses_bad.detail, /given up after three failed analyses/)
  assert.ok(existsSync(join(directory, ".retro", "sessions", "ses_bad.jsonl")), "the log stays until it is quiet")

  const fourth = await retroWith(directory)
  assert.equal(fourth.orders.length, 0, "a fourth command asks nothing of it")

  await cleanup?.()
})

test("the report is written from the first prompt, not once the session is over", async () => {
  // It used to say "Nothing measured yet" until a session ended, which made it stale for
  // exactly as long as somebody was working — the one time they would open it. Nothing in
  // the checks needs the session to be over: a hook fired, and the log has something
  // non-empty in it.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
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

test("a session still working is read, and owed the rest when it writes more", async () => {
  // `/retro` looks at everything accumulated to the moment it is run, which includes the
  // sessions that have not finished -- their friction is the most recent there is. Reading
  // one settles nothing it can still add to: the mark says how far it was read, and whatever
  // it writes next is owed. Its log is not removed, because it was written in the last week.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_working"

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.deepEqual(analysed(fake), [session], "it was read")
  const state = savedState(directory)
  assert.ok(!owed(directory).includes(session), "and owes nothing until it writes more")
  assert.ok(state.looked[session].size > 0, "how much of it was read is remembered")
  assert.ok(state.looked[session].n > 0, "and how far the lessons got, so the next read starts there")
  assert.equal(
    existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)),
    true,
    "and the log is still there, because it is still being written to",
  )

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /# retro — `lint-skill-no-config`/, "the lesson is handed over as any other")

  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m9", prompt: { text: "and now?" } })
  assert.ok(owed(directory).includes(session), "what it writes next is owed")

  await cleanup?.()
})

test("a second look at a session reads only what is new since the first", async () => {
  // This is how these sessions are actually used: left open and returned to, never finished.
  // So a log is read more than once, and without a mark `/retro` a fortnight later re-reads
  // all of it, pays for all of it, and re-derives the lessons that were already integrated.
  const directory = sandbox()
  // A parseable reply, because the mark only moves on success: a failed analysis must not
  // skip the material it failed on.
  const fake = fakeOpenCode({ directory })
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
  const first = fake.generated.at(-1)
  assert.match(first.prompt, /All of it is new/, "the whole session, the first time")
  assert.doesNotMatch(first.prompt, /Steps up to/, "and no claim that anything came before")
  assert.ok(
    first.records.some((r) => r.input?.command === "old early-1"),
    "and the log the order pointed at is the one with that work in it",
  )

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

  // The order no longer carries the log, so what it has to get right is the *scope*: which
  // steps have already become lessons, and therefore where the new material starts.
  assert.match(second, new RegExp(`Steps up to ${markAfterFirst} were analysed before`))
  assert.match(second, new RegExp(`step ${markAfterFirst + 1} onwards — that is what to report on`))
  assert.match(second, /Read the earlier steps too if you need them/, "the instructions are up there, and they say why")
  assert.ok(savedState(directory).looked[session].n > markAfterFirst, "and the mark moved on")

  await cleanup?.()
})

test("a working session is not read again until its log has grown", async () => {
  // The gate is size, not a clock. Re-reading the same bytes costs the same money for the
  // same answer, and it also settles the abandoned case: a log nobody will append to again
  // is read once and then left alone.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, reply: JSON.stringify({ lessons: [] }) })
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
    "and no lesson cites it, yet it is not pruned: it was written in the last week",
  )

  await cleanup?.()
})

test("a log read in part is read again without growing, and is not pruned first", async () => {
  // A reader that gets part way through a long log says so, and the rest stays owed. The
  // hazard the mark has to avoid is the growth gate: the whole file was there to be read, so
  // by size the log looks finished, and a successful analysis would then prune a file most of
  // which nobody read. The next command must read it again even though nothing was appended.
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

  // A subagent that reads twenty steps past the mark each time and reports how far it got.
  const fake = fakeOpenCode({
    directory,
    reply: ({ prompt }) => {
      const from = Number((prompt.match(/Steps up to (\d+) were analysed before/) ?? [])[1] ?? 0)
      return { answer: JSON.stringify({ lessons: [] }), through: Math.min(from + 20, 102) }
    },
  })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 1, "the log was read")
  const mark = savedState(directory).looked[session]
  assert.equal(mark.open, true, "and what is left is remembered")
  assert.equal(mark.n, 20, "the mark follows what the reader said it read, not the file's length")
  assert.ok(existsSync(logPath), "a log with unread steps is not pruned as finished work")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 2, "read again without a single byte being appended")
  assert.ok(
    savedState(directory).looked[session].n > mark.n,
    "and it got further than the first read, so the gap is being worked through",
  )

  // And it keeps going, command after command, until the whole log has been covered. This
  // also crosses the failure-retry budget, which a successful partial read must not spend:
  // the log is being read, just not in one go.
  for (let i = 0; i < 20 && savedState(directory).looked[session]?.open; i++) {
    age(directory, session)
    await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
    if (savedState(directory).looked[session]?.open) assert.ok(existsSync(logPath), "never pruned while part of it is owed")
  }
  assert.ok(!existsSync(logPath), "the log was finished and only then pruned")

  await cleanup?.()
})

test("a log left behind by a server that stopped is read like any other", async () => {
  // A server that stops takes its sessions with it, so no end event ever arrives. When the
  // plugin's view of a session was a memory of its start and end, such a log sat on disk for
  // ever: never analysed, never removed. Owed is computed from the file, so nothing waits for
  // an end that will never come.
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  writeFileSync(
    join(directory, ".retro", "sessions", "ses_orphan.jsonl"),
    [
      JSON.stringify({ v: 1, n: 1, t: 1, k: "prompt", text: "fix the lint skill" }),
      JSON.stringify({ v: 1, n: 2, t: 2, k: "tool", id: "c1", tool: "shell", input: { command: "npx eslint ." }, status: "completed", exit: 2 }),
    ].join("\n") + "\n",
  )

  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory })
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
  // It used to be marked extracted the moment the read threw, so `/retro` said it had
  // analysed a session and found nothing to learn, about a log it had never opened, and the
  // log was closed for good instead of retried. A directory where the file should be is the
  // cheapest log that is listed and cannot be read.
  const directory = sandbox()
  mkdirSync(join(directory, ".retro", "sessions", "ses_vanished.jsonl"), { recursive: true })

  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /opencode-retro on `ses_vanished`/)
  assert.match(delivered.text, /shadow log could not be read/, "with the reason, not a shrug")
  assert.doesNotMatch(delivered.text, /nothing to learn/, "it learned nothing because it read nothing")
  assert.equal(fake.generated.length, 0, "and spent nothing on a log that was not there")

  const state = savedState(directory)
  assert.ok(owed(directory).includes("ses_vanished"), "still owed — a failed extraction keeps its log")
  assert.equal(state.looked.ses_vanished.attempts, 1, "and the attempt is counted towards the cap")
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

  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_x", prompt: { text: "all" } })

  assert.match(fake.synthetic[0].text, /lesson waiting/, "typing `/retro all` reviews everything")
  await cleanup?.()
})

test("a review costs nothing beyond the analysis itself", async () => {
  // The free checks run every time; asking the model whether it answers is a call nobody
  // requested, and the analysis answers that question on its own.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory })
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

  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory, options: { keepSessions: true } })
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

  const fresh = fakeOpenCode({ directory, options: { keepSessions: true } })
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

  const fake = fakeOpenCode({ directory, options: { proposeLimit: 2 } })
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
  const writer = fakeOpenCode({ directory })
  const stopWriter = await plugin.setup(writer.ctx)
  await writer.hooks.get("session.prompt")({ sessionID: "ses_quiet", messageID: "m1", prompt: { text: "hello" } })
  await workSession(writer, "ses_busy")
  await stopWriter?.()

  const fake = fakeOpenCode({ directory, options: { extractLimit: 1 } })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 1, "one model call, as the limit says")
  assert.deepEqual(analysed(fake), ["ses_busy"], "and it was spent on the session with something in it")
  assert.ok(!owed(directory).includes("ses_quiet"), "the one exchange was settled without a call")
  assert.ok(existsSync(join(directory, ".retro", "sessions", "ses_quiet.jsonl")), "and kept while it is recent")
  age(directory, "ses_quiet")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(existsSync(join(directory, ".retro", "sessions", "ses_quiet.jsonl")), false, "then released")

  await cleanup?.()
})

test("extractLimit caps what one command analyses and leaves the rest owed", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, options: { extractLimit: 1 } })
  const cleanup = await plugin.setup(fake.ctx)

  await workSession(fake, "ses_one")
  await workSession(fake, "ses_two")

  const fresh = fakeOpenCode({ directory, options: { extractLimit: 1 } })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fresh.generated.length, 1, "one log, one call")
  assert.equal(owed(directory).filter((id) => id.startsWith("ses_t") || id.startsWith("ses_o")).length, 1, "the other is still owed")
  assert.match(fresh.synthetic[0].text, /1 log not analysed yet/, "said even when a proposal was found")

  await cleanup?.()
  await cleanup2?.()
})

test("a finished session is owed an analysis, and the report proves the hooks ran", async () => {
  // The end-of-session trigger is the plugin's whole capture pipeline: verify the hooks,
  // count the session. Until now every test wrote state.json by hand, so
  // handleEvent — the one function that turns traffic into work — was never executed.
  const directory = sandbox()
  const session = "ses_ended"
  const fake = fakeOpenCode({ directory })
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
  assert.deepEqual(owed(directory), [session], "the finished session is owed an analysis")
  assert.equal(state.sessions, 1, "and the session counter moved, which freshness is measured against")

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /verified\s+\d{4}-\d{2}-\d{2}/, "the end-of-session trigger is proven, not assumed")
  assert.match(report, /ok\s+prompt hook\s+1 prompt seen/)
  assert.match(report, /ok\s+tool hook\s+1 tool-call event seen, 1 reached the hook/)
  assert.match(report, /ok\s+shadow log\s+sessions\/ses_ended\.jsonl, \d+ entries/)
  assert.match(report, /ok\s+trigger\s+session\.execution\.succeeded/)
  assert.match(report, /waiting; `\/retro` analyses it/)

  // A duplicate end event must not count the same session twice.
  fake.emit({ type: "session.execution.succeeded", data: { sessionID: session } })
  await tick()
  const again = savedState(directory)
  assert.equal(again.sessions, 1)
  assert.deepEqual(owed(directory), [session])
  await cleanup?.()
})

test("events the hooks never received are reported as a dead hook, with numbers", async () => {
  // Decision 19's measured failure: a renamed hook registers happily and never fires. The
  // event stream and the hook are two independent paths to the same fact, and only the
  // comparison can name which one broke.
  const directory = sandbox()
  const session = "ses_drift"
  const fake = fakeOpenCode({ directory })
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
  assert.match(report, /BROKEN\s+tool hook\s+2 tool-call events seen, 1 reached the hook/)
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
  const fake = fakeOpenCode({ directory })
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
  assert.ok(!owed(directory).includes(child), "and it is never owed an analysis of its own")
  await cleanup?.()
})

test("a delegation inside a delegation is folded into the root when the links arrive out of order", async () => {
  // A subagent can spawn one of its own. The leaf's link to the middle may be learned before
  // the middle is known to be a child of the root, so the leaf is absorbed into the middle's
  // log first and has to move again when the middle is adopted. Neither the middle nor the
  // leaf is a session: no log of its own is left, neither is queued, and neither moves the
  // freshness counter even though both ends were processed before the links were known.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
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
  assert.deepEqual(owed(directory).filter((id) => id === leaf || id === middle).sort(), [leaf, middle].sort())
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
  assert.ok(!owed(directory).some((id) => id === leaf || id === middle), "neither delegation is owed an analysis")
  assert.equal(state.sessions, 0, "and neither ages a lesson")

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
  // An execution is one turn, and a session left open is prompted again. What it writes in
  // the second turn is owed because the log grew, and the read starts where the first one
  // stopped, so the steps already turned into lessons are not paid for twice.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_twice"

  await turn(fake, session, 1, "first-command")
  assert.deepEqual(owed(directory), [session])

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1)
  const mark = savedState(directory).looked[session].n
  assert.ok(mark > 0, "the first turn was turned into lessons")

  await turn(fake, session, 2, "second-command")
  const after = savedState(directory)
  assert.ok(owed(directory).includes(session), "the second turn is owed an analysis too")
  assert.equal(after.sessions, 1, "but a second turn is not a second session")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "and it was read")

  const second = fake.generated.at(-1)
  assert.match(second.prompt, new RegExp(`Steps up to ${mark} were analysed before`))
  assert.match(second.prompt, new RegExp(`step ${mark + 1} onwards — that is what to report on`))
  assert.ok(
    second.records.some((r) => r.input?.command === "second-command"),
    "and the log it points at has the new work in it",
  )

  await cleanup?.()
})

test("a session picked up again is read while its second turn is running, and its log is kept", async () => {
  // Reading a session in the middle of a turn settles nothing it can still add to: what it
  // writes after the read is owed, and its log is not pruned while it is being written.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
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

  assert.equal(fake.generated.length, 1, "it is read")
  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m21", prompt: { text: "and more" } })
  assert.ok(owed(directory).includes(session), "what it wrote after the read is owed")
  assert.ok(
    existsSync(join(directory, ".retro", "sessions", `${session}.jsonl`)),
    "and its log is still there, because it is still being written to",
  )

  await cleanup?.()
})

test("a log smaller than its mark is read again, not mistaken for already read", async () => {
  // A pruned log that the session writes again starts at step 1 and is shorter. `size` only
  // ever moves forward, so a mark that outlived its file made the new one look already read.
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

  age(directory, session)
  const fake = fakeOpenCode({ directory, reply: JSON.stringify({ lessons: [] }) })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "the orphan log was read")
  assert.ok(!existsSync(logPath), "and pruned, because nothing cites it and it is quiet")

  // The same session is written again, with a shorter log and its own numbering.
  write([
    { v: 1, n: 1, t: 9, k: "prompt", text: "new instruction" },
    { v: 1, n: 2, t: 10, k: "tool", id: "new", tool: "shell", input: { command: "new-command" }, status: "completed", exit: 2 },
  ])

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "a log shorter than the mark is new material, not old news")
  const reread = fake.generated.at(-1)
  assert.match(reread.prompt, /All of it is new/, "read from its own start, not from the old mark")
  assert.ok(reread.records.some((r) => r.input?.command === "new-command"))
  assert.ok(!reread.records.some((r) => r.input?.command === "old-command"), "the old log is gone")

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

  const fake = fakeOpenCode({ directory })
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
  const fresh = fake.generated.at(-1)
  assert.match(fresh.prompt, /All of it is new/, "from its own start")
  assert.ok(fresh.records.some((r) => r.input?.command === "new-command"))

  await cleanup?.()
})

test("an unanswered round on a resumed session leaves the new turn owed", async () => {
  // The second turn was asked about and nothing came back. Nothing is concluded from that
  // (analysis.md): the mark is left where it was, which is exactly what keeps the turn owed,
  // and the next command asks again. It used to be recorded as a failed read of the log, with
  // the size mark moved so the bytes were not paid for twice — and then three such rounds
  // retired a log that nobody had ever read.
  const directory = sandbox()
  const session = "ses_retried"
  let calls = 0
  const fake = fakeOpenCode({
    directory,
    reply: () => (++calls === 1 ? REPLY : "I cannot answer that."),
  })
  const cleanup = await plugin.setup(fake.ctx)

  await turn(fake, session, 1, "first-command")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "the first turn was analysed")
  const afterFirst = savedState(directory).looked[session].n

  await turn(fake, session, 2, "second-command")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "the second turn was asked about")

  assert.ok(owed(directory).includes(session), "and it is still owed")
  const mark = savedState(directory).looked[session]
  assert.equal(mark.n, afterFirst, "the mark did not move: the second turn was not read")
  assert.ok(!mark.attempts, "and nothing was held against the log")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 3, "asked again rather than the entry disappearing")

  await cleanup?.()
})

test("a session whose creation we never saw is not counted, queued or reported on", async () => {
  // The event stream reaches every session in the project, and plugins load lazily: a
  // worktree session created before this instance started still reaches us when it ends.
  // The ingest refuses to open a log without a hook, but the end branch did not, so it
  // queued a log that does not exist, moved the freshness counter, and rewrote
  // selfcheck.md as BROKEN prompt hook about somebody else's healthy session.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
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
  // discarded the session's end event, so the session was never counted or verified.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
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

  assert.equal(savedState(directory).sessions, 1, "its end still reaches us")
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
  const fake = fakeOpenCode({ directory })
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

  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory })
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
  const fake = fakeOpenCode({ directory, options: { heartbeatMs: 0 } })
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
  assert.match(report, /not exercised\s+tool hook\s+2 tool-call events seen, 1 reached the hook — so far/)

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

test("a session that turns out to be a subagent is not analysed on its own", async () => {
  // Its end can be processed before the link is known: `session.created` is missed when the
  // plugin loads lazily, leaving the parent's `subagent` result as the only route. A
  // delegation is a step in its parent's task, so there is nothing of its own to analyse.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  const child = "ses_child"
  const parent = "ses_parent"

  await fake.hooks.get("session.prompt")({ sessionID: child, messageID: "m1", prompt: { text: "you are a subagent" } })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 5 }, data: { sessionID: child } })
  await tick()
  assert.ok(owed(directory).includes(child), "owed, as far as we knew")

  // The parent's own tool result reveals the link.
  await fake.hooks.get("tool.execute.after")({
    sessionID: parent,
    id: "c1",
    tool: "subagent",
    input: { agent: "explore", description: "look around", prompt: "go" },
    status: "completed",
    result: { output: "done", metadata: { sessionID: child } },
  })

  assert.ok(!owed(directory).includes(child), "and then it is not a session to analyse")
  assert.equal(savedState(directory).sessions, 0, "nor a session freshness should age by")
  assert.equal(existsSync(join(directory, ".retro", "sessions", `${child}.jsonl`)), false, "its log went to the parent")

  await cleanup?.()
})

test("a failed read is owed, and tried again on the next command", async () => {
  // The size mark alone hid it: the next command saw "nothing new", and nothing ever looked at
  // the log again. A failure is owed now, while attempts are left — whether or not the session
  // is still working, which the plugin no longer needs to know — and a restart changes nothing.
  const directory = sandbox()
  const session = "ses_failed"
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  // A log the plugin cannot parse: the failure it observes itself, not one it infers.
  brokenLog(directory, session)

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  const mark = savedState(directory).looked[session]
  assert.ok(mark.size > 0, "the bytes read are recorded")
  assert.equal(mark.failed, true, "and so is the debt")
  assert.equal(mark.open, undefined, "which is a failure, not an unread gap")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(savedState(directory).looked[session].attempts, 2, "tried again on the next command, without growing")

  // The plugin restarts in between; the debt is on disk, not in this process's memory.
  await cleanup?.()
  const after = fakeOpenCode({ directory })
  const cleanup2 = await plugin.setup(after.ctx)
  // The log is readable again, as it would be if whatever broke it had been put right.
  writeFileSync(
    join(directory, ".retro", "sessions", `${session}.jsonl`),
    [
      { v: 1, n: 1, t: 1, k: "prompt", text: "do a thing" },
      { v: 1, n: 2, t: 2, k: "tool", id: "c1", tool: "shell", input: { command: "npx eslint ." }, status: "completed", exit: 2 },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  )
  await after.commands.get("retro").execute({ sessionID: "ses_review2", prompt: { text: "" } })

  assert.equal(after.generated.length, 1, "a restart forgets nothing about what is owed")
  assert.equal(savedState(directory).extracted[session]?.ok, true, "and the read that works settles it")
  assert.equal(savedState(directory).looked[session].failed, undefined)

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
  const fake = fakeOpenCode({ directory })
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
  const sent = fake.generated.at(-1)
  assert.match(sent.prompt, /All of it is new/, "from its own start")
  assert.doesNotMatch(sent.prompt, /Steps up to/, "with no claim that any of it was analysed before")
  assert.ok(sent.records.some((r) => r.id === "new-1"))

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
  const fake = fakeOpenCode({ directory, reply })
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
  const fake = fakeOpenCode({ directory })
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
  // A crash between counting the third failure and recording the outcome leaves a mark at
  // three attempts with no outcome: not owed, and — without this — never reported either.
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
      looked: { ses_crashed: { n: 0, size: line.length, failed: true, attempts: 3 } },
    }),
  )
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const state = savedState(directory)
  assert.ok(!owed(directory).includes("ses_crashed"), "not owed")
  assert.equal(state.extracted.ses_crashed?.ok, false, "with its failure recorded")
  assert.match(fake.synthetic[0].text, /ses_crashed.*given up after three failed analyses/, "and said out loud")
  assert.equal(fake.generated.length, 0, "without spending anything on it")
  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /1 log the plugin could not read three times/, "and the stock section names it")

  await cleanup?.()
})

test("a read that got no further than the mark is reported, not settled as done", async () => {
  // How far a log was read is the reader's to report, and a reader that says it got no
  // further than the steps already analysed has read nothing new. Taking that as an answer
  // would mark the whole file read while the new material never reached anyone — so it is a
  // failed attempt, counted, and the log stays owed.
  const directory = sandbox()
  const session = "ses_no_progress"
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  const logPath = join(directory, ".retro", "sessions", `${session}.jsonl`)
  writeFileSync(
    logPath,
    [
      { v: 1, n: 1, t: 1, k: "prompt", text: "fix the lint trap" },
      { v: 1, n: 2, t: 2, k: "tool", id: "c1", tool: "shell", input: { command: "npx eslint ." }, status: "completed", exit: 2 },
      { v: 1, n: 3, t: 3, k: "tool", id: "c2", tool: "shell", input: { command: "npx eslint --fix ." }, status: "completed", exit: 2 },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  )

  const first = fakeOpenCode({ directory, reply: REPLY })
  const cleanup = await plugin.setup(first.ctx)
  await first.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(savedState(directory).looked[session].n, 3, "the first read covered the file")
  assert.ok(!owed(directory).includes(session))

  appendFileSync(logPath, JSON.stringify({ v: 1, n: 4, t: 4, k: "tool", id: "c3", tool: "shell", input: { command: "npx eslint ." }, status: "completed", exit: 2 }) + "\n")
  appendFileSync(logPath, JSON.stringify({ v: 1, n: 5, t: 5, k: "text", text: "THE NEW MATERIAL" }) + "\n")

  // The subagent answers, but says it read only as far as step 3 — which is the mark.
  const stuck = fakeOpenCode({ directory, reply: { answer: REPLY, through: 3 } })
  const cleanup2 = await plugin.setup(stuck.ctx)
  await stuck.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const state = savedState(directory)
  assert.equal(state.looked[session].n, 3, "the mark does not move")
  assert.ok(owed(directory).includes(session), "the unread material stays owed")
  assert.equal(state.looked[session].attempts, 1, "the attempt is counted, so it cannot loop for ever")
  assert.ok(!state.looked[session].open, "and it is not mistaken for a partial read with progress in it")
  assert.ok(existsSync(logPath), "the log is kept for the retry")
  await cleanup?.()
  await cleanup2?.()
})

test("/retro all reports a log it could not read, as well as the plan", async () => {
  // The single hand-over has always carried the failure; the batch path built its message
  // from the open lessons alone, so a log that failed simply vanished from the one command
  // most likely to be used on a backlog. Silence about a failure is the failure this plugin
  // exists to prevent, so both commands say it.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)

  await workSession(fake, "ses_good")
  brokenLog(directory, "ses_bad")
  queue(directory, ["ses_bad", "ses_good"])

  const fresh = fakeOpenCode({ directory, reply: REPLY })
  const cleanup2 = await plugin.setup(fresh.ctx)
  await fresh.commands.get("retro-all").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.deepEqual(analysed(fresh), ["ses_good"], "the good log is analysed")
  const told = [...fresh.orders, ...fresh.synthetic].map((d) => d.text).join("\n")
  assert.match(told, /`ses_bad`[^\n]*shadow log could not be parsed/, "the failure is named")
  assert.match(told, /could not be parsed/, "with what went wrong")
  assert.match(told, /lint-skill-no-config/, "and the plan still arrives")

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
  const fake = fakeOpenCode({ directory, reply })
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

test("a log with no parseable record is reported as a failure, not as a clean analysis", async () => {
  // The log is only created by writing a record to it, so a present file with nothing
  // parseable in it was corrupted, truncated or written by something else. It used to reach
  // the extractor as an empty record list, which answered "one exchange, nothing done" and
  // settled the log: a clean report about material nobody could read.
  const directory = sandbox()
  const session = "ses_garbled"
  mkdirSync(join(directory, ".retro", "sessions"), { recursive: true })
  writeFileSync(join(directory, ".retro", "sessions", `${session}.jsonl`), "this is not a shadow log\nnor is this\n")

  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const [delivered] = fake.synthetic
  assert.match(delivered.text, /opencode-retro on `ses_garbled`/)
  assert.match(delivered.text, /could not be parsed/, "with the reason")
  assert.doesNotMatch(delivered.text, /nothing to learn/, "not a clean analysis of a file it could not read")
  assert.equal(fake.generated.length, 0, "and no model call is spent on it")

  const state = savedState(directory)
  assert.equal(state.looked[session].attempts, 1, "it stays owed and counted")
  assert.ok(owed(directory).includes(session))
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
  const fake = fakeOpenCode({ directory, reply: REPLY })
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
  const sent = fake.generated.at(-1)
  assert.ok(
    sent.records.some((r) => r.input?.command === "new-command-2"),
    "the replacement is the log that gets read",
  )
  assert.match(sent.prompt, /All of it is new/, "from its own start")
  assert.doesNotMatch(sent.prompt, /Steps up to/, "with no claim that any of it was analysed before")

  await cleanup?.()
})

test("a working session read by /retro is reported as read, not as unanalysed", async () => {
  // Measured live: a session that ended a turn (queued), was prompted again, and was then read
  // by `/retro` while working. The report said `extraction: not run` and `1 log not analysed
  // yet` — both false, in the file whose one job is to claim only what happened.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
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
  assert.doesNotMatch(
    readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8"),
    /not analysed yet/,
    "a log read to its end is not called unanalysed — not even for the hand-over written into it",
  )

  // The hand-over turn: a hook fires in the same session and the report is rewritten.
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "h1", tool: "read", input: { path: "x" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session, id: "h1", tool: "read", input: { path: "x" },
    status: "completed", result: { output: "x", metadata: {} },
  })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /extraction\s+not run/, "the analysis that just ran is not denied")
  assert.match(report, /ok\s+extraction/)

  await cleanup?.()
})

test("a log read in part stays read in part after the hand-over wrote into it", async () => {
  // Measured live: `/retro` read a long log as an excerpt, wrote "nothing to learn (from an
  // excerpt…)" and then delivered a hand-over into the same session. The hand-over grew the
  // log past the mark, and the stock line fell back to "not analysed yet" — exactly what
  // selfcheck.md's own invariant says it must not do. The unreached gap is the reason it is
  // owed; later growth does not make the part already read disappear.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  const session = "ses_partial"
  await workSession(fake, session)

  const file = join(directory, ".retro", "sessions", `${session}.jsonl`)
  const size = statSync(file).size
  writeFileSync(
    join(directory, ".retro", "state.json"),
    JSON.stringify({
      version: 2,
      rejected: [],
      extracted: {},
      sessions: 1,
      looked: { [session]: { n: 1, size: size - 1, open: true } },
      counted: { [session]: true },
      anonymous: 0,
      uncounted: [],
    }),
  )
  // A second instance reads the state written above; state is read at setup, so the first
  // one still holds the empty copy it loaded.
  const reader = fakeOpenCode({ directory })
  const cleanup2 = await plugin.setup(reader.ctx)
  await reader.hooks.get("session.prompt")({ sessionID: session, messageID: "m2", prompt: { text: "more" } })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /1 log read in part/, "the excerpt is named as an excerpt")
  assert.doesNotMatch(report, /not analysed yet/, "not as a log nobody has opened")

  await cleanup2?.()
  await cleanup?.()
})

test("a log asked about with no answer is named as that, not as not analysed yet", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  await workSession(fake, "ses_bad")
  queue(directory, ["ses_bad"])

  // Asked twice with nothing coming back. The report says that, and not a verdict about the
  // log — which is all the plugin knows, and the opposite of what it used to claim.
  await retroWith(directory, "not json at all")
  await retroWith(directory, "not json at all")

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /1 log asked about with no answer, up to 2 times/)
  assert.match(report, /Nothing is wrong with the logs themselves/)
  assert.doesNotMatch(report, /given up/, "nothing was given up on")

  await cleanup?.()
})

test("a successful read clears the failed-read flag the mark was carrying", async () => {
  // `failed` means "the last read of this log did not succeed and nothing settled it". A
  // settled failure, a live failure and a successful read after either used three different
  // views of that: only the live one set it, and a success never cleared it. The result was
  // one report saying `extraction: ok` and `1 log whose analysis failed` about the same log,
  // and the stock section crediting a failure that had already been recovered from.
  const directory = sandbox()
  const session = "ses_recovered"
  const fake = fakeOpenCode({ directory, reply: REPLY })
  const cleanup = await plugin.setup(fake.ctx)

  // A log the plugin cannot parse: the failure it observes itself and does count.
  brokenLog(directory, session)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(savedState(directory).looked[session].failed, true, "the failure is on the mark, not only in the counter")
  assert.match(readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8"), /the plugin could not read/)

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
  assert.equal(fake.generated.length, 1, "the new material was read — the first read never got that far")

  const mark = savedState(directory).looked[session]
  assert.equal(mark.failed, undefined, "a successful read is not still a failure")
  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /the plugin could not read/, "the report describes the last read, not the first")

  await cleanup?.()
})

test("a log given up on after three attempts is not retried in the same command", async () => {
  // A mark at three failed attempts is retired by the next command — and the scan for owed
  // logs must not then see the `failed` flag it had just left behind and spend a fourth model
  // call on a log the same report calls "given up on".
  const directory = sandbox()
  const session = "ses_retired_twice"
  const writer = fakeOpenCode({ directory })
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
      looked: { [session]: { n: 0, size: line.length, failed: true, attempts: 3 } },
    }),
  )

  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  assert.equal(fake.generated.length, 0, "a retired entry costs nothing more")
  const state = savedState(directory)
  assert.ok(!owed(directory).includes(session), "it is not owed")
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
  const fake = fakeOpenCode({ directory })
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

  const after = fakeOpenCode({ directory })
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

  const fake = fakeOpenCode({ directory })
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

test("the plugin's own hand-over does not make a log owed", async () => {
  // `/retro` writes its hand-over into the log of the session it runs in. Counted as growth,
  // every command left its own session "not analysed yet" in the report, and the next command
  // paid a read only to skip it.
  const directory = sandbox()
  const session = "ses_review_here"
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  await workSession(fake, session)

  await fake.commands.get("retro").execute({ sessionID: session, prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "the invoking session's own log was read")
  const records = parseShadowLog(readFileSync(join(directory, ".retro", "sessions", `${session}.jsonl`), "utf8"))
  assert.equal(records.at(-1).k, "handover", "the hand-over is in its log")
  assert.ok(!owed(directory).includes(session), "and does not make it owed")
  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /not analysed yet/, "so the report does not call it unread")

  await fake.hooks.get("session.prompt")({ sessionID: session, messageID: "m9", prompt: { text: "yes, do it" } })
  assert.ok(owed(directory).includes(session), "what the session does next is owed")

  await cleanup?.()
})

test("a log given up on and then grown is not reported as beyond reading", async () => {
  // A session kept open can be prompted again after its log was given up on, and what it
  // writes is owed. The stock section looked only at the old outcome and announced that
  // "nothing will read" a log that was about to be read, next to the line saying it would be
  // tried again.
  const directory = sandbox()
  const session = "ses_revived"
  const writer = fakeOpenCode({ directory })
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
      looked: { [session]: { n: 0, size: logSize - 1 } },
    }),
  )

  const fake = fakeOpenCode({ directory, reply: "not json at all" })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /could not read three times/, "it is owed, not given up on")
  assert.match(report, /not analysed yet/, "what is true is that the new material is still owed")
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
    reply: () => JSON.stringify({ lessons: [] }),
  })
  const cleanup = await plugin.setup(fake.ctx)

  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await workSession(fake, session)
  // From another session, so the reply below answers the person's prompt, not a hand-over.
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
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

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "the new reply is read, not skipped as one quiet exchange")
  assert.ok(
    fake.generated.at(-1).records.some((r) => /the command does not exist in this repository/.test(r.text ?? "")),
    "and it is in the log the order points at",
  )

  await cleanup?.()
})

test("a reply to the plugin's own hand-over, with nothing done, is not owed an analysis", async () => {
  // Found by a stranger's run: `/retro` with nothing to review still resumes the agent, which
  // answers. Counted as material, that answer cost a call on the next command, whose own
  // hand-over was answered in turn — a call per `/retro`, spent on the plugin talking to
  // itself, and "1 log not analysed yet" in the report for ever.
  const directory = sandbox()
  const session = "ses_reviewing"
  const fake = fakeOpenCode({ directory, reply: () => JSON.stringify({ lessons: [] }) })
  const cleanup = await plugin.setup(fake.ctx)
  await workSession(fake, session)
  await fake.commands.get("retro").execute({ sessionID: session, prompt: { text: "" } })
  assert.equal(fake.generated.length, 1)

  // The agent answers the hand-over, and does nothing else.
  fake.emit({
    type: "session.text.ended",
    durable: { seq: 40 },
    data: { sessionID: session, assistantMessageID: "m40", text: "Nothing to review — the sessions went straight." },
  })
  await tick()
  await fake.commands.get("retro").execute({ sessionID: session, prompt: { text: "" } })
  await fake.commands.get("retro").execute({ sessionID: session, prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "no call is spent on the agent relaying the plugin's own message")

  // A tool call after a hand-over is work, and is read: checking a lesson can turn up friction.
  await fake.hooks.get("tool.execute.before")({ sessionID: session, id: "r1", tool: "shell", input: { command: "ls" } })
  await fake.hooks.get("tool.execute.after")({
    sessionID: session, id: "r1", tool: "shell", input: { command: "ls" }, status: "completed",
    result: { output: { exit: 0, output: "x" }, metadata: { exit: 0 } },
  })
  await fake.commands.get("retro").execute({ sessionID: session, prompt: { text: "" } })
  assert.equal(fake.generated.length, 2, "work done after a hand-over is still read")

  await cleanup?.()
})

test("a log written in the last seven days is not pruned, whatever else is true of it", async () => {
  // Read to its end, cited by nothing, owed nothing — and still kept, because it was written
  // this week. That is the whole of what makes pruning safe without knowing whether a session
  // is working: a session that writes keeps its log.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, reply: JSON.stringify({ lessons: [] }) })
  const cleanup = await plugin.setup(fake.ctx)
  await workSession(fake, "ses_recent")
  const logPath = join(directory, ".retro", "sessions", "ses_recent.jsonl")

  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(fake.generated.length, 1, "read to its end")
  assert.ok(!owed(directory).includes("ses_recent"), "owing nothing")
  assert.ok(existsSync(logPath), "and kept, because it was written this week")

  age(directory, "ses_recent", 6)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.ok(existsSync(logPath), "six days is not a week")

  age(directory, "ses_recent", 8)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.ok(!existsSync(logPath), "eight days is")
  assert.equal(savedState(directory).looked.ses_recent, undefined, "and its mark goes with it")

  await cleanup?.()
})

test("a log nobody has read is kept, however old", async () => {
  // Pruning is cleanup of what has been read, never a substitute for reading it: a user who
  // runs `/retro` once a month must not find the month gone.
  const directory = sandbox()
  const writer = fakeOpenCode({ directory })
  const stop = await plugin.setup(writer.ctx)
  await workSession(writer, "ses_unread")
  await stop?.()
  age(directory, "ses_unread", 60)

  // A decision prunes without analysing anything — the one path that could take it unread.
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.tools.get("retro_decide").execute({ id: "no-such-lesson", status: "accepted" }, { sessionID: "ses_review" })
  assert.ok(existsSync(join(directory, ".retro", "sessions", "ses_unread.jsonl")), "two months old and still there")
  assert.ok(owed(directory).includes("ses_unread"), "because it is owed")

  await cleanup?.()
})

test("a log given up on goes once it has been quiet for seven days", async () => {
  // A log the plugin could never read is kept for a look, and named in the self-check — but
  // not for ever, or `sessions/` fills with transcripts nothing will read.
  const directory = sandbox()
  const fake = fakeOpenCode({ directory })
  const cleanup = await plugin.setup(fake.ctx)
  brokenLog(directory, "ses_hopeless")
  for (let i = 0; i < 3; i++) await retroWith(directory)
  assert.equal(savedState(directory).extracted.ses_hopeless.ok, false, "given up on")
  const logPath = join(directory, ".retro", "sessions", "ses_hopeless.jsonl")
  assert.ok(existsSync(logPath), "and kept while it is recent")

  age(directory, "ses_hopeless")
  await retroWith(directory)
  assert.ok(!existsSync(logPath), "then pruned like any other")

  await cleanup?.()
})

test("a session picked up after its log was pruned is read from the start of its new log", async () => {
  const directory = sandbox()
  const fake = fakeOpenCode({ directory, reply: JSON.stringify({ lessons: [] }) })
  const cleanup = await plugin.setup(fake.ctx)
  await turn(fake, "ses_back", 1, "first-command")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  age(directory, "ses_back")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.ok(!existsSync(join(directory, ".retro", "sessions", "ses_back.jsonl")), "pruned after a quiet week")

  await turn(fake, "ses_back", 2, "second-command")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  const read = fake.generated.at(-1)
  assert.ok(read.records.some((r) => r.input?.command === "second-command"), "the new log is read")
  assert.doesNotMatch(read.prompt, /were analysed before/, "from its own start, not from the old file's mark")

  await cleanup?.()
})

test("a restart forgets nothing about what is owed", async () => {
  // What is owed is on disk — the log and its mark — so a process that dies with work
  // outstanding leaves nothing to reconstruct.
  const directory = sandbox()
  const writer = fakeOpenCode({ directory })
  const stop = await plugin.setup(writer.ctx)
  await workSession(writer, "ses_before_restart")
  await stop?.()

  const after = await retroWith(directory, undefined)
  assert.deepEqual(analysed(after), ["ses_before_restart"], "the new process reads what the old one wrote")
})

test("two instances on one project neither lose nor prune each other's work", async () => {
  // A second server on the same `.retro/` used to be a documented limit: it did not know which
  // of the other's sessions were working, and could settle and prune a log being written. With
  // the disk as the only state there is nothing for one instance to know about the other.
  const directory = sandbox()
  const a = fakeOpenCode({ directory })
  const b = fakeOpenCode({ directory })
  const stopA = await plugin.setup(a.ctx)
  const stopB = await plugin.setup(b.ctx)

  await turn(a, "ses_on_a", 1, "first-command")
  await b.commands.get("retro").execute({ sessionID: "ses_on_b", prompt: { text: "" } })
  assert.deepEqual(analysed(b), ["ses_on_a"], "B reads A's session")
  assert.ok(existsSync(join(directory, ".retro", "sessions", "ses_on_a.jsonl")), "and does not prune it")

  await turn(a, "ses_on_a", 2, "second-command")
  await b.commands.get("retro").execute({ sessionID: "ses_on_b", prompt: { text: "" } })
  const second = b.generated.at(-1)
  assert.ok(second.records.some((r) => r.input?.command === "second-command"), "what A wrote next is read")
  assert.match(second.prompt, /were analysed before/, "from where B's first read stopped")

  // A saves its own view of the state; B's marks survive it.
  await a.hooks.get("session.prompt")({ sessionID: "ses_other", messageID: "x", prompt: { text: "hi" } })
  a.emit({ type: "session.execution.succeeded", durable: { seq: 99 }, data: { sessionID: "ses_other" } })
  await tick()
  assert.ok(savedState(directory).looked.ses_on_a?.n > 0, "and B's mark survives A's save")

  await stopA?.()
  await stopB?.()
})


test("a plugin reloaded in the middle of a turn does not call the prompt hook dead", async () => {
  // Measured by a stranger: editing `opencode.json` mid-session, as the README suggests when
  // something is not working, reloads the plugin. The new instance never saw the turn's
  // prompt, counted tool calls and no prompt, and reported BROKEN prompt hook — about a session
  // whose log had its prompt at step 1.
  const directory = sandbox()
  const session = "ses_reloaded"
  const before = fakeOpenCode({ directory })
  const stopBefore = await plugin.setup(before.ctx)
  await before.hooks.get("session.prompt")({ sessionID: session, messageID: "m1", prompt: { text: "do it" } })
  before.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: session } })
  await tick()
  await stopBefore?.()

  const after = fakeOpenCode({ directory })
  const stopAfter = await plugin.setup(after.ctx)
  await after.hooks.get("tool.execute.before")({ sessionID: session, id: "c1", tool: "shell", input: { command: "x" } })
  after.emit({ type: "session.tool.called", durable: { seq: 2 }, data: { sessionID: session, id: "c1", input: { command: "x" } } })
  await after.hooks.get("tool.execute.after")({
    sessionID: session, id: "c1", tool: "shell", input: { command: "x" }, status: "completed",
    result: { output: { exit: 0, output: "ok" }, metadata: { exit: 0 } },
  })
  after.emit({ type: "session.execution.succeeded", durable: { seq: 3 }, data: { sessionID: session } })
  await tick()

  const report = readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /BROKEN/, "nothing is broken")
  assert.match(report, /prompt hook\s+the plugin was loaded after this turn began/)

  // And a turn this instance did see begin, with no prompt, is still called what it is.
  after.emit({ type: "session.execution.started", durable: { seq: 4 }, data: { sessionID: session } })
  await tick()
  await after.hooks.get("tool.execute.before")({ sessionID: session, id: "c2", tool: "shell", input: { command: "y" } })
  await after.hooks.get("tool.execute.after")({
    sessionID: session, id: "c2", tool: "shell", input: { command: "y" }, status: "completed",
    result: { output: { exit: 0, output: "ok" }, metadata: { exit: 0 } },
  })
  after.emit({ type: "session.execution.succeeded", durable: { seq: 5 }, data: { sessionID: session } })
  await tick()
  assert.match(readFileSync(join(directory, ".retro", "selfcheck.md"), "utf8"), /BROKEN\s+prompt hook/)

  await stopAfter?.()
})


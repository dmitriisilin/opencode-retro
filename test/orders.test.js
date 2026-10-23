import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { parseFrontmatter } from "../src/frontmatter.js"
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
/** The first order path a hand-over listed, relative to the project. */
const path0 = ({ paths }) => paths[0]

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

/**
 * `/retro`, with the test playing the agent: what it delivered, and the orders it issued.
 *
 * A round that issues nothing delivers a proposal instead, so this counts the hand-overs
 * before the command rather than reading the last one — which is how a stale list of paths
 * was once read as the current round's and made a real give-up look like a loop.
 */
async function retro(fake, { invoker = "ses_review", all = false } = {}) {
  const before = fake.orders.length
  await fake.commands.get(all ? "retro-all" : "retro").execute({ sessionID: invoker, prompt: { text: "" } })
  const issued = fake.orders.length > before ? fake.orders.at(-1) : null
  const handover = issued?.text ?? fake.synthetic.at(-1)?.text ?? ""
  return { handover, paths: [...handover.matchAll(/^- `([^`]+)`$/gm)].map((m) => m[1]) }
}

const record = (fake, session, lessons, invoker = "ses_review_sub") =>
  fake.tools.get("retro_record").execute({ session, lessons }, { sessionID: invoker })
const propose = (fake, all = false, invoker = "ses_review") =>
  fake.tools.get("retro_propose").execute({ all }, { sessionID: invoker })

test("/retro issues a work order per owed log and asks the agent to analyse them", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await work(fake, "ses_b")
  const { handover, paths } = await retro(fake)

  assert.equal(paths.length, 2, `one order per owed log, got ${paths.join(", ")}`)
  assert.match(handover, /Start one subagent per work order/)
  assert.match(handover, /retro_record/, "and the tool each one answers with")
  assert.match(handover, /call `retro_propose`/, "and what to do when they are in")
  assert.match(handover, /Do not read the work orders yourself/, "the agent reading them itself defeats the point")

  for (const path of paths) {
    const order = readFileSync(join(dir, path), "utf8")
    assert.match(order, /^<!-- opencode-retro work order -->/)
    const session = (order.match(/^id: (ses_[ab])$/m) ?? [])[1]
    assert.ok(session, "each order names the session it is about")
    // It points at the log rather than carrying it: reading is the subagent's job.
    assert.match(order, new RegExp(`^log: ${logOf(dir, session)}$`, "m"))
    assert.ok(existsSync(logOf(dir, session)), "at a file that is really there")
    assert.doesNotMatch(order, /npx eslint \./, "and no rendering of the log in the order itself")
  }

  // Nothing is proposed in the same breath: the lessons do not exist yet.
  assert.deepEqual(fake.synthetic, [], "the only thing delivered is the hand-over about the orders")
  await cleanup?.()
})

test("the plugin never calls a model itself", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  // The surface the plugin is allowed to need. `session.create`, `session.generate` and
  // `generate.text` are not on it, and the fake throws from the one it still offers.
  const { REQUIRED_SURFACE } = await import("../src/selfcheck.js")
  for (const [domain, member] of REQUIRED_SURFACE) {
    assert.notEqual(`${domain}.${member}`, "generate.text")
    assert.notEqual(`${domain}.${member}`, "session.generate")
    assert.notEqual(`${domain}.${member}`, "session.create")
  }
  assert.equal(fake.ctx.session.create, undefined, "no session of our own is created")
  assert.equal(fake.ctx.session.generate, undefined)

  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await record(fake, "ses_a", [LESSON])
  const handed = await propose(fake)

  assert.equal(paths.length, 1)
  assert.match(handed.content, /lint skill/i, "a whole analysis, with no model call in it")
  await cleanup?.()
})

test("a record moves the mark to what the order asked for", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  const order = state(dir).orders.ses_a
  assert.ok(order.lastN > 0, "the order says how much there is to read")
  assert.equal(state(dir).looked?.ses_a?.n ?? 0, 0, "and the mark has not moved yet")

  await record(fake, "ses_a", [LESSON])

  const mark = state(dir).looked.ses_a
  assert.equal(mark.n, order.lastN, "a record with no `through` answered the order in full")
  assert.ok(!mark.open, "so nothing of it is left owed")
  assert.equal(mark.size, order.size)
  assert.equal(state(dir).orders.ses_a.done, "answered", "and the order is closed, so it cannot be answered twice")
  await cleanup?.()
})

test("a record with no order behind it is refused", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const first = await record(fake, "ses_a", [LESSON])
  assert.equal(first.output.ok, false, "nothing was asked about this session")
  assert.match(first.output.detail, /no work order is open/)
  assert.equal(existsSync(join(dir, ".retro", "lessons")), false, "and nothing is written")

  // And the same answer twice over: the second call is refused rather than counted again.
  await retro(fake)
  await record(fake, "ses_a", [LESSON])
  const again = await record(fake, "ses_a", [LESSON])
  assert.equal(again.output.ok, false)
  const { recurrence } = JSON.parse(
    JSON.stringify(parseFrontmatter(readFileSync(join(dir, ".retro", "lessons", `${LESSON.id}.md`), "utf8")).data),
  )
  assert.equal(recurrence, 1, "a repeated record is not a second session")
  await cleanup?.()
})

test("a record for a log replaced since its order is refused", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)

  // Somebody restored the log from a backup: the file under that id is a different session
  // now, and the answer in hand is about the one that is gone.
  writeFileSync(
    logOf(dir, "ses_a"),
    [
      { v: 1, n: 1, t: 1, k: "prompt", text: "a different task entirely" },
      { v: 1, n: 2, t: 2, k: "tool", id: "r1", tool: "shell", input: { command: "make" }, status: "completed", exit: 2 },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  )

  const result = await record(fake, "ses_a", [LESSON])
  assert.equal(result.output.ok, false)
  assert.match(result.output.detail, /was replaced since its order was written/)
  assert.match(result.output.detail, /asked for again/, "and says what happens next")
  assert.equal(existsSync(join(dir, ".retro", "lessons", `${LESSON.id}.md`)), false, "no lesson from a log nobody read")

  const { paths } = await retro(fake)
  assert.deepEqual(paths.map((p) => p.split("/").pop()), ["ses_a.md"], "the new log is asked about from its start")
  await cleanup?.()
})

test("a record with no lessons settles the log as read", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  const result = await record(fake, "ses_a", [])

  assert.equal(result.output.ok, true, "an empty answer is an answer")
  assert.match(result.output.detail, /nothing to learn/)
  assert.ok(state(dir).looked.ses_a.n > 0, "the log was read")
  assert.ok(!state(dir).looked.ses_a.failed, "and not charged as a failure")

  const { paths } = await retro(fake)
  assert.deepEqual(paths, [], "so it is not asked about again")
  await cleanup?.()
})

test("an order nobody answered is a failed attempt, and the log is asked for again", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const first = await retro(fake)
  assert.equal(first.paths.length, 1)
  assert.equal(existsSync(join(dir, path0(first))), true, "the order is on disk while it is open")

  // The agent never started a subagent, or they all died. The next command settles the round.
  const second = await retro(fake)
  const mark = state(dir).looked.ses_a
  assert.equal(mark.failed, true)
  assert.equal(mark.attempts, 1, "one attempt spent, two left")
  assert.equal(second.paths.length, 1, "and the log is asked about again")
  assert.equal(
    readdirSync(join(dir, ".retro", "work")).length,
    1,
    "the stale order is replaced, not piled up beside the new one",
  )
  await cleanup?.()
})

test("a log is given up on after three unanswered orders, not asked for forever", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  for (let i = 0; i < 3; i++) await retro(fake)

  // The fourth command settles the third failure and gives up rather than asking again.
  const last = await retro(fake)
  assert.deepEqual(last.paths, [], "nothing more is asked about it")
  assert.match(last.handover, /given up after three failed analyses/, "and the human is told, in the hand-over")
  assert.equal(state(dir).extracted.ses_a.ok, false)
  assert.equal(existsSync(logOf(dir, "ses_a")), true, "the log stays until it is quiet (log.md, Retired)")
  await cleanup?.()
})

test("retro_propose hands over the top lesson once the records are in", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  await record(fake, "ses_a", [
    LESSON,
    { id: "cheap-one", statement: "A smaller problem.", steps: [2, 2], cost: 1, confidence: 0.5, why: "once" },
  ])

  const handed = await propose(fake)
  assert.match(handed.content, new RegExp(LESSON.id), "the highest-scoring lesson, not the first one recorded")
  assert.doesNotMatch(handed.content, /cheap-one/, "one invocation, one lesson")
  assert.match(handed.content, /retro_decide/, "with the bookkeeping the agent is to do after")
  await cleanup?.()
})

test("retro_propose for all delivers the plan", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const { handover } = await retro(fake, { all: true })
  assert.match(handover, /`retro_propose` with `all: true`/, "the batch is remembered across the round")

  await record(fake, "ses_a", [
    LESSON,
    { id: "cheap-one", statement: "A smaller problem.", steps: [2, 2], cost: 1, confidence: 0.5, why: "once" },
  ])
  const handed = await propose(fake, true)

  assert.match(handed.content, new RegExp(LESSON.id))
  assert.match(handed.content, /cheap-one/, "every waiting lesson, as one plan")
  await cleanup?.()
})

test("the plugin's own analysis is not logged as the user's work", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const { paths } = await retro(fake)

  // The agent does what the hand-over asked, with the hooks firing as they would live: it
  // delegates to a subagent with the order's path, and the subagent answers. None of it is
  // the user's work, and a log of it would be read by the next analysis as if it were.
  const sub = "ses_review_sub1"
  const delegation = { sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `opencode-retro work order: read ${paths[0]} and do what it says.` } }
  await fake.hooks.get("tool.execute.before")(delegation)
  await fake.hooks.get("session.prompt")({ sessionID: sub, messageID: "ms1", prompt: { text: `read ${paths[0]}` } })
  await fake.hooks.get("tool.execute.before")({ sessionID: sub, id: "r1", tool: "read", input: { filePath: paths[0] } })
  await fake.hooks.get("tool.execute.after")({ sessionID: sub, id: "r1", tool: "read", input: { filePath: paths[0] }, status: "completed", result: { output: "the order" } })
  await fake.hooks.get("tool.execute.after")({ ...delegation, status: "completed", result: { output: "done", metadata: { sessionID: sub } } })
  for (const tool of ["retro_record", "retro_propose"]) {
    const call = { sessionID: "ses_review", id: `t_${tool}`, tool, input: {} }
    await fake.hooks.get("tool.execute.before")(call)
    await fake.hooks.get("tool.execute.after")({ ...call, status: "completed", result: { output: "ok" } })
  }

  assert.equal(existsSync(logOf(dir, sub)), false, "the subagent has no log of its own")
  const records = readFileSync(logOf(dir, "ses_review"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.deepEqual(
    records.map((r) => r.k),
    ["handover"],
    "the only thing logged is the instruction the plugin itself wrote (log.md): no delegation, " +
      "no read of the order, none of our own tool calls",
  )
  // And it says which hand-over it was. Both read identically otherwise, and the extraction
  // contract discounts work that reviews a lesson it was handed.
  assert.equal(records[0].about, "work")
  await cleanup?.()
})

test("a record that arrives after its round was closed is still recorded", async () => {
  // Calling `retro_propose` is how the agent says the analyses are done, so an order still
  // open then is charged as a failed attempt — the plugin cannot tell a subagent that died
  // from one still reading. Which makes calling it early possible, and it must not destroy
  // the work: the reading happened, only the reporting was late.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  await propose(fake) // too early: the subagent has not reported yet
  assert.equal(state(dir).looked.ses_a.attempts, 1, "the round was closed and the attempt charged")

  const result = await record(fake, "ses_a", [LESSON])
  assert.equal(result.output.ok, true, result.output.detail)
  assert.match(result.output.detail, /after the round was closed/)
  assert.match(result.output.detail, /attempt is given back/)

  const mark = state(dir).looked.ses_a
  assert.ok(!mark.failed, "the failure is withdrawn: the log was read after all")
  assert.ok(!mark.attempts, "and the attempt it was charged is not held against it")
  assert.ok(mark.n > 0, "and the mark follows the order it answered")
  assert.equal(existsSync(join(dir, ".retro", "lessons", `${LESSON.id}.md`)), true)

  // Once is once, though: the same answer again is still refused.
  assert.equal((await record(fake, "ses_a", [LESSON])).output.ok, false)
  await cleanup?.()
})

test("a record is refused once its log was replaced, even if its round is still closeable", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  await propose(fake)
  writeFileSync(
    logOf(dir, "ses_a"),
    JSON.stringify({ v: 1, n: 1, t: 1, k: "prompt", text: "a different task entirely" }) + "\n",
  )

  const result = await record(fake, "ses_a", [LESSON])
  assert.equal(result.output.ok, false)
  assert.match(result.output.detail, /was replaced since its order was written/)
  await cleanup?.()
})

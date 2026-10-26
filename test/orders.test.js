import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { parseFrontmatter } from "../src/frontmatter.js"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import plugin from "../index.js"
import { fakeOpenCode } from "./fake-opencode.js"

// The report's times are the reader's local time (selfcheck.md); these tests spell them out in
// UTC, so they read in UTC whatever zone the machine running them is in.
process.env.TZ = "UTC"

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

/**
 * A subagent's answer. `through` is required of a real one, so it is sent by default as the
 * whole log the order asked for; `through: null` is a reader that did not say how far it got.
 */
const record = (fake, session, lessons, { through, dir, invoker = "ses_review_sub" } = {}) => {
  const ordered = () => {
    try {
      return state(dir).orders?.[session]?.lastN ?? 0
    } catch {
      return 0 // no state.json yet: nothing was ever ordered, which the plugin will say
    }
  }
  const claim = through === undefined ? (dir ? ordered() : 0) : through
  return fake.tools
    .get("retro_record")
    .execute({ session, lessons, ...(claim === null ? {} : { through: claim }) }, { sessionID: invoker })
}
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
    // Absolute, so it opens from wherever the subagent happens to be.
    assert.ok(isAbsolute(path), `the hand-over names the order absolutely: ${path}`)
    const order = readFileSync(path, "utf8")
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
  await record(fake, "ses_a", [LESSON], { dir })
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

  await record(fake, "ses_a", [LESSON], { dir })

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
  const first = await record(fake, "ses_a", [LESSON], { dir })
  assert.equal(first.output.ok, false, "nothing was asked about this session")
  assert.match(first.output.detail, /no work order is open/)
  assert.equal(existsSync(join(dir, ".retro", "lessons")), false, "and nothing is written")

  // And the same answer twice over: the second call is refused rather than counted again.
  await retro(fake)
  await record(fake, "ses_a", [LESSON], { dir })
  const again = await record(fake, "ses_a", [LESSON], { dir })
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

  const result = await record(fake, "ses_a", [LESSON], { dir })
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
  const result = await record(fake, "ses_a", [], { dir })

  assert.equal(result.output.ok, true, "an empty answer is an answer")
  assert.match(result.output.detail, /nothing to learn/)
  assert.ok(state(dir).looked.ses_a.n > 0, "the log was read")
  assert.ok(!state(dir).looked.ses_a.failed, "and not charged as a failure")

  const { paths } = await retro(fake)
  assert.deepEqual(paths, [], "so it is not asked about again")
  await cleanup?.()
})

test("an order nobody answered is reported and asked again, not held against the log", async () => {
  // The plugin does not know whether anybody came. A hand-over into a session that is still
  // working waits in its inbox, so nothing is started and nothing spent; a reader that tried
  // and could not record looks identical from here. So nothing is concluded about the log —
  // the mark is left exactly as it was, which is what keeps it owed.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const first = await retro(fake)
  assert.equal(first.paths.length, 1)
  assert.equal(existsSync(path0(first)), true, "the order is on disk while it is open")

  // The agent never started a subagent, or they all died. The next command settles the round.
  const second = await retro(fake)
  const mark = state(dir).looked.ses_a ?? {}
  assert.ok(!mark.failed, "the log is not marked as having failed a read")
  assert.ok(!mark.attempts, "and nothing is spent against it")
  assert.ok(!mark.n, "the mark has not moved: none of it was read")
  assert.equal(second.paths.length, 1, "and the log is asked about again")
  assert.equal(
    readdirSync(join(dir, ".retro", "work")).length,
    1,
    "the stale order is replaced, not piled up beside the new one",
  )
  assert.match(state(dir).extracted.ses_a.detail, /asked 1 time and no record came back/)
  await cleanup?.()
})

test("a log asked about many times is never given up on for it, and says how many", async () => {
  // Guessing here picked the wrong cause: three rounds of nobody-came retired a perfectly
  // readable log under the words "given up after three failed analyses", when no analysis had
  // been attempted at all. What the plugin knows is how many times it asked, so that is what
  // it reports — and the person reading it draws the conclusion.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  for (let i = 0; i < 5; i++) await retro(fake)

  const last = await retro(fake)
  assert.equal(last.paths.length, 1, "still asked about, however many times it has been asked")
  assert.match(state(dir).extracted.ses_a.detail, /asked 5 times and no record came back/)
  assert.match(last.handover, /asked 5 times/, "and the hand-over says so, rather than a verdict")
  assert.doesNotMatch(last.handover, /given up/)
  assert.equal(existsSync(logOf(dir, "ses_a")), true)
  await cleanup?.()
})

test("the askings start again when the log grows, because the new material was never asked about", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  await retro(fake)
  assert.match(state(dir).extracted.ses_a.detail, /asked 1 time/)

  await work(fake, "ses_a")
  await retro(fake)
  await retro(fake)
  assert.match(state(dir).extracted.ses_a.detail, /asked 1 time/, "the count is about this material")
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
  ], { dir })

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
  ], { dir })
  const handed = await propose(fake, true)

  assert.match(handed.content, new RegExp(LESSON.id))
  assert.match(handed.content, /cheap-one/, "every waiting lesson, as one plan")
  await cleanup?.()
})

/*
 * The plugin's own work (analysis.md): a reader's session is not logged; everything else is,
 * marked by the hand-overs around it, and is not new material.
 */

async function roundIn(fake, dir, { worded = true } = {}) {
  // The agent does what the hand-over asked, with the hooks firing as they would live: it
  // delegates to a subagent, the subagent reads its order and records, the agent proposes.
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const sub = "ses_review_sub1"
  const line = worded ? `opencode-retro work order: read ${paths[0]} and do what it says.` : `Have a look at ${paths[0]}`
  const delegation = { sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: line } }
  await fake.hooks.get("tool.execute.before")(delegation)
  await fake.hooks.get("session.prompt")({ sessionID: sub, messageID: "ms1", prompt: { text: line } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: sub, parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.before")({ sessionID: sub, id: "r1", tool: "read", input: { filePath: paths[0] } })
  await fake.hooks.get("tool.execute.after")({ sessionID: sub, id: "r1", tool: "read", input: { filePath: paths[0] }, status: "completed", result: { output: "the order" } })
  await record(fake, "ses_a", [], { dir })
  await fake.hooks.get("tool.execute.after")({ ...delegation, status: "completed", result: { output: "done", metadata: { sessionID: sub } } })
  const call = { sessionID: "ses_review", id: "t_propose", tool: "retro_propose", input: {} }
  await fake.hooks.get("tool.execute.before")(call)
  await propose(fake)
  await fake.hooks.get("tool.execute.after")({ ...call, status: "completed", result: { output: "ok" } })
  return { sub, records: readFileSync(logOf(dir, "ses_review"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) }
}

test("a round of the plugin's own is logged, and a log grown by nothing else takes no order", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  const { sub, records } = await roundIn(fake, dir)

  assert.equal(existsSync(logOf(dir, sub)), false, "a reader given the line has no log at all")
  assert.equal(records[0].k, "handover")
  assert.equal(records[0].about, "work", "the round opens with the work hand-over")
  const tools = records.filter((r) => r.k === "tool").map((r) => r.tool)
  assert.ok(tools.includes("subagent") && tools.includes("retro_propose"), `the round is in the log as it happened: ${tools}`)
  assert.ok(!records.some((r) => r.tool === "read"), "but nothing of the reader's")
  assert.ok(records.some((r) => r.k === "handover" && r.about !== "work"), "and it closes with the next hand-over")

  const { paths } = await retro(fake)
  assert.ok(!paths.some((path) => path.includes("ses_review")), "a log grown by nothing but a round takes no order")
  await cleanup?.()
})

test("a reworded reader is folded into the person's log inside the round", async () => {
  // Not recognised by the line, it is an ordinary child, and goes where every subagent does —
  // inside the stretch the order tells the next reader to leave out.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  const { sub, records } = await roundIn(fake, dir, { worded: false })

  assert.equal(existsSync(logOf(dir, sub)), false, "no log of its own")
  const read = records.find((r) => r.k === "tool" && r.tool === "read")
  assert.ok(read, "its work is in the person's log")
  const { ownRounds } = await import("../src/extract.js")
  assert.ok(ownRounds(records).steps.has(read.n), "inside the round: " + records.map((r) => `${r.n}:${r.k}:${r.about ?? r.tool ?? ""}`).join(" "))
  await cleanup?.()
})

test("the order tells the reader where the plugin's own work is and to leave it out", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await roundIn(fake, dir)
  // The person goes on working in the session the round ran in, so its log is owed.
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "mx", prompt: { text: "now fix the build" } })
  await work(fake, "ses_review")
  const { paths } = await retro(fake, { invoker: "ses_other" })
  const order = readFileSync(paths.find((path) => path.includes("ses_review")), "utf8")
  assert.match(order, /The plugin's own work — leave it out/)
  const { ownRounds, formatRanges } = await import("../src/extract.js")
  const logged = readFileSync(logOf(dir, "ses_review"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const named = formatRanges(ownRounds(logged).ranges)
  assert.ok(named.length > 0)
  assert.ok(order.includes(`describe: ${named}.`), `the order names exactly the plugin's own steps: ${named}`)
  assert.match(order, /asks for a round of this plugin's own/, "and the rule that says what a round is")
  await cleanup?.()
})

test("a record that arrives after its round was closed is still recorded", async () => {
  // Calling `retro_propose` is how the agent says the analyses are done, so an order still
  // open then is closed as unanswered. Which makes calling it early possible, and it must not
  // destroy the work: the reading happened, only the reporting was late.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  await propose(fake) // too early: the subagent has not reported yet
  assert.match(state(dir).extracted.ses_a.detail, /no record came back/, "the round was closed")
  assert.ok(!(state(dir).looked.ses_a ?? {}).n, "and nothing was concluded about the log")

  const result = await record(fake, "ses_a", [LESSON], { dir })
  assert.equal(result.output.ok, true, result.output.detail)
  assert.match(result.output.detail, /after the round was closed/)

  const mark = state(dir).looked.ses_a
  assert.ok(!mark.failed)
  assert.ok(mark.n > 0, "and the mark follows the order it answered")
  assert.equal(existsSync(join(dir, ".retro", "lessons", `${LESSON.id}.md`)), true)

  // Once is once, though: the same answer again is still refused.
  assert.equal((await record(fake, "ses_a", [LESSON], { dir })).output.ok, false)
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

  const result = await record(fake, "ses_a", [LESSON], { dir })
  assert.equal(result.output.ok, false)
  assert.match(result.output.detail, /was replaced since its order was written/)
  await cleanup?.()
})

test("a record that does not say how far it read leaves the log unread", async () => {
  // Saying how far it got is the reader's job, and the schema requires it — nothing else
  // knows. So silence cannot mean "read it all": that is the one failure that loses material
  // without anybody noticing. The lessons are kept, because they are real; the log is not
  // marked read, and the next command asks about it again.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  const result = await record(fake, "ses_a", [LESSON], { through: null, dir })

  assert.equal(result.output.ok, true, "the answer is kept")
  assert.match(result.output.detail, /did not say how far it read/)
  assert.match(result.output.detail, /asked about again/)
  assert.equal(existsSync(join(dir, ".retro", "lessons", `${LESSON.id}.md`)), true, "the lesson is real and is written")

  const mark = state(dir).looked.ses_a
  assert.ok(!mark.n, "but the step mark does not move")
  assert.equal(mark.open, true, "and the log is owed now, not when it next grows")

  const { paths } = await retro(fake)
  assert.deepEqual(paths.map((p) => p.split("/").pop()), ["ses_a.md"], "so it is asked about again")
  assert.match(fake.orders.at(-1).text, /ses_a/)
  await cleanup?.()
})

test("a record must say how far it read, because nothing else knows", async () => {
  const { RECORD_INPUT } = await import("../src/contract.js")
  assert.ok(RECORD_INPUT.required.includes("through"), "OpenCode refuses a record without it")
  assert.ok(RECORD_INPUT.required.includes("session"))
  assert.ok(RECORD_INPUT.required.includes("lessons"))
})

test("the proposal retro_propose returns is written into the session's log", async () => {
  // Found by a live run. `retro_propose` hands its text back as a tool result — the agent
  // asked for it — so nothing was sent and nothing was logged, and the review session's log
  // showed the work-order hand-over, then the agent reading files and running commands to
  // check a lesson, then its verdict, with nothing saying a lesson had been handed over.
  //
  // The contract tells an analysis that work after a `handover` with `about: "lesson"` is the
  // review of that lesson and not the problem happening again. With no such record the rule
  // can never fire, and the review is read as friction of its own — which the friction bench
  // had already caught once from the other end, when a review added a session and 19 steps of
  // cost to the lesson it was checking.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  await record(fake, "ses_a", [LESSON], { dir })
  const handed = await propose(fake)

  const records = readFileSync(logOf(dir, "ses_review"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
  assert.deepEqual(
    records.filter((r) => r.k === "handover").map((r) => r.about),
    ["work", "lesson"],
    "the round asked for the analyses, and then a lesson was handed over",
  )
  const proposal = records.find((r) => r.about === "lesson")
  assert.ok(proposal.text.includes(LESSON.id), "with what was handed over, so the review reads as a review")
  assert.equal(proposal.text, handed.content, "the same text the agent was given")

  // And it is logged, not sent: the agent already has it as the tool's result.
  assert.deepEqual(fake.synthetic.filter((s) => s.via === undefined), [], "nothing was delivered twice")
  await cleanup?.()
})

test("talking about work orders does not stop a session being logged", async () => {
  // Pre-release review: recognising the plugin's own subagents matched any text containing
  // `.retro/work/` or the mark, and a match marks a session as ours for good — every later
  // prompt and tool call of it dropped from the log. A person who asked their own agent what
  // was in `.retro/work/` silently stopped being logged from that moment.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_user")
  await retro(fake) // an order is open now, so the path exists to be talked about
  await fake.hooks.get("session.prompt")({
    sessionID: "ses_user",
    messageID: "m9",
    prompt: { text: "why is there an opencode-retro work order in .retro/work/ses_user.md?" },
  })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_user", id: "c9", tool: "read", input: { path: "x" } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_user", id: "c9", tool: "read", input: { path: "x" }, status: "completed", result: { output: "ok" } })

  const records = readFileSync(logOf(dir, "ses_user"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.ok(records.some((r) => r.k === "prompt" && /why is there/.test(r.text)), "the question is logged")
  assert.ok(records.some((r) => r.k === "tool" && r.id === "c9"), "and so is the work after it")
  await cleanup?.()
})

test("a fresh session given the prescribed line is recognised as the plugin's own reader", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({
    sessionID: "ses_reader",
    messageID: "r1",
    prompt: { text: `opencode-retro work order: read ${paths[0]} and do what it says.` },
  })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reader", id: "r1", tool: "read", input: { path: paths[0] } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_reader", id: "r1", tool: "read", input: { path: paths[0] }, status: "completed", result: { output: "x" } })

  assert.equal(existsSync(logOf(dir, "ses_reader")), false, "the reader leaves no log of its own")
  await cleanup?.()
})

test("only a lesson is logged as a lesson hand-over", async () => {
  // Pre-release review: "nothing to review" and a failed command's message were both logged as
  // `about: "lesson"`, and the contract tells an analysis that work after a lesson hand-over is
  // the review of that lesson. Real friction after "nothing to review" would have been
  // discounted as the review of a lesson nobody was handed.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  await record(fake, "ses_a", [], { dir }) // the session went straight
  await propose(fake) // so there is nothing to review

  const kinds = readFileSync(logOf(dir, "ses_review"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((r) => r.k === "handover")
    .map((r) => r.about)
  assert.deepEqual(kinds, ["work", "notice"], "a request for analyses, then a notice — no lesson was handed over")
  await cleanup?.()
})

test("every report of how many times a log was asked names the same number", async () => {
  // Pre-release scan: in the same moment state.json and the hand-over said "asked 1 time" and
  // the self-check said "up to 2 times" — it counted the order issued a moment ago, which
  // nobody has had the chance to answer yet. One fact, two counts.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  for (let round = 1; round <= 4; round++) {
    await retro(fake)
    if (round === 1) continue // nothing has gone unanswered yet
    const silent = round - 1
    const times = `${silent} time${silent === 1 ? "" : "s"}`
    assert.match(state(dir).extracted.ses_a.detail, new RegExp(`asked ${times} and no record came back`))
    assert.match(fake.orders.at(-1).text, new RegExp(`asked ${times}`))
    const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, silent === 1 ? /1 log asked about with no answer —/ : new RegExp(`up to ${silent} times`), `round ${round}`)
  }
  await cleanup?.()
})

/**
 * An accepted lesson, then a second session's log written by hand with real timestamps, and a
 * reader citing `steps` from it. Returns what `retro_record` said and whether the lesson came
 * back. Each record is `[n, minutes from the decision]`: negative is before the fix, positive
 * after it.
 */
async function citeAgainstDecision(records, steps, { after = [], through } = {}) {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_first")
  await retro(fake)
  await record(fake, "ses_first", [LESSON], { dir })
  await fake.tools.get("retro_decide").execute({ id: LESSON.id, status: "accepted", note: "fixed" }, { sessionID: "ses_review" })
  const decided = Date.now()
  writeFileSync(
    logOf(dir, "ses_later"),
    records
      .map(([n, minutes], i) =>
        JSON.stringify(
          i === 0
            ? { v: 1, n, t: decided + minutes * 60_000, k: "prompt", text: "do a thing" }
            : { v: 1, n, t: decided + minutes * 60_000, k: "tool", id: `c${n}`, tool: "shell", input: { command: "npx eslint ." }, status: "completed", exit: 2 },
        ),
      )
      .join("\n") + "\n",
  )
  await retro(fake)
  // Written after the order was: the session went on working while its reader read.
  for (const [n, minutes] of after) {
    const line = { v: 1, n, t: decided + minutes * 60_000, k: "tool", id: `c${n}`, tool: "read", input: { path: "x" }, status: "completed" }
    writeFileSync(logOf(dir, "ses_later"), JSON.stringify(line) + "\n", { flag: "a" })
  }
  const result = await record(fake, "ses_later", [{ ...LESSON, steps }], { dir, through })
  const reopened = existsSync(join(dir, ".retro", "lessons", `${LESSON.id}.md`))
  await cleanup?.()
  return { detail: result.output.detail, reopened }
}

/*
 * How evidence is dated against a decision (lesson.md, "Stale evidence"): by the latest record
 * inside the range it cites, `[first, last]`, or inside the whole log when it cites nothing.
 * Nothing inside the range means no date, and undated evidence reopens — putting a lesson to a
 * human twice costs less than dropping one, so when the evidence is ambiguous the plugin errs
 * towards reopening. The first pre-release review pulled the other way and was half right; the
 * second review caught both halves.
 */

test("evidence is dated by the range it cites, not by whatever came after it in the log", async () => {
  // The part of the first review that was right: a citation whose last step is missing used to
  // be dated by the newest record, which reaches past the cited stretch into work done after
  // the fix — and reopened an accepted lesson on evidence from before it.
  const { detail, reopened } = await citeAgainstDecision([[1, -60], [2, -50], [5, 60]], [2, 3])
  assert.match(detail, /already fixed before this session ran/)
  assert.equal(reopened, false, "the accepted lesson stays closed")
})

test("a recurrence after the fix inside the cited range reopens the lesson", async () => {
  // The second review: steps are a range, and the first fix read only its two ends. With the
  // upper end missing it took the lower one, and a genuine recurrence after the fix — inside
  // the range the reader cited — was thrown away as "already fixed".
  const { reopened } = await citeAgainstDecision([[1, -60], [2, -50], [3, 30], [4, 40]], [2, 9])
  assert.equal(reopened, true, "the fix did not hold, and that is news")
})

test("evidence that cites no steps is dated by the whole log", async () => {
  // The second review: `steps` is optional, and a lesson with none came back undated — so a
  // backlog session wholly from before the fix reopened the accepted lesson, the very bug the
  // stale-evidence rule exists to stop.
  const { detail, reopened } = await citeAgainstDecision([[1, -60], [2, -50]], [])
  assert.match(detail, /already fixed before this session ran/)
  assert.equal(reopened, false)
})

test("evidence citing only steps the log does not have is undated, and reopens", async () => {
  const { reopened } = await citeAgainstDecision([[1, -60], [2, -50]], [50, 60])
  assert.equal(reopened, true, "nothing says it is old")
})

test("nothing to review still says how many logs were analysed to find that out", async () => {
  // Pre-release review: "Nothing to review" reads the same after five analyses as after none.
  // The line that says "Analysed N session logs just now" was still in the renderer, but since
  // the analysis moved into subagents nothing fed it a number.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await work(fake, "ses_b")
  await retro(fake)
  await record(fake, "ses_a", [], { dir })
  await record(fake, "ses_b", [], { dir })
  const handed = await propose(fake)

  assert.match(handed.content, /Nothing to review/)
  assert.match(handed.content, /Analysed 2 session logs just now, with nothing to learn from them/)
  await cleanup?.()
})

test("a person who names an open order's path in a new session is still logged", async () => {
  // Second pre-release review: the first fix still let a *fresh* session be taken for the
  // plugin's own reader if its first prompt named an open order's exact path — and that stops a
  // session being logged for good. A session a person types into is recognised only by the
  // exact line the hand-over prescribes, which nobody types by accident.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_curious", messageID: "q1", prompt: { text: `what is in ${paths[0]}?` } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_curious", id: "q2", tool: "read", input: { path: paths[0] } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_curious", id: "q2", tool: "read", input: { path: paths[0] }, status: "completed", result: { output: "x" } })

  assert.equal(existsSync(logOf(dir, "ses_curious")), true, "the person's session has a log")
  await cleanup?.()
})

test("a reader that reported reading nothing new is not reported as no answer", async () => {
  // Second pre-release review: that read was closed as "unanswered", so the self-check said no
  // record came back — about a log whose reader had answered — and at the same time counted it
  // as a failed read. One answer, two contradictory facts.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  await retro(fake)
  await record(fake, "ses_a", [], { dir })
  const mark = state(dir).looked.ses_a.n
  await work(fake, "ses_a") // it grows, so it is asked about again
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 50 }, data: { sessionID: "ses_a" } })
  await new Promise((r) => setImmediate(r))
  await retro(fake)
  await record(fake, "ses_a", [], { dir, through: mark }) // and the reader got no further

  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /asked about with no answer/, "an answer came back")
  assert.match(report, /a reader that reported reading nothing new/, "and the cause it does name is the real one")
  // Third pre-release review: the session's own extraction line kept saying the log was waiting.
  assert.match(report, /extraction\s+the analysis reported reading nothing new/, "the session's line says what happened")
  await cleanup?.()
})

test("a log set aside is described in the same words everywhere it is reported", async () => {
  // Second pre-release review: the self-check said "the plugin could not read three times"
  // while the hand-over and state.json said "given up after three failed analyses", about the
  // same state. One phrase, in one place.
  const { SET_ASIDE } = await import("../src/selfcheck.js")
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  mkdirSync(join(dir, ".retro", "sessions"), { recursive: true })
  writeFileSync(logOf(dir, "ses_broken"), "not a record\nnor this\n")

  for (let i = 0; i < 3; i++) await retro(fake)
  const handed = fake.synthetic.at(-1)?.text ?? ""
  assert.ok(state(dir).extracted.ses_broken.detail.startsWith(SET_ASIDE), state(dir).extracted.ses_broken.detail)
  assert.ok(handed.includes(SET_ASIDE), "the hand-over")
  assert.ok(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8").includes(SET_ASIDE), "the self-check")
  await cleanup?.()
})

test("a person's own delegation stays logged even if an order naming its path is issued while it runs", async () => {
  // Third pre-release review: which call is ours was said to be decided once, when it starts —
  // but the after-hook still asked again at the end, so a person's subagent that started before
  // an order existed could become "ours" when it finished, losing its result from their log.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const future = join(dir, ".retro", "work", "ses_a.md")
  const mine = { sessionID: "ses_person", id: "p1", tool: "subagent", input: { agent: "explore", prompt: `look at ${future}` } }
  await fake.hooks.get("session.prompt")({ sessionID: "ses_person", messageID: "pm", prompt: { text: "explore for me" } })
  await fake.hooks.get("tool.execute.before")(mine)
  await retro(fake) // now an order with that exact path is open
  await fake.hooks.get("tool.execute.after")({ ...mine, status: "completed", result: { output: "found it", metadata: { sessionID: "ses_helper" } } })

  const records = readFileSync(logOf(dir, "ses_person"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const call = records.find((r) => r.k === "tool" && r.id === "p1")
  assert.ok(call, "the person's delegation is in their log")
  assert.equal(call.status, "completed", "with its result, not left unpaired")
  await cleanup?.()
})

test("a fresh session quoting a delegation of ours is the person's, whatever is in flight", async () => {
  // Third pre-release review: a session was once recognised by the prompt of a delegation in
  // flight, and an own call that never finished kept recognising sessions for the life of the
  // process. Only the prescribed line makes a session ours now (rule 3), so a person quoting
  // a delegation is logged however many calls are in flight.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const prompt = `Please read ${paths[0]} and follow it.`
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt } })
  for (let i = 0; i < 1000; i++) {
    await fake.hooks.get("tool.execute.before")({ sessionID: "ses_busy", messageID: "m", id: `i${i}`, tool: "read", input: { path: "x" } })
  }
  await fake.hooks.get("session.prompt")({ sessionID: "ses_later", messageID: "l1", prompt: { text: prompt } })

  assert.ok(existsSync(logOf(dir, "ses_later")), "the interrupted delegation has been forgotten")
  await cleanup?.()
})

test("evidence that cites no steps is dated by what its order covered, not by what came after it", async () => {
  // Third pre-release review: "the whole log" included records written after the order, which
  // the reader never saw — a session still working after the fix dated pre-fix evidence as new.
  const { detail, reopened } = await citeAgainstDecision([[1, -60], [2, -50]], [], { after: [[3, 30]] })
  assert.match(detail, /already fixed before this session ran/)
  assert.equal(reopened, false)
})

/*
 * Fourth pre-release review: which call is ours, decided once per call — by session and id,
 * for the inner tool and its Code Mode wrapper alike, and still decided when the start was
 * never seen.
 */

const kindsIn = (dir, session) =>
  existsSync(logOf(dir, session))
    ? readFileSync(logOf(dir, session), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.k !== "handover")
    : []

test("an analysis does not take over a report that describes another session", async () => {
  // Fourth pre-release review: the record's outcome was written into the report as an old
  // snapshot of the analysed session, replacing the one somebody was working in.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 50 }, data: { sessionID: "ses_a" } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("session.prompt")({ sessionID: "ses_now", messageID: "n1", prompt: { text: "and now this" } })
  await retro(fake)
  await record(fake, "ses_a", [LESSON], { dir })
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /measured on session\s+`ses_now`/, report)
  await cleanup?.()
})

/* Fifth pre-release review. */

test("a child is not taken for a reader while anything of the person's runs beside our delegation", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Please read ${paths[0]}.` } })
  // The person's own delegation, reported wrapper first.
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "p1", tool: "execute", input: { code: "await tools.subagent('explore')" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_helper", messageID: "h1", prompt: { text: "You are a subagent spawned by another session.\nexplore the repo" } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_helper", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_helper", id: "hx", tool: "read", input: { path: "src" } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_helper", id: "hx", tool: "read", input: { path: "src" }, status: "completed", result: { output: "a.js" } })
  // Its own delegation ends and names it: the person's, so it is adopted, with what it did.
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" }, status: "completed", result: { output: "done", metadata: { sessionID: "ses_helper" } } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "p1", tool: "execute", input: { code: "await tools.subagent('explore')" }, status: "completed", result: { output: "done" } })
  const theirs = kindsIn(dir, "ses_review")
  assert.ok(theirs.some((r) => r.k === "prompt" && /explore the repo/.test(r.text)), "the person's helper is adopted into their log")
  assert.ok(theirs.some((r) => r.k === "tool" && r.id === "hx"), "with its work")
  assert.equal(existsSync(logOf(dir, "ses_helper")), false, "and no log of its own left behind")
  await cleanup?.()
})

test("a reader recognised by its parent takes the report back to the person's session", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "please run the analyses" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Please read ${paths[0]}.` } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "Your task is in a file." } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_reader", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /ses_reader/, "the report is not about the reader")
  await cleanup?.()
})

test("an analysis of the session being worked in does not report it as ended", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 50 }, data: { sessionID: "ses_a" } })
  await new Promise((r) => setImmediate(r))
  await work(fake, "ses_a") // working again
  await retro(fake, { invoker: "ses_a" })
  await record(fake, "ses_a", [LESSON], { dir })
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /`ses_a`, which was still working/, report)
  await cleanup?.()
})

test("the third read that covered nothing new says the log is set aside, not that it will be asked again", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await retro(fake)
  await record(fake, "ses_a", [], { dir })
  const mark = state(dir).looked.ses_a.n
  await work(fake, "ses_a")
  let reply
  for (let i = 0; i < 3; i++) {
    await retro(fake)
    reply = (await record(fake, "ses_a", [], { dir, through: mark })).output.detail
  }
  assert.match(reply, /set aside/)
  assert.doesNotMatch(reply, /will be asked about again/)
  await cleanup?.()
})

test("a reader delegating part of its reading does not make the report about itself", async () => {
  // Seventh pre-release review: claiming the helper re-measured its parent — our own reader.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: `opencode-retro work order: read ${paths[0]} and do what it says.` } })
  const help = { sessionID: "ses_reader", id: "h1", tool: "subagent", input: { agent: "explore", prompt: "skim the log" } }
  await fake.hooks.get("tool.execute.before")(help)
  await fake.hooks.get("tool.execute.after")({ ...help, status: "completed", result: { output: "skimmed", metadata: { sessionID: "ses_helper" } } })
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /ses_reader|ses_helper/)
  await cleanup?.()
})

test("a reader's helper is ours however it was told what to do", async () => {
  // Eighth pre-release review: a helper whose prompt matched nothing was adopted into the
  // reader, so its calls went into a log under the reader's id; and its short prompt, stored,
  // could match a person's subagent told the same words.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: `opencode-retro work order: read ${paths[0]} and do what it says.` } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reader", id: "h1", tool: "subagent", input: { agent: "explore", prompt: "skim the log" } })
  // The person, meanwhile, asks their own subagent the same thing.
  await fake.hooks.get("session.prompt")({ sessionID: "ses_theirs", messageID: "t1", prompt: { text: "skim the log" } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_helper", messageID: "x1", prompt: { text: "You are a subagent spawned by another session.\nGo." } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_helper", parentID: "ses_reader", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_helper", id: "hr", tool: "read", input: { path: "x" } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_helper", id: "hr", tool: "read", input: { path: "x" }, status: "completed", result: { output: "y" } })

  assert.equal(existsSync(logOf(dir, "ses_reader")), false, "nothing under the reader's id")
  assert.equal(existsSync(logOf(dir, "ses_helper")), false, "nor the helper's")
  assert.ok(existsSync(logOf(dir, "ses_theirs")), "the person's own subagent is logged")
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /ses_reader|ses_helper/, "and the report is about none of ours")
  await cleanup?.()
})

test("a reader already recognised is not claimed again when its delegation ends", async () => {
  // Pins the guard the seventh review added: the after-hook re-claimed a reader already
  // recognised — a state write and a forced report per reader.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const line = `opencode-retro work order: read ${paths[0]} and do what it says.`
  const delegation = { sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: line } }
  await fake.hooks.get("tool.execute.before")(delegation)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: line } })
  await record(fake, "ses_a", [LESSON], { dir })
  await fake.hooks.get("tool.execute.after")({ ...delegation, status: "completed", result: { output: "done", metadata: { sessionID: "ses_reader" } } })
  assert.ok(!(state(dir).uncounted ?? []).includes("ses_reader"), "a reader never counted is not uncounted")
  await cleanup?.()
})

/* Ninth pre-release review: a child is decided when the delegation that started it ends. */

test("a report about a session that turns out to be ours goes back to the last that ended, rather than stay", async () => {
  // Ninth pre-release review: with no session of the person's live to hand it back to, the
  // report stayed about the helper its first prompt made it about.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 50 }, data: { sessionID: "ses_a" } })
  await new Promise((r) => setImmediate(r))
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: `opencode-retro work order: read ${paths[0]} and do what it says.` } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reader", id: "rh", tool: "subagent", input: { agent: "explore", prompt: "skim it" } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_helper", messageID: "h1", prompt: { text: "skim it" } })
  assert.match(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /ses_helper/, "its first prompt made the report about it")
  fake.emit({ type: "session.created", durable: { seq: 91 }, data: { sessionID: "ses_helper", parentID: "ses_reader", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /ses_helper/)
  // Tenth review: not an empty "nothing measured yet" under a fresh timestamp, but the last
  // session that ended, as it was measured then.
  assert.match(report, /measured on session\s+`ses_a`, which ended at/)
  // Eleventh: replayed with what is known about its log, not as "not run".
  assert.match(report, /this session's log is waiting/)
  await cleanup?.()
})

/* A delegated child is a step in its parent's task, never a session of its own. */

async function delegateHelper(fake, dir) {
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go on" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Have a look at ${paths[0]}` } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_helper", messageID: "h1", prompt: { text: "explore the repo" } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_helper", parentID: "ses_review", location: { directory: dir } } })
  fake.emit({ type: "session.execution.started", durable: { seq: 91 }, data: { sessionID: "ses_helper" } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_helper", id: "hx", tool: "read", input: { path: "src" } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_helper", id: "hx", tool: "read", input: { path: "src" }, status: "completed", result: { output: "a.js" } })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 92 }, data: { sessionID: "ses_helper" } })
  await new Promise((r) => setImmediate(r))
  return paths
}

test("a delegated child's turn is a step, not a session", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await delegateHelper(fake, dir)
  assert.doesNotMatch(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /ses_helper/, "the report is not about it")
  assert.ok(!("ses_helper" in (state(dir).counted ?? {})), "it did not age the workspace")
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" }, status: "completed", result: { output: "done", metadata: { sessionID: "ses_helper" } } })
  const kinds = kindsIn(dir, "ses_review").map((r) => r.k)
  assert.ok(kinds.includes("tool"), "adopted with its work")
  assert.ok(!kinds.includes("session"), `and no session start or end in the middle of the parent's turn: ${kinds}`)
  await cleanup?.()
})

test("a delegated child keeps everything but its start and end", async () => {
  // Eleventh pre-release review: all its events were dropped — its answer, its steps, the seq
  // of its calls — when only its start and end are a step's.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await delegateHelper(fake, dir)
  fake.emit({ type: "session.text.ended", durable: { seq: 93 }, data: { sessionID: "ses_helper", text: "there are two files" } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" }, status: "completed", result: { output: "done", metadata: { sessionID: "ses_helper" } } })
  const theirs = kindsIn(dir, "ses_review")
  assert.ok(theirs.some((r) => r.k === "text" && /two files/.test(r.text)), "its answer came with it")
  assert.ok(!theirs.some((r) => r.k === "session"), "its start and end did not")
  await cleanup?.()
})

test("a delegated child is not counted as waiting on its own", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await delegateHelper(fake, dir)
  await record(fake, "ses_a", [], { dir }) // the one real order is answered; the report is rewritten
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  // On disk: ses_a (read) and ses_review (the person's, with the helper folded in, waiting).
  assert.match(report, /- 1 log not analysed yet/, "the person's log is waiting, and no helper's of its own")
  const { paths } = await retro(fake, { invoker: "ses_other" })
  assert.ok(!paths.some((path) => path.includes("ses_helper")), "and /retro does not ask about it either")
  await cleanup?.()
})

test("a child adopted by its delegation's end stays adopted when its creation arrives late", async () => {
  // Pins the order the tenth review raised: hooks run ahead of the event stream, so a child can
  // be adopted by its delegation's end before its creation arrives — and must stay adopted.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go on" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Have a look at ${paths[0]}` } })
  const mine = { sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" } }
  await fake.hooks.get("tool.execute.before")(mine)
  await fake.hooks.get("tool.execute.after")({ ...mine, status: "completed", result: { output: "done", metadata: { sessionID: "ses_helper" } } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_helper", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_helper", id: "late", tool: "read", input: { path: "z" } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_helper", id: "late", tool: "read", input: { path: "z" }, status: "completed", result: { output: "z" } })
  assert.ok(kindsIn(dir, "ses_review").some((r) => r.id === "late"), "its later work still goes to the person's log")
  await cleanup?.()
})

/* Twelfth pre-release review. */

test("a delegated child interrupted mid-call is adopted with the call, and the tool hook is not called dead", async () => {
  // Twelfth pre-release review, reproduced: adopted, its open call was lost from the log while
  // its event still counted, and the self-check called the tool hook dead.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await delegateHelper(fake, dir)
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_helper", id: "open1", tool: "read", input: { path: "big" } })
  fake.emit({ type: "session.tool.called", durable: { seq: 94 }, data: { sessionID: "ses_helper", id: "open1", tool: "read" } })
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 95 }, data: { sessionID: "ses_helper" } })
  await new Promise((r) => setImmediate(r))
  // The person's delegation ends and names it: theirs, adopted with the call still open.
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" }, status: "error", result: { output: "interrupted", metadata: { sessionID: "ses_helper" } } })
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 96 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  const theirs = kindsIn(dir, "ses_review")
  assert.ok(theirs.some((r) => r.k === "tool" && r.id === "open1" && r.status === "unfinished" && r.seq === 94), "the open call is in their log, as unfinished, with its seq")
  assert.doesNotMatch(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /BROKEN\s+tool hook/)
  await cleanup?.()
})

/* Thirteenth pre-release review. */

/* Fourteenth pre-release review. */

/* Fifteenth pre-release review, over the whole series. */

test("evidence is dated by what its order covered, not by how far the reader says it got", async () => {
  // Sixteenth and seventeenth pre-release reviews: bounded by `through`, a citation of steps the
  // order did send came back undated and reopened a decision — and citing one more step flipped
  // it. Every step up to the order's end went out with it.
  const a = await citeAgainstDecision([[1, -60], [2, -50], [3, -40]], [3], { through: 2 })
  const b = await citeAgainstDecision([[1, -60], [2, -50], [3, -40]], [2, 3], { through: 2 })
  assert.equal(a.reopened, false, a.detail)
  assert.equal(b.reopened, false, b.detail)
})

test("a report with no session of the person's to describe does not say no hook has fired", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_helper", messageID: "h1", prompt: { text: "skim it" } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "opencode-retro work order: read /x/.retro/work/ses_a.md and do what it says." } })
  fake.emit({ type: "session.created", durable: { seq: 91 }, data: { sessionID: "ses_helper", parentID: "ses_reader", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /ses_helper/)
  assert.doesNotMatch(report, /Nothing measured yet/)
  assert.match(report, /No session of yours to describe right now/)
  await cleanup?.()
})

test("a child whose delegation errored without naming it is still the person's", async () => {
  // Sixteenth pre-release review: claimed as ours, the person's helper was deleted, though every
  // reader of ours was already accounted for.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await delegateHelper(fake, dir)
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: "x" }, status: "completed", result: { output: "done", metadata: { sessionID: "ses_reader" } } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" }, status: "error", result: { output: "failed" } })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 97 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  assert.ok(kindsIn(dir, "ses_review").some((r) => r.id === "hx"), "the helper's work is the person's")
  await cleanup?.()
})

/* Eighteenth pre-release review. */

/* Whole-series review over 4112915..ead6e44. */

test("a report with no session to describe keeps when its checks were last evaluated", async () => {
  // Whole-series review: `verified never` under a fresh heartbeat reads, by the file's own key,
  // as hooks that never fire.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_helper", messageID: "h1", prompt: { text: "skim it" } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "opencode-retro work order: read /x/.retro/work/ses_a.md and do what it says." } })
  fake.emit({ type: "session.created", durable: { seq: 91 }, data: { sessionID: "ses_helper", parentID: "ses_reader", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /verified\s+never/)
  assert.match(report, /none are shown, see below/, "and the label does not point at checks that are not there")
  await cleanup?.()
})

/* Only a hook moves the heartbeat (selfcheck.md). */

test("a recorded outcome is evaluated anew without moving the heartbeat, and a round's own calls move it", async () => {
  const real = Date.now
  let now = Date.parse("2026-10-25T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    await work(fake, "ses_a")
    fake.emit({ type: "session.execution.succeeded", durable: { seq: 50 }, data: { sessionID: "ses_a" } })
    await new Promise((r) => setImmediate(r))
    now += 10 * 60_000
    await retro(fake)
    await record(fake, "ses_a", [LESSON], { dir })
    let report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /heartbeat\s+2026-10-25 10:00/, "a tool of ours is not a hook firing")
    assert.match(report, /verified\s+2026-10-25 10:10/, "but the checks were evaluated again, now")
    // The person's session delegating for the round is a hook firing.
    now += 10 * 60_000
    await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d9", tool: "retro_propose", input: {} })
    report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /heartbeat\s+2026-10-25 10:20/)
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

test("an outcome for a session still working leaves the heartbeat, and a reader's own hooks move it", async () => {
  // Twenty-third pre-release review: the working-session branch observed, and observing moved
  // the heartbeat from a tool of ours; a reader's hooks, all a round has for minutes, did not.
  const real = Date.now
  let now = Date.parse("2026-10-25T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    await work(fake, "ses_b") // still working
    now += 10 * 60_000
    await retro(fake, { invoker: "ses_b" })
    await record(fake, "ses_b", [LESSON], { dir })
    let report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /heartbeat\s+2026-10-25 10:00/, "a tool of ours is not a hook firing")
    assert.match(report, /verified\s+2026-10-25 10:10/, "and the checks were evaluated again")
    now += 10 * 60_000
    await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "opencode-retro work order: read /x/.retro/work/ses_q.md and do what it says." } })
    await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reader", id: "rr", tool: "read", input: { path: "x" } })
    report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /heartbeat\s+2026-10-25 10:20/, "a reader's hook is a hook firing")
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

test("a report written while a hook runs carries that hook's beat", async () => {
  // Twenty-fifth pre-release review, reproduced: the beat came after the handler, so the
  // handler's own write carried the previous one — "heartbeat never" beside a prompt hook just
  // reported ok — and the write after it was skipped as too soon.
  const real = Date.now
  let now = Date.parse("2026-10-25T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    now += 5 * 60_000
    await fake.hooks.get("session.prompt")({ sessionID: "ses_x", messageID: "m1", prompt: { text: "hello" } })
    assert.match(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /heartbeat\s+2026-10-25 10:05/)
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

test("while a session works, its checks are evaluated again once a minute, not only the heartbeat", async () => {
  // Twenty-sixth pre-release review, reproduced: a hook's plain write reset the clock that also
  // throttled `observe`, so `verified` and the counts froze at the first prompt while the
  // heartbeat moved — a fresh heartbeat over stale checks.
  const real = Date.now
  let now = Date.parse("2026-10-25T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    await fake.hooks.get("session.prompt")({ sessionID: "ses_x", messageID: "m1", prompt: { text: "go" } })
    for (let i = 0; i < 5; i++) {
      now += 61_000
      const call = { sessionID: "ses_x", id: `c${i}`, tool: "read", input: { path: "x" } }
      await fake.hooks.get("tool.execute.before")(call)
      await fake.hooks.get("tool.execute.after")({ ...call, status: "completed", result: { output: "y" } })
    }
    const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /verified\s+2026-10-25 10:05/, report)
    assert.doesNotMatch(report, /ses_x\.jsonl, 1 entries/, "and the log's count with it")
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

test("a /retro round's readers keep the session the report describes measured", async () => {
  // Twenty-seventh pre-release review: a reader's hook wrote the heartbeat alone and reset the
  // clock, so the session the report described stayed at its last measurement for the whole
  // round while the heartbeat moved.
  const real = Date.now
  let now = Date.parse("2026-10-25T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    await fake.hooks.get("session.prompt")({ sessionID: "ses_p", messageID: "m1", prompt: { text: "go" } })
    await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "opencode-retro work order: read /x/.retro/work/ses_q.md and do what it says." } })
    for (let i = 0; i < 4; i++) {
      now += 61_000
      const call = { sessionID: "ses_reader", id: `r${i}`, tool: "read", input: { path: "x" } }
      await fake.hooks.get("tool.execute.before")(call)
      await fake.hooks.get("tool.execute.after")({ ...call, status: "completed", result: { output: "y" } })
    }
    const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /measured on session\s+`ses_p`/)
    assert.match(report, /verified\s+2026-10-25 10:04/, "measured again, not only the heartbeat")
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

test("a delegated child's hooks keep its parent measured", async () => {
  // Twenty-eighth pre-release review: a child's hooks measure the session that delegated it.
  const real = Date.now
  let now = Date.parse("2026-10-25T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    await delegateHelper(fake, dir)
    for (let i = 0; i < 3; i++) {
      now += 61_000
      const call = { sessionID: "ses_helper", id: `k${i}`, tool: "read", input: { path: "x" } }
      await fake.hooks.get("tool.execute.before")(call)
      await fake.hooks.get("tool.execute.after")({ ...call, status: "completed", result: { output: "y" } })
    }
    const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /measured on session\s+`ses_review`/)
    assert.match(report, /verified\s+2026-10-25 10:03/)
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

test("a report about a child goes back to the session that delegated it, not to another one open", async () => {
  // Twenty-ninth pre-release review, reproduced: marking the parent to be measured afresh took
  // it out of the sessions the report could go back to, and the report went to an unrelated one.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_b", messageID: "b1", prompt: { text: "other work" } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_p", messageID: "p1", prompt: { text: "delegate" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_p", id: "s1", tool: "subagent", input: { agent: "explore", prompt: "look" } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_c", messageID: "c1", prompt: { text: "look" } })
  assert.match(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /ses_c/, "the child's first prompt made it about the child")
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_c", parentID: "ses_p", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  assert.match(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /measured on session\s+`ses_p`/)
  await cleanup?.()
})

test("a hook that names no session still keeps the report measured", async () => {
  // Twenty-ninth and thirtieth pre-release reviews: a payload that lost its session id must not
  // read as a dead plugin, nor write a fresh heartbeat over checks that never move.
  const real = Date.now
  let now = Date.parse("2026-10-25T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    await fake.hooks.get("session.prompt")({ sessionID: "ses_x", messageID: "m1", prompt: { text: "go" } })
    now += 61_000
    await fake.hooks.get("tool.execute.before")({ id: "n1", tool: "read", input: { path: "x" } })
    const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /heartbeat\s+2026-10-25 10:01/)
    assert.match(report, /verified\s+2026-10-25 10:01/)
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

/* Thirty-second pre-release review, and the first live bench of the marked rounds. */

test("a reader whose prompt OpenCode prefixed with its own line is still not logged", async () => {
  // Live, a subagent's prompt arrives as "You are a subagent spawned by another session." and
  // then the delegation's text: a check anchored at the start never matched a real reader.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const text = `You are a subagent spawned by another session.\nopencode-retro work order: read ${paths[0]} and do what it says.`
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reader", id: "rr", tool: "read", input: { path: paths[0] } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_reader", id: "rr", tool: "read", input: { path: paths[0] }, status: "completed", result: { output: "x" } })
  assert.equal(existsSync(logOf(dir, "ses_reader")), false)
  await cleanup?.()
})

test("a /retro posted into a turn still running leaves the rest of that turn the person's", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix the build" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "handover", about: "work", text: "the logs come first" },
    { n: 4, k: "tool", tool: "shell", input: { command: "npm run build" }, exit: 1 },
    { n: 5, k: "session", event: "end" },
    { n: 6, k: "session", event: "start" },
    { n: 7, k: "tool", tool: "subagent", input: { prompt: "opencode-retro work order: read /x.md and do what it says." } },
    { n: 8, k: "handover", about: "lesson", text: "a lesson" },
  ]
  const { steps, ranges } = ownRounds(records)
  assert.ok(!steps.has(4), "the person's turn finishing is theirs")
  assert.ok(steps.has(6) && steps.has(7), "the round is the turn the hand-over started")
  assert.deepEqual(ranges, [[3, 3], [6, 7]], "the hand-over named, and its round after the person's turn")
})

test("a delegation of ours written after an early retro_propose is still ours", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "handover", about: "work", text: "the logs come first" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "handover", about: "lesson", text: "a lesson" },
    { n: 4, k: "tool", tool: "retro_propose", input: {} },
    // As measured in twelve live delegations: the call carries the line as the agent wrote it,
    // with none of OpenCode's own text, which is added to the child's prompt only.
    { n: 5, k: "tool", tool: "subagent", input: { prompt: "opencode-retro work order: read /x.md and do what it says." }, output: "the reader's report" },
    { n: 6, k: "tool", tool: "subagent", input: { prompt: "explore the repo" } },
  ]
  const { steps } = ownRounds(records)
  assert.ok(steps.has(4) && steps.has(5), "the plugin's own calls, wherever they land")
  assert.ok(!steps.has(6), "and only those")
})

test("a reader that read everything but a trailing round has read it all", async () => {
  // The order's steps run to the end of the log, a trailing round included; a reader that
  // leaves the round out as it is told to, and reports the last step before it, read it all.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  const t = Date.now()
  const lines = [
    { v: 1, n: 1, t, k: "prompt", text: "fix the build" },
    { v: 1, n: 2, t, k: "tool", id: "c1", tool: "shell", input: { command: "npm run build" }, status: "completed", exit: 1 },
    { v: 1, n: 3, t, k: "handover", about: "work", text: "the logs come first" },
    { v: 1, n: 4, t, k: "session", event: "start" },
    { v: 1, n: 5, t, k: "tool", id: "d1", tool: "subagent", input: { prompt: "opencode-retro work order: read /x.md and do what it says." }, status: "completed" },
  ]
  mkdirSync(join(dir, ".retro", "sessions"), { recursive: true })
  writeFileSync(logOf(dir, "ses_old"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  await retro(fake, { invoker: "ses_other" })
  assert.equal(state(dir).orders.ses_old.lastN, 5, "the order runs to the end, the round included")
  await record(fake, "ses_old", [], { dir, through: 2 })
  assert.ok(!state(dir).looked.ses_old.open, "not left open as a partial read")
  await cleanup?.()
})

test("a hand-over that could not be delivered is followed by a notice saying so", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  fake.ctx.session.synthetic = async () => {
    throw new Error("session is gone")
  }
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go" } })
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  const records = readFileSync(logOf(dir, "ses_review"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const handovers = records.filter((r) => r.k === "handover")
  assert.equal(handovers.at(-2)?.about, "work")
  assert.equal(handovers.at(-1)?.about, "notice")
  assert.match(handovers.at(-1).text, /could not be delivered: session is gone/)
  await cleanup?.()
})

/* Thirty-third pre-release review. */

test("a hand-over that landed in a running turn with no turn after it takes nothing of the person's", async () => {
  const { ownRounds, nothingNew } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix the build" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "handover", about: "work", text: "the logs come first" },
    { n: 4, k: "tool", tool: "shell", input: { command: "npm run build" }, exit: 1 },
    { n: 5, k: "text", text: "the build is broken because…" },
    { n: 6, k: "session", event: "end" },
    { n: 7, k: "prompt", text: "and now?" },
  ]
  const { steps } = ownRounds(records)
  assert.ok(!steps.has(4) && !steps.has(5), "the person's turn is theirs")
  assert.equal(nothingNew(records, records.slice(3, 6)), false, "and their answer is something to read")
})

test("a person who pastes the hand-over into a new session is still logged", async () => {
  // The hand-over carries the reader's line indented deep inside it; only a prompt that starts
  // with it, or has it right after one line (OpenCode's own), is a reader's.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  const pasted = [
    "_opencode-retro — the logs come first:_",
    "",
    "1 session log is waiting to be analysed.",
    "",
    "    opencode-retro work order: read /x/.retro/work/ses_a.md and do what it says.",
    "",
    "what does this mean?",
  ].join("\n")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_curious", messageID: "m1", prompt: { text: pasted } })
  assert.ok(existsSync(logOf(dir, "ses_curious")))
  await cleanup?.()
})

test("a reader that read up to a trailing turn's end has read it all", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  const t = Date.now()
  const lines = [
    { v: 1, n: 1, t, k: "prompt", text: "fix the build" },
    { v: 1, n: 2, t, k: "tool", id: "c1", tool: "shell", input: { command: "npm run build" }, status: "completed", exit: 1 },
    { v: 1, n: 3, t, k: "session", event: "end", outcome: "succeeded" },
  ]
  mkdirSync(join(dir, ".retro", "sessions"), { recursive: true })
  writeFileSync(logOf(dir, "ses_old"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  await retro(fake, { invoker: "ses_other" })
  await record(fake, "ses_old", [], { dir, through: 2 })
  assert.ok(!state(dir).looked.ses_old.open, "a turn's end holds nothing to read")
  await cleanup?.()
})

/* Whole-series review over 4112915..9f75752. */

test("a reworded reader still reading after an early retro_propose is ours to its last record", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "handover", about: "work", text: "the logs come first" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "prompt", from: "ses_reader", text: "You are a subagent.\nHave a look at /x/.retro/work/ses_a.md" },
    { n: 4, k: "tool", from: "ses_reader", tool: "read", input: { path: "/x/.retro/sessions/ses_a.jsonl" } },
    { n: 5, k: "handover", about: "lesson", text: "a lesson" },
    { n: 6, k: "tool", tool: "retro_propose", input: {} },
    { n: 7, k: "tool", from: "ses_reader", tool: "read", input: { path: "/x/.retro/sessions/ses_a.jsonl" } },
    { n: 8, k: "tool", from: "ses_helper", tool: "read", input: { path: "src/a.js" } },
  ]
  const { steps } = ownRounds(records)
  assert.ok(steps.has(7), "its reading after the round closed is still ours")
  assert.ok(!steps.has(8), "and only its")
})

test("orders whose hand-over could not be delivered are voided, not reported as unanswered", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  fake.ctx.session.synthetic = async () => {
    throw new Error("session is gone")
  }
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(state(dir).orders.ses_a.done, "void", "never put to anybody")
  assert.equal(existsSync(join(dir, ".retro", "work", "ses_a.md")), false)
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  assert.equal(state(dir).orders.ses_a.asked, 1, "asked once — the first time was not an asking")
  await cleanup?.()
})

/* Whole-series review over 4112915..f47d919. */

test("the rounds an order names include a reworded reader's records after the round closed", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 5, k: "handover", about: "work", text: "the logs come first" },
    { n: 6, k: "session", event: "start" },
    { n: 7, k: "text", text: "starting a reader" },
    { n: 8, k: "prompt", from: "c1", text: "You are a subagent.\nHave a look at /x/.retro/work/ses_a.md" },
    { n: 9, k: "tool", tool: "retro_propose", input: {} },
    { n: 10, k: "handover", about: "lesson", text: "a lesson" },
    { n: 11, k: "tool", from: "c1", tool: "read", input: { path: "/x/.retro/sessions/ses_b.jsonl" } },
    { n: 12, k: "text", from: "c1", text: "session B had eslint problems" },
  ]
  assert.deepEqual(ownRounds(records).ranges, [[5, 9], [11, 12]])
})

test("a second /retro inside a running round continues it", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 5, k: "handover", about: "work", text: "the logs come first" },
    { n: 6, k: "session", event: "start" },
    { n: 7, k: "text", text: "starting readers" },
    { n: 8, k: "handover", about: "work", text: "the logs come first, again" },
    { n: 9, k: "text", text: "waiting on the first reader" },
    { n: 10, k: "tool", tool: "subagent", input: { prompt: "explore" } },
    { n: 11, k: "handover", about: "lesson", text: "a lesson" },
  ]
  const { steps } = ownRounds(records)
  assert.ok(steps.has(9) && steps.has(10), "the round goes on")
})

test("a reader calling retro_propose is told it is not its call, and nothing happens", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: `opencode-retro work order: read ${paths[0]} and do what it says.` } })
  const result = await fake.tools.get("retro_propose").execute({}, { sessionID: "ses_reader" })
  assert.match(result.content, /Not yours to call/)
  assert.equal(existsSync(logOf(dir, "ses_reader")), false, "no log of its own")
  assert.ok(!state(dir).orders.ses_a.done, "the order is still open for its reader")
  await cleanup?.()
})

test("a turn that added only a round does not report its log as waiting", async () => {
  // Whole-series review, reproduced: the end of the round's turn set the line to "waiting"
  // while the stock — rightly — counted nothing waiting.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_p")
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 50 }, data: { sessionID: "ses_p" } })
  await new Promise((r) => setImmediate(r))
  await retro(fake, { invoker: "ses_p" })
  fake.emit({ type: "session.execution.started", durable: { seq: 51 }, data: { sessionID: "ses_p" } })
  await new Promise((r) => setImmediate(r))
  await record(fake, "ses_p", [], { dir })
  await propose(fake, false, "ses_p")
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 52 }, data: { sessionID: "ses_p" } })
  await new Promise((r) => setImmediate(r))
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /this session's log is waiting/, report)
  assert.doesNotMatch(report, /not analysed yet/, "and the stock agrees")
  await cleanup?.()
})

test("a reworded reader calling retro_propose is told so too", async () => {
  // Thirty-sixth and thirty-ninth pre-release reviews: a reader worded its own way is an
  // ordinary child, not known by its line; called through, it got the proposal and its
  // instruction to record a decision, and its call closed every open order.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_kid", messageID: "k1", prompt: { text: "have a look" } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_kid", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  const result = await fake.tools.get("retro_propose").execute({}, { sessionID: "ses_kid" })
  assert.match(result.content, /Not yours to call/)
  assert.equal(result.output.ok, false, "with an output the declared schema accepts")
  assert.ok(!state(dir).orders.ses_a.done, "nothing closed")
  assert.ok(existsSync(join(dir, ".retro", "work", "ses_a.md")), "and no order removed")
  const parentLog = readFileSync(logOf(dir, "ses_review"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.ok(!parentLog.some((r) => r.k === "handover" && r.from), "and no hand-over written for it")
  await cleanup?.()
})

test("a delegated hand-over in a log does not end the round", async () => {
  // A reader that slipped past the gate — before its creation was known, or after a reload —
  // must not close the round for the rest of it (fortieth review).
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "handover", about: "work", text: "the logs come first" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "prompt", from: "ses_kid", text: "You are a subagent.\nHave a look at /x.md" },
    { n: 4, k: "handover", about: "lesson", from: "ses_kid", text: "a lesson" },
    { n: 5, k: "tool", tool: "subagent", input: { prompt: "another reader, worded its own way" } },
    { n: 6, k: "handover", about: "lesson", text: "the lesson, to the person" },
  ]
  const { steps } = ownRounds(records)
  assert.ok(steps.has(5), "the round goes on past the reader's hand-over")
  assert.ok(!steps.has(6), "and ends at the person's")
})

test("/retro in a subagent's session issues nothing", async () => {
  // Its round could never be proposed there: `retro_propose` refuses delegated sessions.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_kid", messageID: "k1", prompt: { text: "look" } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_kid", parentID: "ses_p", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.commands.get("retro").execute({ sessionID: "ses_kid", prompt: { text: "" } })
  assert.equal(state(dir).orders?.ses_a, undefined, "no order issued")
  assert.match(fake.synthetic.at(-1).text, /runs in a session of your own/)
  assert.equal(fake.synthetic.at(-1).resume, false, "a note to the person, not a turn for the subagent")
  const parent = existsSync(logOf(dir, "ses_p")) ? readFileSync(logOf(dir, "ses_p"), "utf8") : ""
  assert.doesNotMatch(parent, /"k":"handover"/, "and nothing of it in any log")
  await cleanup?.()
})

test("a work hand-over noted for a subagent opens no round", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "handover", about: "work", from: "ses_kid", text: "the logs come first" },
    { n: 2, k: "tool", tool: "shell", input: { command: "npm test" }, exit: 1 },
  ]
  assert.ok(!ownRounds(records).steps.has(2), "the person's work after it is theirs")
})

test("a reader's call to retro_propose writes nothing into any log", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: `opencode-retro work order: read ${paths[0]} and do what it says.` } })
  await fake.tools.get("retro_propose").execute({}, { sessionID: "ses_reader" })
  assert.equal(existsSync(logOf(dir, "ses_reader")), false)
  await cleanup?.()
})

/* Whole-series review over 4112915..85657f4. */

test("a /retro posted into a running turn has its round begin at the turn it resumes", async () => {
  // Reproduced by the forty-second review against the entry point: the plugin stopped owning a
  // session when its turn ended, so the resumed turn's start was not logged, and the round came
  // out empty. A session stays the plugin's across turns now, and the start is there.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_p", messageID: "p1", prompt: { text: "fix the build" } })
  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "ses_p" } })
  await new Promise((r) => setImmediate(r))
  const sh = { sessionID: "ses_p", id: "s1", tool: "shell", input: { command: "npm run build" } }
  await fake.hooks.get("tool.execute.before")(sh)
  await fake.hooks.get("tool.execute.after")({ ...sh, status: "completed", result: { output: { exit: 1 } } })
  await fake.commands.get("retro").execute({ sessionID: "ses_p", prompt: { text: "" } })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 5 }, data: { sessionID: "ses_p" } })
  fake.emit({ type: "session.execution.started", durable: { seq: 6 }, data: { sessionID: "ses_p" } })
  await new Promise((r) => setImmediate(r))
  const d = { sessionID: "ses_p", id: "d1", tool: "subagent", input: { agent: "general", prompt: "have a look at the order" } }
  await fake.hooks.get("tool.execute.before")(d)
  await fake.hooks.get("tool.execute.after")({ ...d, status: "completed", result: { output: "report", metadata: { sessionID: "ses_r" } } })
  const { ownRounds } = await import("../src/extract.js")
  const records = readFileSync(logOf(dir, "ses_p"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const call = records.find((r) => r.id === "d1")
  assert.ok(ownRounds(records).steps.has(call.n), "the round is the turn after the person's ended")
  assert.ok(!ownRounds(records).steps.has(records.find((r) => r.id === "s1").n), "and the person's call is theirs")
  await cleanup?.()
})

test("a reworded reader's delegation is ours wherever it lands", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "handover", about: "work", text: "the logs come first" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "prompt", from: "ses_r", text: "You are a subagent.\nanalyse the order at /x" },
    { n: 4, k: "tool", tool: "retro_propose", input: {} },
    { n: 5, k: "handover", about: "lesson", text: "a lesson" },
    { n: 6, k: "tool", tool: "subagent", child: "ses_r", input: { prompt: "analyse the order at /x" }, output: "other session failed npm run lint" },
  ]
  assert.ok(ownRounds(records).steps.has(6))
})

test("a subagent's prompt does not end a reply to the plugin's hand-over", async () => {
  const { nothingNew } = await import("../src/extract.js")
  const all = [
    { n: 1, k: "prompt", text: "go" },
    { n: 2, k: "handover", about: "notice", text: "nothing to review" },
    { n: 3, k: "prompt", from: "ses_x", text: "You are a subagent.\nexplore" },
    { n: 4, k: "text", text: "ok, nothing to do then" },
  ]
  // The reply at 4 still answers the notice; the subagent's prompt in between changes nothing.
  assert.equal(nothingNew(all, [all[3]]), true)
})

test("a session stays the plugin's across turns, so a turn resumed by a hand-over is logged from its start", async () => {
  // Forty-third pre-release review: forgetting a session at its turn's end dropped the next
  // turn's start, and anything before its first hook, whenever that turn began with no hook.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_p")
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 5 }, data: { sessionID: "ses_p" } })
  fake.emit({ type: "session.execution.started", durable: { seq: 6 }, data: { sessionID: "ses_p" } })
  fake.emit({ type: "session.text.ended", durable: { seq: 7 }, data: { sessionID: "ses_p", text: "picking it up" } })
  await new Promise((r) => setImmediate(r))
  const records = readFileSync(logOf(dir, "ses_p"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const after = records.slice(records.findIndex((r) => r.k === "session" && r.event === "end") + 1)
  assert.ok(after.some((r) => r.k === "session" && r.event === "start"), "the resumed turn's start")
  assert.ok(after.some((r) => r.k === "text" && r.text === "picking it up"), "and what came before its first hook")
  await cleanup?.()
})

test("a subagent's text, delegated in answer to a plugin notice, is part of that reply", async () => {
  const { nothingNew } = await import("../src/extract.js")
  const all = [
    { n: 1, k: "prompt", text: "go" },
    { n: 2, k: "handover", about: "notice", text: "nothing to review" },
    { n: 3, k: "prompt", from: "ses_x", text: "You are a subagent.\nexplore" },
    { n: 4, k: "text", from: "ses_x", text: "there is nothing here" },
  ]
  // Its instruction and its text arrive together, as they do live (forty-fourth review).
  assert.equal(nothingNew(all, all.slice(2)), true)
})

test("a subagent of the person's already running when a hand-over arrives stays theirs", async () => {
  const { nothingNew } = await import("../src/extract.js")
  const all = [
    { n: 1, k: "prompt", text: "explore the repo for me" },
    { n: 2, k: "prompt", from: "ses_x", text: "You are a subagent.\nexplore the repo" },
    { n: 3, k: "handover", about: "notice", text: "nothing to review" },
    { n: 4, k: "text", from: "ses_x", text: "found three config files that disagree" },
  ]
  assert.equal(nothingNew(all, [all[3]]), false, "its findings are something to read")
})

test("a turn resumed by a hand-over that arrived in the previous turn is not a dead prompt hook", async () => {
  // Forty-fourth pre-release review: the turn's end reset the hand-over count, and the resumed
  // turn — no prompt of its own — read as a dead prompt hook.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_p", messageID: "p1", prompt: { text: "fix the build" } })
  fake.emit({ type: "session.execution.started", durable: { seq: 1 }, data: { sessionID: "ses_p" } })
  await new Promise((r) => setImmediate(r))
  await fake.commands.get("retro").execute({ sessionID: "ses_p", prompt: { text: "" } })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 5 }, data: { sessionID: "ses_p" } })
  fake.emit({ type: "session.execution.started", durable: { seq: 6 }, data: { sessionID: "ses_p" } })
  await new Promise((r) => setImmediate(r))
  const d = { sessionID: "ses_p", id: "d1", tool: "read", input: { path: "x" } }
  await fake.hooks.get("tool.execute.before")(d)
  await fake.hooks.get("tool.execute.after")({ ...d, status: "completed", result: { output: "y" } })
  assert.doesNotMatch(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /BROKEN\s+prompt hook/)
  await cleanup?.()
})

test("a log pruned between turns starts its numbering again", async () => {
  // Forty-fourth pre-release review: a session kept across turns kept its step counter, and a
  // log written again after a prune went on from the old numbers.
  const real = Date.now
  let now = Date.parse("2026-10-25T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    await work(fake, "ses_x")
    await retro(fake, { invoker: "ses_other" })
    await record(fake, "ses_x", [], { dir })
    // A week of silence; the next command prunes what is read, quiet and cited by nothing.
    now += 8 * 24 * 60 * 60 * 1000
    const { utimesSync } = await import("node:fs")
    utimesSync(logOf(dir, "ses_x"), (now - 8 * 24 * 60 * 60 * 1000) / 1000, (now - 8 * 24 * 60 * 60 * 1000) / 1000)
    await retro(fake, { invoker: "ses_other" })
    assert.equal(existsSync(logOf(dir, "ses_x")), false, "pruned")
    // Its next turn starts before any hook: still the plugin's, so the start is logged
    // (forty-fifth review — pruning used to forget the session outright).
    fake.emit({ type: "session.execution.started", durable: { seq: 99 }, data: { sessionID: "ses_x" } })
    await new Promise((r) => setImmediate(r))
    await fake.hooks.get("session.prompt")({ sessionID: "ses_x", messageID: "m9", prompt: { text: "back again" } })
    const lines = readFileSync(logOf(dir, "ses_x"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.equal(lines[0].n, 1, "the new log is read from its own start")
    assert.ok(lines.some((r) => r.k === "session" && r.event === "start"), "and its turn's start is in it")
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

test("a hand-over is the input of the first turn that starts after it", async () => {
  // Forty-fourth to forty-seventh pre-release reviews: which turn a hand-over excuses is read
  // from the order of the log, not from a flag set and cleared by async completions.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  const start = (seq) => fake.emit({ type: "session.execution.started", durable: { seq }, data: { sessionID: "ses_p" } })
  const end = (seq) => fake.emit({ type: "session.execution.succeeded", durable: { seq }, data: { sessionID: "ses_p" } })
  const tick = () => new Promise((r) => setImmediate(r))
  const report = () => readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_p", messageID: "p1", prompt: { text: "earlier" } })
  start(1)
  await tick()
  end(2)
  await tick()
  // Sent between turns: it starts its own, which has no prompt and is excused.
  await fake.commands.get("retro").execute({ sessionID: "ses_p", prompt: { text: "" } })
  start(3)
  await tick()
  end(4)
  await tick()
  assert.doesNotMatch(report(), /BROKEN\s+prompt hook/, "the hand-over's own turn is excused")
  // The person's next turn, with the prompt hook dead: nothing of the plugin's to excuse it.
  start(5)
  await tick()
  end(6)
  await tick()
  assert.match(report(), /BROKEN\s+prompt hook/, "a dead prompt hook is reported")
  await cleanup?.()
})
test("a proposal handed back by retro_propose does not excuse the person's next turn", async () => {
  // Forty-eighth pre-release review: the proposal is a tool result inside the review turn; it
  // starts no turn, and counted as one it hid a dead prompt hook after every review.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  const start = (seq) => fake.emit({ type: "session.execution.started", durable: { seq }, data: { sessionID: "ses_p" } })
  const end = (seq) => fake.emit({ type: "session.execution.succeeded", durable: { seq }, data: { sessionID: "ses_p" } })
  const tick = () => new Promise((r) => setImmediate(r))
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_p", messageID: "p1", prompt: { text: "earlier" } })
  start(1)
  await tick()
  end(2)
  await tick()
  await retro(fake, { invoker: "ses_p" })
  start(3)
  await tick()
  await record(fake, "ses_a", [], { dir })
  await propose(fake, false, "ses_p") // the proposal, inside the review turn
  end(4)
  await tick()
  // The person types; the prompt hook is dead, so no prompt is logged.
  start(5)
  await tick()
  end(6)
  await tick()
  assert.match(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /BROKEN\s+prompt hook/)
  await cleanup?.()
})

test("a hand-over that never arrived, or arrived during the turn, excuses nothing of it", async () => {
  // Round 2 of 10: a failed send left the hand-over counted as sent, and one landing inside the
  // running turn was counted for that turn rather than the next.
  const tick = () => new Promise((r) => setImmediate(r))
  for (const scene of ["undelivered", "during"]) {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    if (scene === "undelivered") fake.ctx.session.synthetic = async () => { throw new Error("gone") }
    const cleanup = await plugin.setup(fake.ctx)
    const start = (seq) => fake.emit({ type: "session.execution.started", durable: { seq }, data: { sessionID: "ses_p" } })
    const end = (seq) => fake.emit({ type: "session.execution.succeeded", durable: { seq }, data: { sessionID: "ses_p" } })
    await work(fake, "ses_a")
    await fake.hooks.get("session.prompt")({ sessionID: "ses_p", messageID: "p1", prompt: { text: "earlier" } })
    start(1)
    await tick()
    end(2)
    await tick()
    if (scene === "undelivered") await fake.commands.get("retro").execute({ sessionID: "ses_p", prompt: { text: "" } })
    // The person's turn, with the prompt hook dead.
    start(3)
    await tick()
    if (scene === "during") await fake.commands.get("retro").execute({ sessionID: "ses_p", prompt: { text: "" } })
    end(4)
    await tick()
    assert.match(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /BROKEN\s+prompt hook/, scene)
    await cleanup?.()
  }
})

test("a person's first message quoting the work line after a blank line is still logged", async () => {
  // Round 3 of 10: the line was accepted after any whitespace, blank lines and indentation
  // included, and a session that quoted it — copied from the hand-over — was never logged.
  const { isWorkLine } = await import("../src/extract.js")
  assert.equal(isWorkLine("what does this do?\n\n    opencode-retro work order: read /x/.retro/work/ses_a.md and do what it says."), false)
  assert.equal(isWorkLine("what does this do?\n    opencode-retro work order: read /x.md"), false, "indented, it is quoted")
  assert.equal(isWorkLine("You are a subagent spawned by another session.\nopencode-retro work order: read /x.md and do what it says."), true)
  assert.equal(isWorkLine("opencode-retro work order: read /x.md"), true)
  // Round 4 of 10: and not at the very start either, after blank lines and an indent.
  assert.equal(isWorkLine("\n\n    opencode-retro work order: read /x/.retro/work/ses_a.md and do what it says.\n\nwhat does this mean?"), false)
})

/* Round 5 of 10. */

test("a notice sent into a running turn leaves the rest of that turn the person's", async () => {
  const { nothingNew } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "text", text: "looking" },
    { n: 4, k: "handover", about: "notice", sent: true, text: "nothing to review" },
    { n: 5, k: "text", text: "I found the cause and fixed it" },
    { n: 6, k: "session", event: "end" },
  ]
  assert.equal(nothingNew(records, records.slice(4)), false, "the person's answer is something to read")
})

test("a long first prompt is checked for the reader line in linear time", async () => {
  const { isWorkLine } = await import("../src/extract.js")
  const long = "x".repeat(400_000)
  const t = Date.now()
  assert.equal(isWorkLine(long), false)
  assert.equal(isWorkLine(long + "\nmore"), false)
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`)
})

test("a reader whose delegation copied the indented line is still recognised", async () => {
  const { isWorkLine } = await import("../src/extract.js")
  assert.equal(isWorkLine("You are a subagent spawned by another session.\n    opencode-retro work order: read /x.md and do what it says."), true)
  assert.equal(isWorkLine("what does this do?\n    opencode-retro work order: read /x.md"), false, "a person's quote is not")
})

/* Round 6 of 10. */

test("a hand-over that was never delivered leaves the rest of the turn the person's", async () => {
  const { nothingNew, lastReadable } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "handover", about: "lesson", sent: true, text: "a lesson" },
    { n: 4, k: "handover", about: "notice", undelivered: true, of: 3, text: "could not be delivered" },
    { n: 5, k: "text", text: "found the bug in foo" },
    { n: 6, k: "session", event: "end" },
  ]
  assert.equal(nothingNew(records, records.slice(3)), false, "the person's text is something to read")
  assert.equal(lastReadable(records), 5)
})

test("a hand-over waiting for the round's turn to end leaves that turn the round's", async () => {
  const { ownRounds, nothingNew } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "session", event: "end" },
    { n: 4, k: "handover", about: "work", sent: true, text: "the logs come first" },
    { n: 5, k: "session", event: "start" },
    { n: 6, k: "tool", tool: "subagent", input: { prompt: "opencode-retro work order: read /x.md and do what it says." } },
    { n: 7, k: "handover", about: "lesson", sent: true, text: "a lesson" },
    { n: 8, k: "text", text: "reader 1 done" },
    { n: 9, k: "tool", tool: "glob", input: { pattern: ".retro/work/*" } },
    { n: 10, k: "session", event: "end" },
  ]
  const { steps, ranges } = ownRounds(records)
  assert.ok(steps.has(8) && steps.has(9), "the round's turn goes on past the waiting hand-over")
  assert.deepEqual(ranges, [[4, 10]])
  assert.equal(nothingNew(records, records.slice(3)), true, "nothing of the person's was added")
})

/* Round 7 of 10. */

test("a /retro run again after an undelivered one has its round", async () => {
  const { ownRounds, nothingNew } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "tool", tool: "read", input: { path: "a.js" } },
    { n: 3, k: "session", event: "end" },
    { n: 4, k: "handover", about: "work", sent: true, text: "the logs come first" },
    { n: 5, k: "handover", about: "notice", undelivered: true, of: 4, text: "could not be delivered" },
    { n: 6, k: "handover", about: "work", sent: true, text: "the logs come first" },
    { n: 7, k: "session", event: "start" },
    { n: 8, k: "text", text: "starting readers" },
    { n: 9, k: "tool", tool: "read", input: { path: ".retro/work/x.md" } },
    { n: 10, k: "tool", tool: "retro_propose", input: {} },
    { n: 11, k: "handover", about: "lesson", text: "a lesson" },
    { n: 12, k: "text", text: "here is the lesson" },
    { n: 13, k: "session", event: "end" },
  ]
  const { steps } = ownRounds(records)
  for (const n of [7, 8, 9]) assert.ok(steps.has(n), `step ${n} is the round's`)
  assert.equal(nothingNew(records, records.slice(3)), true, "a log grown by the round takes no order")
})

test("the person speaking before a waiting hand-over's turn makes that turn theirs", async () => {
  const { repliesToPlugin, lastReadable } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "tool", tool: "read", input: { path: "a.js" } },
    { n: 4, k: "handover", about: "lesson", sent: true, text: "a lesson" },
    { n: 5, k: "text", text: "fixed" },
    { n: 6, k: "session", event: "end" },
    { n: 7, k: "prompt", text: "now do X, that was wrong" },
    { n: 8, k: "session", event: "start" },
    { n: 9, k: "text", text: "you are right, X is done differently" },
    { n: 10, k: "session", event: "end" },
  ]
  assert.ok(!repliesToPlugin(records).has(9), "the answer to the person is theirs")
  assert.equal(lastReadable(records), 9)
})

test("the contract says the agent's text answering a notice is not the session's", async () => {
  const { OUTPUT_CONTRACT } = await import("../src/contract.js")
  assert.match(OUTPUT_CONTRACT, /ordinary work, but for the agent's text in answer to it/)
})

/* Round 8 of 10. */

test("a /retro waiting behind a round keeps its own round when the first one ends first", async () => {
  const { ownRounds, repliesToPlugin } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "tool", tool: "read", input: { path: "a.js" } },
    { n: 4, k: "session", event: "end" },
    { n: 5, k: "handover", about: "work", sent: true, text: "the logs come first" },
    { n: 6, k: "session", event: "start" },
    { n: 7, k: "tool", tool: "subagent", input: { prompt: "opencode-retro work order: read /x.md and do what it says." } },
    { n: 8, k: "handover", about: "work", sent: true, text: "the logs come first" },
    { n: 9, k: "tool", tool: "retro_propose", input: {} },
    { n: 10, k: "handover", about: "lesson", text: "a lesson" },
    { n: 11, k: "text", text: "here is the lesson" },
    { n: 12, k: "session", event: "end" },
    { n: 13, k: "session", event: "start" },
    { n: 14, k: "text", text: "starting readers" },
    { n: 15, k: "tool", tool: "read", input: { path: ".retro/work/y.md" } },
    { n: 16, k: "session", event: "end" },
  ]
  const { steps } = ownRounds(records)
  for (const n of [13, 14, 15]) assert.ok(steps.has(n), `step ${n} is the second round's`)
  assert.ok(!steps.has(11), "the review of the lesson is not a round")
  assert.ok(repliesToPlugin(records).has(11))
})

/* Round 9 of 10. */

test("the contract describes a round as the code reads it, and defers to the order's list", async () => {
  const { OUTPUT_CONTRACT } = await import("../src/contract.js")
  assert.match(OUTPUT_CONTRACT, /at the hand-over itself when it came between turns/)
  assert.match(OUTPUT_CONTRACT, /A prompt of the person's with no `session` record between it and the round's turn start —\s+the person opening that turn — makes the turn theirs/)
  assert.match(OUTPUT_CONTRACT, /go by the list/)
})

/* Round 10 of 10. */

test("the askings add up in the session /retro runs in, which its own rounds lengthen", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  for (let i = 0; i < 3; i++) await retro(fake, { invoker: "ses_a" })

  const last = await retro(fake, { invoker: "ses_a" })
  assert.equal(last.paths.length, 1, "still asked about")
  assert.match(state(dir).extracted.ses_a.detail, /asked 3 times and no record came back/)
  await cleanup?.()
})

/* After the ten rounds: the self-check reads a hand-over's turn as rounds and replies do. */

test("the self-check reads which turn a hand-over started as rounds and replies do", async () => {
  const { turnHandovers } = await import("../src/extract.js")
  const turn = (extra) => [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "handover", about: "lesson", sent: true, text: "a lesson" },
    { n: 4, k: "text", text: "fixed" },
    { n: 5, k: "session", event: "end" },
    ...extra,
    { n: 9, k: "session", event: "start" },
  ]
  assert.equal(turnHandovers(turn([])), 1, "waiting in the inbox, it is the next turn's input")
  assert.equal(turnHandovers(turn([{ n: 6, k: "prompt", text: "no, do X" }])), 0, "the person spoke first: their turn")
  assert.equal(
    turnHandovers([
      { n: 1, k: "prompt", text: "fix bug" },
      { n: 2, k: "session", event: "start" },
      { n: 3, k: "session", event: "end" },
      { n: 4, k: "handover", about: "work", sent: true, text: "the logs come first" },
      { n: 5, k: "handover", about: "notice", undelivered: true, of: 4, text: "could not be delivered" },
      { n: 6, k: "session", event: "start" },
    ]),
    0,
    "one never delivered started nothing",
  )
  assert.equal(
    turnHandovers([
      { n: 1, k: "prompt", text: "fix bug" },
      { n: 2, k: "session", event: "start" },
      { n: 3, k: "handover", about: "lesson", text: "a lesson" },
      { n: 4, k: "session", event: "end" },
      { n: 5, k: "session", event: "start" },
    ]),
    0,
    "one handed back as a tool result answered the turn it was in",
  )
})

test("the person steering into the running turn leaves a waiting /retro its round", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "handover", about: "work", sent: true, text: "the logs come first" },
    { n: 4, k: "prompt", text: "and check the tests too", delivery: "steer" },
    { n: 5, k: "tool", tool: "shell", input: { command: "npm test" }, exit: 0 },
    { n: 6, k: "session", event: "end" },
    { n: 7, k: "session", event: "start" },
    { n: 8, k: "text", text: "starting readers" },
    { n: 9, k: "session", event: "end" },
  ]
  const { steps } = ownRounds(records)
  assert.ok(steps.has(7) && steps.has(8), "the turn the hand-over waited for is the round")
  assert.ok(!steps.has(5), "the steered turn is the person's")
})

test("a prompt that opens the next turn, after a turn whose end was lost, is the person's turn", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "tool", tool: "shell", input: { command: "npm test" }, exit: 2 },
    { n: 4, k: "handover", about: "work", sent: true, text: "the logs come first" },
    { n: 5, k: "prompt", text: "try again" },
    { n: 6, k: "session", event: "start" },
    { n: 7, k: "tool", tool: "shell", input: { command: "npm test" }, exit: 2 },
  ]
  assert.ok(!ownRounds(records).steps.has(7), "the person's work is not taken for a round")
})

/* Checks after the ten rounds. */

test("an undelivered notice cancels the hand-over it names, not the latest one", async () => {
  const { ownRounds, repliesToPlugin } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "handover", about: "work", sent: true, text: "the logs come first" },
    // Logged while the send above was still being awaited: the agent's own `retro_propose`.
    { n: 4, k: "handover", about: "lesson", text: "a lesson" },
    { n: 5, k: "handover", about: "notice", undelivered: true, of: 3, text: "could not be delivered" },
    { n: 6, k: "text", text: "here is the lesson" },
    { n: 7, k: "session", event: "end" },
    { n: 8, k: "session", event: "start" },
    { n: 9, k: "tool", tool: "shell", input: { command: "npm test" }, exit: 2 },
  ]
  assert.ok(repliesToPlugin(records).has(6), "the proposal handed back is still answered")
  assert.ok(!ownRounds(records).steps.has(9), "and the failed /retro opens no round")
})

test("a notice of a failed send names the hand-over by its step", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  fake.ctx.session.synthetic = async () => {
    throw new Error("session is gone")
  }
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go" } })
  await fake.commands.get("retro").execute({ sessionID: "ses_review", prompt: { text: "" } })
  const records = readFileSync(logOf(dir, "ses_review"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const handovers = records.filter((r) => r.k === "handover")
  assert.equal(handovers.at(-1).of, handovers.at(-2).n)
  await cleanup?.()
})

test("the askings start again for a log replaced under the same id", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.execution.succeeded")?.({ sessionID: "ses_a" })
  for (let i = 0; i < 3; i++) await retro(fake)
  assert.match(state(dir).extracted.ses_a.detail, /asked 2 times/)
  // Pruned and written again: a new first line, a new file — smaller than the old, so its size
  // says nothing about whether it grew.
  const fresh = [
    { v: 1, n: 1, t: 1, k: "prompt", text: "a new task" },
    { v: 1, n: 2, t: 2, k: "tool", tool: "shell", id: "c9", input: { command: "make" }, exit: 2 },
  ]
  writeFileSync(logOf(dir, "ses_a"), fresh.map((l) => JSON.stringify(l)).join("\n") + "\n")
  await retro(fake)
  await retro(fake)
  assert.match(state(dir).extracted.ses_a.detail, /asked 1 time and/, "the new log has been asked about once")
  await cleanup?.()
})

test("reads that covered nothing add up in the session /retro runs in, and set it aside", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  for (let i = 0; i < 3; i++) {
    await retro(fake, { invoker: "ses_a" })
    await record(fake, "ses_a", [], { through: 0, dir })
  }
  assert.equal(state(dir).extracted.ses_a?.setAside, true, JSON.stringify(state(dir).looked.ses_a))
  await cleanup?.()
})

test("an asking that was answered is not counted among those nobody answered", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await retro(fake, { invoker: "ses_a" })
  await record(fake, "ses_a", [], { through: 2, dir })
  assert.equal(state(dir).looked.ses_a?.open, true, "a partial read leaves the rest owed")
  await retro(fake, { invoker: "ses_a" })
  await retro(fake, { invoker: "ses_a" })
  assert.match(state(dir).extracted.ses_a.detail, /asked 1 time and no record came back/)
  await cleanup?.()
})

test("the report's own writes do not keep the session it describes from being measured", async () => {
  const real = Date.now
  let now = Date.parse("2026-10-25T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    await fake.hooks.get("session.prompt")({ sessionID: "ses_p", messageID: "m1", prompt: { text: "go" } })
    await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "opencode-retro work order: read /x/.retro/work/ses_q.md and do what it says." } })
    for (let i = 0; i < 4; i++) {
      // A write that measures nothing — a decision recorded, a reader's record — then a hook.
      now += 40_000
      await fake.tools.get("retro_decide").execute({ id: "no-such-lesson", status: "rejected" }, { sessionID: "ses_p" })
      now += 21_000
      const call = { sessionID: "ses_reader", id: `r${i}`, tool: "read", input: { path: "x" } }
      await fake.hooks.get("tool.execute.before")(call)
      await fake.hooks.get("tool.execute.after")({ ...call, status: "completed", result: { output: "y" } })
    }
    const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /verified\s+2026-10-25 10:04/, "measured again, not only the heartbeat")
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

test("the contract explains the field a round's start is read from", async () => {
  const { OUTPUT_CONTRACT } = await import("../src/contract.js")
  assert.match(OUTPUT_CONTRACT, /A hand-over with `"sent": true` was sent\s+to the session to start a turn/)
})

test("a turn whose start went unlogged is not excused by the hand-over that began the one before", async () => {
  const { turnHandovers } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "session", event: "end" },
    { n: 4, k: "handover", about: "lesson", sent: true, text: "a lesson" },
    { n: 5, k: "session", event: "start" },
    { n: 6, k: "text", text: "the lesson says…" },
    { n: 7, k: "session", event: "end" },
    // A new process, which did not own the session when its turn started: no start record.
    { n: 8, k: "tool", tool: "read", input: { path: "a.js" } },
    { n: 9, k: "session", event: "end" },
  ]
  assert.equal(turnHandovers(records), 0)
})

test("the session's line reports an asking nobody answered, not just that the log waits", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go" } })
  await retro(fake)
  await record(fake, "ses_a", [], { dir })
  await work(fake, "ses_a")
  await retro(fake)
  // The round ends with nobody having answered: settled as unanswered, and nothing issued since.
  await propose(fake)
  // ses_a working again a minute later, measured afresh.
  const real = Date.now
  Date.now = () => real() + 61_000
  try {
    await fake.hooks.get("session.prompt")({ sessionID: "ses_a", messageID: "m9", prompt: { text: "and now" } })
  } finally {
    Date.now = real
  }
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /measured on session\s+`ses_a`/)
  assert.match(report, /extraction\s+asked 1 time and no record came back/, report)
  await cleanup?.()
})

test("a log with no turn start at all is not excused by hand-overs from turns long gone", async () => {
  const { turnHandovers } = await import("../src/extract.js")
  const records = [
    // Every start dropped: the prompt hook dead, so a session owned only from its first tool call.
    { n: 1, k: "tool", tool: "read", input: { path: "a.js" } },
    { n: 2, k: "session", event: "end" },
    { n: 3, k: "handover", about: "lesson", sent: true, text: "a lesson" },
    { n: 4, k: "text", text: "the lesson says…" },
    { n: 5, k: "session", event: "end" },
    { n: 6, k: "tool", tool: "read", input: { path: "b.js" } },
  ]
  assert.equal(turnHandovers(records), 0)
  assert.equal(turnHandovers(records.slice(0, 4)), 1, "while its own turn runs, the hand-over is its input")
})

test("a /retro sent between the person's prompt and the turn it opens takes nothing of that turn", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "session", event: "end" },
    { n: 4, k: "prompt", text: "now fix the build" },
    { n: 5, k: "handover", about: "work", sent: true, text: "the logs come first" },
    { n: 6, k: "session", event: "start" },
    { n: 7, k: "tool", tool: "shell", input: { command: "npm run build" }, exit: 1 },
    { n: 8, k: "text", text: "the build fails because…" },
    { n: 9, k: "session", event: "end" },
  ]
  const { steps } = ownRounds(records)
  assert.ok(!steps.has(7) && !steps.has(8), "the person's turn is theirs")
})

test("an order still waiting lists the lessons a reader before it recorded", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await work(fake, "ses_b")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go" } })
  const round = await retro(fake)
  const waiting = round.paths.find((p) => p.endsWith("ses_b.md"))
  assert.ok(waiting, round.handover)
  assert.doesNotMatch(readFileSync(waiting, "utf8"), /lint-skill-no-config/)
  await record(fake, "ses_a", [LESSON], { dir })
  const order = readFileSync(waiting, "utf8")
  assert.match(order, /`lint-skill-no-config` \(seen in 1\)/, "the next reader is told what the last one found")
  assert.match(order, /read tool/, "and how to look for itself")
  await cleanup?.()
})

test("a reader started by a work order's line is the plugin's, recognised by its prompt or not", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "tool", tool: "read", input: { path: "a.js" } },
    { n: 4, k: "prompt", from: "ses_r", text: "go and read it" },
    { n: 5, k: "tool", from: "ses_r", tool: "read", input: { path: "/p/.retro/sessions/ses_other.jsonl" } },
    { n: 6, k: "text", from: "ses_r", text: "ses_other hit the lint trap" },
    { n: 7, k: "tool", tool: "subagent", child: "ses_r", input: { prompt: "opencode-retro work order: read /p/.retro/work/ses_other.md and do what it says." } },
  ]
  const { steps } = ownRounds(records)
  for (const n of [4, 5, 6, 7]) assert.ok(steps.has(n), `step ${n} is the reader's`)
  assert.ok(!steps.has(3))
})

test("what a reworded reader starts after an early retro_propose is the plugin's too", async () => {
  const { ownRounds } = await import("../src/extract.js")
  const records = [
    { n: 1, k: "prompt", text: "fix bug" },
    { n: 2, k: "session", event: "start" },
    { n: 3, k: "session", event: "end" },
    { n: 4, k: "handover", about: "work", sent: true, text: "the logs come first" },
    { n: 5, k: "session", event: "start" },
    { n: 6, k: "prompt", from: "ses_c", text: "please analyse that log" },
    { n: 7, k: "tool", tool: "retro_propose", input: {} },
    { n: 8, k: "handover", about: "lesson", text: "a lesson" },
    { n: 9, k: "prompt", from: "ses_g", text: "grep the other log" },
    { n: 10, k: "tool", from: "ses_g", tool: "shell", input: { command: "grep lint ses_other.jsonl" }, exit: 1 },
    { n: 11, k: "tool", from: "ses_c", tool: "subagent", child: "ses_g", input: { prompt: "grep the other log" } },
  ]
  const { steps } = ownRounds(records)
  for (const n of [9, 10, 11]) assert.ok(steps.has(n), `step ${n} is the plugin's`)
})

test("the checks section agrees with the rest of the report after a decision and a prompt edit", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go" } })
  await retro(fake)
  await record(fake, "ses_a", [LESSON], { dir })
  await fake.tools.get("retro_decide").execute({ id: LESSON.id, status: "accepted", note: "done" }, { sessionID: "ses_review" })
  let report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /store\s+0 open lesson\(s\)/, report)
  // The person edits their criteria; the next write of the report says so, with no /retro.
  const prompt = join(dir, ".retro", "prompts", "extract.md")
  writeFileSync(prompt, readFileSync(prompt, "utf8") + "\nEvery ask begins with PINEAPPLE.\n")
  await fake.tools.get("retro_decide").execute({ id: "no-such", status: "rejected" }, { sessionID: "ses_review" })
  report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.match(report, /extract prompt\s+project \(base \d+, edited\)/, report)
  await cleanup?.()
})

test("a log passed over as one exchange, grown since by the plugin's round, says so on its line", async () => {
  const real = Date.now
  let now = Date.parse("2026-10-26T10:00:00Z")
  Date.now = () => now
  try {
    const dir = sandbox()
    const fake = fakeOpenCode({ directory: dir, agent: false })
    const cleanup = await plugin.setup(fake.ctx)
    await work(fake, "ses_a")
    await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "ready?" } })
    await retro(fake)
    now += 61_000
    await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "opencode-retro work order: read /x/.retro/work/ses_a.md and do what it says." } })
    const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
    assert.match(report, /measured on session\s+`ses_review`/, report)
    assert.match(report, /one exchange[^\n]*; what it holds since is the plugin's own work/, report)
    await cleanup?.()
  } finally {
    Date.now = real
  }
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { parseFrontmatter } from "../src/frontmatter.js"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
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

test("a reworded delegation of a work order stays out of the person's log", async () => {
  // Second pre-release review: the hand-over asks for an exact prompt, but an agent may word the
  // delegation its own way. That was recognised by the order's path only while the order was
  // open — and by the time the `subagent` call returns, the reader has recorded and the order is
  // closed. So the plugin's own subagent call was written into the person's log, unpaired, for
  // the next analysis to read as their work. Which call is ours is decided once, when it starts.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const delegation = { sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Please read ${paths[0]} and follow it.` } }
  await fake.hooks.get("tool.execute.before")(delegation)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: delegation.input.prompt } })
  await record(fake, "ses_a", [LESSON], { dir }) // the reader answers; the order closes
  await fake.hooks.get("tool.execute.after")({ ...delegation, status: "completed", result: { output: "done", metadata: { sessionID: "ses_reader" } } })

  const records = readFileSync(logOf(dir, "ses_review"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.deepEqual(records.filter((r) => r.k === "tool").map((r) => r.tool), [], "no tool call of ours in the person's log")
  assert.equal(existsSync(logOf(dir, "ses_reader")), false, "and the reader has no log of its own")
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

test("a reworded delegation's reader stays out of the person's log, in the order the events arrive", async () => {
  // Third pre-release review, reproduced: the hooks arrive as before-hook, the reader's prompt,
  // `session.created` naming the parent, the reader's own tool calls, then the after-hook. With
  // the reader recognised only by the exact prescribed line, a reworded delegation left it
  // unrecognised at its first prompt — `session.created` then folded it into the person's log,
  // and the after-hook could not take those records back out.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)

  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const delegation = { sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Please read ${paths[0]} and follow it.` } }
  await fake.hooks.get("tool.execute.before")(delegation)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: delegation.input.prompt } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_reader", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reader", id: "rr1", tool: "read", input: { path: paths[0] } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_reader", id: "rr1", tool: "read", input: { path: paths[0] }, status: "completed", result: { output: "the order" } })
  await record(fake, "ses_a", [LESSON], { dir })
  await fake.hooks.get("tool.execute.after")({ ...delegation, status: "completed", result: { output: "done", metadata: { sessionID: "ses_reader" } } })

  const kinds = readFileSync(logOf(dir, "ses_review"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => r.k)
  assert.deepEqual(kinds.filter((k) => k !== "handover"), [], "nothing of the reader's — no prompt, no read — in the person's log")
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

test("own calls that never finish are bounded, so a later session quoting one is logged in the end", async () => {
  // Third pre-release review: an own call that never reached its after-hook stayed remembered
  // for the life of the process — and with it the prompt a fresh session is recognised by. Not
  // swept when its turn ends (the event stream lags the hooks, fifth review); bounded instead.
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

test("evidence that cites no steps is dated by what the reader read, not by what came after the order", async () => {
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

test("an own delegation whose after-hook outlives its turn is still ours", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const delegation = { sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Please read ${paths[0]} and follow it.` } }
  await fake.hooks.get("tool.execute.before")(delegation)
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 91 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.after")({ ...delegation, status: "error", result: { output: "interrupted" } })
  assert.deepEqual(kindsIn(dir, "ses_review").filter((r) => r.k === "tool"), [], "not in the person's log")
  await cleanup?.()
})

test("an own call run through Code Mode's execute is ours in both of its hook pairs", async () => {
  // Measured live (cycle 12's bench): the review log held an `execute` record wrapping
  // `retro_propose`, because the wrapper's hooks went the person's way.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const prompt = `Please read ${paths[0]} and follow it.`
  const inner = { sessionID: "ses_review", id: "x1", tool: "subagent", input: { agent: "general", prompt } }
  const wrapper = { sessionID: "ses_review", id: "x1", tool: "execute", input: { code: `await tools.subagent(${JSON.stringify(prompt)})` } }
  await fake.hooks.get("tool.execute.before")(inner)
  await fake.hooks.get("tool.execute.before")(wrapper)
  await fake.hooks.get("tool.execute.after")({ ...inner, status: "completed", result: { output: "done", metadata: { sessionID: "ses_reader" } } })
  await fake.hooks.get("tool.execute.after")({ ...wrapper, status: "completed", result: { output: "done" } })

  const propose = { sessionID: "ses_review", id: "x2", tool: "retro_propose", input: {} }
  const wrapped = { sessionID: "ses_review", id: "x2", tool: "execute", input: { code: "await tools.retro_propose({})" } }
  await fake.hooks.get("tool.execute.before")(propose)
  await fake.hooks.get("tool.execute.before")(wrapped)
  await fake.hooks.get("tool.execute.after")({ ...propose, status: "completed", result: { output: "ok" } })
  await fake.hooks.get("tool.execute.after")({ ...wrapped, status: "completed", result: { output: "ok" } })

  assert.deepEqual(kindsIn(dir, "ses_review").filter((r) => r.k === "tool"), [], "no wrapper of ours in the person's log")
  await cleanup?.()
})

test("a reader whose prompt reads nothing like the delegation is still recognised by its parent", async () => {
  // Fourth pre-release review: recognising the reader by its prompt holds only while OpenCode
  // hands it the prompt verbatim. A parent whose only delegation in flight is ours needs no
  // wording at all.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const delegation = { sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Please read ${paths[0]}\nand follow it.` } }
  await fake.hooks.get("tool.execute.before")(delegation)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "You are a subagent spawned by another session.\nYour task is in a file." } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_reader", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reader", id: "rr1", tool: "read", input: { path: paths[0] } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_reader", id: "rr1", tool: "read", input: { path: paths[0] }, status: "completed", result: { output: "the order" } })
  await fake.hooks.get("tool.execute.after")({ ...delegation, status: "completed", result: { output: "done", metadata: { sessionID: "ses_reader" } } })

  assert.deepEqual(kindsIn(dir, "ses_review"), [], "nothing of the reader's in the person's log")
  assert.equal(existsSync(logOf(dir, "ses_reader")), false, "and no log of its own")
  await cleanup?.()
})

test("a person's call is not taken for ours because one of ours elsewhere has the same id", async () => {
  // Fourth pre-release review: ids were remembered without their session, and some providers
  // number calls per message.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "call_0", tool: "retro_propose", input: {} })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_person", messageID: "pm", prompt: { text: "run it" } })
  const shell = { sessionID: "ses_person", id: "call_0", tool: "shell", input: { command: "ls" } }
  await fake.hooks.get("tool.execute.before")(shell)
  await fake.hooks.get("tool.execute.after")({ ...shell, status: "completed", result: { output: "a b" } })
  assert.ok(kindsIn(dir, "ses_person").some((r) => r.k === "tool" && r.id === "call_0"), "the person's call is in their log")
  await cleanup?.()
})

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

test("an own delegation interrupted with its turn recognises nothing afterwards", async () => {
  // Third and sixth pre-release reviews: a call its turn ended in the middle of never reaches
  // its after-hook, and its prompt went on recognising fresh sessions — a person pasting the
  // same text later, or an interrupted call of theirs blocking recognition by parent for good.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  const prompt = `Please read ${paths[0]} and follow it.`
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt } })
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 91 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("session.prompt")({ sessionID: "ses_later", messageID: "l1", prompt: { text: prompt } })
  assert.ok(existsSync(logOf(dir, "ses_later")), "a session typed after the call was interrupted is the person's")
  await cleanup?.()
})

test("an interrupted call of the person's does not stop a later reader being recognised by its parent", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "read something" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "p1", tool: "read", input: { path: "x" } })
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 60 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  const { paths } = await retro(fake)
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Please read ${paths[0]}.` } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "Your task is in a file." } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_reader", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  assert.ok(!kindsIn(dir, "ses_review").some((r) => r.k === "prompt" && /Your task/.test(r.text)), "the reader is not in the person's log")
  await cleanup?.()
})

test("a Code Mode wrapper reported ahead of an own call leaves nothing unpaired in the person's log", async () => {
  // Sixth pre-release review: the wrapper's start was taken as the person's and left pending,
  // to be flushed into their log as an unpaired call when the session ended.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_person", messageID: "pm", prompt: { text: "go" } })
  const wrapper = { sessionID: "ses_person", id: "w1", tool: "execute", input: { code: "await tools.retro_propose({})" } }
  const inner = { sessionID: "ses_person", id: "w1", tool: "retro_propose", input: {} }
  await fake.hooks.get("tool.execute.before")(wrapper)
  await fake.hooks.get("tool.execute.before")(inner)
  await fake.hooks.get("tool.execute.after")({ ...inner, status: "completed", result: { output: "ok" } })
  await fake.hooks.get("tool.execute.after")({ ...wrapper, status: "completed", result: { output: "ok" } })
  fake.emit({ type: "session.execution.succeeded", durable: { seq: 70 }, data: { sessionID: "ses_person" } })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(kindsIn(dir, "ses_person").filter((r) => r.k === "tool"), [])
  await cleanup?.()
})

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

test("a reworded reader is not folded into the person's log while its delegation runs", async () => {
  // The order the events really arrive in for a reworded reader: its prompt, its creation
  // under the person's session, its own work — and a helper of its own — then the delegation's
  // end. Nothing of it may reach the person's log, at any point.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go on" } })
  const delegation = { sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Have a look at ${paths[0]}` } }
  await fake.hooks.get("tool.execute.before")(delegation)
  // The person's agent runs something of its own beside it.
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "own1", tool: "read", input: { path: "README.md" } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "You are a subagent spawned by another session.\nSee the file." } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_reader", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reader", id: "rr1", tool: "read", input: { path: paths[0] } })
  const help = { sessionID: "ses_reader", id: "rh", tool: "subagent", input: { agent: "explore", prompt: "skim it" } }
  await fake.hooks.get("tool.execute.before")(help)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_helper", messageID: "h1", prompt: { text: "You are a subagent spawned by another session.\nskim it" } })
  fake.emit({ type: "session.created", durable: { seq: 91 }, data: { sessionID: "ses_helper", parentID: "ses_reader", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.after")({ ...help, status: "completed", result: { output: "skimmed", metadata: { sessionID: "ses_helper" } } })
  assert.ok(!kindsIn(dir, "ses_review").some((r) => r.k === "prompt" && /See the file|skim it/.test(r.text)), "nothing of the reader's yet")
  let report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /ses_reader|ses_helper/, "and the report is not about it")
  await record(fake, "ses_a", [LESSON], { dir })
  // A call it started before it was known to be ours ends after.
  await fake.hooks.get("tool.execute.after")({ ...delegation, status: "completed", result: { output: "done", metadata: { sessionID: "ses_reader" } } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_reader", id: "rr1", tool: "read", input: { path: paths[0] }, status: "completed", result: { output: "the order" } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "own1", tool: "read", input: { path: "README.md" }, status: "completed", result: { output: "# hi" } })

  const theirs = kindsIn(dir, "ses_review")
  assert.ok(theirs.some((r) => r.k === "tool" && r.id === "own1"), "the person's own call is there")
  assert.ok(!theirs.some((r) => ["rr1", "rh", "d1"].includes(r.id) || /See the file|skim it/.test(r.text ?? "")), "nothing of ours is")
  assert.equal(existsSync(logOf(dir, "ses_reader")), false)
  assert.equal(existsSync(logOf(dir, "ses_helper")), false)
  report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  assert.doesNotMatch(report, /ses_reader|ses_helper/)
  await cleanup?.()
})

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

/* Tenth pre-release review: a deferred session is no session of its own. */

async function deferHelper(fake, dir) {
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

test("a deferred child's turn is a step, not a session", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await deferHelper(fake, dir)
  assert.doesNotMatch(readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8"), /ses_helper/, "the report is not about it")
  assert.ok(!("ses_helper" in (state(dir).counted ?? {})), "it did not age the workspace")
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" }, status: "completed", result: { output: "done", metadata: { sessionID: "ses_helper" } } })
  const kinds = kindsIn(dir, "ses_review").map((r) => r.k)
  assert.ok(kinds.includes("tool"), "adopted with its work")
  assert.ok(!kinds.includes("session"), `and no session start or end in the middle of the parent's turn: ${kinds}`)
  await cleanup?.()
})

test("a child nobody names by its parent's turn end is ours, even beside a delegation of the person's", async () => {
  // Rule 2, and its stated cost: with an interrupted turn running both kinds of delegation, a
  // child no delegation named is taken for ours — never left a session of its own, which a
  // delegation must not become (eleventh review), and never guessed at from what else ran.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await deferHelper(fake, dir)
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 95 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  assert.ok(!kindsIn(dir, "ses_review").some((r) => r.id === "hx"), "not adopted")
  assert.equal(existsSync(logOf(dir, "ses_helper")), false, "and no log of its own")
  const { paths } = await retro(fake, { invoker: "ses_other" })
  assert.ok(!paths.some((path) => path.includes("ses_helper")), "so never asked about on its own")
  await cleanup?.()
})
test("a child left deferred with only our delegation beside it is taken for ours", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go on" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Have a look at ${paths[0]}` } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "See the file." } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_reader", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_reader", id: "rr", tool: "read", input: { path: paths[0] } })
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_reader", id: "rr", tool: "read", input: { path: paths[0] }, status: "completed", result: { output: "x" } })
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 95 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  assert.ok(!kindsIn(dir, "ses_review").some((r) => r.id === "rr" || /See the file/.test(r.text ?? "")), "nothing of it in the person's log")
  assert.equal(existsSync(logOf(dir, "ses_reader")), false, "nor a log of its own")
  await cleanup?.()
})

test("a deferred child keeps everything but its start and end", async () => {
  // Eleventh pre-release review: all its events were dropped — its answer, its steps, the seq
  // of its calls — when only its start and end are a step's.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await deferHelper(fake, dir)
  fake.emit({ type: "session.text.ended", durable: { seq: 93 }, data: { sessionID: "ses_helper", text: "there are two files" } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.after")({ sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" }, status: "completed", result: { output: "done", metadata: { sessionID: "ses_helper" } } })
  const theirs = kindsIn(dir, "ses_review")
  assert.ok(theirs.some((r) => r.k === "text" && /two files/.test(r.text)), "its answer came with it")
  assert.ok(!theirs.some((r) => r.k === "session"), "its start and end did not")
  await cleanup?.()
})

test("a deferred child is not counted as waiting while /retro would not ask about it", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await deferHelper(fake, dir)
  await record(fake, "ses_a", [], { dir }) // the one real order is answered; the report is rewritten
  const report = readFileSync(join(dir, ".retro", "selfcheck.md"), "utf8")
  // On disk: ses_a (read), ses_review (the person's, waiting) and ses_helper (deferred).
  assert.match(report, /- 1 log not analysed yet/, "the person's log is waiting, the deferred helper's is not")
  const { paths } = await retro(fake, { invoker: "ses_other" })
  assert.ok(!paths.some((path) => path.includes("ses_helper")), "and /retro does not ask about it either")
  await cleanup?.()
})

test("a child already adopted is not deferred by its creation arriving late", async () => {
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

test("a deferred child interrupted mid-call is adopted with the call, and the tool hook is not called dead", async () => {
  // Twelfth pre-release review, reproduced: adopted, its open call was lost from the log while
  // its event still counted, and the self-check called the tool hook dead.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await deferHelper(fake, dir)
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
test("a delegation of the person's that already named its child does not make a deferred reader theirs", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go on" } })
  const mine = { sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" } }
  await fake.hooks.get("tool.execute.before")(mine)
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Have a look at ${paths[0]}` } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "See the file." } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_reader", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  // The person's delegation ends and names its own child; ours is interrupted.
  await fake.hooks.get("tool.execute.after")({ ...mine, status: "completed", result: { output: "done", metadata: { sessionID: "ses_helper" } } })
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 95 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  assert.ok(!kindsIn(dir, "ses_review").some((r) => /See the file/.test(r.text ?? "")), "the reader is not the person's")
  assert.equal(existsSync(logOf(dir, "ses_reader")), false)
  await cleanup?.()
})

/* Thirteenth pre-release review. */

test("a person's call interrupted in an earlier turn does not make a later reader theirs", async () => {
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "explore" } })
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "old", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" } })
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 60 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  const { paths } = await retro(fake)
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Have a look at ${paths[0]}` } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "See the file." } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_reader", parentID: "ses_review", location: { directory: dir } } })
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 95 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  assert.ok(!kindsIn(dir, "ses_review").some((r) => /See the file/.test(r.text ?? "")), "the reader is not the person's")
  await cleanup?.()
})

/* Fourteenth pre-release review. */

test("under Code Mode a delegation that named its child is not counted as unsaid", async () => {
  // Reproduced by the review: the wrapper's after-hook names nothing, and arriving last it
  // counted the person's delegation as unsaid — so an interrupted reader of ours was theirs.
  const dir = sandbox()
  const fake = fakeOpenCode({ directory: dir, agent: false })
  const cleanup = await plugin.setup(fake.ctx)
  await work(fake, "ses_a")
  const { paths } = await retro(fake)
  await fake.hooks.get("session.prompt")({ sessionID: "ses_review", messageID: "rv", prompt: { text: "go on" } })
  const inner = { sessionID: "ses_review", id: "p1", tool: "subagent", input: { agent: "explore", prompt: "explore the repo" } }
  const wrapper = { sessionID: "ses_review", id: "p1", tool: "execute", input: { code: "await tools.subagent('explore')" } }
  await fake.hooks.get("tool.execute.before")(inner)
  await fake.hooks.get("tool.execute.before")(wrapper)
  await fake.hooks.get("tool.execute.before")({ sessionID: "ses_review", id: "d1", tool: "subagent", input: { agent: "general", prompt: `Have a look at ${paths[0]}` } })
  await fake.hooks.get("session.prompt")({ sessionID: "ses_reader", messageID: "r1", prompt: { text: "See the file." } })
  fake.emit({ type: "session.created", durable: { seq: 90 }, data: { sessionID: "ses_reader", parentID: "ses_review", location: { directory: dir } } })
  await new Promise((r) => setImmediate(r))
  await fake.hooks.get("tool.execute.after")({ ...inner, status: "completed", result: { output: "done", metadata: { sessionID: "ses_helper" } } })
  await fake.hooks.get("tool.execute.after")({ ...wrapper, status: "completed", result: { output: "done" } })
  fake.emit({ type: "session.execution.interrupted", durable: { seq: 95 }, data: { sessionID: "ses_review" } })
  await new Promise((r) => setImmediate(r))
  assert.ok(!kindsIn(dir, "ses_review").some((r) => /See the file/.test(r.text ?? "")), "the reader is not the person's")
  await cleanup?.()
})

/* Fifteenth pre-release review, over the whole series. */

test("evidence citing only steps past what the reader says it read is dated by its citation", async () => {
  // The upper bound alone was clamped to `through`, so a citation wholly past it matched no
  // record, came back undated, and reopened a decision.
  const { detail, reopened } = await citeAgainstDecision([[1, -60], [2, -50], [3, -40]], [3], { through: 2 })
  assert.equal(reopened, false, detail)
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
  assert.match(report, /No session of yours measured since the plugin loaded/)
  await cleanup?.()
})

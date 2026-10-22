import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.js"
import { fakeOpenCode } from "./fake-opencode.js"
import { parseShadowLog } from "../src/shadowlog.js"
import { parseFrontmatter } from "../src/frontmatter.js"

/**
 * The concepts, executed.
 *
 * Every defect the audit cycles found had one shape: some sequence of events, in some order,
 * leaves the plugin in a state an invariant in docs/concepts forbids. Agents reading code try
 * one or two sequences in their heads; the space is combinatorial, so each cycle walked into
 * corners the last one had not, and cycle 5 found twelve defects in code that had not
 * changed. This walks the space instead: random histories of turns, hooks, `/retro`,
 * decisions, restarts, crashes mid-answer, replaced logs and a model that sometimes answers
 * nothing — through the real entry point, against the shared fake — and checks the
 * invariants after every step. A failure is shrunk to the shortest history that still fails,
 * which is a ready-made regression test.
 *
 *   RETRO_MODEL_RUNS=2000 RETRO_MODEL_STEPS=60 npm test     a deeper walk
 *   RETRO_MODEL_SEED=1234 npm test                          replay one history
 *   RETRO_MODEL_HISTORY='[{"op":…}]' RETRO_MODEL_DEBUG=1 node --test test/model.test.js
 *                                                           replay a shrunk one, verbosely
 */

const RUNS = Number(process.env.RETRO_MODEL_RUNS ?? 60)
const STEPS = Number(process.env.RETRO_MODEL_STEPS ?? 40)
const ONLY_SEED = process.env.RETRO_MODEL_SEED ? Number(process.env.RETRO_MODEL_SEED) : null
const HISTORY = process.env.RETRO_MODEL_HISTORY ? JSON.parse(process.env.RETRO_MODEL_HISTORY) : null
const DEBUG = Boolean(process.env.RETRO_MODEL_DEBUG)
const debug = (...args) => DEBUG && console.error("  ·", ...args)
const POOL = ["ses_a", "ses_b", "ses_c"]
const LESSON_IDS = ["lesson-one", "lesson-two", "lesson-three"]
const MODEL = { providerID: "fake", id: "fake-model" }

/* ------------------------------------------------------------- determinism */

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hash = (text) => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * Time is a counter and timers never fire. A history is then a pure function of its actions:
 * the same list replays to the same files, which is what makes shrinking possible. It is also
 * how a crash is simulated — a model call that never settles leaves its `/retro` suspended
 * for good, exactly as a process that died would.
 */
function freezeTime() {
  const real = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  let clock = 1_800_000_000_000
  Date.now = () => (clock += 7)
  globalThis.setTimeout = () => ({ unref() {}, ref() {} })
  globalThis.clearTimeout = () => {}
  return () => {
    Date.now = real.now
    globalThis.setTimeout = real.setTimeout
    globalThis.clearTimeout = real.clearTimeout
  }
}
const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve))
}

/* ------------------------------------------------------------- histories */

/** A history is a list of fully specified actions, so it can be replayed and shrunk. */
function generate(seed, steps) {
  const r = rng(seed)
  const pick = (list) => list[Math.floor(r() * list.length)]
  const actions = [{ op: "options", maxInput: r() < 0.5 ? 4000 : 32000 }]
  for (let i = 0; i < steps; i++) {
    const roll = r()
    const s = pick(POOL)
    if (roll < 0.14) actions.push({ op: "prompt", s })
    else if (roll < 0.36) actions.push({ op: "tool", s, exit: r() < 0.5 ? 2 : 0, size: 40 + Math.floor(r() * 600) })
    else if (roll < 0.42) actions.push({ op: "text", s })
    else if (roll < 0.52) actions.push({ op: "end", s })
    else if (roll < 0.64) actions.push({ op: "retro", invoker: r() < 0.6 ? "ses_review" : s, all: r() < 0.3 })
    else if (roll < 0.72) actions.push({ op: "decide", pick: r(), status: pick(["accepted", "rejected", "later"]) })
    else if (roll < 0.8) actions.push({ op: "model", mode: pick(["ok", "ok", "ok", "empty", "prose"]) })
    else if (roll < 0.86) actions.push({ op: "restart" })
    else if (roll < 0.9) actions.push({ op: "crash", invoker: "ses_review" })
    else if (roll < 0.93) actions.push({ op: "replace", s })
    else actions.push({ op: "tool", s, exit: 2, size: 1200 })
  }
  return actions
}

/* ------------------------------------------------------------- the world */

// A hand-over is the plugin's own text: on its own it proves nothing (analysis.md), and when
// the agent works after it, it travels with that work. So it is not owed by itself.
const MATERIAL = new Set(["prompt", "text", "tool"])
const isMaterial = (r) => MATERIAL.has(r.k) || (r.k === "step" && r.files?.length)
/** One prompt and nothing done: the skip rule says such a log cannot hold evidence. */
const skippable = (records) =>
  records.filter((r) => r.k === "prompt").length <= 1 && !records.some((r) => r.k === "tool")

function createWorld() {
  const directory = mkdtempSync(join(tmpdir(), "retro-model-"))
  writeFileSync(join(directory, "AGENTS.md"), "always run the lint skill\n")
  const retro = join(directory, ".retro")
  const world = {
    directory,
    options: { model: MODEL, heartbeatMs: 0 },
    instance: null,
    mode: "ok",
    inTurn: new Set(),
    prompted: new Set(),
    calls: 0,
    /** session -> step numbers that reached a model which answered. */
    analysed: new Map(),
    /** session -> the records last seen in its log. */
    seen: new Map(),
    replaced: new Set(),
    generated: 0,
  }

  world.reply = async (input) => {
    world.generated++
    const prompt = input.prompt
    const session = (prompt.match(/id: (ses_\w+)/) ?? [])[1]
    debug(`model (${world.mode}) asked about ${session}: steps ${[...(prompt.split("## Log")[1]?.split("\n## ")[0] ?? "").matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]).join(",")}`)
    if (world.mode === "hang") return new Promise(() => {})
    if (world.mode === "empty") return ""
    if (world.mode === "prose") return "I think the session went fine overall."
    const logSection = prompt.split("## Log")[1]?.split("\n## ")[0] ?? ""
    const steps = [...logSection.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]))
    if (session) {
      const set = world.analysed.get(session) ?? new Set()
      for (const n of steps) set.add(n)
      world.analysed.set(session, set)
    }
    const h = hash(prompt)
    if (!steps.length || h % 3 === 0) return '```json\n{ "lessons": [] }\n```'
    const a = steps[h % steps.length]
    const b = steps[(h >>> 8) % steps.length]
    const lesson = {
      id: LESSON_IDS[(h >>> 4) % LESSON_IDS.length],
      statement: "the session kept running a linter this project does not have",
      steps: [Math.min(a, b), Math.max(a, b)],
      cost: 1 + (h % 5),
      confidence: 0.6,
      why: "seen in the log",
    }
    return "```json\n" + JSON.stringify({ lessons: [lesson] }) + "\n```"
  }

  world.start = async () => {
    const fake = fakeOpenCode({ directory, options: world.options, reply: world.reply })
    const cleanup = await plugin.setup(fake.ctx)
    world.instance = { fake, cleanup }
    await flush()
  }

  world.logPath = (s) => join(retro, "sessions", `${s}.jsonl`)
  world.readLog = (s) => (existsSync(world.logPath(s)) ? parseShadowLog(readFileSync(world.logPath(s), "utf8")) : null)
  // state.json exists only once something changed it, so a missing file is a clean state.
  world.state = () =>
    existsSync(join(retro, "state.json"))
      ? JSON.parse(readFileSync(join(retro, "state.json"), "utf8"))
      : { rejected: [], pending: [], extracted: {} }
  world.lessons = (where) => {
    const dir = join(retro, where)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parseFrontmatter(readFileSync(join(dir, f), "utf8")).data)
      .filter((l) => l?.id)
  }
  world.dispose = () => rmSync(directory, { recursive: true, force: true })
  return world
}

/* ------------------------------------------------------------- actions */

async function apply(world, action) {
  const fake = () => world.instance.fake
  const hooks = () => world.instance.fake.hooks
  const ensureTurn = async (s) => {
    if (world.inTurn.has(s)) return
    // A session always begins with a prompt, then its execution starts — the measured order.
    await hooks().get("session.prompt")({ sessionID: s, messageID: `m${++world.calls}`, prompt: { text: `do task ${world.calls}` } })
    world.prompted.add(s)
    fake().emit({ type: "session.execution.started", durable: { seq: world.calls }, data: { sessionID: s } })
    world.inTurn.add(s)
    await flush()
  }

  switch (action.op) {
    case "options":
      world.options.maxInput = action.maxInput
      return
    case "prompt":
      if (world.inTurn.has(action.s)) return
      return ensureTurn(action.s)
    case "tool": {
      await ensureTurn(action.s)
      const id = `c${++world.calls}`
      const input = { command: action.exit ? "npx eslint ." : "ls" }
      await hooks().get("tool.execute.before")({ sessionID: action.s, id, tool: "shell", input })
      fake().emit({ type: "session.tool.called", durable: { seq: world.calls }, data: { sessionID: action.s, id, input } })
      await hooks().get("tool.execute.after")({
        sessionID: action.s,
        id,
        tool: "shell",
        input,
        status: "completed",
        result: { output: { exit: action.exit, output: "x".repeat(action.size) }, metadata: { exit: action.exit } },
      })
      return flush()
    }
    case "text":
      await ensureTurn(action.s)
      fake().emit({
        type: "session.text.ended",
        durable: { seq: ++world.calls },
        data: { sessionID: action.s, assistantMessageID: `a${world.calls}`, text: `I tried again (${world.calls}).` },
      })
      return flush()
    case "end":
      if (!world.inTurn.has(action.s)) return
      fake().emit({ type: "session.execution.succeeded", durable: { seq: ++world.calls }, data: { sessionID: action.s } })
      world.inTurn.delete(action.s)
      return flush()
    case "retro": {
      const name = action.all ? "retro-all" : "retro"
      await fake().commands.get(name).execute({ sessionID: action.invoker, prompt: { text: "" } })
      return flush()
    }
    case "decide": {
      const open = world.lessons("lessons").filter((l) => ["new", "later", undefined, null].includes(l.status))
      if (!open.length) return
      const lesson = open[Math.floor(action.pick * open.length)]
      await fake().tools.get("retro_decide").execute(
        { id: lesson.id, status: action.status, note: "decided in the model test" },
        { sessionID: "ses_review" },
      )
      return flush()
    }
    case "model":
      world.mode = action.mode
      return
    case "restart":
      // A restart ends every session with the server: no end event reaches anybody.
      await world.instance.cleanup?.()
      world.inTurn.clear()
      return world.start()
    case "crash": {
      // `/retro` starts, the model never answers, and the process dies mid-call. The old
      // instance is abandoned rather than cleaned up: a dead process runs no `finally`.
      const before = world.mode
      world.mode = "hang"
      void fake().commands.get("retro").execute({ sessionID: action.invoker, prompt: { text: "" } })
      await flush(8)
      world.mode = before
      world.inTurn.clear()
      return world.start()
    }
    case "replace": {
      // Somebody else replaced the file while the plugin was down: a hand edit, a restore from
      // a backup. What was in the old file is no longer the plugin's to answer for; the new
      // file is. Replacing a log under a running plugin that is writing to it is outside the
      // contract (log.md: the plugin is the only writer of its logs), so the plugin is stopped
      // first and started after.
      if (world.inTurn.has(action.s) || !existsSync(world.logPath(action.s))) return
      await world.instance.cleanup?.()
      world.inTurn.clear()
      const lines = [
        { v: 1, n: 1, t: 1, k: "prompt", text: `a different task, replaced at ${world.calls}` },
        { v: 1, n: 2, t: 2, k: "tool", id: `r${world.calls}`, tool: "shell", input: { command: "make" }, status: "completed", exit: 2 },
        { v: 1, n: 3, t: 3, k: "session", event: "end", outcome: "succeeded" },
      ]
      writeFileSync(world.logPath(action.s), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
      world.analysed.set(action.s, new Set())
      world.seen.set(action.s, lines)
      world.replaced.add(action.s)
      return world.start()
    }
  }
}

/* ------------------------------------------------------------- invariants */

/**
 * Checked after every step. Each names the concept it comes from; a violation is reported
 * with the invariant's own words, so a failing run reads as the sentence it broke.
 */
function check(world) {
  const fail = (concept, sentence, detail) => {
    const err = new Error(`${concept}: ${sentence}\n  ${detail}`)
    err.invariant = `${concept}: ${sentence}`
    throw err
  }
  const retro = join(world.directory, ".retro")

  // state.md — the file is always readable, and the queue holds a session once.
  let state
  try {
    state = world.state()
  } catch (err) {
    fail("state", "state.json is always valid", String(err))
  }
  const pending = state.pending.map((p) => p.session)
  if (new Set(pending).size !== pending.length) fail("state", "a session is queued once", JSON.stringify(pending))

  // log.md — step numbers are unique within a file and increase.
  for (const s of [...POOL, "ses_review"]) {
    const records = world.readLog(s)
    if (!records) continue
    for (let i = 1; i < records.length; i++) {
      if (!(records[i].n > records[i - 1].n)) {
        fail("log", "step numbers are unique within a file and increase", `${s}: ${records.map((r) => r.n).join(",")}`)
      }
    }
  }

  // log.md — a log is pruned only when nothing can ask about it: everything material in it
  // reached a model that answered, or it could never hold evidence at all.
  for (const s of POOL) {
    const before = world.seen.get(s)
    const now = world.readLog(s)
    if (before && !now) {
      if (!skippable(before)) {
        const analysed = world.analysed.get(s) ?? new Set()
        const unread = before.filter((r) => isMaterial(r) && !analysed.has(r.n)).map((r) => r.n)
        if (unread.length) {
          fail("log", "a log is pruned only when nothing is owed for it", `${s} vanished with steps ${unread.join(",")} never analysed`)
        }
      }
      // A new file under this id starts its own numbering, so what was read of the old one
      // says nothing about it.
      world.analysed.delete(s)
    }
    if (now) world.seen.set(s, now)
    else world.seen.delete(s)
  }

  // lesson.md — evidence of an open lesson resolves to real records (decision 18).
  for (const lesson of world.lessons("lessons")) {
    if (!["new", "later", undefined, null].includes(lesson.status)) continue
    const evidence = Array.isArray(lesson.evidence) ? lesson.evidence : [lesson.evidence].filter(Boolean)
    for (const e of evidence) {
      if (!e?.session || e.released || world.replaced.has(e.session) || !Array.isArray(e.steps) || !e.steps.length) continue
      const records = world.readLog(e.session)
      if (!records) fail("lesson", "an open lesson's evidence resolves to a log on disk", `${lesson.id} cites ${e.session}, which is gone`)
      const ns = new Set(records.map((r) => r.n))
      for (const n of e.steps) {
        if (!ns.has(n)) fail("lesson", "an open lesson's evidence resolves to real records", `${lesson.id} cites ${e.session} step ${n}`)
      }
    }
  }

  // lesson.md — a rejected lesson never returns.
  const rejected = new Set((state.rejected ?? []).map((r) => r.id))
  for (const lesson of world.lessons("lessons")) {
    if (rejected.has(lesson.id)) fail("lesson", "a rejected lesson never returns", lesson.id)
  }

  // selfcheck.md — the hooks here always work, so the report may never call them broken.
  const report = existsSync(join(retro, "selfcheck.md")) ? readFileSync(join(retro, "selfcheck.md"), "utf8") : ""
  const broken = report.split("\n").find((l) => /BROKEN/.test(l))
  if (broken) fail("selfcheck", "the report may claim only what the traffic proved", broken.trim())

  // Nothing throws into the user's session or into the plugin log.
  const pluginLog = existsSync(join(retro, "plugin.log")) ? readFileSync(join(retro, "plugin.log"), "utf8") : ""
  const thrown = pluginLog.split("\n").find((l) => /TypeError|ReferenceError|RangeError|SyntaxError|is not a function|Cannot read/.test(l))
  if (thrown) fail("selfcheck", "a hook or command never throws", thrown.trim())
  for (const delivered of world.instance.fake.synthetic) {
    if (/`\/retro(-all)?` failed/.test(delivered.text)) fail("selfcheck", "a command never fails", delivered.text.slice(0, 200))
  }
}

/**
 * The strongest invariant only holds once the world is calm: every turn over, the model
 * answering. Then `/retro`, repeated until it stops spending anything, must leave nothing
 * owed — every material step of every log was analysed, or the log was given up on after
 * three failed attempts, or it could never hold evidence.
 */
async function quiesce(world) {
  world.mode = "ok"
  for (const s of [...world.inTurn]) await apply(world, { op: "end", s })
  let last = -1
  for (let i = 0; i < 40 && world.generated !== last; i++) {
    last = world.generated
    await apply(world, { op: "retro", invoker: `ses_quiet_${i}` })
    if (DEBUG) {
      const st = world.state()
      debug(`quiesce ${i}: pending ${JSON.stringify(st.pending)} extracted ${JSON.stringify(Object.fromEntries(Object.entries(st.extracted ?? {}).filter(([k]) => POOL.includes(k))))}`)
      for (const s of POOL) {
        const records = world.readLog(s)
        if (records) debug(`  ${s}: ${records.map((r) => `${r.n}${r.k[0]}`).join(" ")}  mark ${JSON.stringify(st.looked?.[s] ?? null)}`)
      }
    }
    check(world)
  }
  const state = world.state()
  for (const s of POOL) {
    const records = world.readLog(s)
    if (!records || skippable(records)) continue
    const retired = state.extracted?.[s]?.ok === false && !state.pending.some((p) => p.session === s)
    if (retired) continue
    const analysed = world.analysed.get(s) ?? new Set()
    const unread = records.filter((r) => isMaterial(r) && !analysed.has(r.n)).map((r) => r.n)
    if (unread.length) {
      const err = new Error(
        `analysis: once the world is calm, nothing is owed\n  ${s}: steps ${unread.join(",")} never reached a model that answered`,
      )
      err.invariant = "analysis: once the world is calm, nothing is owed"
      throw err
    }
  }
}

/* ------------------------------------------------------------- running */

async function run(actions) {
  const thaw = freezeTime()
  const world = createWorld()
  try {
    await world.start()
    for (let i = 0; i < actions.length; i++) {
      try {
        debug(`step ${i}: ${JSON.stringify(actions[i])}`)
        await apply(world, actions[i])
        if (DEBUG) {
          for (const s of POOL) {
            const records = world.readLog(s)
            if (records) debug(`  ${s}: ${records.map((r) => `${r.n}${r.k[0]}`).join(" ")}  mark ${JSON.stringify(world.state().looked?.[s] ?? null)}`)
          }
        }
        check(world)
      } catch (err) {
        err.step = i
        throw err
      }
    }
    await quiesce(world)
    return null
  } catch (err) {
    return err
  } finally {
    try {
      await world.instance?.cleanup?.()
    } catch {
      /* a crashed instance may not clean up */
    }
    thaw()
    world.dispose()
  }
}

/** Remove actions one at a time while the same invariant still fails. */
async function shrink(actions, invariant) {
  let current = actions
  let changed = true
  let budget = 300
  while (changed && budget > 0) {
    changed = false
    for (let i = current.length - 1; i >= 1 && budget > 0; i--) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)]
      budget--
      const err = await run(candidate)
      if (err?.invariant === invariant) {
        current = candidate
        changed = true
      }
    }
  }
  return current
}

test(`random histories never break an invariant in docs/concepts (${ONLY_SEED ?? `${RUNS} runs`} × ${STEPS} steps)`, async () => {
  if (HISTORY) {
    const err = await run(HISTORY)
    if (err) assert.fail(`the given history broke an invariant at step ${err.step ?? "quiesce"}:\n${err.message}`)
    return
  }
  const seeds = ONLY_SEED != null ? [ONLY_SEED] : Array.from({ length: RUNS }, (_, i) => 1000 + i)
  for (const seed of seeds) {
    const actions = generate(seed, STEPS)
    const err = await run(actions)
    if (!err) continue
    const minimal = err.invariant ? await shrink(actions, err.invariant) : actions
    const replay = await run(minimal)
    assert.fail(
      `seed ${seed} broke an invariant at step ${err.step ?? "quiesce"}:\n${err.message}\n\n` +
        `Shortest history that still breaks it (${minimal.length} actions):\n` +
        minimal.map((a, i) => `  ${String(i).padStart(2)} ${JSON.stringify(a)}`).join("\n") +
        `\n\nWhich, replayed, says:\n${replay?.message ?? "(passed on replay — a flaky failure, which is itself a finding)"}` +
        `\n\nTo replay it: RETRO_MODEL_HISTORY='${JSON.stringify(minimal)}' RETRO_MODEL_DEBUG=1 node --test test/model.test.js`,
    )
  }
})

/* ------------------------------------------------------------- found by walking */

/**
 * Histories the random walk found, shrunk, and kept. Each broke an invariant before its fix;
 * each is its own test so the concepts can cite it by name like any other.
 */
const FOUND = {
  "a log given up on stays on disk, even when another log's success runs the pruning": [
    { op: "options", maxInput: 4000 },
    { op: "tool", s: "ses_a", exit: 2, size: 1200 },
    { op: "crash", invoker: "ses_review" },
    { op: "model", mode: "prose" },
    { op: "retro", invoker: "ses_review", all: false },
    { op: "retro", invoker: "ses_c", all: false },
    { op: "retro", invoker: "ses_review", all: true },
  ],
  "a session skipped as one exchange is read from its start once it does real work": [
    { op: "options", maxInput: 4000 },
    { op: "text", s: "ses_a" },
    { op: "crash", invoker: "ses_review" },
    { op: "prompt", s: "ses_a" },
    { op: "retro", invoker: "ses_c", all: false },
  ],
  "material that arrives after failures gets attempts of its own": [
    { op: "options", maxInput: 32000 },
    { op: "model", mode: "prose" },
    { op: "tool", s: "ses_a", exit: 0, size: 611 },
    { op: "end", s: "ses_a" },
    { op: "retro", invoker: "ses_a", all: false },
    { op: "retro", invoker: "ses_review", all: false },
    { op: "tool", s: "ses_a", exit: 2, size: 406 },
    { op: "retro", invoker: "ses_a", all: false },
  ],
  "a log replaced by a smaller one is settled, and one command reads it once": [
    { op: "options", maxInput: 32000 },
    { op: "tool", s: "ses_c", exit: 2, size: 1200 },
    { op: "tool", s: "ses_c", exit: 2, size: 1200 },
    { op: "end", s: "ses_c" },
    { op: "replace", s: "ses_c" },
    { op: "retro", invoker: "ses_review", all: false },
  ],
}

for (const [title, actions] of Object.entries(FOUND)) {
  test(title, async () => {
    const err = await run(actions)
    assert.equal(err, null, err ? `${err.message}` : "")
  })
}

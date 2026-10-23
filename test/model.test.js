import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
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
 * changed. This walks the space instead: random histories of turns, hooks, delegations,
 * `/retro`, decisions, restarts, crashes mid-answer and mid-append, replaced logs, lesson
 * files and prompts edited by hand, weeks passing, a second plugin instance on the same
 * project in half the histories, and a model that sometimes answers nothing — through the
 * real entry
 * point, against the shared fake — and checks the invariants after every step. A failure is
 * shrunk to the shortest history that still fails, which is a ready-made regression test.
 *
 *   RETRO_MODEL_RUNS=1000 RETRO_MODEL_STEPS=60 npm test     a deeper walk
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
const LESSON_IDS = Array.from({ length: 40 }, (_, i) => `lesson-${i}`)

/**
 * Which branches the walk actually reached, across all runs. A clean walk proves nothing
 * about a branch no history got to, so the deep run says which ones it did.
 */
const COVERAGE = new Map()
const reached = (what) => COVERAGE.set(what, (COVERAGE.get(what) ?? 0) + 1)

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
 * the same list replays to the same files, which is what makes shrinking possible.
 *
 * Nothing in the plugin schedules anything any more — the one timer it ever had bounded a
 * model call it no longer makes — so the stub is here to keep that true: a timer appearing
 * in a run is a dependency on a clock, and it will never fire.
 */
const timers = new Set()
/** The world's clock, in ms. Starts at the real time, so files written in a run are recent. */
let clock = 0
const WEEK = 7 * 24 * 60 * 60 * 1000
function freezeTime() {
  const real = { Date: globalThis.Date, now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
  clock = Math.floor(real.now() / 1000) * 1000
  // `new Date()` reads the real clock, not `Date.now`, and a recorded date that differs per
  // run reaches the model's prompt — the same history then answered differently on replay.
  const RealDate = real.Date
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [clock += 7]))
    }
    static now() {
      return (clock += 7)
    }
  }
  timers.clear()
  globalThis.setTimeout = (fn) => {
    const t = { fn, unref() {}, ref() {} }
    timers.add(t)
    return t
  }
  globalThis.clearTimeout = (t) => void timers.delete(t)
  return () => {
    timers.clear()
    globalThis.Date = real.Date
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
  const forced = process.env.RETRO_MODEL_WRITERS ? Number(process.env.RETRO_MODEL_WRITERS) : null
  const roll = r()
  // Half the histories run two instances on the project: nothing about what is read or pruned
  // depends on one instance knowing the other's sessions (session.md). RETRO_MODEL_WRITERS
  // pins either case.
  const writers = forced ?? (roll < 0.5 ? 1 : 2)
  const w = () => (writers === 2 && r() < 0.5 ? 1 : 0)
  // A prolific history has a model that finds four to eight lessons a time and a human who
  // mostly defers: that is what fills the open set past its cap, a branch the ordinary
  // histories almost never reached.
  const prolific = r() < 0.2
  const actions = [{ op: "options", partial: r() < 0.5, writers, prolific }]
  const delegations = []
  let next = 0
  for (let i = 0; i < steps; i++) {
    const roll = r()
    const s = pick(POOL)
    if (roll < 0.12) actions.push({ op: "prompt", s, w: w() })
    else if (roll < 0.3) actions.push({ op: "tool", s, w: w(), exit: r() < 0.5 ? 2 : 0, size: 40 + Math.floor(r() * 600) })
    else if (roll < 0.35) actions.push({ op: "text", s, w: w() })
    else if (roll < 0.43) actions.push({ op: "end", s })
    else if (roll < 0.5) {
      // A delegation is two actions, so anything can happen between the child's work and
      // the parent learning its id — which is where the races are.
      const child = `${s}_sub${++next}`
      const nested = r() < 0.25 ? `${child}_sub${++next}` : null
      actions.push({ op: "delegate", s, child, nested, order: pick(["created", "prompt", "silent"]), w: w() })
      delegations.push({ s, child })
    } else if (roll < 0.54 && delegations.length) {
      const d = delegations.splice(Math.floor(r() * delegations.length), 1)[0]
      actions.push({ op: "linked", s: d.s, child: d.child })
    } else if (roll < 0.64) actions.push({ op: "retro", invoker: r() < 0.6 ? "ses_review" : s, all: r() < 0.3, w: w() })
    else if (roll < 0.71) {
      const status = prolific ? pick(["later", "later", "later", "accepted", "rejected"]) : pick(["accepted", "rejected", "later"])
      actions.push({ op: "decide", pick: r(), status, archived: r() < 0.15, w: w() })
    }
    else if (roll < 0.78) actions.push({ op: "model", mode: pick(["ok", "ok", "ok", "silent", "silent"]) })
    else if (roll < 0.84) actions.push({ op: "restart", w: w() })
    else if (roll < 0.86) actions.push({ op: "crash", invoker: "ses_review", w: w() })
    else if (roll < 0.88) actions.push({ op: "abandoned", invoker: r() < 0.6 ? "ses_review" : s, w: w() })
    else if (roll < 0.91) actions.push({ op: "replace", s })
    else if (roll < 0.925) actions.push({ op: "torn", s })
    else if (roll < 0.945) actions.push({ op: "edit", pick: r(), how: pick(["delete", "later", "nostatus", "body", "break"]) })
    else if (roll < 0.955) actions.push({ op: "reprompt", marker: `marker-${Math.floor(r() * 1e6)}` })
    else if (roll < 0.975) actions.push({ op: "week", days: pick([3, 6, 8, 8, 15]) })
    else actions.push({ op: "tool", s, w: w(), exit: 2, size: 1200 })
  }
  // Every delegation the parent finished is eventually reported; ones whose parent died with
  // a restart never are, and that is a documented limit (session.md: silence is ours).
  for (const d of delegations) actions.push({ op: "linked", s: d.s, child: d.child })
  return actions
}

/* ------------------------------------------------------------- the world */

// A hand-over is the plugin's own text: on its own it proves nothing (analysis.md), and when
// the agent works after it, it travels with that work. So it is not owed by itself.
const MATERIAL = new Set(["prompt", "text", "tool"])
const isMaterial = (r) => MATERIAL.has(r.k) || (r.k === "step" && r.files?.length)
/**
 * The material steps of a log, in context: a reply that answers the plugin's own hand-over is
 * the plugin talking to itself (analysis.md, "Skipped"), not something owed a model call.
 */
const materialSteps = (records) => {
  let answering = null
  const out = []
  for (const r of [...records].sort((a, b) => a.n - b.n)) {
    if (r.k === "prompt" || r.k === "handover") answering = r.k
    if (!isMaterial(r)) continue
    if (r.k === "text" && answering === "handover") continue
    out.push(r)
  }
  return out
}
/** One prompt and nothing done: the skip rule says such a log cannot hold evidence. */
const skippable = (records) =>
  records.filter((r) => r.k === "prompt").length <= 1 && !records.some((r) => r.k === "tool")

function createWorld() {
  const directory = mkdtempSync(join(tmpdir(), "retro-model-"))
  writeFileSync(join(directory, "AGENTS.md"), "always run the lint skill\n")
  const retro = join(directory, ".retro")
  const world = {
    directory,
    options: { heartbeatMs: 0 },
    writers: 1,
    /** One plugin instance per writer, all on the same project directory. */
    instances: [],
    /** How many times each instance has been started: a call begun on an older one is dead. */
    generation: [],
    /** session -> the instance it runs on. A session exists on one server. */
    home: new Map(),
    mode: "ok",
    /** Whether a subagent reads only part of a log and reports how far it got. */
    partial: false,
    inTurn: new Set(),
    calls: 0,
    /** session -> step numbers that reached a model which answered. */
    analysed: new Map(),
    /** session -> the records last seen in its log. */
    seen: new Map(),
    replaced: new Set(),
    /** Sessions whose log was given up on after three failures: allowed to go when quiet. */
    givenUp: new Set(),
    /** session -> { size, at }: when each log last changed, by the world's clock. */
    written: new Map(),
    /** file -> the text a hand edit left in it, unparseable: the user's, until they fix it. */
    broken: new Map(),
    /** session -> half-records a crash left in its log, which no write may swallow. */
    torn: new Map(),
    /** Set by the model when it was called in a way an invariant forbids. */
    violation: null,
    marker: null,
    /** child -> { parent, root, linked }: delegations, and whether the plugin was told. */
    children: new Map(),
    generated: 0,
    /** Branches this history reached, folded into COVERAGE when it ends. */
    saw: new Set(),
    inPrompt: false,
  }

  /**
   * One subagent reading one work order. `mode` is what becomes of the order:
   * `ok` records an answer, `silent` is a subagent that reads it and never records — the
   * answer it would have given is unusable — and `absent` is a round whose agent never
   * started a subagent at all, so this is not reached.
   */
  world.reply = async (input) => {
    world.generated++
    const prompt = input.prompt
    const session = (prompt.match(/id: (ses_\w+)/) ?? [])[1]
    // The order points at the log; the subagent opens it. `records` is what the fake read
    // there, and `analysedUpTo` is what the order said was already analysed — so the steps
    // this analysis is answering about are the ones past it.
    const from = Number((prompt.match(/Steps up to (\d+) were analysed before/) ?? [])[1] ?? 0)
    const all = input.records.filter((r) => (r.n ?? 0) > from).map((r) => r.n).sort((a, b) => a - b)
    /**
     * A subagent that reads only part of a long log, and reports how far it got. Half the
     * new steps, and only when there are enough of them to leave something behind: the
     * branch being covered is a mark left open with the rest of the log still owed.
     */
    const through = world.partial && all.length >= 4 ? all[Math.floor(all.length / 2)] : null
    const steps = through === null ? all : all.filter((n) => n <= through)
    if (through !== null) world.saw.add("part of a log was read, and said so")
    debug(`subagent (${world.mode}) read the order for ${session}: steps ${steps.join(",")}${through === null ? "" : ` (through ${through})`}`)
    world.saw.add(`a work order was read (${world.mode})`)
    if (world.marker && !prompt.includes(world.marker)) world.violation ??= `the order did not carry the edited prompt (${world.marker})`
    if (world.marker) world.saw.add("an edited prompt reached the order")
    if (from > 0) world.saw.add("a re-read from the mark")
    if (world.mode === "silent") return "I think the session went fine overall."
    if (session) {
      const set = world.analysed.get(session) ?? new Set()
      for (const n of steps) set.add(n)
      world.analysed.set(session, set)
    }
    /** Everything this answer returns carries the coverage it is claiming. */
    const answered = (answer) => (through === null ? answer : { answer, through })
    // Without the temporary directory's name, or the same history would answer differently
    // on every run and a shrunk failure would replay as a different one.
    const h = hash(prompt.split(world.directory).join(""))
    if (!steps.length || h % 4 === 0) return answered('```json\n{ "lessons": [] }\n```')
    // Ids the prompt names as already recorded, concluded or rejected: a real model refers
    // back to them, by `matches` or by reusing the id, and sometimes ignores the rejection.
    const known = [...prompt.matchAll(/^- `([a-z0-9-]+)`/gm)].map((m) => m[1])
    const lessons = []
    const count = world.prolific ? 4 + ((h >>> 3) % 5) : 1 + ((h >>> 3) % 4)
    for (let i = 0; i < count; i++) {
      const g = hash(`${h}:${i}`)
      const a = steps[g % steps.length]
      const b = steps[(g >>> 8) % steps.length]
      const reuse = known.length && g % 5 === 0 ? known[(g >>> 4) % known.length] : null
      lessons.push({
        id: reuse && g % 2 ? reuse : LESSON_IDS[(g >>> 4) % LESSON_IDS.length],
        ...(reuse && !(g % 2) ? { matches: reuse } : {}),
        statement: `the session kept running a linter this project does not have (${g % 7})`,
        steps: [Math.min(a, b), Math.max(a, b)],
        cost: 1 + (g % 5),
        confidence: 0.6,
        why: "seen in the log",
      })
    }
    return answered("```json\n" + JSON.stringify({ lessons }) + "\n```")
  }

  world.start = async (w) => {
    const fake = fakeOpenCode({
      directory,
      options: world.options,
      reply: world.reply,
      // `absent`: the agent in the session never starts a subagent, so the orders of that
      // round are answered by nobody. The next command has to settle them.
      agent: () => world.mode !== "absent",
    })
    const cleanup = await plugin.setup(fake.ctx)
    world.instances[w] = { fake, cleanup }
    world.generation[w] = (world.generation[w] ?? 0) + 1
    await flush()
  }
  world.on = (w) => world.instances[Math.min(w ?? 0, world.writers - 1)]
  /** The instance a session runs on, fixed by its first action. */
  world.homeOf = (s, w) => {
    if (!world.home.has(s)) world.home.set(s, Math.min(w ?? 0, world.writers - 1))
    return world.instances[world.home.get(s)]
  }

  world.logPath = (s) => join(retro, "sessions", `${s}.jsonl`)
  world.logs = () =>
    existsSync(join(retro, "sessions"))
      ? readdirSync(join(retro, "sessions")).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6))
      : []
  world.readLog = (s) => (existsSync(world.logPath(s)) ? parseShadowLog(readFileSync(world.logPath(s), "utf8")) : null)
  // state.json exists only once something changed it, so a missing file is a clean state.
  world.state = () =>
    existsSync(join(retro, "state.json"))
      ? JSON.parse(readFileSync(join(retro, "state.json"), "utf8"))
      : { rejected: [], extracted: {}, looked: {} }
  world.lessons = (where) => {
    const dir = join(retro, where)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parseFrontmatter(readFileSync(join(dir, f), "utf8")).data)
      .filter((l) => l?.id)
  }
  /**
   * The filesystem's clock is the world's: a log that changed is stamped with the world's
   * time, so "a week of silence" means a week of the world, not of the CPU. Run around every
   * action and every check.
   */
  world.sync = () => {
    for (const s of world.logs()) {
      let st
      try {
        st = statSync(world.logPath(s))
      } catch {
        continue
      }
      // By size and by stamp: a file replaced by one of the same size is a write too, and its
      // modification time is then the CPU's, not the world's.
      const held = world.written.get(s)
      if (held && held.size === st.size && held.mtimeMs === st.mtimeMs) continue
      const t = clock / 1000
      utimesSync(world.logPath(s), t, t)
      world.written.set(s, { size: st.size, at: clock, mtimeMs: statSync(world.logPath(s)).mtimeMs })
    }
  }
  world.dispose = () => rmSync(directory, { recursive: true, force: true })
  return world
}

/* ------------------------------------------------------------- actions */

async function apply(world, action) {
  world.sync()
  try {
    return await act(world, action)
  } finally {
    world.sync()
  }
}

async function act(world, action) {
  const prompt = async (s, inst, text) => {
    world.inPrompt = true
    await inst.fake.hooks.get("session.prompt")({ sessionID: s, messageID: `m${++world.calls}`, prompt: { text } })
    await flush()
    world.inPrompt = false
  }
  const tool = async (s, inst, { exit = 2, size = 100, name = "shell", input, result } = {}) => {
    const id = `c${++world.calls}`
    const args = input ?? { command: exit ? "npx eslint ." : "ls" }
    await inst.fake.hooks.get("tool.execute.before")({ sessionID: s, id, tool: name, input: args })
    inst.fake.emit({ type: "session.tool.called", durable: { seq: world.calls }, data: { sessionID: s, id, input: args } })
    return async (res) => {
      await inst.fake.hooks.get("tool.execute.after")({
        sessionID: s,
        id,
        tool: name,
        input: args,
        status: "completed",
        result: res ?? result ?? { output: { exit, output: "x".repeat(size) }, metadata: { exit } },
      })
    }
  }
  const ensureTurn = async (s, w) => {
    if (world.inTurn.has(s)) return
    const inst = world.homeOf(s, w)
    // A session always begins with a prompt, then its execution starts — the measured order.
    await prompt(s, inst, `do task ${world.calls}`)
    inst.fake.emit({ type: "session.execution.started", durable: { seq: world.calls }, data: { sessionID: s } })
    world.inTurn.add(s)
    await flush()
  }

  switch (action.op) {
    case "options":
      // What used to be `maxInput` — the budget that made an order an excerpt — is now a
      // subagent that reads part of a log and says so. Same branch to cover: a mark left
      // open, and the rest of the log still owed.
      world.partial = Boolean(action.partial)
      world.prolific = Boolean(action.prolific)
      world.writers = action.writers ?? 1
      return
    case "abandoned": {
      // `/retro` issues its orders and the agent in that session does nothing with them: it
      // was interrupted, it misread the hand-over, its subagents died. The orders stay open
      // until a later command settles them as a failed attempt.
      const inst = world.homeOf(action.invoker, action.w)
      const before = world.mode
      world.mode = "absent"
      await inst.fake.commands.get("retro").execute({ sessionID: action.invoker, prompt: { text: "" } })
      world.mode = before
      world.saw.add("a round was abandoned with its orders open")
      return flush()
    }
    case "prompt":
      if (world.inTurn.has(action.s)) return
      return ensureTurn(action.s, action.w)
    case "tool": {
      await ensureTurn(action.s, action.w)
      const finish = await tool(action.s, world.homeOf(action.s), action)
      await finish()
      return flush()
    }
    case "text": {
      await ensureTurn(action.s, action.w)
      const inst = world.homeOf(action.s)
      inst.fake.emit({
        type: "session.text.ended",
        durable: { seq: ++world.calls },
        data: { sessionID: action.s, assistantMessageID: `a${world.calls}`, text: `I tried again (${world.calls}).` },
      })
      return flush()
    }
    case "end": {
      if (!world.inTurn.has(action.s)) return
      world.homeOf(action.s).fake.emit({ type: "session.execution.succeeded", durable: { seq: ++world.calls }, data: { sessionID: action.s } })
      world.inTurn.delete(action.s)
      return flush()
    }
    case "delegate": {
      // A subagent runs in a session of its own. Its records belong to the root's log; the
      // three orders are the ones the API allows: `session.created` naming the parent first,
      // the child's own instruction first (the measured race), or no `session.created` at
      // all, so the parent's `subagent` result is the only route to the link.
      await ensureTurn(action.s, action.w)
      const inst = world.homeOf(action.s)
      const root = world.children.get(action.s)?.root ?? action.s
      const run = async (child, parent) => {
        world.home.set(child, world.home.get(action.s))
        world.children.set(child, { parent, root, linked: false })
        const created = () => {
          inst.fake.emit({
            type: "session.created",
            durable: { seq: ++world.calls },
            data: { sessionID: child, parentID: parent, location: { directory: world.directory } },
          })
          world.children.get(child).linked = true
        }
        if (action.order === "created") created()
        await flush()
        await prompt(child, inst, "You are a subagent spawned by another session.")
        if (action.order === "prompt") created()
        await flush()
        inst.fake.emit({ type: "session.execution.started", durable: { seq: ++world.calls }, data: { sessionID: child } })
        const finish = await tool(child, inst, { exit: 2, size: 120 })
        await finish()
        await flush()
        return () => inst.fake.emit({ type: "session.execution.succeeded", durable: { seq: ++world.calls }, data: { sessionID: child } })
      }
      // The parent's `subagent` call is open for the whole delegation and reports the child's
      // id when it finishes — in a later action, `linked`.
      const call = await tool(action.s, inst, { name: "subagent", input: { agent: "explore", description: "look around", prompt: "go" } })
      const home = world.home.get(action.s)
      world.children.set(`${action.child}#call`, { call, home, generation: world.generation[home] })
      const endChild = await run(action.child, action.s)
      if (action.nested) {
        const endNested = await run(action.nested, action.child)
        endNested()
        await flush()
        // A nested child is reported by its own parent's `subagent` result, at once.
        const nestedCall = await tool(action.child, inst, { name: "subagent", input: { agent: "explore", description: "deeper", prompt: "go" } })
        await nestedCall({ output: "done", metadata: { sessionID: action.nested } })
        world.children.get(action.nested).linked = true
      }
      endChild()
      return flush()
    }
    case "linked": {
      const pendingCall = world.children.get(`${action.child}#call`)
      if (!pendingCall || !world.children.has(action.child)) return
      world.children.delete(`${action.child}#call`)
      // If the parent's server died since, the call died with it and its result never arrives
      // — even if the parent session was prompted again on the server that came back.
      if (world.generation[pendingCall.home] !== pendingCall.generation) return
      if (!world.inTurn.has(action.s)) return
      await pendingCall.call({ output: "done", metadata: { sessionID: action.child } })
      world.children.get(action.child).linked = true
      return flush()
    }
    case "retro": {
      const inst = world.homeOf(action.invoker, action.w)
      const name = action.all ? "retro-all" : "retro"
      await inst.fake.commands.get(name).execute({ sessionID: action.invoker, prompt: { text: "" } })
      return flush()
    }
    case "decide": {
      // Usually an open lesson; sometimes one from the archive — an id the agent remembers
      // from an earlier hand-over, decided or evicted since.
      const pool = action.archived
        ? world.lessons("archive")
        : world.lessons("lessons").filter((l) => ["new", "later", undefined, null].includes(l.status))
      if (!pool.length) return
      const lesson = pool[Math.floor(action.pick * pool.length)]
      await world.on(action.w).fake.tools.get("retro_decide").execute(
        { id: lesson.id, status: action.status, note: "decided in the model test" },
        { sessionID: "ses_review" },
      )
      return flush()
    }
    case "model":
      world.mode = action.mode
      return
    case "week":
      // Time passes with nothing written: the only thing the plugin measures with a clock.
      clock += action.days * 24 * 60 * 60 * 1000
      if (action.days >= 7) world.saw.add("a week passed")
      return
    case "restart": {
      // A restart ends every session on that server: no end event reaches anybody.
      const w = Math.min(action.w ?? 0, world.writers - 1)
      await world.instances[w].cleanup?.()
      for (const s of [...world.inTurn]) if ((world.home.get(s) ?? 0) === w) world.inTurn.delete(s)
      return world.start(w)
    }
    case "crash": {
      // `/retro` issues its orders and the process dies before any of them is answered. The
      // old instance is abandoned rather than cleaned up: a dead process runs no `finally`,
      // and the orders it wrote are on disk with nobody left to answer them.
      const w = Math.min(action.w ?? 0, world.writers - 1)
      const before = world.mode
      world.mode = "absent"
      world.home.set(action.invoker, world.home.get(action.invoker) ?? w)
      void world.instances[world.home.get(action.invoker)].fake.commands
        .get("retro")
        .execute({ sessionID: action.invoker, prompt: { text: "" } })
      await flush(8)
      world.mode = before
      // A dead process's timers never fire.
      timers.clear()
      const dead = world.home.get(action.invoker)
      for (const s of [...world.inTurn]) if ((world.home.get(s) ?? 0) === dead) world.inTurn.delete(s)
      return world.start(dead)
    }
    case "torn": {
      // The process dies in the middle of an append: the log ends in half a record with no
      // newline, and the server that comes back appends after it.
      if (!existsSync(world.logPath(action.s))) return
      const dead = world.home.get(action.s) ?? 0
      appendFileSync(world.logPath(action.s), `{"v":1,"n":999999,"t":1,"k":"tool","id":"torn`)
      world.torn.set(action.s, (world.torn.get(action.s) ?? 0) + 1)
      world.saw.add("a log was torn by a crash mid-append")
      timers.clear()
      for (const s of [...world.inTurn]) if ((world.home.get(s) ?? 0) === dead) world.inTurn.delete(s)
      return world.start(dead)
    }
    case "edit": {
      // The user opens a lesson file, as the README invites them to.
      const dir = join(world.directory, ".retro", "lessons")
      if (!existsSync(dir)) return
      const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
      if (!files.length) return
      const file = join(dir, files[Math.floor(action.pick * files.length)])
      const text = readFileSync(file, "utf8")
      world.saw.add(`a lesson was edited by hand (${action.how})`)
      if (action.how === "delete") rmSync(file)
      else if (action.how === "later") writeFileSync(file, text.replace(/^status: .*$/m, "status: later"))
      else if (action.how === "nostatus") writeFileSync(file, text.replace(/^status: .*\n/m, ""))
      else if (action.how === "body") writeFileSync(file, text + "\nA note the user added by hand.\n")
      // A stray edit that breaks the frontmatter: the closing fence is gone.
      else writeFileSync(file, text.replace(/\n---\n/, "\n--\n"))
      // The user's own edits to a file they broke are theirs too: what is watched is whatever
      // they left there last, for as long as it does not read as a lesson.
      const now = existsSync(file) ? readFileSync(file, "utf8") : null
      if (now !== null && !parseFrontmatter(now).data?.id) world.broken.set(file, now)
      else world.broken.delete(file)
      return
    }
    case "reprompt": {
      // The user rewrites what counts as a lesson; the next analysis must be given their words.
      const file = join(world.directory, ".retro", "prompts", "extract.md")
      if (!existsSync(file)) return
      writeFileSync(file, readFileSync(file, "utf8").replace(/\n*$/, `\n\nAlso: ${action.marker}\n`))
      world.marker = action.marker
      return
    }
    case "replace": {
      // Somebody else replaced the file while the plugin was down: a hand edit, a restore from
      // a backup. What was in the old file is no longer the plugin's to answer for; the new
      // file is. Replacing a log under a running plugin that is writing to it is outside the
      // contract (log.md: the plugin is the only writer of its logs), so every instance is
      // stopped first and started after.
      if (world.inTurn.has(action.s) || !existsSync(world.logPath(action.s))) return
      for (const inst of world.instances) await inst.cleanup?.()
      world.inTurn.clear()
      const lines = [
        // Unique per replacement: a byte-identical file *is* the same log (log.md: identity is
        // the first record), and the plugin is right to treat it as already read.
        { v: 1, n: 1, t: 1, k: "prompt", text: `a different task, replacement ${++world.calls}` },
        { v: 1, n: 2, t: 2, k: "tool", id: `r${world.calls}`, tool: "shell", input: { command: "make" }, status: "completed", exit: 2 },
        { v: 1, n: 3, t: 3, k: "session", event: "end", outcome: "succeeded" },
      ]
      writeFileSync(world.logPath(action.s), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
      world.analysed.set(action.s, new Set())
      world.seen.set(action.s, lines)
      world.replaced.add(action.s)
      world.torn.delete(action.s)
      for (let w = 0; w < world.writers; w++) await world.start(w)
      return
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
  const isChild = (s) => world.children.has(s) && !s.includes("#")

  world.sync()
  const linked = (s) => isChild(s) && world.children.get(s).linked

  // state.md — the file is always readable.
  let state
  try {
    state = world.state()
  } catch (err) {
    fail("state", "state.json is always valid", String(err))
  }
  for (const [id, x] of Object.entries(state.extracted ?? {})) if (x?.ok === false) world.givenUp.add(id)
  for (const inst of world.instances) {
    for (const d of inst.fake.synthetic) {
      for (const m of d.text.matchAll(/`(ses_\w+)`: given up after three failed analyses/g)) world.givenUp.add(m[1])
    }
  }

  const logs = world.logs()

  // log.md — step numbers are unique within a file and increase.
  for (const s of logs) {
    const records = world.readLog(s)
    for (let i = 1; i < records.length; i++) {
      if (!(records[i].n > records[i - 1].n)) {
        fail("log", "step numbers are unique within a file and increase", `${s}: ${records.map((r) => r.n).join(",")}`)
      }
    }
  }

  // session.md — a delegation whose link the plugin was told is never a session of its own:
  // no log under its id, not counted.
  for (const s of world.children.keys()) {
    if (!linked(s)) continue
    if (logs.includes(s)) fail("session", "a delegation is never a session of its own", `${s} still has a log`)
    const counted = state.counted ?? {}
    const uncounted = new Set(state.uncounted ?? [])
    if (Object.hasOwn(counted, s) && !uncounted.has(s)) fail("session", "a delegation is never a session of its own", `${s} is counted`)
  }

  // log.md — a log is pruned only when nothing can ask about it: everything material in it
  // reached a model that answered, or it could never hold evidence at all. A linked child's
  // log does not vanish, it moves: its records are in the root's log now.
  for (const s of new Set([...world.seen.keys(), ...logs])) {
    const before = world.seen.get(s)
    const now = logs.includes(s) ? world.readLog(s) : null
    if (before && !now && !linked(s)) {
      // session.md — a log written in the last seven days is never pruned.
      const last = world.written.get(s)?.at ?? 0
      if (clock - last < WEEK) {
        fail("session", "a log written in the last seven days is not pruned", `${s} last written ${Math.round((clock - last) / 3600000)}h before it vanished`)
      }
      // A log given up on after three failures is not owed, and goes once it is quiet like any
      // other (log.md, "Retired"). The outcome that says so is compacted with the log in the
      // same command, so it is remembered here from the reports and from earlier checks.
      if (!skippable(before) && !world.givenUp.has(s)) {
        const analysed = world.analysed.get(s) ?? new Set()
        const unread = materialSteps(before).filter((r) => !analysed.has(r.n)).map((r) => r.n)
        if (unread.length) {
          fail("log", "a log is pruned only when nothing is owed for it", `${s} vanished with steps ${unread.join(",")} never analysed`)
        }
      }
    }
    // log.md — a log is append-only: while it is the same file, every record once in it stays.
    if (before && now && JSON.stringify(before[0]) === JSON.stringify(now[0])) {
      const kept = new Set(now.map((r) => JSON.stringify(r)))
      const lost = before.filter((r) => !kept.has(JSON.stringify(r)))
      if (lost.length) fail("log", "a log is append-only", `${s} lost ${lost.map((r) => `${r.n}${r.k}`).join(",")}`)
    }
    // log.md — a record written after a crash survives the half-record the crash left: the
    // only record a torn append may lose is its own.
    if (now) {
      const text = readFileSync(world.logPath(s), "utf8")
      const started = (text.match(/\{"v":/g) ?? []).length
      if (started > now.length + (world.torn.get(s) ?? 0)) {
        fail("log", "a crash mid-append loses at most the record being written", `${s}: ${started} records begun, ${now.length} readable`)
      }
    }
    if (before && !now) world.analysed.delete(s) // a new file under this id numbers afresh
    if (!now) world.torn.delete(s)
    if (now) world.seen.set(s, now)
    else {
      world.seen.delete(s)
      world.written.delete(s)
    }
  }

  if (world.violation) fail("prompts", "only the user's prose reaches the model", world.violation)

  // lesson.md — a file the user broke by hand is theirs until they fix it: never written
  // over, never moved, never deleted.
  for (const [file, text] of world.broken) {
    const now = existsSync(file) ? readFileSync(file, "utf8") : null
    if (now !== text) fail("lesson", "a lesson file the plugin cannot read is left as the user left it", `${file}: ${now === null ? "gone" : "rewritten"}`)
  }

  const lessons = world.lessons("lessons")
  const archived = world.lessons("archive")
  if (archived.some((l) => l.status === "new")) world.saw.add("the cap evicted a lesson")
  if (archived.some((l) => l.status === "accepted")) world.saw.add("a lesson was accepted")
  if (archived.some((l) => l.status === "rejected")) world.saw.add("a lesson was rejected")
  if (lessons.some((l) => l.reopenedFrom)) world.saw.add("a lesson was reopened")
  if (lessons.some((l) => (Array.isArray(l.evidence) ? l.evidence : []).some((e) => e?.released))) world.saw.add("earlier evidence was released")
  if (lessons.some((l) => (l.recurrence ?? 1) > 1)) world.saw.add("a lesson recurred")
  if (lessons.length > 30) world.saw.add("the open set went past thirty with `later`")
  for (const m of Object.values(state.looked ?? {})) {
    if (m?.open) world.saw.add("a mark was left open")
    if (m?.failed) world.saw.add("a mark recorded a failed read")
  }
  if (Object.values(state.extracted ?? {}).some((x) => x?.ok === false)) world.saw.add("a log was given up on")
  if ([...world.children.values()].some((c) => c?.linked)) world.saw.add("a delegation was folded into its root")

  // lesson.md — evidence of an open lesson resolves to real records (decision 18), except
  // evidence released while the lesson was closed, which is history.
  for (const lesson of lessons) {
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

  // lesson.md — recurrence is the number of independent sessions the problem appeared in.
  for (const lesson of [...lessons, ...archived]) {
    const evidence = Array.isArray(lesson.evidence) ? lesson.evidence : [lesson.evidence].filter(Boolean)
    const distinct = new Set(evidence.map((e) => e?.session).filter(Boolean)).size
    if ((lesson.recurrence ?? 1) !== distinct) {
      fail(
        "lesson",
        "recurrence is the number of independent sessions in the evidence",
        `${lesson.id}: recurrence ${lesson.recurrence}, sessions ${evidence.map((e) => e.session).join(",")}`,
      )
    }
  }

  // lesson.md — a lesson is open or archived, never both, and never twice in one place.
  const openIds = lessons.map((l) => l.id)
  const archivedIds = archived.map((l) => l.id)
  if (new Set(openIds).size !== openIds.length) fail("lesson", "a lesson is one file", `lessons/: ${openIds.join(",")}`)
  if (new Set(archivedIds).size !== archivedIds.length) fail("lesson", "a lesson is one file", `archive/: ${archivedIds.join(",")}`)
  const both = openIds.filter((id) => archivedIds.includes(id))
  if (both.length) fail("lesson", "a lesson is open or archived, never both", both.join(","))
  for (const l of archived) {
    if (!["accepted", "rejected", "new"].includes(l.status)) fail("lesson", "an archived lesson was decided or evicted", `${l.id}: ${l.status}`)
  }

  // lesson.md — the cap holds for everything but `later`, which is never evicted.
  const capped = lessons.filter((l) => l.status !== "later").length
  if (capped > 30) fail("lesson", "the open set is capped at thirty, `later` aside", `${capped} open lessons`)

  // lesson.md — a rejected lesson never returns.
  const rejected = new Set((state.rejected ?? []).map((r) => r.id))
  for (const lesson of lessons) {
    if (rejected.has(lesson.id)) fail("lesson", "a rejected lesson never returns", lesson.id)
  }

  // selfcheck.md — the hooks here always work, so the report may never call them broken.
  const report = existsSync(join(retro, "selfcheck.md")) ? readFileSync(join(retro, "selfcheck.md"), "utf8") : ""
  const broken = report.split("\n").find((l) => /BROKEN/.test(l))
  if (broken) fail("selfcheck", "the report may claim only what the traffic proved", broken.trim())

  // Nothing throws into the user's session or into the plugin log.
  const pluginLog = existsSync(join(retro, "plugin.log")) ? readFileSync(join(retro, "plugin.log"), "utf8") : ""
  if (/no record came back from its analysis/.test(pluginLog)) world.saw.add("an order was left unanswered")
  const thrown = pluginLog.split("\n").find((l) => /TypeError|ReferenceError|RangeError|SyntaxError|is not a function|Cannot read/.test(l))
  if (thrown) fail("selfcheck", "a hook or command never throws", thrown.trim())
  for (const inst of world.instances) {
    for (const delivered of inst.fake.synthetic) {
      if (/`\/retro(-all)?` failed/.test(delivered.text)) fail("selfcheck", "a command never fails", delivered.text.slice(0, 200))
    }
  }
}

/**
 * The strongest invariant only holds once the world is calm: every turn over, every
 * delegation reported, every order answered. Then `/retro`, repeated until it stops issuing
 * anything, must leave nothing owed — every material step of every log was recorded, or the
 * log was given up on after three failed attempts, or it could never hold evidence.
 */
async function quiesce(world) {
  world.mode = "ok"
  for (const [key, call] of [...world.children.entries()]) {
    if (!key.endsWith("#call")) continue
    const child = key.slice(0, -5)
    const parent = world.children.get(child)?.parent
    if (parent && world.inTurn.has(parent)) await apply(world, { op: "linked", s: parent, child })
  }
  for (const s of [...world.inTurn]) await apply(world, { op: "end", s })
  let last = -1
  for (let i = 0; i < 40 && world.generated !== last; i++) {
    last = world.generated
    await apply(world, { op: "retro", invoker: `ses_quiet_${i}`, w: i % world.writers })
    if (DEBUG) {
      const st = world.state()
      debug(`quiesce ${i}: looked ${JSON.stringify(st.looked)}`)
      for (const s of world.logs()) {
        const records = world.readLog(s)
        debug(`  ${s}: ${records.map((r) => `${r.n}${r.k[0]}`).join(" ")}  mark ${JSON.stringify(st.looked?.[s] ?? null)}`)
      }
    }
    check(world)
  }
  const state = world.state()
  for (const s of world.logs()) {
    const records = world.readLog(s)
    if (!records || skippable(records)) continue
    const mark = state.looked?.[s] ?? {}
    const owedNow = statSync(world.logPath(s)).size > (mark.size ?? 0) || mark.open || (mark.failed && (mark.attempts ?? 0) < 3)
    const retired = state.extracted?.[s]?.ok === false && !owedNow
    if (retired) continue
    const analysed = world.analysed.get(s) ?? new Set()
    const unread = materialSteps(records).filter((r) => !analysed.has(r.n)).map((r) => r.n)
    if (unread.length) {
      const err = new Error(
        `analysis: once the world is calm, nothing is owed\n  ${s}: steps ${unread.join(",")} were never recorded`,
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
    const writers = actions.find((a) => a.op === "options")?.writers ?? 1
    world.writers = writers
    for (let w = 0; w < writers; w++) await world.start(w)
    for (let i = 0; i < actions.length; i++) {
      try {
        debug(`step ${i}: ${JSON.stringify(actions[i])}`)
        await apply(world, actions[i])
        if (DEBUG) {
          for (const s of world.logs()) {
            const records = world.readLog(s)
            debug(`  ${s}: ${records.map((r) => `${r.n}${r.k[0]}`).join(" ")}  mark ${JSON.stringify(world.state().looked?.[s] ?? null)}`)
          }
        }
        check(world)
      } catch (err) {
        err.step = i
        throw err
      }
    }
    await quiesce(world)
    for (const what of world.saw) reached(what)
    reached("histories")
    return null
  } catch (err) {
    return err
  } finally {
    for (const inst of world.instances) {
      try {
        await inst?.cleanup?.()
      } catch {
        /* a crashed instance may not clean up */
      }
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

test(`random histories never break an invariant in docs/concepts (${ONLY_SEED ?? `${RUNS} runs`} × ${STEPS} steps)`, async (t) => {
  if (HISTORY) {
    const err = await run(HISTORY)
    if (err) assert.fail(`the given history broke an invariant at step ${err.step ?? "quiesce"}:\n${err.message}`)
    return
  }
  const seeds = ONLY_SEED != null ? [ONLY_SEED] : Array.from({ length: RUNS }, (_, i) => 1000 + i)
  t.after(() => {
    const total = COVERAGE.get("histories") ?? 0
    const lines = [...COVERAGE.entries()]
      .filter(([k]) => k !== "histories")
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${String(n).padStart(6)}  ${k}`)
    t.diagnostic(`branches reached, out of ${total} histories:`)
    for (const line of lines) t.diagnostic(line)
  })
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
    { op: "options", partial: true },
    { op: "tool", s: "ses_a", exit: 2, size: 1200 },
    { op: "crash", invoker: "ses_review" },
    { op: "model", mode: "silent" },
    { op: "retro", invoker: "ses_review", all: false },
    { op: "retro", invoker: "ses_c", all: false },
    { op: "retro", invoker: "ses_review", all: true },
  ],
  "a session skipped as one exchange is read from its start once it does real work": [
    { op: "options", partial: true },
    { op: "text", s: "ses_a" },
    { op: "crash", invoker: "ses_review" },
    { op: "prompt", s: "ses_a" },
    { op: "retro", invoker: "ses_c", all: false },
  ],
  "material that arrives after failures gets attempts of its own": [
    { op: "options", partial: false },
    { op: "model", mode: "silent" },
    { op: "tool", s: "ses_a", exit: 0, size: 611 },
    { op: "end", s: "ses_a" },
    { op: "retro", invoker: "ses_a", all: false },
    { op: "retro", invoker: "ses_review", all: false },
    { op: "tool", s: "ses_a", exit: 2, size: 406 },
    { op: "retro", invoker: "ses_a", all: false },
  ],
  "an interrupted turn with a subagent still running is not a dead tool hook": [
    { op: "options", partial: false, writers: 1 },
    { op: "delegate", s: "ses_a", child: "ses_a_sub4", nested: null, order: "prompt", w: 0 },
    { op: "end", s: "ses_a" },
  ],
  "a log replaced by a smaller one is settled, and one command reads it once": [
    { op: "options", partial: false },
    { op: "tool", s: "ses_c", exit: 2, size: 1200 },
    { op: "tool", s: "ses_c", exit: 2, size: 1200 },
    { op: "end", s: "ses_c" },
    { op: "replace", s: "ses_c" },
    { op: "retro", invoker: "ses_review", all: false },
  ],
  "a crash mid-append loses only its own half-record, not the prompt after it": [
    { op: "options", partial: false, writers: 1, prolific: false },
    { op: "tool", s: "ses_c", w: 0, exit: 0, size: 374 },
    { op: "torn", s: "ses_c" },
    { op: "prompt", s: "ses_c", w: 0 },
  ],
  "a lesson file broken by hand is left as the user left it": [
    { op: "options", partial: true, writers: 1, prolific: true },
    { op: "prompt", s: "ses_c", w: 0 },
    { op: "tool", s: "ses_a", w: 0, exit: 0, size: 613 },
    { op: "crash", invoker: "ses_review", w: 0 },
    { op: "tool", s: "ses_c", w: 0, exit: 2, size: 56 },
    { op: "text", s: "ses_c", w: 0 },
    { op: "retro", invoker: "ses_c", all: true, w: 0 },
    { op: "edit", pick: 0.41373699461109936, how: "break" },
    { op: "retro", invoker: "ses_c", all: false, w: 0 },
    { op: "retro", invoker: "ses_a", all: false, w: 0 },
  ],
}

for (const [title, actions] of Object.entries(FOUND)) {
  test(title, async () => {
    const err = await run(actions)
    assert.equal(err, null, err ? `${err.message}` : "")
  })
}

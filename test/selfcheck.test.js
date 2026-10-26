import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SET_ASIDE, assess, activeCheck, createSelfCheck, STATUS } from "../src/selfcheck.js"
import { createPrompts } from "../src/prompts.js"
import { createStore } from "../src/lessons.js"
import { createState } from "../src/state.js"

const healthy = {
  id: "ses_x",
  counts: { prompts: 1, toolHook: 12, toolEvents: 12, steps: 10, records: 24 },
  log: { exists: true, size: 900 },
  triggered: "session.execution.succeeded",
  extraction: null,
}

const status = (checks, name) => checks.find((c) => c.name === name).status

test("a healthy session reports ok, and a pending extraction says so", () => {
  const checks = assess(healthy)
  assert.equal(status(checks, "prompt hook"), STATUS.OK)
  assert.equal(status(checks, "tool hook"), STATUS.OK)
  assert.equal(status(checks, "shadow log"), STATUS.OK)
  assert.equal(status(checks, "trigger"), STATUS.OK)
  assert.equal(status(checks, "extraction"), STATUS.SKIPPED)
})

test("the shadow log line counts the file, not just the turn being measured", () => {
  // Found live: a session prompted again reported "3 entries" about a log with 79 lines,
  // because the ingest counters are cleared when an execution ends. The file is the fact.
  const checks = assess({
    ...healthy,
    counts: { ...healthy.counts, records: 3 },
    log: { exists: true, size: 900, entries: 79 },
  })
  assert.match(checks.find((c) => c.name === "shadow log").detail, /79 entries/)
})

test("a log waiting for analysis says what will analyse it, and that nothing happens unasked", () => {
  const checks = assess({ ...healthy, extraction: { owed: true } })
  const x = checks.find((c) => c.name === "extraction")
  assert.equal(x.status, STATUS.SKIPPED)
  assert.match(x.detail, /`\/retro` analyses it/)
  assert.match(x.meaning, /costs a subagent, so it happens when you ask/)
  assert.match(x.meaning, /work order/, "and says what `/retro` will actually do")
})

test("a skipped extraction is not dressed up as a success", () => {
  const checks = assess({ ...healthy, extraction: { ok: true, skipped: true, detail: "nothing to extract (1 tool calls, no anchors)" } })
  const x = checks.find((c) => c.name === "extraction")
  assert.equal(x.status, STATUS.SKIPPED)
  assert.match(x.detail, /nothing to extract/)
})

test("events without hook calls is the API-drift signature, and reads BROKEN", () => {
  const checks = assess({ ...healthy, counts: { ...healthy.counts, toolHook: 0 } })
  const tool = checks.find((c) => c.name === "tool hook")
  assert.equal(tool.status, STATUS.BROKEN)
  assert.match(tool.detail, /12 tool-call events seen, 0 reached the hook/)
  assert.match(tool.meaning, /dead/)
})

test("no tool calls proves nothing and must not claim to", () => {
  const checks = assess({ ...healthy, counts: { ...healthy.counts, toolHook: 0, toolEvents: 0 } })
  assert.equal(status(checks, "tool hook"), STATUS.SKIPPED)
})

test("a turn with no tool calls does not claim the whole session had none", () => {
  // Live: after a `/retro` turn that ran no tools, the report said "no tool calls in this
  // session" beside a shadow-log line counting 135 entries from the same session. The
  // counters are per turn (session.md, selfcheck.md), and the sentence has to say so.
  const checks = assess({ ...healthy, counts: { ...healthy.counts, toolHook: 0, toolEvents: 0 } })
  const tool = checks.find((c) => c.name === "tool hook")
  assert.match(tool.detail, /in this turn/)
  assert.doesNotMatch(tool.detail, /in this session/)
})

test("a hand-over with no prompt is not evidence that the prompt hook is dead", () => {
  // Live: `/retro` delivers into a fresh session through `session.synthetic`, which does
  // not fire the prompt hook. The report said BROKEN prompt hook / "renamed upstream" about
  // a working hook, in the session the plugin had just created. A hand-over proves nothing.
  const checks = assess({ ...healthy, counts: { ...healthy.counts, prompts: 0, handovers: 1 } })
  const prompt = checks.find((c) => c.name === "prompt hook")
  assert.equal(prompt.status, STATUS.SKIPPED)
  assert.match(prompt.detail, /turn began with a `\/retro` hand-over/)
  assert.doesNotMatch(prompt.detail, /session was started/, "the counters are per turn, not per session")
  assert.doesNotMatch(prompt.detail, /no session\.prompt arrived/)
})

test("a prompt still proves the prompt hook, hand-over or not", () => {
  const checks = assess({ ...healthy, counts: { ...healthy.counts, prompts: 1, handovers: 1 } })
  assert.equal(status(checks, "prompt hook"), STATUS.OK)
})

test("a running session's tool calls may still be in flight, and that is not BROKEN", () => {
  // Tool calls run in parallel; their events can arrive before their `after` hooks. Measured
  // live: 2 events / 1 hook call, reported as BROKEN with "the plugin needs an update" while
  // the session was healthy. Only the end of the session settles the comparison.
  const running = assess({ ...healthy, ended: false, counts: { ...healthy.counts, toolHook: 1, toolEvents: 2 } })
  const tool = running.find((c) => c.name === "tool hook")
  assert.equal(tool.status, STATUS.SKIPPED)
  assert.match(tool.detail, /2 tool-call events seen, 1 reached the hook — so far/)
  assert.match(tool.meaning, /not finished yet/)

  // Once it ends, the same shortfall is the real drift signature.
  const ended = assess({ ...healthy, counts: { ...healthy.counts, toolHook: 1, toolEvents: 2 } })
  assert.equal(status(ended, "tool hook"), STATUS.BROKEN)
})

test("a missing log and a missing trigger are each BROKEN", () => {
  assert.equal(status(assess({ ...healthy, log: { exists: false, size: 0 } }), "shadow log"), STATUS.BROKEN)
  assert.equal(status(assess({ ...healthy, triggered: null }), "trigger"), STATUS.BROKEN)
})

test("the file says it is about the plugin, not about the session", () => {
  const check = createSelfCheck({ versions: {}, repo: "r" })
  check.verify(healthy)
  const text = check.render()

  assert.match(text, /about whether the plugin is working/)
  assert.match(text, /not a report on your session/)
  assert.match(text, /## Is it working/)
  assert.doesNotMatch(text, /## Last session/, "the session is evidence, not the subject")
  assert.match(text, /measured on session\n?`ses_x`/, "but it is cited, for debugging")
})

test("the stock of lessons is reported separately from health", () => {
  const check = createSelfCheck({ versions: {}, repo: "r" })
  check.verify(healthy)
  check.stock({ lessons: 3, top: "lint-skill-no-config", topScore: 27, queued: 1, cited: 3 })
  const text = check.render()

  assert.match(text, /## What is waiting for you/)
  assert.match(text, /3 lessons in `lessons\/` — run `\/retro` to review/)
  assert.match(text, /`lint-skill-no-config` \(score 27\)/)
  assert.match(text, /1 log not analysed yet/)
  // Why an analysed log is still on disk, stated rather than inferred from state.json.
  assert.match(text, /3 logs kept in `sessions\/` because open lessons cite them/)
  assert.match(text, /deciding those lessons releases them/)
})

test("an empty store says so rather than staying silent", () => {
  const check = createSelfCheck({ versions: {}, repo: "r" })
  check.stock({ lessons: 0, queued: 0 })
  assert.match(check.render(), /no lessons recorded yet/)
})

test("with no lessons, nothing claims that lessons are holding logs", () => {
  // A live run printed "2 analysed logs kept because open lessons still cite them" while
  // there were no lessons at all: the count was logs minus queue, not a count of citations.
  const check = createSelfCheck({ versions: {}, repo: "r" })
  check.stock({ lessons: 0, queued: 2, cited: 0 })
  const text = check.render()

  assert.match(text, /2 logs not analysed yet/)
  assert.doesNotMatch(text, /open lessons cite/, "there are none to cite anything")
})

test("the rendered file carries its own cadence, threshold and remedy", () => {
  const check = createSelfCheck({ versions: { opencode: "2.0.32", plugin: "0.0.2" }, repo: "github.com/x/y" })
  check.notes(["prompts/extract.md is locally edited (base 2); a newer default is in prompts/updates/extract.v3.md"])
  check.verify(healthy)
  const text = check.render()

  assert.match(text, /opencode 2\.0\.32 · opencode-retro 0\.0\.2 · github\.com\/x\/y/)
  assert.match(text, /loaded\s+\d{4}-\d{2}-\d{2}/)
  assert.match(text, /heartbeat .*at most once a minute/)
  assert.match(text, /this\n?plugin is not running/, "the staleness rule must be in the file itself")
  assert.match(text, /absolute\s+path/, "an absolute path is the checkout remedy")
  assert.match(text, /still names the plugin/, "and a package install has a remedy too, not only a checkout")
  assert.match(text, /## Notes/)
  assert.match(text, /extract\.v3\.md/)
})

test("before any session ends the file says so rather than looking healthy", () => {
  const check = createSelfCheck({ versions: {}, repo: "r" })
  const text = check.render()
  assert.match(text, /Nothing measured yet/)
  assert.match(text, /registers happily and never fires/, "and says why registration is no proof")
})

test("an extraction that ran and produced something is ok, and repeats its own summary", () => {
  const checks = assess({ ...healthy, extraction: { ok: true, detail: "1 new (lint-skill-no-config)" } })
  const x = checks.find((c) => c.name === "extraction")
  assert.equal(x.status, STATUS.OK)
  assert.match(x.detail, /1 new/)
  assert.equal(x.meaning, undefined, "nothing to explain when nothing is wrong")
})

/* ------------------------------------------------------- the active check */

const activeRig = () => {
  const root = mkdtempSync(join(tmpdir(), "retro-active-"))
  const dir = join(root, "prompts")
  const updates = join(dir, "updates")
  return {
    root,
    dir,
    updates,
    // Written out by hand rather than derived from the plugin's own list, so that the two
    // can disagree. The analysis runs through session create/generate/remove; `generate.text`
    // is deliberately absent, because the plugin does not call it.
    ctx: {
      tool: { hook() {}, transform() {} },
      session: { hook() {}, synthetic() {}, create() {}, generate() {}, remove() {} },
      command: { transform() {} },
      event: { subscribe() {} },
      model: { default() {} },
    },
    config: {},
    prompts: createPrompts({ dir, updates, global: join(root, "global") }),
    store: createStore({ dir: join(root, "lessons"), archive: join(root, "archive") }),
    state: createState({ path: join(root, "state.json") }),
  }
}

const activeStatus = (report, name) => report.checks.find((c) => c.name === name)

test("the active check passes when every member the plugin depends on is present", async () => {
  // This is the check decision 19 leans on: a missing member reads `undefined` at load,
  // so it is the one API break a plugin can detect without waiting for traffic.
  const r = activeRig()
  const report = await activeCheck(r)

  assert.equal(activeStatus(report, "ctx surface").status, STATUS.OK)
  assert.match(activeStatus(report, "ctx surface").detail, /6 members present/)
  assert.equal(activeStatus(report, "extract prompt").status, STATUS.OK)
  assert.match(activeStatus(report, "extract prompt").detail, /^packaged \(base \d+\)$/, "and which layer is live")
  assert.equal(activeStatus(report, "store").status, STATUS.OK)
  assert.match(activeStatus(report, "store").detail, /0 open lesson\(s\); what is waiting is under "What is waiting for you"/)
  assert.deepEqual(report.notes, [])
})

test("a missing ctx member is named, and does not stop the rest of the check", async () => {
  const r = activeRig()
  delete r.ctx.session.synthetic
  r.ctx.tool.transform = "not a function"
  const report = await activeCheck(r)

  const surface = activeStatus(report, "ctx surface")
  assert.equal(surface.status, STATUS.BROKEN)
  assert.match(surface.detail, /tool\.transform/)
  assert.match(surface.detail, /session\.synthetic/)
  assert.doesNotMatch(surface.detail, /event\.subscribe/, "only what is actually missing")
  assert.match(surface.meaning, /moved the plugin API/)

  assert.equal(activeStatus(report, "extract prompt").status, STATUS.OK, "one broken member does not hide the rest")
})

test("a prompt that cannot be resolved anywhere is BROKEN, not silently defaulted", async () => {
  const r = activeRig()
  r.prompts = { resolve: () => null, pendingUpdates: () => [] }
  const report = await activeCheck(r)

  assert.equal(activeStatus(report, "extract prompt").status, STATUS.BROKEN)
  assert.match(activeStatus(report, "extract prompt").detail, /could not be resolved at any layer/)
})

test("a newer default waiting on disk is named, and says nothing was changed", async () => {
  const r = activeRig()
  mkdirSync(r.updates, { recursive: true })
  writeFileSync(join(r.updates, "extract.v3.md"), "a newer default\n")
  const report = await activeCheck(r)

  assert.equal(report.notes.length, 1)
  assert.match(report.notes[0], /prompts\/updates\/extract\.v3\.md/)
  assert.match(report.notes[0], /Nothing was changed for you/)
})

test("the checked block does not count waiting logs, so it cannot contradict the stock", async () => {
  // A stranger's run: the checked block, taken before the hand-over, said "0 logs waiting"
  // while the stock section below, written after it, said "1 log not analysed yet".
  const report = await activeCheck(activeRig())
  assert.doesNotMatch(activeStatus(report, "store").detail, /waiting to be analysed|log\(s\)/)
})

test("a lesson file that cannot be read is named, with what to do about it", () => {
  // Invisible to `/retro` and written over by nothing: without this line, a stray edit that
  // broke a frontmatter would make the lesson quietly disappear.
  const check = createSelfCheck({ versions: {}, repo: "r" })
  check.stock({ lessons: 2, unreadable: ["lessons/lint-skill-no-config.md"] })
  const text = check.render()
  assert.match(text, /`lessons\/lint-skill-no-config\.md` cannot be read as a lesson/)
  assert.match(text, /Nothing was changed; fix or remove it\./)
})

test("a log read in part is named as such, not as not analysed yet", () => {
  // Measured by a stranger's run: right after `/retro` read a long log as an excerpt, the
  // report said "1 log not analysed yet", and the command looked as if it had not finished.
  const check = createSelfCheck({ versions: {}, repo: "r" })
  check.stock({ lessons: 1, partial: 1 })
  const text = check.render()
  assert.match(text, /1 log read in part — too long for one call/)
  assert.doesNotMatch(text, /not analysed yet/)
})

test("a session whose log was set aside is not told the next /retro asks again", () => {
  // Fourth pre-release review: the extraction line explained every failure as one the next
  // command retries, including a log nothing will read again unless it grows.
  const x = assess({ ...healthy, extraction: { ok: false, detail: `${SET_ASIDE}: the analysis reported reading nothing new`, setAside: true } })
  const line = x.find((c) => c.name === "extraction")
  assert.equal(line.status, STATUS.DEGRADED)
  assert.doesNotMatch(line.meaning, /asks again/)
  assert.match(line.meaning, /unless it grows/)
})

test("the report's times are the reader's own, with their offset", () => {
  // Read against a clock: an unlabelled UTC time made a healthy plugin look hours dead to a
  // reader seven hours east, next to a rule that calls a few minutes' silence a dead plugin.
  const tz = process.env.TZ
  process.env.TZ = "Asia/Novosibirsk"
  try {
    const check = createSelfCheck({ versions: {}, repo: "r", now: () => Date.parse("2026-10-26T04:12:00Z") })
    check.verify(healthy, Date.parse("2026-10-26T04:12:00Z"))
    assert.match(check.render(), /verified\s+2026-10-26 11:12 \+07:00/)
  } finally {
    process.env.TZ = tz
  }
})

test("more hook calls than events is explained, and the remedy for a dead plugin is one that works", () => {
  const checks = assess({ ...healthy, counts: { ...healthy.counts, toolEvents: 2, toolHook: 3 } })
  assert.match(checks.find((c) => c.name === "tool hook").detail, /reaches the hook twice/)
  const check = createSelfCheck({ versions: {}, repo: "r" })
  check.verify(healthy)
  const text = check.render()
  assert.doesNotMatch(text, /then run `\/retro`/, "a plugin that did not load has no /retro")
  assert.match(text, /then start a session/)
})

test("a note about a file that is gone goes with it", () => {
  const check = createSelfCheck({ versions: {}, repo: "r" })
  check.verify(healthy)
  check.notes(["prompts/updates/extract.v7.md is a newer default waiting to be read. Nothing was changed for you."])
  assert.match(check.render(), /extract\.v7\.md/)
  check.notes([])
  assert.doesNotMatch(check.render(), /extract\.v7\.md/)
})

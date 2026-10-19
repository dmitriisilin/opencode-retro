import { test } from "node:test"
import assert from "node:assert/strict"
import { assess, createSelfCheck, STATUS } from "../src/selfcheck.js"

const healthy = {
  id: "ses_x",
  counts: { prompts: 1, toolHook: 12, toolEvents: 12, steps: 10, records: 24 },
  log: { exists: true, size: 900 },
  triggered: "session.execution.succeeded",
  extraction: null,
}

const status = (checks, name) => checks.find((c) => c.name === name).status

test("a healthy session reports ok, and extraction is honest about M1", () => {
  const checks = assess(healthy)
  assert.equal(status(checks, "prompt hook"), STATUS.OK)
  assert.equal(status(checks, "tool hook"), STATUS.OK)
  assert.equal(status(checks, "shadow log"), STATUS.OK)
  assert.equal(status(checks, "trigger"), STATUS.OK)
  assert.equal(status(checks, "extraction"), STATUS.SKIPPED)
})

test("events without hook calls is the API-drift signature, and reads BROKEN", () => {
  const checks = assess({ ...healthy, counts: { ...healthy.counts, toolHook: 0 } })
  const tool = checks.find((c) => c.name === "tool hook")
  assert.equal(tool.status, STATUS.BROKEN)
  assert.match(tool.detail, /12 tool-call events \/ 0 hook calls/)
  assert.match(tool.meaning, /dead/)
})

test("no tool calls proves nothing and must not claim to", () => {
  const checks = assess({ ...healthy, counts: { ...healthy.counts, toolHook: 0, toolEvents: 0 } })
  assert.equal(status(checks, "tool hook"), STATUS.SKIPPED)
})

test("a missing log and a missing trigger are each BROKEN", () => {
  assert.equal(status(assess({ ...healthy, log: { exists: false, size: 0 } }), "shadow log"), STATUS.BROKEN)
  assert.equal(status(assess({ ...healthy, triggered: null }), "trigger"), STATUS.BROKEN)
})

test("the rendered file carries its own cadence, threshold and remedy", () => {
  const check = createSelfCheck({ versions: { opencode: "2.0.32", plugin: "0.0.2" }, repo: "github.com/x/y" })
  check.note("prompts/extract.md is locally edited (base 2); a newer default is in prompts/updates/extract.v3.md")
  check.verify(healthy)
  const text = check.render()

  assert.match(text, /opencode 2\.0\.32 · opencode-retro 0\.0\.2 · github\.com\/x\/y/)
  assert.match(text, /loaded\s+\d{4}-\d{2}-\d{2}/)
  assert.match(text, /heartbeat .*at most once a minute/)
  assert.match(text, /this\n?plugin is not running/, "the staleness rule must be in the file itself")
  assert.match(text, /absolute path/, "and so must the first thing to check")
  assert.match(text, /## Notes/)
  assert.match(text, /extract\.v3\.md/)
})

test("before any session ends the file says so rather than looking healthy", () => {
  const check = createSelfCheck({ versions: {}, repo: "r" })
  assert.match(check.render(), /No session has ended/)
})

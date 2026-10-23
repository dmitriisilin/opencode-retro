import { test } from "node:test"
import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { DEFAULTS, clamp, resolveConfig } from "../src/config.js"

const location = { directory: "/tmp/project", project: { id: "proj_1" } }

test("defaults are the documented layout, in one place", () => {
  assert.equal(DEFAULTS.dir, ".retro")
  assert.equal(DEFAULTS.prompts, "prompts")
  assert.equal(DEFAULTS.keepSessions, false, "machine state is not kept unless asked")
  assert.equal(DEFAULTS.extractLimit, Infinity, "a half-analysed backlog only moves the work")
})

test("the layout is resolved under the project, not under the process", () => {
  const got = resolveConfig({ location, options: {} })

  assert.equal(got.directory, "/tmp/project")
  assert.equal(got.project, "proj_1", "the stable workspace id, not a git subprocess")
  assert.equal(got.dir, resolve("/tmp/project", ".retro"))
  assert.equal(got.sessions, resolve(got.dir, "sessions"))
  assert.equal(got.work, resolve(got.dir, "work"))
  assert.equal(got.lessons, resolve(got.dir, "lessons"))
  assert.equal(got.archive, resolve(got.dir, "archive"))
  assert.equal(got.prompts, resolve(got.dir, "prompts"))
  assert.equal(got.updates, resolve(got.dir, "prompts", "updates"))
  assert.equal(got.selfcheck, resolve(got.dir, "selfcheck.md"))
  assert.equal(got.state, resolve(got.dir, "state.json"))
  assert.equal(got.pluginLog, resolve(got.dir, "plugin.log"))
})

test("an absolute dir or prompt path is used as given", () => {
  const got = resolveConfig({ location, options: { dir: "/var/tmp/retro", prompts: "/var/tmp/prompts" } })
  assert.equal(got.dir, "/var/tmp/retro")
  assert.equal(got.sessions, "/var/tmp/retro/sessions")
  assert.equal(got.prompts, "/var/tmp/prompts")
})

test("every settable option is carried through, and omitted ones take the default", () => {
  const options = {
    maxOutput: 100,
    maxInput: 1234,
    heartbeatMs: 5,
    halfLife: 3,
    keepSessions: true,
    proposeLimit: 2,
    extractLimit: 4,
  }
  const got = resolveConfig({ location, options })
  for (const [key, value] of Object.entries(options)) assert.deepEqual(got[key], value, key)

  const plain = resolveConfig({ location, options: {} })
  assert.equal(plain.maxOutput, DEFAULTS.maxOutput)
  assert.equal(plain.maxInput, DEFAULTS.maxInput)
  assert.equal(plain.heartbeatMs, DEFAULTS.heartbeatMs)
  assert.equal(plain.halfLife, DEFAULTS.halfLife)
  assert.equal(plain.keepSessions, DEFAULTS.keepSessions)
  assert.equal(plain.proposeLimit, DEFAULTS.proposeLimit)
  assert.equal(plain.extractLimit, DEFAULTS.extractLimit)
})

test("a context without a location still yields a usable layout", () => {
  const got = resolveConfig({})
  assert.equal(got.directory, process.cwd())
  assert.equal(got.project, null)
  assert.equal(got.dir, resolve(process.cwd(), ".retro"))
  assert.equal(got.work, resolve(process.cwd(), ".retro", "work"))
})

test("clamp keeps the head and the tail, and says how much went missing", () => {
  const text = "START" + "x".repeat(200) + "END"
  const got = clamp(text, 40)

  assert.equal(got.truncated, true)
  assert.equal(got.originalLength, text.length)
  assert.match(got.text, /^START/)
  assert.match(got.text, /END$/)
  assert.match(got.text, /\[\d+ characters elided\]/)
  assert.ok(got.text.length < text.length, "the point is to save room")
})

test("short text and non-strings are handed back untouched", () => {
  assert.deepEqual(clamp("hi", 10), { text: "hi", truncated: false })
  assert.deepEqual(clamp(null, 10), { text: null, truncated: false })
  assert.deepEqual(clamp("", 0), { text: "", truncated: false })
})

test("clamp refuses to elide when the notice would cost more than it saves", () => {
  // A tiny budget plus a long notice is longer than the original. Returning it truncated
  // would be a lie about the only thing clamp is for.
  const got = clamp("abcdefghij", 1)
  assert.equal(got.text, "abcdefghij")
  assert.equal(got.truncated, false)
})

test("update notices land beside the prompts, including when the directory is overridden", () => {
  // They are news about the prompts you have. Pointed at a shared directory, the notices used
  // to be written to `<dir>/prompts/updates` — the place the user had just stopped using, so
  // the one file meant to be noticed went where nobody looks.
  const plain = resolveConfig({ location: { directory: "/w" } })
  assert.equal(plain.updates, join(plain.prompts, "updates"))

  const relative = resolveConfig({ location: { directory: "/w" }, options: { prompts: "shared/prompts" } })
  assert.equal(relative.prompts, "/w/.retro/shared/prompts")
  assert.equal(relative.updates, "/w/.retro/shared/prompts/updates")

  const absolute = resolveConfig({ location: { directory: "/w" }, options: { prompts: "/etc/retro/prompts" } })
  assert.equal(absolute.updates, "/etc/retro/prompts/updates")
})

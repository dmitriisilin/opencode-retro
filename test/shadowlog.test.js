import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createShadowLog, parseShadowLog } from "../src/shadowlog.js"

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "retro-shadow-"))
  return { root, dir: join(root, "sessions") }
}

test("a record is appended as one JSON line, in the order it happened", () => {
  const s = sandbox()
  const log = createShadowLog({ dir: s.dir })

  assert.equal(log.write("ses_a", { v: 1, n: 1, k: "prompt", text: "first" }), true)
  assert.equal(log.write("ses_a", { v: 1, n: 2, k: "text", text: "second" }), true)

  const lines = readFileSync(log.path("ses_a"), "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((l) => JSON.parse(l).n), [1, 2])
})

test("read gives back exactly what was written, and nothing for a session that never ran", () => {
  const s = sandbox()
  const log = createShadowLog({ dir: s.dir })
  log.write("ses_a", { n: 1, k: "prompt", text: "hello" })

  assert.deepEqual(log.read("ses_a"), [{ n: 1, k: "prompt", text: "hello" }])
  assert.deepEqual(log.read("ses_never"), [])
})

test("list names sessions with a log, and ignores everything else in the directory", () => {
  const s = sandbox()
  const log = createShadowLog({ dir: s.dir })
  log.write("ses_one", { n: 1 })
  log.write("ses_two", { n: 1 })
  writeFileSync(join(s.dir, "notes.txt"), "not a log\n")

  assert.deepEqual(log.list().sort(), ["ses_one", "ses_two"])
})

test("stat is the self-check's evidence that writing works", () => {
  const s = sandbox()
  const log = createShadowLog({ dir: s.dir })

  assert.deepEqual(log.stat("ses_a"), { exists: false, size: 0 })
  log.write("ses_a", { n: 1, k: "prompt" })
  const got = log.stat("ses_a")
  assert.equal(got.exists, true)
  assert.ok(got.size > 0)
})

test("remove is idempotent and silent when the file is already gone", () => {
  const s = sandbox()
  const errors = []
  const log = createShadowLog({ dir: s.dir, onError: (where) => errors.push(where) })
  log.write("ses_a", { n: 1 })

  assert.equal(log.remove("ses_a"), true)
  assert.ok(!existsSync(log.path("ses_a")))
  assert.equal(log.remove("ses_a"), false, "the second removal has nothing to do")
  assert.deepEqual(errors, [], "and a missing file is not an error worth reporting")
})

test("a directory that cannot be created is reported and swallowed", () => {
  // Fail silent in hooks: a broken log degrades to no log, it never reaches the session.
  const s = sandbox()
  writeFileSync(join(s.root, "blocked"), "not a directory\n")
  const errors = []
  const log = createShadowLog({ dir: join(s.root, "blocked", "sessions"), onError: (where) => errors.push(where) })

  assert.equal(log.write("ses_a", { n: 1 }), false)
  assert.deepEqual(errors, ["shadowlog.mkdir"])
  assert.deepEqual(log.list(), [])
  assert.deepEqual(log.read("ses_a"), [])
})

test("a half-written final line is skipped, not fatal", () => {
  // Being killed mid-append leaves a partial line. The rest of the log is still evidence.
  const text = '{"n":1,"k":"prompt"}\n{"n":2,"k":"te'
  assert.deepEqual(parseShadowLog(text), [{ n: 1, k: "prompt" }])

  const withGap = '{"n":1}\nnot json at all\n{"n":3}\n\n'
  assert.deepEqual(parseShadowLog(withGap), [{ n: 1 }, { n: 3 }])
})

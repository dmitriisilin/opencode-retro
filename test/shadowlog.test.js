import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createShadowLog, identityOf, parseShadowLog } from "../src/shadowlog.js"
import { createIngest } from "../src/ingest.js"

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

test("count reports the file's records, not the counters of the current turn", () => {
  const s = sandbox()
  const log = createShadowLog({ dir: s.dir })

  assert.equal(log.count("ses_a"), 0)
  log.write("ses_a", { n: 1, k: "prompt", text: "first" })
  log.write("ses_a", { n: 2, k: "text", text: "second" })
  assert.equal(log.count("ses_a"), 2)

  // A new process, or a second turn, appends more: the file is what the self-check reports.
  log.write("ses_a", { n: 3, k: "prompt", text: "again" })
  assert.equal(log.count("ses_a"), 3)
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

test("numbering continues from the log, so a step range resolves to one record", () => {
  // Found by the plugin on its own logs: `n` lives in memory, so a second process appending
  // to an existing session log started again at 1. Real files here had three and four blocks
  // of `n` restarting inside them, and a lesson's evidence range then pointed at several
  // records — while decision 18 keeps the log on disk precisely so that range resolves.
  const dir = mkdtempSync(join(tmpdir(), "retro-log-n-"))
  const log = createShadowLog({ dir })

  assert.equal(log.lastN("ses_a"), 0, "nothing written yet")
  log.write("ses_a", { v: 1, n: 1, k: "prompt", text: "go" })
  log.write("ses_a", { v: 1, n: 2, k: "tool", tool: "shell" })
  assert.equal(log.lastN("ses_a"), 2)

  // A fresh writer for a session that already has a log: the next record is 3, not 1.
  const second = createIngest({ maxOutput: 8000, emit: (id, r) => log.write(id, r), startAt: (id) => log.lastN(id) })
  second.prompt({ sessionID: "ses_a", messageID: "m2", prompt: { text: "again" } })

  const ns = log.read("ses_a").map((r) => r.n)
  assert.deepEqual(ns, [1, 2, 3])
  assert.equal(new Set(ns).size, ns.length, "every step number appears once")
})

test("a half-written last line does not reset the numbering", () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-log-n2-"))
  const log = createShadowLog({ dir })
  log.write("ses_b", { v: 1, n: 7, k: "prompt", text: "go" })
  appendFileSync(join(dir, "ses_b.jsonl"), '{"v":1,"n":8,"k":"to')

  assert.equal(log.lastN("ses_b"), 7, "the last whole record is what counts")
})

test("identity is the first whole record of the text that was read", () => {
  // Taken from the snapshot, not by reading the file again: a log replaced between the read
  // and the identity would otherwise mark the old records as the new file's.
  const a = '{"v":1,"n":1,"k":"prompt","text":"one"}\n{"v":1,"n":2}\n'
  const b = '{"v":1,"n":1,"k":"prompt","text":"two"}\n{"v":1,"n":2}\n'

  assert.equal(identityOf(a), identityOf(a), "deterministic")
  assert.notEqual(identityOf(a), identityOf(b), "a different first record is a different log")
  assert.equal(identityOf(""), null, "no record, no identity")
  assert.equal(identityOf('{"v":1,"n":1'), null, "a half-written first line is not one yet")
  assert.equal(identityOf("not json\n" + a), null, "so a file with no whole first record has no identity")
})

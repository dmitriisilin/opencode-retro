import { test } from "node:test"
import assert from "node:assert/strict"
import { replay } from "./replay.js"

test("the lint-trap session replays into a shadow log", () => {
  const { records } = replay("session-lint-trap.jsonl")

  const prompts = records.filter((r) => r.k === "prompt")
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].text, /average\(numbers\)/)

  const tools = records.filter((r) => r.k === "tool")
  assert.equal(tools.length, 12, "M0 captured exactly 12 tool calls")
  assert.deepEqual(
    [...new Set(tools.map((t) => t.tool))].sort(),
    ["edit", "glob", "read", "shell", "skill"],
    "tool names as verified in M0 — note shell, not bash",
  )

  const end = records.at(-1)
  assert.equal(end.k, "session")
  assert.equal(end.outcome, "succeeded")
})

test("n is monotonic per session and unique", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const ns = records.map((r) => r.n)
  assert.deepEqual(ns, [...ns].sort((a, b) => a - b))
  assert.equal(new Set(ns).size, ns.length)
})

test("a failing shell command keeps its exit code, which status hides", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const eslint = records.find((r) => r.k === "tool" && /eslint/.test(r.input?.command ?? ""))

  assert.equal(eslint.status, "completed", "OpenCode reports a non-zero exit as completed")
  assert.equal(eslint.exit, 2, "so the exit code is the only failure signal")
  assert.match(eslint.output, /couldn't find an eslint\.config/)
})

test("an edit keeps its patch, and a skill keeps the directory to propose against", () => {
  const { records } = replay("session-lint-trap.jsonl")

  const edit = records.find((r) => r.k === "tool" && r.tool === "edit")
  assert.equal(edit.files.length, 1)
  assert.equal(edit.files[0].file, "src/sum.js")
  assert.match(edit.files[0].patch, /\+export function average/)

  const skill = records.find((r) => r.k === "tool" && r.tool === "skill")
  assert.equal(skill.skill.name, "lint")
  assert.match(skill.skill.directory, /\.opencode\/skills\/lint$/)
})

test("tool calls are paired by id, not by arrival order", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const reads = records.filter((r) => r.k === "tool" && r.tool === "read")

  // M0 observed three `before` payloads arriving ahead of their three `after`s.
  assert.ok(reads.length >= 3)
  for (const r of reads) {
    assert.ok(r.input?.path, "a mispaired call would have lost its input")
    assert.equal(r.status, "completed")
  }
})

test("step records carry what the git snapshot and the changed files say", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const steps = records.filter((r) => r.k === "step")
  assert.ok(steps.length > 0)
  assert.ok(steps.some((s) => s.snapshot), "snapshot is what makes revert checkable against git")
  assert.ok(steps.some((s) => typeof s.cost === "number"), "cost grounds a lesson score in real tokens")
})

test("output is clamped head-and-tail with the loss stated", () => {
  const { records } = replay("session-lint-trap.jsonl", { maxOutput: 200 })
  const clamped = records.filter((r) => r.k === "tool" && r.outputLength)
  assert.ok(clamped.length > 0)
  for (const r of clamped) {
    assert.ok(r.output.length < r.outputLength)
    assert.match(r.output, /characters elided/)
  }
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { replay } from "./replay.js"
import { project } from "../src/projection.js"

test("the projection is deterministic", () => {
  const { records } = replay("session-lint-trap.jsonl")
  assert.equal(project(records), project(records), "the extractor prompt cannot be iterated otherwise")
})

test("it keeps intent and failure, and sheds output volume", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const text = project(records)

  assert.match(text, /user:/)
  assert.match(text, /average\(numbers\)/, "the prompt is kept in full — intent lives there")
  assert.match(text, /skill: lint/)
  assert.match(text, /shell: npx eslint \. --fix/)
  assert.match(text, /-> exit 2/, "the failure must survive, status alone would hide it")
  assert.match(text, /-> modified src\/sum\.js \(\+4\/-0\)/)
  assert.match(text, /--- session end: succeeded/)

  const raw = records.reduce((n, r) => n + JSON.stringify(r).length, 0)
  assert.ok(text.length < raw / 2, `projection should shrink the log (${text.length} vs ${raw})`)
})

test("every step line is addressable by its n", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const text = project(records)
  for (const r of records.filter((r) => r.k === "tool")) {
    assert.ok(text.includes(`[${r.n}] `), `step ${r.n} is missing from the projection`)
  }
})

test("an unfinished call is shown as unfinished rather than dropped", () => {
  const text = project([
    { k: "tool", n: 1, tool: "shell", input: { command: "sleep 100" }, status: "unfinished" },
  ])
  assert.match(text, /never finished/)
})

test("a delegation shows which agent, what for, and what it was asked", () => {
  // This used to fall to the default case and be truncated at 200 characters, cutting off
  // the instruction — the one thing that says what the subagent was supposed to do.
  const text = project([
    {
      k: "tool",
      n: 3,
      tool: "subagent",
      status: "completed",
      input: {
        agent: "explore",
        description: "Find src/sum.js exports",
        prompt: "Quick exploration. In the repository at /p, look at src/sum.js and report which functions it exports.",
      },
    },
    { k: "tool", n: 5, tool: "read", agent: "explore", input: { path: "src/sum.js" }, status: "completed" },
  ])

  assert.match(text, /\[3\] delegated to explore: Find src\/sum\.js exports/)
  assert.match(text, /asked:/)
  assert.match(text, /report which functions it exports/, "the instruction survives in full")
  assert.match(text, /\[5\] read: src\/sum\.js/, "and the subagent's own steps are in the same sequence")
})

test("a step done by a subagent says so, and the usual agent is not labelled", () => {
  // Captured and invisible was the failure here: subagent records are written into the
  // parent's log, and without this the extractor reads them as the main agent's own work.
  const text = project([
    { k: "tool", n: 3, tool: "read", agent: "build", input: { path: "a.js" }, status: "completed" },
    { k: "tool", n: 5, tool: "read", agent: "explore", input: { path: "b.js" }, status: "completed" },
    { k: "tool", n: 7, tool: "read", agent: "build", input: { path: "c.js" }, status: "completed" },
  ])

  assert.match(text, /\[5\] \(explore\) read: b\.js/, "the delegated step is attributed")
  assert.match(text, /\[3\] read: a\.js/, "and the usual agent adds no noise")
  assert.doesNotMatch(text, /\(build\)/)
})

test("with one agent throughout, nothing is labelled", () => {
  const text = project([
    { k: "tool", n: 1, tool: "read", agent: "build", input: { path: "a.js" }, status: "completed" },
    { k: "tool", n: 2, tool: "read", agent: "build", input: { path: "b.js" }, status: "completed" },
  ])
  assert.doesNotMatch(text, /\(/)
})

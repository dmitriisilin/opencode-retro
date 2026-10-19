import { test } from "node:test"
import assert from "node:assert/strict"
import { replay } from "./replay.js"
import {
  detectAnchors,
  detectRepeat,
  detectRevert,
  detectSkillFailure,
  patchLines,
  prescribedCommands,
  signature,
} from "../src/anchors.js"

test("the lint trap is flagged as skill -> failure, pointing at the SKILL.md", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const anchors = detectAnchors(records)

  const skillFailure = anchors.find((a) => a.kind === "skill-failure")
  assert.ok(skillFailure, "the motivating example must be caught by a detector, not by a model")
  assert.equal(skillFailure.skill, "lint")
  assert.match(skillFailure.target, /\.opencode\/skills\/lint$/)
  assert.match(skillFailure.reason, /prescribes `npx eslint \. --fix`/)
  assert.match(skillFailure.reason, /exit 2/)
})

test("the link survives the agent wandering off between skill and failure", () => {
  // A real session invoked the skill at step 9 and failed its command at step 18.
  const skill = {
    k: "tool",
    n: 9,
    tool: "skill",
    input: { id: "lint" },
    status: "completed",
    skill: { name: "lint", directory: "/p/.opencode/skills/lint" },
    output: "1. Run `npx eslint . --fix` to lint and autofix the whole project.",
  }
  const noise = Array.from({ length: 8 }, (_, i) => ({
    k: "tool",
    n: 10 + i,
    tool: "read",
    input: { path: `/p/f${i}.js` },
    status: "completed",
  }))
  const fail = {
    k: "tool",
    n: 18,
    tool: "shell",
    input: { command: "npx eslint . --fix" },
    status: "completed",
    exit: 2,
  }

  const anchors = detectSkillFailure([skill, ...noise, fail])
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].from, 9)
  assert.equal(anchors[0].to, 18)
})

test("a failure the skill never prescribed is not attributed to it", () => {
  const skill = {
    k: "tool",
    n: 1,
    tool: "skill",
    input: { id: "lint" },
    status: "completed",
    skill: { name: "lint", directory: "/p/.opencode/skills/lint" },
    output: "Run `npx eslint . --fix`.",
  }
  const unrelated = { k: "tool", n: 2, tool: "shell", input: { command: "npm run build" }, status: "completed", exit: 1 }
  assert.deepEqual(detectSkillFailure([skill, unrelated]), [])
})

test("prescribedCommands takes runnable spans and ignores prose words", () => {
  const got = prescribedCommands("Run `npx eslint . --fix`, then check `eslint.config.js` and `ok`.")
  assert.deepEqual(got, ["npx eslint . --fix"])
})

test("a session that went straight gets no anchors", () => {
  const { records } = replay("session-minimal.jsonl")
  assert.deepEqual(detectAnchors(records), [])
})

test("anchors carry a step range that exists in the log", () => {
  const { records } = replay("session-lint-trap.jsonl")
  const ns = new Set(records.map((r) => r.n))
  for (const a of detectAnchors(records)) {
    assert.ok(ns.has(a.from), `anchor ${a.kind} points at a missing step ${a.from}`)
    assert.ok(ns.has(a.to))
    assert.ok(a.to >= a.from)
  }
})

const tool = (n, t, input, extra = {}) => ({ k: "tool", n, tool: t, input, status: "completed", ...extra })

test("repeat fires on an identical call with nothing changed in between", () => {
  const anchors = detectRepeat([
    tool(1, "shell", { command: "npm test" }, { exit: 1 }),
    tool(2, "read", { path: "a.js" }),
    tool(3, "shell", { command: "npm test" }, { exit: 1 }),
  ])
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].from, 1)
  assert.equal(anchors[0].to, 3)
  assert.match(anchors[0].reason, /2 times/)
})

test("repeat does not fire when a file changed in between — that is normal work", () => {
  const anchors = detectRepeat([
    tool(1, "shell", { command: "npm test" }, { exit: 1 }),
    tool(2, "edit", { path: "a.js" }, { files: [{ file: "a.js", patch: "+x", additions: 1, deletions: 0 }] }),
    tool(3, "shell", { command: "npm test" }, { exit: 0 }),
  ])
  assert.deepEqual(anchors, [])
})

test("revert fires when every line added is removed again", () => {
  const added = "--- a\n+++ b\n@@\n+const a = 1\n+const b = 2\n"
  const removed = "--- a\n+++ b\n@@\n-const a = 1\n-const b = 2\n"
  const anchors = detectRevert([
    tool(1, "edit", { path: "a.js" }, { files: [{ file: "a.js", patch: added, additions: 2, deletions: 0 }] }),
    tool(2, "edit", { path: "a.js" }, { files: [{ file: "a.js", patch: removed, additions: 0, deletions: 2 }] }),
  ])
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].file, "a.js")
  assert.equal(anchors[0].from, 1)
  assert.equal(anchors[0].to, 2)
})

test("revert fires when git discards work the session had edited", () => {
  const anchors = detectRevert([
    tool(1, "edit", { path: "a.js" }, { files: [{ file: "a.js", patch: "+x", additions: 1, deletions: 0 }] }),
    tool(2, "shell", { command: "git checkout -- ." }),
  ])
  assert.equal(anchors.length, 1)
  assert.match(anchors[0].reason, /discarded working-tree changes/)
})

test("a git command before any edit is not a revert", () => {
  assert.deepEqual(detectRevert([tool(1, "shell", { command: "git checkout -- ." })]), [])
})

test("signature ignores key order so one call is one call", () => {
  assert.equal(signature({ a: 1, b: [2, { c: 3 }] }), signature({ b: [2, { c: 3 }], a: 1 }))
  assert.notEqual(signature({ a: 1 }), signature({ a: 2 }))
})

test("patchLines drops the file headers and keeps the body", () => {
  const { plus, minus } = patchLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context\n")
  assert.deepEqual(plus, ["new"])
  assert.deepEqual(minus, ["old"])
})

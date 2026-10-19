import { test } from "node:test"
import assert from "node:assert/strict"
import { OUTPUT_CONTRACT, parseLessons, slug } from "../src/contract.js"

const good = {
  id: "lint-skill-no-config",
  statement: "The lint skill assumes eslint; this project has no linter.",
  steps: [9, 18],
  cost: 9,
  confidence: 0.9,
  matches: null,
  proposal: { target: ".opencode/skills/lint/SKILL.md", change: "Check for a config first." },
  ask: "Is the linter really unused?",
  why: "Step 9 invoked the skill; step 18 exited 2.",
}

test("the contract is never written to disk, only wrapped at call time", () => {
  assert.match(OUTPUT_CONTRACT, /fenced `json` block/)
  assert.match(OUTPUT_CONTRACT, /"lessons": \[\]/, "the empty answer must be spelled out")
})

test("a clean reply parses", () => {
  const { ok, lessons } = parseLessons("```json\n" + JSON.stringify({ lessons: [good] }) + "\n```")
  assert.ok(ok)
  assert.equal(lessons.length, 1)
  assert.deepEqual(lessons[0].steps, [9, 18])
  assert.equal(lessons[0].cost, 9)
  assert.equal(lessons[0].proposal.target, ".opencode/skills/lint/SKILL.md")
})

test("prose around the json, a trailing comma, and a missing fence all survive", () => {
  const body = JSON.stringify({ lessons: [good] })
  for (const reply of [
    `Sure! Here you go:\n\n\`\`\`json\n${body}\n\`\`\`\n\nHope that helps.`,
    body,
    `\`\`\`\n{"lessons":[${JSON.stringify(good)},]}\n\`\`\``,
    `{"lessons":[${JSON.stringify(good)}]} and then some trailing prose`,
  ]) {
    const { ok, lessons } = parseLessons(reply)
    assert.ok(ok, `failed on: ${reply.slice(0, 40)}`)
    assert.equal(lessons.length, 1)
  }
})

test("an empty list is a valid answer, not a failure", () => {
  const { ok, lessons } = parseLessons('```json\n{"lessons": []}\n```')
  assert.ok(ok)
  assert.deepEqual(lessons, [])
})

test("an unparseable reply fails loudly rather than silently returning nothing", () => {
  const { ok, error, lessons } = parseLessons("I could not find anything worth reporting.")
  assert.equal(ok, false)
  assert.match(error, /no parseable json/)
  assert.deepEqual(lessons, [])
})

test("a lesson with no statement is dropped; the rest are kept", () => {
  const { lessons } = parseLessons(JSON.stringify({ lessons: [{ id: "x" }, good] }))
  assert.equal(lessons.length, 1)
  assert.equal(lessons[0].id, "lint-skill-no-config")
})

test("junk values are clamped instead of trusted", () => {
  const { lessons } = parseLessons(
    JSON.stringify({ lessons: [{ ...good, confidence: 7, cost: "nonsense", steps: ["9", 18, "x"] }] }),
  )
  assert.equal(lessons[0].confidence, 1)
  assert.deepEqual(lessons[0].steps, [9, 18])
  assert.equal(lessons[0].cost, 10, "falls back to the step span")
})

test("a proposal without a change is no proposal", () => {
  const { lessons } = parseLessons(JSON.stringify({ lessons: [{ ...good, proposal: { target: "f" } }] }))
  assert.equal(lessons[0].proposal, null)
})

test("a missing id is derived from the statement", () => {
  const { lessons } = parseLessons(JSON.stringify({ lessons: [{ ...good, id: undefined }] }))
  assert.equal(lessons[0].id, "the-lint-skill-assumes-eslint-this")
})

test("slug stays short and file-safe", () => {
  assert.equal(slug("The `lint` skill assumes eslint; no linter!"), "the-lint-skill-assumes-eslint-no")
  assert.equal(slug("!!!"), "lesson")
})

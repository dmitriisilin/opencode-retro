import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { OUTPUT_CONTRACT, RECORD_INPUT, normaliseLessons, parseLessons, slug } from "../src/contract.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

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

test("no prompt file carries the contract; it is written into the work order", () => {
  assert.match(OUTPUT_CONTRACT, /retro_record/, "the answer is a tool call, not a reply to parse")
  assert.match(OUTPUT_CONTRACT, /"lessons": \[\]/, "the empty answer must be spelled out")

  // The rule is not "the constant exists" but "it is not in any file the user can edit":
  // a copy in a prompt would drift from this one, and editing it would break the parser
  // while looking like a normal prompt change.
  const prompts = join(root, "prompts")
  for (const file of readdirSync(prompts).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(prompts, file), "utf8")
    assert.doesNotMatch(text, /## How to answer/, `${file} carries a copy of the output contract`)
    assert.doesNotMatch(text, /"lessons": \[\]/, `${file} carries a copy of the output contract`)
  }
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

test("lessons that arrive as a string are parsed rather than refused", () => {
  // The schema asks for an array and OpenCode enforces it, but a model handed a nested
  // structure will stringify it often enough that refusing one would throw away a good
  // answer. Everything the reply parser tolerates is tolerated here.
  assert.deepEqual(normaliseLessons(JSON.stringify([good]))[0].statement, good.statement)
  assert.deepEqual(normaliseLessons('```json\n{"lessons": [' + JSON.stringify(good) + "]}\n```")[0].steps, [9, 18])
  assert.deepEqual(normaliseLessons("not json at all"), [], "and nothing is invented from prose")
  assert.deepEqual(normaliseLessons(undefined), [])
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

test("a scalar step is a one-step citation, not a missing one", () => {
  const { lessons } = parseLessons(JSON.stringify({ lessons: [{ ...good, steps: 9 }] }))
  assert.deepEqual(lessons[0].steps, [9, 9], "it used to be dropped, and cost fell to 1")
  assert.equal(lessons[0].cost, 9, "the explicit cost is still the one that counts")
})

test("the example a reader copies carries every field the schema requires", () => {
  // Pre-release scan: `through` was required by the schema and missing from the example, and
  // from the sentence introducing it. A reader following the example to the letter is refused
  // by OpenCode and has to go round again — it worked in every live run only because the
  // requirement is spelled out further down, in prose. A required field the example leaves out
  // is now a failing test rather than a second round trip.
  const example = OUTPUT_CONTRACT.match(/```json\n([\s\S]*?)```/)[1]
  const top = [...example.matchAll(/^  "([a-z]+)":/gm)].map((m) => m[1])
  const intro = OUTPUT_CONTRACT.split("```json")[0]
  for (const field of RECORD_INPUT.required) {
    assert.ok(top.includes(field), `the example leaves out the required \`${field}\``)
    assert.ok(intro.includes(`\`${field}\``), `the sentence introducing the call does not name \`${field}\``)
  }
})

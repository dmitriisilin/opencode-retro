import { test } from "node:test"
import assert from "node:assert/strict"
import { parseFrontmatter, stringifyFrontmatter } from "../src/frontmatter.js"

const LESSON = `---
id: lint-skill-no-config
statement: The \`lint\` skill assumes eslint; this project has no linter.
evidence:
  - session: a81f
    steps: [41, 58]
  - session: c204
    steps: [12, 19]
cost: 34
recurrence: 3
confidence: 0.9
proposal:
  target: .opencode/skills/lint/SKILL.md
  change: |
    Before running: check for a lint config
    and a \`lint\` script in package.json.
ask: Is the linter really unused here?
status: new
---

Body text here.
`

test("the lesson format from README parses", () => {
  const { data, body } = parseFrontmatter(LESSON)

  assert.equal(data.id, "lint-skill-no-config")
  assert.match(data.statement, /assumes eslint/)
  assert.equal(data.cost, 34)
  assert.equal(data.recurrence, 3)
  assert.equal(data.confidence, 0.9)
  assert.equal(data.status, "new")

  assert.equal(data.evidence.length, 2)
  assert.deepEqual(data.evidence[0], { session: "a81f", steps: [41, 58] })
  assert.deepEqual(data.evidence[1], { session: "c204", steps: [12, 19] })

  assert.equal(data.proposal.target, ".opencode/skills/lint/SKILL.md")
  assert.match(data.proposal.change, /^Before running: check for a lint config\n/)
  assert.match(data.proposal.change, /lint` script in package\.json\.\n$/)

  assert.equal(body, "Body text here.")
})

test("a round trip through the writer keeps every value", () => {
  const { data, body } = parseFrontmatter(LESSON)
  const again = parseFrontmatter(stringifyFrontmatter(data, body))
  assert.deepEqual(again.data, data)
  assert.equal(again.body, body)
})

test("writing twice is byte-identical, so git diffs stay honest", () => {
  const { data, body } = parseFrontmatter(LESSON)
  assert.equal(stringifyFrontmatter(data, body), stringifyFrontmatter(parseFrontmatter(stringifyFrontmatter(data, body)).data, body))
})

test("no frontmatter is not an error", () => {
  const { data, body } = parseFrontmatter("just a body\n")
  assert.deepEqual(data, {})
  assert.equal(body, "just a body")
})

test("strings that would read as something else are quoted", () => {
  const text = stringifyFrontmatter({ a: "true", b: "12", c: "", d: "- leading dash", e: "key: value" })
  const { data } = parseFrontmatter(text)
  assert.deepEqual(data, { a: "true", b: "12", c: "", d: "- leading dash", e: "key: value" })
})

test("empty collections survive", () => {
  const { data } = parseFrontmatter(stringifyFrontmatter({ evidence: [], steps: [], note: null }))
  assert.deepEqual(data.evidence, [])
  assert.deepEqual(data.steps, [])
  assert.equal(data.note, null)
})

test("comments and blank lines in a hand-edited file are ignored", () => {
  const { data } = parseFrontmatter(`---
# a user's note
id: x

status: later
---
`)
  assert.deepEqual(data, { id: "x", status: "later" })
})

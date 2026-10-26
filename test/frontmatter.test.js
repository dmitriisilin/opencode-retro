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

test("a quoted value survives a second write without growing its escapes", () => {
  // Found live: a proposal containing "Retro workflow" in quotes was re-saved when the
  // lesson recurred, and its `change` came back with another layer of backslashes each time.
  const value = 'Add a "Retro workflow" section: keep C:\\tmp literal'
  const once = parseFrontmatter(stringifyFrontmatter({ proposal: { change: value } }))
  assert.equal(once.data.proposal.change, value, "the first round trip is exact")

  const twice = parseFrontmatter(stringifyFrontmatter(once.data))
  assert.equal(twice.data.proposal.change, value, "and a recurrence does not escape it again")
  assert.equal(stringifyFrontmatter(twice.data), stringifyFrontmatter(once.data), "the file is stable")
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

test("a `|-` block scalar keeps its lines and drops the trailing newline", () => {
  const { data } = parseFrontmatter("---\nnote: |-\n  one\n  two\n---\n")
  assert.equal(data.note, "one\ntwo")
})

test("an inline array is a list, and a one-item list stays a list", () => {
  assert.deepEqual(parseFrontmatter("---\nsteps: [41, 58]\n---\n").data.steps, [41, 58])
  assert.deepEqual(parseFrontmatter("---\ntags: [only]\n---\n").data.tags, ["only"])
  assert.deepEqual(parseFrontmatter("---\ntags: []\n---\n").data.tags, [])
})

test("a list item with more than one key keeps all of them", () => {
  // A hand-edited evidence entry grows a note. Losing it silently would lose the reason.
  const { data } = parseFrontmatter(`---
evidence:
  - session: a81f
    steps: [41, 58]
    note: the second attempt
---
`)
  assert.deepEqual(data.evidence, [{ session: "a81f", steps: [41, 58], note: "the second attempt" }])
})

test("scalars that look like other things are typed, and `~` is null", () => {
  const { data } = parseFrontmatter("---\na: true\nb: 12\nc: 0.5\nd: ~\ne: 2026-10-19\n---\n")
  assert.equal(data.a, true)
  assert.equal(data.b, 12)
  assert.equal(data.c, 0.5)
  assert.equal(data.d, null)
  assert.equal(data.e, "2026-10-19", "a date is kept as text, not guessed into a Date")
})

test("a stray deeper line with no key above it is skipped, not guessed at", () => {
  const { data } = parseFrontmatter("---\nid: x\n      mystery\nstatus: new\n---\n")
  assert.deepEqual(data, { id: "x", status: "new" })
})

test("a block of text whose first line is indented comes back as it went in", () => {
  const text = "    npm run build\nthen remove the line"
  const back = parseFrontmatter(stringifyFrontmatter({ note: text, decisions: [{ discovered: text }] }, "")).data
  assert.equal(back.note.replace(/\n$/, ""), text)
  assert.equal(back.decisions[0].discovered.replace(/\n$/, ""), text)
})

test("a text opening on an empty line, and indicators in either order, read back as written", () => {
  const text = "\n  indented line\nback at zero"
  const back = parseFrontmatter(stringifyFrontmatter({ note: text }, "")).data
  assert.equal(back.note.replace(/\n$/, ""), text)
  const hand = parseFrontmatter("---\na: |-2\n    x\n  y\nb: |2-\n    x\n  y\n---\n").data
  assert.equal(hand.a, "  x\ny")
  assert.equal(hand.b, "  x\ny")
})

test("a line of spaces alone inside a block keeps its spaces", () => {
  const back = parseFrontmatter(stringifyFrontmatter({ change: "x\n   \ny" }, "")).data
  assert.equal(back.change.replace(/\n$/, ""), "x\n   \ny")
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assessCurrency, fingerprintOf } from "../src/currency.js"

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "retro-currency-"))
  mkdirSync(join(root, ".opencode", "skills", "lint"), { recursive: true })
  const target = ".opencode/skills/lint/SKILL.md"
  writeFileSync(join(root, target), "run npx eslint . --fix\n")
  return { root, target, fingerprint: fingerprintOf(root) }
}

const lesson = (over = {}) => ({
  id: "l",
  proposal: { target: ".opencode/skills/lint/SKILL.md", change: "add a precondition" },
  ...over,
})

test("an unchanged target reads as unchanged", () => {
  const s = sandbox()
  const got = assessCurrency(lesson({ targetFingerprint: s.fingerprint(s.target) }), { directory: s.root })
  assert.equal(got.state, "unchanged")
  assert.equal(got.hint, undefined, "nothing to point at")
})

test("a target that changed since the lesson was written is flagged, not dropped", () => {
  const s = sandbox()
  const before = s.fingerprint(s.target)
  writeFileSync(join(s.root, s.target), "check for a config first, then run eslint\n")

  const got = assessCurrency(lesson({ targetFingerprint: before }), { directory: s.root })
  assert.equal(got.state, "target-changed")
  assert.match(got.hint, /has changed since this lesson was recorded/)
  assert.doesNotMatch(got.hint, /read it|check it/i, "it states a fact; deciding is the agent's job")
})

test("a target that is gone probably means the problem was settled", () => {
  const s = sandbox()
  const got = assessCurrency(lesson({ targetFingerprint: "deadbeef", proposal: { target: "gone.md", change: "x" } }), {
    directory: s.root,
  })
  assert.equal(got.state, "target-gone")
  assert.match(got.hint, /no longer exists/)
})

test("a lesson with no target cannot be checked this way, and says so", () => {
  const s = sandbox()
  assert.equal(assessCurrency(lesson({ proposal: null }), { directory: s.root }).state, "unverifiable")
})

test("a lesson recorded before fingerprints existed is unknown, not stale", () => {
  const s = sandbox()
  const got = assessCurrency(lesson(), { directory: s.root })
  assert.equal(got.state, "unknown")
  assert.equal(got.hint, undefined, "absence of evidence is not evidence")
})

test("the fingerprint is stable and content-addressed", () => {
  const s = sandbox()
  const a = s.fingerprint(s.target)
  assert.equal(a, s.fingerprint(s.target))
  writeFileSync(join(s.root, s.target), "different\n")
  assert.notEqual(a, s.fingerprint(s.target))
  assert.equal(s.fingerprint("nope.md"), undefined)
})

test("an absolute target is checked where it is, not joined to the project", () => {
  const s = sandbox()
  const absolute = join(s.root, "elsewhere.md")
  writeFileSync(absolute, "a file outside the project\n")

  const got = assessCurrency(
    { proposal: { target: absolute, change: "x" }, targetFingerprint: fingerprintOf("/")(absolute) },
    { directory: s.root },
  )
  assert.equal(got.state, "unchanged")
})

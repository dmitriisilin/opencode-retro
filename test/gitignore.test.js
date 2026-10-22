import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GITIGNORE, seedGitignore } from "../src/gitignore.js"

const sandbox = () => mkdtempSync(join(tmpdir(), "retro-ignore-"))

test("the plugin decides what git sees without touching the project's own gitignore", () => {
  const dir = join(sandbox(), ".retro")
  const result = seedGitignore({ dir })

  assert.equal(result.seeded, true)
  assert.equal(result.path, join(dir, ".gitignore"), "inside our directory, not the project root")
  assert.equal(readFileSync(result.path, "utf8"), GITIGNORE)
})

test("machine state is ignored and the product is not", () => {
  for (const ignored of ["sessions/", "state.json", "selfcheck.md", "plugin.log", "prompts/updates/"]) {
    assert.ok(GITIGNORE.includes(`\n${ignored}\n`), `${ignored} should be ignored`)
  }
  const rules = new Set(GITIGNORE.split("\n").map((line) => line.trim()))
  // The live prompts are configuration and the lessons are the product: both travel with the
  // repository. Only the update notices, which are news about those prompts, do not.
  for (const kept of ["lessons/", "archive/", "prompts/extract.md", "prompts/propose.md"]) {
    assert.ok(!rules.has(kept), `${kept} is the product or the configuration and must stay in git`)
  }
  assert.match(GITIGNORE, /deliberately NOT ignored/, "and the file says why, since nobody reads docs for this")
})

test("it is seeded once and never rewritten", () => {
  const dir = join(sandbox(), ".retro")
  seedGitignore({ dir })
  writeFileSync(join(dir, ".gitignore"), "mine\n")

  assert.equal(seedGitignore({ dir }).seeded, false)
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "mine\n", "after the first run it is the user's file")
})

test("a seed that cannot happen is reported, not thrown", () => {
  // First run is exactly when this file matters, and a read-only or obstructed directory
  // must degrade to no .gitignore rather than break setup.
  const root = sandbox()
  writeFileSync(join(root, "blocked"), "not a directory\n")
  const errors = []
  const result = seedGitignore({ dir: join(root, "blocked", ".retro"), onError: (where) => errors.push(where) })

  assert.equal(result.seeded, false)
  assert.match(result.error, /ENOTDIR|EEXIST|not a directory/)
  assert.deepEqual(errors, ["gitignore.seed"])
})

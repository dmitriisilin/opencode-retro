import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPrompts } from "../src/prompts.js"

const sandbox = () => {
  const root = mkdtempSync(join(tmpdir(), "retro-prompts-"))
  const dir = join(root, "prompts")
  const global = join(root, "global")
  return {
    root,
    dir,
    global,
    updates: join(dir, "updates"),
    prompts: createPrompts({ dir, updates: join(dir, "updates"), global }),
  }
}

test("the default is seeded into the project so there is something to edit", () => {
  const s = sandbox()
  const result = s.prompts.seed("extract")

  assert.equal(result.seeded, true)
  const text = readFileSync(join(s.dir, "extract.md"), "utf8")
  assert.match(text, /shorter and straighter/)
  assert.match(text, /^---\nprompt: extract\nbase: \d+/m, "it records which default it came from")
  assert.match(text, /appended automatically by the plugin/, "and says where the output format went")
})

test("seeding never overwrites what is already there", () => {
  const s = sandbox()
  s.prompts.seed("extract")
  writeFileSync(join(s.dir, "extract.md"), "---\nprompt: extract\nbase: 1\n---\n\nmine\n")

  assert.equal(s.prompts.seed("extract").seeded, false)
  assert.match(readFileSync(join(s.dir, "extract.md"), "utf8"), /mine/)
})

test("resolution is project, then global, then packaged", () => {
  const s = sandbox()
  assert.equal(s.prompts.resolve("extract").layer, "packaged")

  mkdirSync(s.global, { recursive: true })
  writeFileSync(join(s.global, "extract.md"), "---\nprompt: extract\nbase: 1\n---\n\nglobal one\n")
  assert.equal(s.prompts.resolve("extract").layer, "global")
  assert.equal(s.prompts.resolve("extract").text, "global one")

  mkdirSync(s.dir, { recursive: true })
  writeFileSync(join(s.dir, "extract.md"), "---\nprompt: extract\nbase: 1\n---\n\nproject one\n")
  assert.equal(s.prompts.resolve("extract").layer, "project")
  assert.equal(s.prompts.resolve("extract").text, "project one")
})

test("the frontmatter is stripped, so only the user's prose reaches the model", () => {
  const s = sandbox()
  s.prompts.seed("extract")
  assert.doesNotMatch(s.prompts.resolve("extract").text, /^---/)
})

test("an older base gets a news file, and the live file is left alone", () => {
  const s = sandbox()
  mkdirSync(s.dir, { recursive: true })
  writeFileSync(join(s.dir, "extract.md"), "---\nprompt: extract\nbase: 0\n---\n\nmy own version\n")

  const note = s.prompts.checkForUpdate("extract")
  assert.ok(note, "a newer default must be announced")
  assert.match(note, /Nothing was changed for you/)

  assert.match(readFileSync(join(s.dir, "extract.md"), "utf8"), /my own version/, "live file untouched")

  const [file] = readdirSync(s.updates)
  assert.match(file, /^extract\.v\d+\.md$/)
  const update = readFileSync(join(s.updates, file), "utf8")
  assert.match(update, /This file is NOT in use/)
  assert.match(update, /keep your own file and adapt it/)
  assert.match(update, /shorter and straighter/, "the full new default is included")
})

test("a current base produces no news", () => {
  const s = sandbox()
  s.prompts.seed("extract")
  assert.equal(s.prompts.checkForUpdate("extract"), null)
  assert.deepEqual(s.prompts.pendingUpdates(), [])
})

test("the news file is written once, and keeps being reported", () => {
  const s = sandbox()
  mkdirSync(s.dir, { recursive: true })
  writeFileSync(join(s.dir, "extract.md"), "---\nprompt: extract\nbase: 0\n---\n\nmine\n")

  assert.ok(s.prompts.checkForUpdate("extract"))
  const first = readdirSync(s.updates)
  writeFileSync(join(s.updates, first[0]), "edited by hand")

  assert.ok(s.prompts.checkForUpdate("extract"), "still named in the report")
  assert.equal(readFileSync(join(s.updates, first[0]), "utf8"), "edited by hand", "and not rewritten")
})

test("all three prompts seed, resolve and carry a base", () => {
  const s = sandbox()
  for (const name of ["extract", "review", "review-auto"]) {
    assert.equal(s.prompts.seed(name).seeded, true, `${name} did not seed`)
    const got = s.prompts.resolve(name)
    assert.equal(got.layer, "project")
    assert.equal(typeof got.base, "number", `${name} must record which default it came from`)
    assert.ok(got.text.length > 100, `${name} looks empty`)
  }
})

test("every prompt makes the local-or-global call explicit", () => {
  const s = sandbox()
  for (const name of ["extract", "review", "review-auto"]) {
    s.prompts.seed(name)
    const text = s.prompts.resolve(name).text
    // Lessons are always workspace-local (decision 10); what varies is where the fix goes.
    assert.match(text, /different repository/, `${name} must carry the test for a global fix`)
    assert.match(text, /config\/opencode\/AGENTS\.md/, `${name} must name the global harness`)
  }
  assert.match(s.prompts.resolve("review").text, /Never edit anything outside this\nproject without asking/)
  assert.match(s.prompts.resolve("review-auto").text, /approval of their own/)
})

test("no prompt suggests lessons themselves are global", () => {
  const s = sandbox()
  for (const name of ["extract", "review", "review-auto"]) {
    s.prompts.seed(name)
    const text = s.prompts.resolve(name).text
    assert.doesNotMatch(text, /global lesson|promote .*lesson|lesson.* global scope/i, `${name} reintroduces global lessons`)
  }
})

test("the review prompts ask the currency question without prescribing how", () => {
  const s = sandbox()
  for (const name of ["review", "review-auto"]) {
    s.prompts.seed(name)
    const text = s.prompts.resolve(name).text
    assert.match(text, /already resolved in this workspace/, `${name} must put the question`)
    assert.match(text, /however you normally would/, `${name} must leave the method open`)
    assert.match(text, /retro_decide/, `${name} must say how to record the outcome`)
    assert.match(
      text,
      /already available in\s+this session|already available in this session/,
      `${name} must say the tool is present, or the agent goes looking for it`,
    )
    assert.doesNotMatch(text, /git log/, `${name} must not prescribe a command`)
  }
  assert.match(s.prompts.resolve("review").text, /Change nothing until they have decided/)
  assert.match(s.prompts.resolve("review-auto").text, /one plan/)
})

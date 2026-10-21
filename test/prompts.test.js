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

test("both prompts seed, resolve and carry a base", () => {
  const s = sandbox()
  for (const name of ["extract", "propose"]) {
    assert.equal(s.prompts.seed(name).seeded, true, `${name} did not seed`)
    const got = s.prompts.resolve(name)
    assert.equal(got.layer, "project")
    assert.equal(typeof got.base, "number", `${name} must record which default it came from`)
    assert.ok(got.text.length > 100, `${name} looks empty`)
  }
})

test("every prompt makes the local-or-global call explicit", () => {
  const s = sandbox()
  for (const name of ["extract", "propose"]) {
    s.prompts.seed(name)
    const text = s.prompts.resolve(name).text
    // Lessons are always workspace-local (decision 10); what varies is where the fix goes.
    assert.match(text, /global harness|global skill|different repository/, `${name} must raise local vs global`)
  }
  assert.match(s.prompts.resolve("propose").text, /Never edit anything outside this\nproject without asking/)
  // The batch case is a section of the same rule, so the global call is made once, there.
  assert.match(s.prompts.resolve("propose").text, /approval of\s+their own/)
})

test("the propose prompt surveys the setup instead of assuming a target", () => {
  const s = sandbox()
  for (const name of ["propose"]) {
    s.prompts.seed(name)
    const text = s.prompts.resolve(name).text
    assert.match(text, /guess made without/, `${name} must treat the named target as a guess`)
    assert.match(text, /instruction files does the harness read|instruction files the\s+harness reads/, `${name} must ask what exists`)
    assert.match(text, /skills/, `${name} must consider skills`)
  }
  // Creating something new is a legitimate outcome, not only editing what is there.
  assert.match(s.prompts.resolve("propose").text, /Create something that is missing/)
})

test("no prompt suggests lessons themselves are global", () => {
  const s = sandbox()
  for (const name of ["extract", "propose"]) {
    s.prompts.seed(name)
    const text = s.prompts.resolve(name).text
    assert.doesNotMatch(text, /global lesson|promote .*lesson|lesson.* global scope/i, `${name} reintroduces global lessons`)
  }
})

test("the propose prompt asks the currency question without prescribing how", () => {
  const s = sandbox()
  for (const name of ["propose"]) {
    s.prompts.seed(name)
    const text = s.prompts.resolve(name).text
    assert.match(text, /already resolved in this workspace/, `${name} must put the question`)
    assert.match(text, /however you normally would/, `${name} must leave the method open`)
    assert.match(text, /retro_decide/, `${name} must say how to record the outcome`)
    assert.match(text, /discovered/, `${name} must ask for what the work turned up`)
    assert.match(text, /proposed again/, `${name} must say what happens if nothing is recorded`)
    assert.match(
      text,
      /already available in\s+this session|already available in this session/,
      `${name} must say the tool is present, or the agent goes looking for it`,
    )
    assert.doesNotMatch(text, /git log/, `${name} must not prescribe a command`)
  }
  assert.match(s.prompts.resolve("propose").text, /Change nothing until they have decided/)
})

test("a prompt that cannot be seeded reports it and leaves nothing behind", () => {
  const s = sandbox()
  writeFileSync(join(s.root, "blocked"), "not a directory\n")
  const errors = []
  const prompts = createPrompts({
    dir: join(s.root, "blocked", "prompts"),
    updates: join(s.root, "blocked", "prompts", "updates"),
    global: s.global,
    onError: (where) => errors.push(where),
  })

  const result = prompts.seed("extract")
  assert.equal(result.seeded, false)
  assert.match(result.error, /ENOTDIR|EEXIST|not a directory/)
  assert.deepEqual(errors, ["prompts.seed extract"])
  assert.equal(prompts.resolve("extract").layer, "packaged", "and the packaged default still runs")
})

test("one rule covers a batch, instead of a second file repeating it", () => {
  // There used to be a propose-all.md, and it was the same judgement rewritten shorter:
  // currency, where the fix belongs, local or global, change nothing, record the outcome.
  // Two copies of a rule is one the user edits and one that silently disagrees with it.
  const s = sandbox()
  s.prompts.seed("propose")
  const text = s.prompts.resolve("propose").text

  assert.equal(s.prompts.resolve("propose-all"), null, "there is no second file to keep in step")
  assert.match(text, /If several lessons are listed/, "the batch case is a section of the one rule")
  assert.match(text, /Everything above applies to each of them/, "and it says so, rather than restating it")
  assert.match(text, /one plan/)
  assert.match(text, /group anything touching the same file/, "what a batch actually adds is the shape")
})

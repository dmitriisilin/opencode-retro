import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitsTouching, headCommit } from "../src/git.js"
import { assessCurrency, explainChange, fingerprintOf } from "../src/currency.js"

function repo() {
  const root = mkdtempSync(join(tmpdir(), "retro-git-"))
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  mkdirSync(join(root, "docs"), { recursive: true })
  writeFileSync(join(root, "docs", "AGENTS.md"), "always run the lint skill\n")
  git("add", "-A")
  git("commit", "-qm", "baseline")
  return { root, git }
}

test("the head commit is read, and nonsense directories fail silent", async () => {
  const r = repo()
  const head = await headCommit(r.root)
  assert.match(head, /^[0-9a-f]{40}$/)
  assert.equal(await headCommit(join(r.root, "nope-not-here")), null)
})

test("commits touching the target since the lesson are named", async () => {
  const r = repo()
  const base = await headCommit(r.root)

  writeFileSync(join(r.root, "docs", "AGENTS.md"), "only run lint if eslint.config.* exists\n")
  r.git("commit", "-aqm", "make lint conditional on a config")

  const commits = await commitsTouching(r.root, "docs/AGENTS.md", base)
  assert.equal(commits.length, 1)
  assert.match(commits[0], /make lint conditional on a config/)

  assert.deepEqual(await commitsTouching(r.root, "docs/other.md", base), [], "untouched files name nothing")
  assert.deepEqual(await commitsTouching(r.root, "docs/AGENTS.md", null), [], "and without a base there is nothing to compare")
})

test("a changed target comes with the commit that changed it", async () => {
  const r = repo()
  const fingerprint = fingerprintOf(r.root)
  const lesson = {
    id: "l",
    proposal: { target: "docs/AGENTS.md", change: "make it conditional" },
    targetFingerprint: fingerprint("docs/AGENTS.md"),
    baseCommit: await headCommit(r.root),
  }

  writeFileSync(join(r.root, "docs", "AGENTS.md"), "only run lint if eslint.config.* exists\n")
  r.git("commit", "-aqm", "make lint conditional on a config")

  const base = assessCurrency(lesson, { directory: r.root })
  assert.equal(base.state, "target-changed")

  const explained = await explainChange(base, lesson, { directory: r.root })
  assert.match(explained.warning, /Committed since the lesson was recorded/)
  assert.match(explained.warning, /make lint conditional on a config/)
  assert.equal(explained.commits.length, 1)
})

test("an unchanged target is not dressed up with commit noise", async () => {
  const r = repo()
  const fingerprint = fingerprintOf(r.root)
  const lesson = {
    id: "l",
    proposal: { target: "docs/AGENTS.md", change: "x" },
    targetFingerprint: fingerprint("docs/AGENTS.md"),
    baseCommit: await headCommit(r.root),
  }
  const got = await explainChange(assessCurrency(lesson, { directory: r.root }), lesson, { directory: r.root })
  assert.equal(got.state, "unchanged")
  assert.equal(got.commits, undefined)
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { VERSION } from "../index.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))

test("the version the self-check reports is the version we ship", () => {
  // Read from package.json at runtime, not copied: `npm version` commits only package.json,
  // so a constant here would stay behind and ship a self-check that lies about its version.
  assert.equal(VERSION, pkg.version, "a diagnostic that misreports its own version is worse than none")
})

test("the published tarball carries everything the entry point imports", () => {
  const out = mkdtempSync(join(tmpdir(), "retro-pack-"))
  execFileSync("npm", ["pack", "--pack-destination", out], { cwd: root, stdio: "pipe" })
  const [tgz] = readdirSync(out).filter((f) => f.endsWith(".tgz"))
  assert.ok(tgz, "npm pack produced nothing")

  const listed = execFileSync("tar", ["-tzf", join(out, tgz)], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.replace(/^package\//, "").trim())
    .filter(Boolean)

  // Every local import the plugin makes has to be in the tarball, or it loads and dies.
  const sources = readdirSync(join(root, "src")).filter((f) => f.endsWith(".js"))
  for (const file of sources) {
    assert.ok(listed.includes(`src/${file}`), `src/${file} is missing from the package`)
  }
  assert.ok(listed.includes("index.js"))
  assert.ok(
    listed.includes("package.json"),
    "package.json must ship: the self-check reads the version it reports from it",
  )
  for (const name of ["extract", "propose", "propose-all"]) {
    assert.ok(listed.includes(`prompts/${name}.md`), `prompts/${name}.md must ship — it is seeded at runtime`)
  }
  assert.ok(listed.includes("README.md"))
  assert.ok(listed.includes("LICENSE"))

  // And nothing that is only ours to develop with.
  for (const unwanted of ["spike", "fixtures", "test"]) {
    assert.ok(
      !listed.some((f) => f.startsWith(`${unwanted}/`)),
      `${unwanted}/ should not be published`,
    )
  }
})

test("every local import in src resolves to a file that exists", () => {
  const files = readdirSync(join(root, "src")).filter((f) => f.endsWith(".js"))
  for (const file of [...files, "../index.js"]) {
    const where = file.startsWith("..") ? join(root, "index.js") : join(root, "src", file)
    const text = readFileSync(where, "utf8")
    for (const [, spec] of text.matchAll(/from "(\.\.?\/[^"]+)"/g)) {
      const resolved = join(dirname(where), spec)
      assert.ok(existsSync(resolved), `${file} imports missing ${spec}`)
      assert.ok(readFileSync(resolved, "utf8").length > 0, `${file} imports an empty ${spec}`)
    }
  }
})

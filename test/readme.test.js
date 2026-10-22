import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CANONICAL, LANGUAGES, READMES, bar, englishHash, stampOf } from "../scripts/i18n-stamp.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

test("every language in the set has a README", () => {
  for (const { file } of READMES) assert.ok(existsSync(join(root, file)), `${file} is missing`)
})

test("Russian is the README that opens by default, and English is the canonical text", () => {
  // GitHub and npm show `README.md`. Which language that is was the owner's choice; which
  // text the translations are checked against is a separate one, and stays English.
  assert.equal(READMES.find((r) => r.file === "README.md").code, "ru")
  assert.equal(CANONICAL, "README.en.md")
})

test("every README carries the same language bar, with its own language unlinked", () => {
  for (const { code, file } of READMES) {
    const text = readFileSync(join(root, file), "utf8")
    assert.ok(text.includes(bar(code)), `${file} should carry the bar: ${bar(code)}`)
  }
})

test("no translation has drifted from the English it was translated from", () => {
  const want = englishHash()
  const stale = []
  for (const { code, name, file } of LANGUAGES) {
    const { stamp } = stampOf(code)
    if (stamp !== want) stale.push(`${name} (${file}, stamped ${stamp ?? "never"})`)
  }
  assert.deepEqual(
    stale,
    [],
    `${CANONICAL} changed and these translations have not been updated:\n  ${stale.join("\n  ")}\n` +
      `Update them, then run \`npm run i18n\` to re-stamp. English is canonical; a stale ` +
      `translation is a lie told to whoever can only read it.`,
  )
})

test("each translation says, in its own words plus the word itself, that English wins", () => {
  // The literal "canonical" is the machine-checkable part; every translation carries it in
  // parentheses so this contract does not depend on guessing each language's phrasing.
  // Full-width parentheses count: the punctuation should follow the language, not the test.
  for (const { code, file } of LANGUAGES) {
    const text = stampOf(code).text
    assert.match(text, /[(（]canonical[)）]/, `${file} must mark which version wins`)
    assert.match(text, /^> .*README\.en\.md/m, `${file} must name the English file in a blockquote near the top`)
  }
})

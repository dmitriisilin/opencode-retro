import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { LANGUAGES, englishHash, stampOf } from "../scripts/i18n-stamp.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const english = readFileSync(join(root, "README.md"), "utf8")

test("every language in the set has a translation", () => {
  for (const { code } of LANGUAGES) {
    assert.ok(existsSync(join(root, `README.${code}.md`)), `README.${code}.md is missing`)
  }
})

test("every README carries the same language bar, with its own language unlinked", () => {
  const files = [["en", english], ...LANGUAGES.map(({ code }) => [code, readFileSync(join(root, `README.${code}.md`), "utf8")])]

  for (const [code, text] of files) {
    for (const { code: other, name } of LANGUAGES) {
      if (other === code) {
        assert.match(text, new RegExp(`\\*\\*${name}\\*\\*`), `README.${code}.md should show ${name} as plain text`)
      } else {
        assert.ok(text.includes(`(README.${other}.md)`), `README.${code}.md does not link to ${other}`)
      }
    }
    if (code !== "en") assert.ok(text.includes("(README.md)"), `README.${code}.md does not link back to English`)
  }
})

test("no translation has drifted from the English it was translated from", () => {
  const want = englishHash()
  const stale = []
  for (const { code, name } of LANGUAGES) {
    const { stamp } = stampOf(code)
    if (stamp !== want) stale.push(`${name} (README.${code}.md, stamped ${stamp ?? "never"})`)
  }
  assert.deepEqual(
    stale,
    [],
    `README.md changed and these translations have not been updated:\n  ${stale.join("\n  ")}\n` +
      `Update them, then run \`npm run i18n\` to re-stamp. English is canonical; a stale ` +
      `translation is a lie told to whoever can only read it.`,
  )
})

test("each translation says, in its own words plus the word itself, that English wins", () => {
  // The literal "canonical" is the machine-checkable part; every translation carries it in
  // parentheses so this contract does not depend on guessing each language's phrasing.
  // Full-width parentheses count: the punctuation should follow the language, not the test.
  for (const { code } of LANGUAGES) {
    const text = stampOf(code).text
    assert.match(text, /[(（]canonical[)）]/, `README.${code}.md must mark which version wins`)
    assert.match(text, /^> /m, `README.${code}.md must carry the note as a blockquote near the top`)
  }
})

#!/usr/bin/env node
/**
 * Stamps every translation with the hash of the English README it matches.
 *
 * Run it after updating a translation. `npm test` fails while any stamp is stale, which is
 * the only thing that makes "we maintain the translations" true rather than aspirational —
 * a translation that silently drifts is a lie told to the people who can read only it.
 *
 * English is canonical and lives in `README.en.md`. Russian is `README.md`, the page GitHub
 * and npm open by default — the owner's choice of the language the project is presented in,
 * which is a separate question from which text the others are checked against.
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

export const CANONICAL = "README.en.md"

/** Every README, in the order the language bar shows them. */
export const READMES = [
  { code: "ru", name: "Русский", file: "README.md" },
  { code: "en", name: "English", file: CANONICAL },
  { code: "zh-CN", name: "简体中文", file: "README.zh-CN.md" },
  { code: "es", name: "Español", file: "README.es.md" },
  { code: "ja", name: "日本語", file: "README.ja.md" },
]

/** The translations: everything but the canonical text. */
export const LANGUAGES = READMES.filter((r) => r.file !== CANONICAL)

export const STAMP = /^<!-- translated-from: README\.en\.md@([0-9a-f]{12}) -->$/m

/** The language bar for one README: its own language in bold, the others linked. */
export const bar = (code) =>
  READMES.map((r) => (r.code === code ? `**${r.name}**` : `[${r.name}](${r.file})`)).join(" | ")

export const englishHash = () =>
  createHash("sha256").update(readFileSync(join(root, CANONICAL))).digest("hex").slice(0, 12)

export const stampOf = (code) => {
  const { file } = READMES.find((r) => r.code === code)
  const text = readFileSync(join(root, file), "utf8")
  return { text, stamp: STAMP.exec(text)?.[1] ?? null }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = englishHash()
  for (const { file } of LANGUAGES) {
    const path = join(root, file)
    const text = readFileSync(path, "utf8")
    const line = `<!-- translated-from: README.en.md@${want} -->`
    writeFileSync(path, STAMP.test(text) ? text.replace(STAMP, line) : `${line}\n${text}`)
    console.log(`stamped ${file} -> ${want}`)
  }
}

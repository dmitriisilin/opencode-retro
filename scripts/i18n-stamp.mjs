#!/usr/bin/env node
/**
 * Stamps every translation with the hash of the English README it matches.
 *
 * Run it after updating a translation. `npm test` fails while any stamp is stale, which is
 * the only thing that makes "we maintain the translations" true rather than aspirational —
 * a translation that silently drifts is a lie told to the people who can read only it.
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

export const LANGUAGES = [
  { code: "ru", name: "Русский" },
  { code: "zh-CN", name: "简体中文" },
  { code: "es", name: "Español" },
  { code: "ja", name: "日本語" },
]

export const STAMP = /^<!-- translated-from: README\.md@([0-9a-f]{12}) -->$/m

export const englishHash = () =>
  createHash("sha256").update(readFileSync(join(root, "README.md"))).digest("hex").slice(0, 12)

export const stampOf = (code) => {
  const text = readFileSync(join(root, `README.${code}.md`), "utf8")
  return { text, stamp: STAMP.exec(text)?.[1] ?? null }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = englishHash()
  for (const { code } of LANGUAGES) {
    const path = join(root, `README.${code}.md`)
    const text = readFileSync(path, "utf8")
    const line = `<!-- translated-from: README.md@${want} -->`
    writeFileSync(path, STAMP.test(text) ? text.replace(STAMP, line) : `${line}\n${text}`)
    console.log(`stamped README.${code}.md -> ${want}`)
  }
}

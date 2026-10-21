import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { REQUIRED_SURFACE } from "../src/selfcheck.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => readFileSync(join(root, p), "utf8")

/**
 * Guards against the failure that cost the most time in this project: text and behaviour
 * drifting apart. Removing a command left its name in six places in shipped code, in the
 * seeded prompt and twice in every README, and nothing failed. These check the claims that
 * can be checked mechanically.
 */

const SHIPPED = [
  "index.js",
  ...readdirSync(join(root, "src")).map((f) => `src/${f}`),
  ...readdirSync(join(root, "prompts")).map((f) => `prompts/${f}`),
  "README.md",
  "README.ru.md",
  "README.zh-CN.md",
  "README.es.md",
  "README.ja.md",
]

test("every command named in shipped text is a command that exists", () => {
  const registered = [...read("index.js").matchAll(/name: "(retro[a-z-]*)"/g)].map((m) => m[1])
  assert.deepEqual(registered.sort(), ["retro", "retro-all"], "the surface itself")

  // `/retro all` is an argument to `/retro`, so both spellings are legitimate.
  const allowed = new Set([...registered, "retro all"])
  const offenders = []
  for (const file of SHIPPED) {
    for (const [, named] of read(file).matchAll(/`\/(retro[a-z -]*)`/g)) {
      const name = named.trim()
      if (!allowed.has(name)) offenders.push(`${file}: /${name}`)
    }
  }
  assert.deepEqual(offenders, [], `text names commands that do not exist:\n  ${offenders.join("\n  ")}`)
})

test("every option the plugin reads is documented, in every language", () => {
  // The other direction of the same drift: extractLimit and heartbeatMs were settable and
  // undocumented, and autoExtract appeared only in prose.
  const block = read("src/config.js").match(/export const DEFAULTS = \{([\s\S]*?)\n\}/)?.[1] ?? ""
  const declared = new Set([...[...block.matchAll(/^  ([a-zA-Z]+):/gm)].map((m) => m[1]), "model"])
  assert.ok(declared.size >= 10, "config should still be declaring options")

  const undocumented = []
  for (const file of SHIPPED.filter((f) => f.startsWith("README"))) {
    const text = read(file)
    for (const option of declared) {
      if (!text.includes(`\`${option}\``) && !text.includes(`options.${option}`)) {
        undocumented.push(`${file}: ${option}`)
      }
    }
  }
  assert.deepEqual(undocumented, [], `settable and undocumented:\n  ${undocumented.join("\n  ")}`)
})

test("every record kind the log can hold is rendered to the extractor", () => {
  const written = new Set([...read("src/ingest.js").matchAll(/k: "([a-z]+)"/g)].map((m) => m[1]))
  const rendered = new Set([...read("src/projection.js").matchAll(/case "([a-z]+)":/g)].map((m) => m[1]))
  for (const kind of written) {
    assert.ok(rendered.has(kind), `records of kind "${kind}" are written but never projected`)
  }
})

test("nothing exported from src is unreachable", () => {
  const files = readdirSync(join(root, "src")).filter((f) => f.endsWith(".js"))
  const everywhere = [...files.map((f) => read(`src/${f}`)), read("index.js"), ...readdirSync(join(root, "test")).map((f) => read(`test/${f}`))].join("\n")

  const dead = []
  for (const file of files) {
    const body = read(`src/${file}`)
    for (const [, name] of body.matchAll(/^export (?:async function|function|const) ([A-Za-z_]+)/gm)) {
      // Count uses outside its own export line; a constant used as a default parameter in
      // its own file counts, which is why the whole corpus is searched.
      const uses = everywhere.split(new RegExp(`\\b${name}\\b`)).length - 1
      const declarations = [...everywhere.matchAll(new RegExp(`^export (?:async function|function|const) ${name}\\b`, "gm"))].length
      if (uses - declarations <= 0) dead.push(`src/${file}: ${name}`)
    }
  }
  assert.deepEqual(dead, [], `exported and never used:\n  ${dead.join("\n  ")}`)
})

test("the self-check requires exactly the ctx surface the plugin calls", () => {
  // The surface check is the one API break detectable without waiting for traffic, so it is
  // only worth what it names. It required `generate.text`, which index.js mentions only to
  // say why it is not used, and left out session.create/generate/remove — the calls every
  // analysis runs through. Present-but-unused proves nothing; absent-and-used is invisible.
  const source = read("index.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

  const used = new Set()
  for (const [, domain, member] of source.matchAll(/\bctx\.([a-z]+)\.([a-zA-Z]+)\s*\(/g)) {
    used.add(`${domain}.${member}`)
  }
  // Hooks go through one helper, so the domain is a literal argument rather than a property.
  for (const [, domain] of source.matchAll(/\bhook\(\s*"([a-z]+)"\s*,/g)) used.add(`${domain}.hook`)

  const declared = new Set(REQUIRED_SURFACE.map(([d, m]) => `${d}.${m}`))

  assert.deepEqual(
    [...used].sort().filter((m) => !declared.has(m)),
    [],
    "the plugin calls something the self-check does not watch",
  )
  assert.deepEqual(
    [...declared].sort().filter((m) => !used.has(m)),
    [],
    "the self-check watches something the plugin does not call",
  )
})

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { REQUIRED_SURFACE } from "../src/selfcheck.js"
import { DEFAULTS } from "../src/config.js"

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
  "README.en.md",
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
  // SHIPPED only, and AGENTS.md deliberately not. Widening it there was tried and reverted:
  // the brief legitimately *records* removed commands ("there was a third, and it is gone",
  // and the plan entries that built them), so a rule of "a removed command may not be named"
  // flags five correct sentences to catch one wrong one. Telling an assertion from a record
  // mechanically is the open question in the `agents-md-drift-not-guarded` lesson, and it is
  // the owner's to answer.
  for (const file of SHIPPED) {
    for (const [, named] of read(file).matchAll(/`\/(retro[a-z -]*)`/g)) {
      const name = named.trim()
      if (!allowed.has(name)) offenders.push(`${file}: /${name}`)
    }
  }
  assert.deepEqual(offenders, [], `text names commands that do not exist:\n  ${offenders.join("\n  ")}`)
})

test("the hand-over names the session logs where the plugin actually keeps them", () => {
  // Measured live: the agent read a lesson, went to `sessions/` in the project root as the
  // hand-over told it to, found nothing, and wrote the mistake into `discovered`. The path
  // is in a file the user can edit, so it cannot be derived at call time — but the default
  // it names has to be the default the plugin uses.
  const where = `${DEFAULTS.dir}/sessions/`
  assert.ok(
    read("prompts/propose.md").includes(where),
    `prompts/propose.md must name ${where}, where the logs are by default`,
  )
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

test("the three steps are named extract, propose and decide — and no name is `review`", () => {
  // Names, not prose: `review` is still ordinary English for reading something ("nothing to
  // review", "a lesson can sit for weeks before anyone reviews it") and that is fine. What is
  // not fine is a name a user types or edits — a prompt file, an option, a command, a section
  // heading — because that is where the vocabulary lives. This was the drift that left
  // `### Review` in five READMEs and "Review …" in both command descriptions.
  const prompts = readdirSync(join(root, "prompts")).filter((f) => f.endsWith(".md"))
  assert.deepEqual(
    prompts.sort(),
    ["extract.md", "propose.md"],
    "one prompt per step the user owns; `propose-all.md` was two copies of one rule",
  )
  for (const name of ["extract", "propose"]) {
    const frontmatter = read(`prompts/${name}.md`).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""
    assert.match(frontmatter, new RegExp(`^prompt: ${name}$`, "m"), `prompts/${name}.md must name itself ${name}`)
  }

  const options = [...read("src/config.js").matchAll(/^  ([a-zA-Z]+):/gm)].map((m) => m[1])
  const commands = [...read("index.js").matchAll(/name: "(retro[a-z-]*)"/g)].map((m) => m[1])
  const named = [...options.map((o) => `option ${o}`), ...commands.map((c) => `/${c}`)]
  assert.deepEqual(named.filter((n) => /review/i.test(n)), [], "a step was renamed; no name may still carry the old word")

  const tool = read("index.js").match(/name: "(retro_[a-z_]+)"/)?.[1] ?? null
  assert.equal(tool, "retro_decide", "the decision step is recorded through `retro_decide`")

  // English headings are matched by word; translated ones only by structure, because a
  // translated heading cannot be compared with an English one. The four translations used to
  // say "Revisión" / "レビュー" / "复核" / "Разбор" where English now says "Propose".
  const headings = (file) => [...read(file).matchAll(/^#{1,6} .*$/gm)].map((m) => m[0])
  assert.deepEqual(headings("README.en.md").filter((h) => /review/i.test(h)), [], "README.en.md still has a `review` heading")
  const levels = headings("README.en.md").map((h) => h.match(/^#+/)[0])
  for (const file of SHIPPED.filter((f) => /^README(\..+)?\.md$/.test(f) && f !== "README.en.md")) {
    assert.deepEqual(headings(file).map((h) => h.match(/^#+/)[0]), levels, `${file} has a different section structure`)
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

test("nothing after setup returns is a binding, because a binding there is never initialised", () => {
  // `/retro` shipped broken for a commit on exactly this: `const currencyOf = …` written
  // below setup's `return`, so every call threw "Cannot access 'currencyOf' before
  // initialization" while the unit tests passed. It happened again with `isLive`. Function
  // declarations hoist out of the dead region; `const` and `let` do not, and the failure is
  // invisible until a command actually runs.
  const source = read("index.js")
  const lines = source.split("\n")
  const ret = lines.findIndex((l) => /^ {4}return \(\) =>/.test(l))
  assert.ok(ret > 0, "setup's return should be at one indent inside setup")

  const offenders = lines
    .slice(ret + 1)
    .map((line, i) => [ret + i + 2, line])
    .filter(([, line]) => /^ {4}(const|let|var) /.test(line))
    .map(([n, line]) => `${n}: ${line.trim().slice(0, 60)}`)

  assert.deepEqual(offenders, [], "declare it as `function name() {}` or move it above the return")
})

test("every invariant in docs/concepts cites a test that exists", () => {
  // The concept documents are the place to change first, and they stay honest the same way
  // the READMEs do: mechanically. Each invariant names the test that pins it by its exact
  // title, so a renamed or deleted test breaks the document that leaned on it, and an
  // invariant nobody tested is visible as a missing citation rather than as a sentence that
  // reads as settled.
  const titles = new Set()
  for (const file of readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.js"))) {
    for (const [, title] of read(`test/${file}`).matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)) {
      titles.add(title.replace(/\\"/g, '"'))
    }
    // Histories the model test found are tests too, declared as keys of its FOUND table.
    for (const [, title] of read(`test/${file}`).matchAll(/^  "((?:[^"\\]|\\.)*)": \[$/gm)) {
      titles.add(title)
    }
  }

  const missing = []
  for (const file of readdirSync(join(root, "docs", "concepts")).filter((f) => f.endsWith(".md") && f !== "README.md")) {
    const text = read(`docs/concepts/${file}`)
    // A citation is a backticked line standing on its own under an invariant.
    for (const [, cited] of text.matchAll(/^\s*`([^`]+)`\s*$/gm)) {
      if (!titles.has(cited)) missing.push(`${file}: ${cited}`)
    }
  }
  assert.deepEqual(missing, [], `cited tests that do not exist:\n  ${missing.join("\n  ")}`)
})

test("an invariant that names no test says so, rather than looking settled", () => {
  // docs/concepts/README.md promises this: an invariant with no test reads `(untested)`.
  // Without a check the promise is only a habit, and the habit is exactly what fails first.
  const naked = []
  for (const file of readdirSync(join(root, "docs", "concepts")).filter((f) => f.endsWith(".md") && f !== "README.md")) {
    let inInvariants = false
    let bullet = null
    const flush = () => {
      if (bullet && !bullet.cited && !/\(untested\)/.test(bullet.text)) {
        naked.push(`${file}: ${bullet.text.trim().slice(0, 72)}`)
      }
    }
    for (const line of read(`docs/concepts/${file}`).split("\n")) {
      if (/^## Invariants/.test(line)) {
        inInvariants = true
        continue
      }
      if (inInvariants && /^## /.test(line)) {
        flush()
        inInvariants = false
        bullet = null
        continue
      }
      if (!inInvariants) continue
      if (/^- /.test(line)) {
        flush()
        bullet = { text: line, cited: false }
      } else if (bullet && /^\s*`[^`]+`\s*$/.test(line)) bullet.cited = true
    }
    flush()
  }
  assert.deepEqual(naked, [], `invariants with no test and no marker:\n  ${naked.join("\n  ")}`)
})

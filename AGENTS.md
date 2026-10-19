# AGENTS.md — opencode-retro

Context for any coding agent (OpenCode, Claude Code, …) working on this repo. Read this first; README.md is the public-facing pitch, this file is the working brief.

## What we are building

An OpenCode **v2** plugin that turns friction in agent sessions into proposed changes to the project's harness (skills, AGENTS.md, tools, code), reviewed by a human via `/retro`.

Owner's framing: the goal is that a human never has to read session logs, yet every next session gets *shorter and straighter*. The plugin reads the log; the human reads proposals.

Motivating example: a project carries a `lint` skill borrowed from another harness. The project doesn't use a linter. The agent runs the skill, eslint rewrites dozens of files, the agent realises the project has no linter and reverts everything. Every session. The plugin should catch this once and propose fixing the skill (precondition: check for lint config) or removing it.

## Decisions already made (don't relitigate without a reason)

1. **Name:** `opencode-retro` (retrospective). npm name reserved by `dmitriisilin`. "loop" was rejected: in the OpenCode ecosystem `/loop` already means recurring prompts / Ralph loops.
2. **v2 only.** No v1 compatibility layer.
3. **Shadow log.** Plugin writes its own append-only log of every tool call and prompt to `.opencode/retro/sessions/<sessionID>.jsonl` in real time. No LLM, no batching. We do *not* depend on session history surviving compaction.
4. **Anchors, not a gate.** Cheap deterministic detectors (revert, repeat, skill→failure, abandon, correction) mark suspicious step ranges. They do not decide anything; they tell the extractor where to look and give precise evidence refs.
5. **Extraction runs in a separate, clean-context session**, not the working agent (it would defend its own choices). Input: compressed projection of the shadow log (tool outputs trimmed to head/tail, prompts and assistant text in full) + anchors + existing lessons. Core question: *"If this session were run again, what should change so it goes shorter and straighter?"*
6. **No separate "incident" entity.** Log → lessons. Each lesson carries `evidence` (session id + step ranges).
7. **Lesson ≠ proposal.** Extracting the lesson is mandatory; proposing where to apply it is optional. Targets `skill | instruction | tool | refactor | other` are prompt hints, not an enum the extractor must fit into. "Doesn't fit the ontology" is a normal outcome — the human decides.
8. **Lessons are workspace-scoped** (git root), capped (default 30), ranked by `score = cost × recurrence × confidence`. When an extraction matches an existing lesson, increment `recurrence` instead of creating a duplicate. Overflow is archived, not deleted.
9. **Integration loop is human-triggered:** `/retro` walks lessons by score, one by one: accept / edit / reject / later. Accept applies the diff. Reject is remembered and fed back to the extractor so it isn't proposed again. `tool` and `refactor` are never auto-applied — only written up as requests.
10. **Project-scoped by default.** Global promotion only if evidence has no project-specific files/configs AND the lesson recurred in ≥2 workspaces. Promotion is itself a `/retro` proposal.
11. **Autonomy ladder L0–L3** (see README). v1 target is L1. Promotion between levels is to be driven by accept/reject stats, later.
12. **Not a memory plugin.** We edit artifacts the harness already reads; we don't build a knowledge base the agent must remember to query.
13. **Both prompts live in the user's project, not in the package.** The extraction prompt (log → lessons) and the application prompt (lesson → proposal) are the two places where this plugin's behaviour is actually decided, so they sit next to their inputs and outputs, in `.retro/prompts/`. The package ships defaults; on first run they are copied into the project if absent. Resolution order per prompt: project → global (`~/.config/opencode/retro/prompts/`) → packaged default. `options` in `opencode.json` can override the directory and the extractor model.
14. **The prompt is editable; the output contract is not.** The project file holds criteria, emphasis and project-specific wording. The plugin appends an output-format block it owns and the user does not edit. Reason: a free-form edit that breaks parsing would silently stop lessons from being created — the exact failure mode decision 16 exists to prevent.
15. **Shipped prompts upgrade without clobbering local edits.** Each copied prompt records in frontmatter the hash of the default it came from. On load: unchanged copy + newer default → upgrade silently; locally edited + newer default → leave the local file alone and say so in the self-check report, with the diff available. Never overwrite an edited prompt.
16. **The plugin must prove it is alive, in a file.** `.retro/selfcheck.md`, rewritten at the end of every session. Registration proves nothing (see "Gotchas": wrong hook names register happily), so the report asserts *liveness*, not setup. If the file is older than the user's last session, the plugin is not running — that is the one failure it cannot report itself, so the file's mtime carries it.

## On-disk layout (in the user's project, not this repo)

```
.retro/
├── prompts/
│   ├── extract.md            # log → lessons        (user-editable, decision 13)
│   └── apply.md              # lesson → proposal    (user-editable, decision 13)
├── sessions/<sessionID>.jsonl # shadow log, one event per line
├── lessons/<lessonID>.md      # YAML frontmatter + body, one per lesson
├── archive/                   # evicted lessons
├── selfcheck.md               # is the plugin actually working (decision 16)
├── state.json                 # rejected ids, last extraction per session, etc.
└── plugin.log                 # hook errors; never thrown at the user's session
```

One directory holding, in order: the prompt that produces the lessons, the raw
material, the lessons, and the evidence that any of it ran. That is the whole
plugin, readable without us.

**Not `.opencode/retro/`.** Measured in M0: every write under `.opencode/` makes
OpenCode rescan skills and emit `skill.updated`, so a plugin that writes on events
writes forever — 416 events in one session and still climbing with no session running
(`fixtures/payloads/event-feedback-loop.jsonl`). Even without the loop it would mean
one skill rescan per shadow-log append. `<project>/.retro/` is clean: 1 `skill.updated`,
no loop. (`.opencode-retro/` was the other candidate; same properties, longer to type.)

Lesson frontmatter: see README "Lesson format". Keep it human-editable — users will open these files.

## OpenCode v2 plugin API — verified against 2.0.32

Checked on a real install (`opencode v2.0.32`, Bun runtime) with `spike/probe`.
Raw payloads: `fixtures/payloads/`. Everything in this section is observed, not inferred.

### Package

`@opencode/plugin` — **not** `@opencode-ai/plugin`. Two unrelated npm lines:

| Package | Latest | What it is |
|---|---|---|
| `@opencode/plugin` | `2.0.32` | v2. Versioned in lockstep with the `opencode` binary. |
| `@opencode-ai/plugin` | `1.19.3` | v1, plus a transitional `./v2/promise` subpath whose context has none of the hooks we need. Ignore it. |

Exports: `.` (promise flavour — use this), `./effect`, `./host`, `./runtime`, `./tui`.
`import { Plugin } from "@opencode/plugin"` works: the entry does `export * as Plugin from "./plugin.js"`.
Our `peerDependencies` is already right (`>=2.0.18 <3`) but names the wrong package — fix in M1.

### Shape

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-retro",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", (e) => {})        // returns { dispose }
    await ctx.session.hook("prompt", (e) => {})
    await ctx.command.transform((cmds) => cmds.add({ name, description, execute }))
    const ac = new AbortController()
    void (async () => {
      for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {}
    })()
    return () => ac.abort()                                // cleanup runs on shutdown
  },
})
```

`ctx` carries 26 keys. The ones that matter to us:

| | |
|---|---|
| `tool` | `hook("execute.before"\|"execute.after")`, `transform`, `list`, `reload` |
| `session` | `hook(…)` ×12, plus `create / prompt / generate / command / compact / context / wait / interrupt / …` |
| `event` | `subscribe({ signal })` → `AsyncIterable` over every event in the location |
| `generate` | `text({ prompt, model: { providerID, id } })` → `{ text }` |
| `command` | `transform(cmds => cmds.add({ name, description, execute }))`, `list`, `reload` |
| `skill` | `list`, `transform`, `reload` |
| `vcs` | `status`, `diff`, `base`, `branch`, `get` |
| `storage` | `get / set / remove / scan` — JSON KV, plugin-scoped |
| `permission` | `hook`, `assert`, `list`, `reply` |
| `shell` | `hook` |
| `location` | `{ directory, project: { id, directory, canonical }, workspaceID }` |

`location.project.id` is a stable workspace identifier — use it for lesson scoping
(decision 8) instead of shelling out to `git rev-parse`.

Local loading: `"plugins": [{ "package": "/abs/path", "options": {…} }]` in
`opencode.json`. Verify with `opencode api get /api/plugin -H "x-opencode-directory: <dir>"`;
ours reports `source: { type: "local", path }`, `features: { server: true }`.

### What the payloads actually look like

**Tool calls.** `execute.before` / `execute.after` both carry
`{ tool, sessionID, agent, messageID, id, input }`; `after` adds
`status: "completed" | "error"` and `result: { output, content, metadata }`.
Observed tool names: `read`, `glob`, `edit`, `shell`, `skill`. Not `bash` — `shell`.

- **A skill invocation is an ordinary tool call**: `tool: "skill"`, `input: { id: "lint" }`,
  and the result's `metadata` gives `{ name, directory }` — the exact `SKILL.md` to
  propose a change to. The skill→failure anchor needs nothing but the shadow log.
- **`edit` returns a unified patch** per file in `result.metadata.files[]` with
  `{ file, patch, additions, deletions, status }`. Revert detection can compare patches
  instead of guessing from paths.
- **`shell` exit codes live in `result.output.exit` / `result.metadata.exit`**, *not* in
  `status`. The eslint failure in the trap fixture is `status: "completed"` with `exit: 2`.
  Any failure detector that reads `status` will see a clean session.
- **Tool calls run in parallel.** `before` events arrive batched ahead of their `after`s
  (observed: 3 × `before`, then 3 × `after`). Pair them by `id`; never assume interleaving
  and never use arrival order as a step index.

**Prompts.** `session.prompt` → `{ sessionID, messageID, prompt: { text, files }, delivery }`.

**Step index.** Every event carries `durable: { aggregateID, seq, version }`, where
`aggregateID` is the session and `seq` is monotonic per session. That is our evidence
coordinate (decision 6) — not a counter we maintain ourselves.

**Clean-context model call.** `ctx.generate.text({ prompt, model: { providerID, id } })`
returns `{ text }` — one-shot, no session, no history. This is the extractor's call
(decision 5). `ctx.session.create({ title, location })` also works as a fallback if the
extractor ever needs tools.

**`/retro` is a real command.** `cmds.add({ name, description, execute })` registers, and
`execute` fires with `{ sessionID, prompt: { text }, delivery }`. No template and no TUI
plugin needed — and it gets the `sessionID`, so it can drive the review conversation with
`ctx.session.prompt()`.

### Gotchas that cost time

1. **Writing under `.opencode/` is a feedback loop.** Any write there makes OpenCode
   rescan skills and emit `skill.updated`. A plugin that writes on each event therefore
   writes forever: the probe produced 416 `skill.updated` in one session and kept growing
   by ~17 events/second with no session running
   (`fixtures/payloads/event-feedback-loop.jsonl`). The same probe writing to
   `<project>/.retro-probe/` or outside the project emits exactly 1.
   **This breaks the on-disk layout above — see the flag there.**
2. **`session.idle` never fired.** Not in `opencode run --standalone`, not on the
   background service a minute after the turn finished. The event type exists in the
   schema; assume it is TUI-only. Use `session.execution.succeeded` / `.failed` /
   `.interrupted` — they fire reliably and carry `{ sessionID }`. Decision 5 says
   "on `session.idle`"; read it as "on `session.execution.*`".
3. **The plugin path must be absolute.** A relative `package` path hangs session startup
   and the plugin never loads — no error, no log line, nothing in `/api/plugin`. Retested
   against an absolute control that completed in seconds under the same service.
4. **The background service caches the plugin**, including the environment it was started
   with. Use `--standalone` while iterating, or `opencode service restart`.
5. **Never hook `session.hook("http.request"|"http.response")`** — they carry the provider
   `Authorization` header. `model.request` is safe (checked: headers are session/telemetry
   only), and that is the one to use if we ever need the model ref.
6. **API requests are location-scoped.** GETs honour `-H "x-opencode-directory: <dir>"`;
   `POST /api/session` ignores it and needs `location: { directory }` in the body. A
   session created in the wrong location makes a plugin-registered command 404 with
   `CommandNotFoundError` even though `/api/command` lists it.
7. **Plugins load lazily per location.** The first command invocation right after service
   start can 404 before the plugin has finished loading, and `/api/plugin` does not list
   the plugin until something in that location has triggered a load.
8. **A wrong hook name registers happily.** `ctx.tool.hook("execute.nonsense")` and
   `ctx.session.hook("promptz")` both return a normal `{ dispose }` registration
   (`fixtures/payloads/api-drift.jsonl`). So a hook renamed in a future OpenCode means we
   subscribe successfully and receive nothing, forever, silently. **This is the single
   reason decision 16 exists.** What *is* detectable at load: a missing domain or method
   reads as `undefined` (`ctx.tool.nosuch`, `ctx.nosuchdomain`), and `generate.text`
   rejects a bad model loudly (`"Model unavailable: nope/nope"`).
9. **Nothing tells the user a plugin failed to load.** A bad path, a throwing `setup`, a
   module that does not import — the session just runs without us. Hence "if `selfcheck.md`
   is older than your last session, the plugin is not running".

### Still unverified

- Does `session.execution.*` fire separately for subagent sessions, and does
  `event.subscribe` see them? (Needed before we decide whether subagent sessions get their
  own shadow log.)
- `session.hook("compaction")` — registered without error but never fired; no session got
  long enough. Decision 3 means we do not depend on it, but the payload is still unknown.
- `ctx.storage` vs our own files. Storage is plugin-scoped JSON KV and would be the natural
  home for `state.json`, but decision 12 / the "human-readable files" convention argues
  for staying on disk. Not urgent.
- Whether `/api/experimental/session/{id}/log` (the durable event log) makes the shadow log
  redundant. Decision 3 says keep our own; worth a look before M1 ships.

## Customisation: the two prompts

Decisions 13–15. Everything this plugin decides, it decides in two prompts, so both are
files in the user's project.

| File | Reads | Writes | Owns the question |
|---|---|---|---|
| `.retro/prompts/extract.md` | projection of the shadow log + anchors + existing lessons + rejected ids | lessons | *If this session ran again, what should change so it goes shorter and straighter?* |
| `.retro/prompts/apply.md` | one lesson + the candidate target files | a proposed diff, or a written-up request | *Where does this lesson belong, and what is the smallest change that applies it?* |

Resolution per prompt, first hit wins:

1. `<project>/.retro/prompts/<name>.md`
2. `~/.config/opencode/retro/prompts/<name>.md`
3. the packaged default

So a user can pin a prompt for one project, for all their projects, or neither. The
packaged defaults are also the seed: on first run each missing prompt is copied into
`.retro/prompts/` so there is something concrete to edit, rather than an empty directory
and a doc telling you what you could have written.

### Keeping the contract while letting the prose move

The file is split: everything the user writes, then a block the plugin appends and owns.

```markdown
---
retro: extract
base: 9f2a1c4            # hash of the packaged default this was seeded from
---

<!-- Everything above the marker is yours. Edit freely. -->

You are reviewing one coding session…

<!-- retro:output-contract — appended by the plugin, do not edit -->
```

The appended block carries the output format the parser needs. Edits to it are discarded
on load (and reported), because a prompt that no longer produces parseable lessons fails
*silently* — the session ends, nothing appears in `lessons/`, and nobody finds out for a
week. Keeping the contract out of reach is what makes the rest safe to edit.

`base` is how an upgrade stays non-destructive. On load, compare the file against the
default it was seeded from:

| local file | packaged default | action |
|---|---|---|
| unchanged | unchanged | nothing |
| unchanged | newer | replace silently, update `base` |
| edited | unchanged | nothing |
| edited | newer | **leave it alone**, note it in `selfcheck.md` with the diff |

That last row is the one that matters: the user's work is never overwritten, and they
still find out that a better default exists. It is also the path for contributing back —
the diff between the local prompt and its `base` is exactly the patch to propose upstream.

### Config

```jsonc
{
  "plugins": [
    {
      "package": "opencode-retro",
      "options": {
        "dir": ".retro",                                  // where everything lives
        "model": { "providerID": "deepseek", "id": "deepseek-flash" },  // extractor model
        "prompts": "./prompts"                            // override the prompt directory
      }
    }
  ]
}
```

`ctx.options` is delivered verbatim (verified: arrives as `{}` when unset).

## Self-check

Decision 16. The failure this guards against is specific and measured: **a hook whose name
the API changed still registers successfully and simply never fires** (Gotcha 8). A plugin
that reports "setup complete" is reporting nothing.

So `.retro/selfcheck.md` asserts liveness, and it does it by cross-checking two independent
paths to the same fact. The event stream (`ctx.event.subscribe`) and the hooks
(`ctx.tool.hook`) observe the same tool calls through different machinery. If the events say
twelve tool calls happened and the hook fired zero times, the hook API moved — and we can
say so, with numbers, instead of guessing.

### Passive, every session

Written at `session.execution.succeeded|failed|interrupted`:

| Check | Assertion | What a failure means |
|---|---|---|
| prompt hook | a session that ran at all produced ≥1 `session.prompt` | the prompt hook is dead |
| tool hook | `session.tool.called` events seen ⇒ equally many `tool.execute.after` with matching `id` | the tool hook is dead, or the payload shape moved |
| shadow log | the session's `.jsonl` exists and is non-empty | writing is broken (permissions, path, the `.opencode/` loop) |
| trigger | the end-of-session event arrived | our extraction trigger is gone (`session.idle` is already one such casualty) |
| extraction | ran, and produced either lessons or an explicit "nothing to learn" | the model call or the output contract broke |

### Active, on `/retro check`

Costs a model call, so it is asked for, not automatic:

- versions: `ctx.app.version`, the plugin's own, the resolved `@opencode/plugin`;
- surface: every `ctx` domain and method we rely on is present, not `undefined` (this part
  *is* detectable at load — Gotcha 8);
- connectivity: `ctx.generate.text` with a trivial prompt against the configured model;
- round-trip: run the real extraction prompt over a committed fixture session and check the
  result parses into lessons. This is the only check that exercises the whole pipeline,
  including a user-edited prompt, which is why the fixture ships with the package;
- prompts: which of the three resolution layers each prompt came from, and whether a local
  edit is sitting on a stale `base`.

### What it looks like

```markdown
# retro self-check

opencode 2.0.32 · opencode-retro 0.1.0 · checked 2026-10-19 20:31

- ok        prompt hook          3 prompts
- ok        tool hook            12 events / 12 hook calls
- ok        shadow log           sessions/ses_eabb21.jsonl, 47 entries
- ok        trigger              session.execution.succeeded
- DEGRADED  extraction           model call failed: Model unavailable: foo/bar
- note      prompts/extract.md   locally edited, base 9f2a1c4, default is now 2b71e08
```

Honest statuses only: `ok`, `DEGRADED`, `BROKEN`, and `not exercised` for anything this
session could not test (a session with no tool calls does not prove the tool hook works, and
must not claim to).

### The one thing it cannot say

If the plugin does not load at all — bad path, throwing `setup`, a module that will not
import — nothing is written, because nothing is running, and OpenCode will not mention it
either (Gotcha 9). The file's own staleness is therefore part of the contract, and the README
has to say it plainly: **if `.retro/selfcheck.md` is older than your last session, the plugin
is not running.**

## Plan

**M0 — spikes — done** (OpenCode 2.0.32, `spike/`, `fixtures/payloads/`)
- [x] Minimal plugin loads from a local path; logs `setup` to a file.
- [x] Dump raw payloads. 9 hooks registered, 0 failures; committed to `fixtures/payloads/`.
      `session.idle` never fired and `compaction` never fired — see "Gotchas" and "Still unverified".
- [x] Answer open questions 1–5; this file rewritten against what the install actually does.
- [x] Playground with planted traps (`spike/playground/`); the `lint` trap from "What we are
      building" reproduces on every source edit.

**M1 — capture (L0, no LLM)**
- [ ] Shadow log writer into `.retro/sessions/`. Pair `execute.before`/`after` by `id`;
      index steps by `durable.seq`.
- [ ] Fix `peerDependencies` to `@opencode/plugin`.
- [ ] Passive self-check (decision 16): the five liveness assertions, written to
      `.retro/selfcheck.md` at `session.execution.*`. Ship this *with* the shadow log, not
      after it — an unverified capture layer is worse than none.
- [ ] Projection: shadow log → compressed text for the extractor (deterministic, unit-tested on fixtures).
- [ ] Anchor detectors: revert, repeat. (skill→failure, abandon, correction later.)

**M2 — extraction**
- [ ] Packaged default `extract.md` + seeding into `.retro/prompts/`, the three-layer
      resolution, and the owned output-contract block (decisions 13–14).
- [ ] Extractor runs it through `ctx.generate.text` on `session.execution.succeeded|failed|interrupted`.
- [ ] Lesson store: create / merge (recurrence++) / score / cap / archive.
- [ ] Rejected-ids fed back into the extractor prompt.
- [ ] `base`-hash upgrade logic for shipped prompts (decision 15).
- [ ] Bundled fixture session + the round-trip check that a prompt still parses, so
      `/retro check` can exercise the whole pipeline.

**M3 — `/retro` (L1)**
- [ ] Packaged default `apply.md`, same seeding and resolution as `extract.md`.
- [ ] Command via `cmds.add({ execute })` + decision tool; accept applies diff, reject/later recorded.
- [ ] `/retro check` — the active self-check.
- [ ] End-of-review summary + `git diff`.

**M4 — first public release** (`v0.1.0` tag → CI publishes).

## Dev environment

- Develop **outside** your everyday OpenCode config: load the plugin by absolute path in a dedicated playground project's `opencode.json`, not globally. The path must be absolute — a relative one hangs startup and the plugin never loads.
- The **playground with planted traps** lives in `spike/playground/` (`lint` skill with no linter, `AGENTS.md` pointing at a `npm run build` that does not exist). See `spike/README.md` for how to run it. Deterministic friction → reproducible test sessions.
- Use `--standalone` while iterating; the background service caches the plugin and its environment.
- Save real shadow logs from the playground into `fixtures/sessions/` — then projection, detectors and the extractor prompt can be iterated without running OpenCode. Raw hook/event captures (a layer below the shadow log) are in `fixtures/payloads/`.
- Dogfooding: once M1 works, keep the plugin enabled while developing the plugin itself.

## Conventions

- Plain ESM, TypeScript source if build is trivial; otherwise JS + JSDoc. Keep runtime deps at zero if possible (OpenCode installs the package with Bun at startup).
- Files written into user projects must be human-readable (JSONL / Markdown + YAML frontmatter). No binary DBs.
- Never write outside `.retro/` except when the user accepts a proposal in `/retro`.
- Fail silent in hooks: a broken plugin must never break the user's session. Log errors to
  `.retro/plugin.log` — and record the failure in `selfcheck.md`, because silent-and-invisible
  is the failure mode decision 16 exists to kill.
- Anything a user may want to change is a file in `.retro/`, not a config key and not a
  constant in our source.

## Release

- Name reserved on npm as `opencode-retro@0.0.0-stage` by `dmitriisilin`.
- Publishing is via npm Trusted Publishing from `.github/workflows/publish.yml` on tags `v*`. Tag must match `package.json` version.
- Release: `npm version <x.y.z> && git push --follow-tags`. No tokens anywhere.

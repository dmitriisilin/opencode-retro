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

## On-disk layout (in the user's project, not this repo)

```
.opencode/retro/
├── sessions/<sessionID>.jsonl   # shadow log, one event per line
├── lessons/<lessonID>.md        # YAML frontmatter + body, one per lesson
├── archive/                     # evicted lessons
└── state.json                   # rejected ids, last extraction per session, etc.
```

Lesson frontmatter: see README "Lesson format". Keep it human-editable — users will open these files.

> ⚠ **`.opencode/` does not survive M0.** Every write under `.opencode/` makes OpenCode
> rescan skills and emit `skill.updated`, so a plugin that writes on events writes forever
> (see "Gotchas" below, and `fixtures/payloads/event-feedback-loop.jsonl`). Even without the
> loop, one shadow-log append per tool call means one skill rescan per tool call.
>
> The layout has to move out of `.opencode/`. Measured: `<project>/.retro/` is clean —
> 1 `skill.updated`, no loop — and keeps the files in the project, human-readable and
> git-visible, which is the point of decision 3. Proposed:
>
> ```
> .retro/
> ├── sessions/<sessionID>.jsonl
> ├── lessons/<lessonID>.md
> ├── archive/
> └── state.json
> ```
>
> Owner's call: `.retro/` as above, or move the machine-local part (sessions, state) into
> OpenCode's own data dir keyed by `location.project.id` and keep only `lessons/` in the
> project. **Not decided — do not write the path into code until it is.**

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
   with no error message at all — not a load failure, a hang.
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
   start can 404 before the plugin has finished loading.

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

## Plan

**M0 — spikes — done** (OpenCode 2.0.32, `spike/`, `fixtures/payloads/`)
- [x] Minimal plugin loads from a local path; logs `setup` to a file.
- [x] Dump raw payloads. 9 hooks registered, 0 failures; committed to `fixtures/payloads/`.
      `session.idle` never fired and `compaction` never fired — see "Gotchas" and "Still unverified".
- [x] Answer open questions 1–5; this file rewritten against what the install actually does.
- [x] Playground with planted traps (`spike/playground/`); the `lint` trap from "What we are
      building" reproduces on every source edit.

**M1 — capture (L0, no LLM)**
- [ ] Decide the on-disk path first (see the flag under "On-disk layout").
- [ ] Shadow log writer. Pair `execute.before`/`after` by `id`; index steps by `durable.seq`.
- [ ] Fix `peerDependencies` to `@opencode/plugin`.
- [ ] Projection: shadow log → compressed text for the extractor (deterministic, unit-tested on fixtures).
- [ ] Anchor detectors: revert, repeat. (skill→failure, abandon, correction later.)

**M2 — extraction**
- [ ] Extractor prompt + `ctx.generate.text` on `session.execution.succeeded|failed|interrupted`.
- [ ] Lesson store: create / merge (recurrence++) / score / cap / archive.
- [ ] Rejected-ids fed back into the extractor prompt.

**M3 — `/retro` (L1)**
- [ ] Command via `cmds.add({ execute })` + decision tool; accept applies diff, reject/later recorded.
- [ ] End-of-review summary + `git diff`.

**M4 — first public release** (`v0.1.0` tag → CI publishes).

## Dev environment

- Develop **outside** your everyday OpenCode config: load the plugin by absolute path in a dedicated playground project's `opencode.json`, not globally. The path must be absolute — a relative one hangs startup.
- The **playground with planted traps** lives in `spike/playground/` (`lint` skill with no linter, `AGENTS.md` pointing at a `npm run build` that does not exist). See `spike/README.md` for how to run it. Deterministic friction → reproducible test sessions.
- Use `--standalone` while iterating; the background service caches the plugin and its environment.
- Save real shadow logs from the playground into `fixtures/sessions/` — then projection, detectors and the extractor prompt can be iterated without running OpenCode. Raw hook/event captures (a layer below the shadow log) are in `fixtures/payloads/`.
- Dogfooding: once M1 works, keep the plugin enabled while developing the plugin itself.

## Conventions

- Plain ESM, TypeScript source if build is trivial; otherwise JS + JSDoc. Keep runtime deps at zero if possible (OpenCode installs the package with Bun at startup).
- Files written into user projects must be human-readable (JSONL / Markdown + YAML frontmatter). No binary DBs.
- Never write outside `.opencode/retro/` except when the user accepts a proposal in `/retro`.
- Fail silent in hooks: a broken plugin must never break the user's session. Log errors to `.opencode/retro/plugin.log`.

## Release

- Name reserved on npm as `opencode-retro@0.0.0-stage` by `dmitriisilin`.
- Publishing is via npm Trusted Publishing from `.github/workflows/publish.yml` on tags `v*`. Tag must match `package.json` version.
- Release: `npm version <x.y.z> && git push --follow-tags`. No tokens anywhere.

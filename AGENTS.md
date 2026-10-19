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
14. **The prompt is editable; the output contract is compiled in.** The project file is entirely the user's — criteria, emphasis, project-specific wording. The output format the parser needs lives in the plugin's source and is wrapped around the prompt at call time. It is never written to disk, so it cannot be edited away by accident, and the prompt file has no "do not touch" region in it. `/retro check` prints the contract for anyone who wants to see it.
15. **New defaults arrive as news, never as changes.** One live file per prompt, seeded from our default, carrying `base` (the default's version) in frontmatter. We never write to it again — not even when the user has not touched it. A newer default lands in `.retro/prompts/updates/extract.v3.md`, headed by a statement that *this file is not used*, that the live file is what runs, and that if they have their own version they should keep it and consider adapting it to what changed. Named in `selfcheck.md` so it is not just a file in a directory nobody opens. Updates accumulate like release notes; deleting them is the user's call. Rejected alternative: shipping a default file plus a user override file. It forces the user to know what the default said before they can write a meaningful override, makes partial overrides ambiguous, and gives two sources of truth for one prompt.
16. **The plugin must prove it is alive, in a file.** `.retro/selfcheck.md`. Registration proves nothing (see "Gotchas": wrong hook names register happily), so the report asserts *liveness*, not setup. It carries three timestamps — `loaded`, `heartbeat`, `verified` — because they fail separately and the gaps between them name which half broke.
17. **Everything the file needs to be understood is in the file.** `selfcheck.md` states its own cadence, its own staleness threshold, what each failing line means, what to run next, and the version and repo it came from. Nobody reads documentation to interpret a diagnostic, and a diagnostic that needs documentation is not one. Same rule for `.retro/prompts/updates/`: each update file explains in its own header what it is and that nothing was changed on the user's behalf.

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

**Step index.** Every *event* carries `durable: { aggregateID, seq, version }`, where
`aggregateID` is the session and `seq` is monotonic per session. Hooks carry no `seq` at
all, so indexing tool calls by it would mean joining hook data to `session.tool.called` on
the call id and racing the event stream. So the evidence coordinate (decision 6) is `n` —
our own per-session counter, assigned when a record is appended, deterministic from the log
alone — and `seq` is recorded alongside it when the event supplies it, which in practice is
every time (17/17 in a live session). Corrects an earlier claim in this file that `seq`
should be the index outright.

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

### The output contract is not on disk

The prompt file is wholly the user's. The format the parser needs is a constant in our
source, wrapped around the prompt at call time:

```
generate.text({ prompt: userPrompt + OUTPUT_CONTRACT })
```

No "managed block", no marker comments, no region the user is told not to touch — because a
file with a do-not-touch region is a file someone will eventually touch. The seeded prompt
carries one line saying the output format is appended automatically and that `/retro check`
will print it.

### New defaults arrive as news

```
.retro/prompts/
├── extract.md                  # live. the only file the plugin reads
├── apply.md
└── updates/
    └── extract.v3.md           # a newer default, for you to read. nothing was changed.
```

The live file's frontmatter records where it came from:

```yaml
---
prompt: extract
base: 2            # our default version it was seeded from
base_sha: 9f2a1c4  # hash of that default's body
---
```

On load, hash the live body:

| hashes to `base_sha` | newer default shipped | what happens |
|---|---|---|
| yes (untouched) | no | nothing |
| yes (untouched) | yes | replaced silently, `base` bumped — there was nothing to lose |
| no (user owns it) | no | nothing |
| no (user owns it) | yes | `updates/extract.v3.md` written, named in `selfcheck.md`, live file untouched |

Updates accumulate like release notes and are never applied on the user's behalf. We never
delete them either — that is the user's call. The diff between the live file and its `base`
is also the patch to propose back upstream.

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

Decisions 16–17. The failure this guards against is specific and measured: **a hook whose
name the API changed still registers successfully and simply never fires** (Gotcha 8). A
plugin that reports "setup complete" is reporting nothing.

So `.retro/selfcheck.md` asserts liveness, and it does it by cross-checking two independent
paths to the same fact. The event stream (`ctx.event.subscribe`) and the hooks
(`ctx.tool.hook`) observe the same tool calls through different machinery. If the events say
twelve tool calls happened and the hook fired zero times, the hook API moved — and we can
say so, with numbers, instead of guessing.

### Three timestamps, because three things fail separately

| Field | Written | Costs | Gone means |
|---|---|---|---|
| `loaded` | plugin `setup` runs | nothing | the plugin is not being loaded at all |
| `heartbeat` | on tool-call activity, throttled to ≤1 write/min | one small file write | hooks stopped firing mid-session |
| `verified` | at `session.execution.succeeded\|failed\|interrupted`, after the assertions below | one file write | our end-of-session trigger is gone |

The gaps diagnose the halves. `loaded` fresh but `verified` old → we load and hook, but the
trigger event moved (`session.idle` is already one such casualty, Gotcha 2). All three old
→ not running. `heartbeat` fresh, `verified` old → the session never ended cleanly.

The heartbeat is what makes staleness mean something. Without it, a long session looks
identical to a dead plugin. One write per minute, into `.retro/` which provokes no watcher
rescan (measured — Gotcha 1 is about `.opencode/` only), is cheap enough to not think about.

### The assertions

Evaluated when a session ends, written into `verified`:

| Check | Assertion | What a failure means |
|---|---|---|
| prompt hook | a session that ran at all produced ≥1 `session.prompt` | the prompt hook is dead |
| tool hook | `session.tool.called` events seen ⇒ equally many `tool.execute.after` with matching `id` | the tool hook is dead, or the payload shape moved |
| shadow log | the session's `.jsonl` exists and is non-empty | writing is broken (permissions, path) |
| trigger | the end-of-session event arrived | our extraction trigger is gone |
| extraction | ran, and produced either lessons or an explicit "nothing to learn" | the model call or the output contract broke |

Statuses are `ok`, `DEGRADED`, `BROKEN`, and `not exercised` — a session with no tool calls
does not prove the tool hook works and must not claim to.

### `/retro check` — the active version

Costs a model call, so it is asked for, not automatic. Adds: versions (`ctx.app.version`,
ours, the resolved `@opencode/plugin`); the `ctx` surface we depend on, member by member
(this part *is* detectable — missing ones read `undefined`, Gotcha 8); connectivity via
`ctx.generate.text`; a round-trip of the real extraction prompt over a bundled fixture
session, checking the result still parses into lessons — the only check that exercises the
whole pipeline including a user-edited prompt; and which resolution layer each prompt came
from, with any pending update named.

### The file explains itself

Decision 17. This is the whole file, not an excerpt — the prose is part of the artifact:

```markdown
# retro self-check

opencode 2.0.32 · opencode-retro 0.1.0 · github.com/dmitriisilin/opencode-retro

loaded     2026-10-19 20:29   (plugin start)
heartbeat  2026-10-19 20:31   (refreshed while a session is working, at most once a minute)
verified   2026-10-19 20:31   (rewritten when a session ends)

**If you are working right now and `heartbeat` is more than a few minutes old, this plugin
is not running.** Nothing else will tell you: OpenCode does not report a plugin that failed
to load. Check that `opencode.json` points at an absolute path, then run `/retro check`.

## Last session — ses_eabb21faaffeVlcHi1DAhqgq1p

- ok              prompt hook     3 prompts seen
- ok              tool hook       12 tool-call events / 12 hook calls
- ok              shadow log      sessions/ses_eabb21.jsonl, 47 entries
- ok              trigger         session.execution.succeeded
- DEGRADED        extraction      model call failed: Model unavailable: foo/bar
                                  → no lessons from this session. Check `options.model`
                                    in opencode.json, then /retro check.

## Notes

- prompts/extract.md is locally edited (base 2). A newer default is in
  prompts/updates/extract.v3.md. Nothing was changed for you.
```

Every failing line carries what broke and what to do about it, next to each other. The
version and the repo are in the header so that whoever debugs this — a person or an agent
reading the file — needs no other context.

### Debugging needs no shipped toolkit

The question "how will an agent know how this is supposed to work?" is answered by the file
above, not by a kit. It states the pipeline, the versions, which stage failed, and the next
command. An agent handed `.retro/selfcheck.md` has what it needs; the header's repo URL
covers the rest. We do not register a skill, add instructions to the user's harness, or
install anything into their agent's context — our prompts operate on our own extraction, not
in the user's skill space, and a diagnostic that needs to inject itself into a session to be
understood is just a diagnostic that was written badly.

## Plan

**M0 — spikes — done** (OpenCode 2.0.32, `spike/`, `fixtures/payloads/`)
- [x] Minimal plugin loads from a local path; logs `setup` to a file.
- [x] Dump raw payloads. 9 hooks registered, 0 failures; committed to `fixtures/payloads/`.
      `session.idle` never fired and `compaction` never fired — see "Gotchas" and "Still unverified".
- [x] Answer open questions 1–5; this file rewritten against what the install actually does.
- [x] Playground with planted traps (`spike/playground/`); the `lint` trap from "What we are
      building" reproduces on every source edit.

**M1 — capture (L0, no LLM) — done** (30 tests, `npm test`; verified live in the playground)
- [x] Shadow log writer into `.retro/sessions/` (`src/shadowlog.js`, `src/ingest.js`). Pairs
      `execute.before`/`after` by `id`; steps indexed by our own `n`, with `durable.seq`
      joined in from the event stream.
- [x] Fix `peerDependencies` to `@opencode/plugin`.
- [x] Passive self-check (`src/selfcheck.js`): three timestamps, five liveness assertions,
      throttled heartbeat, self-explaining prose. Shipped *with* the shadow log — an
      unverified capture layer is worse than none.
- [x] Projection (`src/projection.js`): deterministic, 26 KB of log → 9.5 KB of text.
- [x] Anchor detectors (`src/anchors.js`): repeat, revert, and skill→failure. The last one
      matches on *what the skill prescribes*, because a live session put the skill at step 9
      and its failing command at step 18 — any fixed proximity window is arbitrary.
- [x] Real shadow log saved to `fixtures/sessions/lint-trap-live.jsonl`.
- [ ] Left for M2, where they have something to be judged against: abandon and correction
      detectors (both need assistant text analysis, not tool shapes).

**M2 — extraction**
- [ ] Packaged default `extract.md` + seeding into `.retro/prompts/`, the three-layer
      resolution, and `OUTPUT_CONTRACT` as a source constant wrapped at call time
      (decisions 13–14).
- [ ] Extractor runs it through `ctx.generate.text` on `session.execution.succeeded|failed|interrupted`.
- [ ] Lesson store: create / merge (recurrence++) / score / cap / archive.
- [ ] Rejected-ids fed back into the extractor prompt.
- [ ] `base`/`base_sha` logic: silent upgrade when untouched, `prompts/updates/<name>.v<n>.md`
      when the user owns the file (decision 15).
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
- The background service caches the plugin and its environment, so restart it after editing
  (`opencode service restart`). `--standalone` avoids that but is flaky here — it has hung
  at `serve --stdio` repeatedly, with an absolute-path control passing seconds later. Prefer
  restarting the service.
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

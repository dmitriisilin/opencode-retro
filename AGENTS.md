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
4. **No detectors in front of the model.** There were three — `repeat`, `revert`, `skill-failure` — marking suspicious step ranges in the prompt. They are gone, and `fixtures/ab-anchors/` is why: given the same log, the model found the same lessons with them and without. What they encoded was never really detection, it was *guidance about what to look for*, and guidance belongs in `prompts/extract.md`, where the user can read it, disagree with it and change it — not in 196 lines of JavaScript that decide in advance what the model is allowed to notice. So the signals the detectors knew are now prose in that prompt: a call repeated with nothing changed between attempts, an edit undone, a skill followed into a dead end, a non-zero exit hiding behind a "completed" status, a task quietly dropped, a correction the user had to repeat. Stated as a place to start, explicitly not a checklist. The one mechanical thing left is a cost guard: fewer than three tool calls and the model is not called at all — which claims nothing about the session, only that there is too little in it to read.
5. **Extraction runs in a clean context**, not the working agent (it would defend its own choices) — one `ctx.generate.text` call, no session, no history. Input: compressed projection of the shadow log (tool outputs trimmed to head/tail, prompts and assistant text in full) + existing lessons + rejected ids. Core question: *"If this session were run again, what should change so it goes shorter and straighter?"* **When** it runs is forced by the API, not chosen: see "Extraction has to run where a hook is running".
6. **No separate "incident" entity.** Log → lessons. Each lesson carries `evidence` (session id + step ranges).
7. **Lesson ≠ proposal.** Extracting the lesson is mandatory; proposing where to apply it is optional. Targets `skill | instruction | tool | refactor | other` are prompt hints, not an enum the extractor must fit into. "Doesn't fit the ontology" is a normal outcome — the human decides.
8. **Lessons are workspace-scoped and keyed by problem, not by session.** One file per lesson, `lessons/<id>.md`, scoped to `location.project.id`. Sessions appear only as evidence refs, and a second session hitting the same problem increments `recurrence` and appends evidence rather than creating a second file. Score = `cost × recurrence × confidence × freshness`, where freshness halves every `halfLife` sessions (default 10) since the problem was last seen — counted in **sessions, not days**, because at one session a day a wall-clock decay buries everything. Recurrence matters more than one expensive incident: a lesson that shows up in three sessions *will* show up in the fourth. Overflow past the cap (default 30) is archived, never deleted.
9. **Integration loop is human-triggered, and the plugin stops at the proposal.** *Audit note: `retro_decide` is idempotent. A decided lesson lives in `archive/`, and the first version answered "no lesson" on a second call, which a live agent read as a failure — it then searched the filesystem for a tool it already had and called it twice more. A repeat call now reports that the decision was already recorded, and an unknown id lists what is open.* `/retro` delivers **one** lesson — the highest-scoring one still undecided — into the session the user ran it in, and stops. The human and the agent already in that session work out whether they like it and how to integrate it; the plugin does not patch files and does not drive the conversation. One invocation, one lesson: deciding is not a wizard to be stepped through. The outcome comes back through a `retro_decide` tool, which is bookkeeping only — a rejection is remembered and fed to the extractor so it is not proposed again. *Amended after M2: the earlier "accept applies the diff" could not work. The extractor's `proposal.change` comes out as prose — "add a precondition as step 1: ..." — because the model has not carefully read the target file and the file may have moved since. The agent in the session has both the file and the human; we have neither.*
10. **Lessons are always local to the workspace. There is no such thing as a global lesson.** A lesson is evidence from sessions in one project, so it lives in that project and nowhere else — this is by design, not a stage we grow out of. What *can* be global is the **target of the proposed change**: some friction is about this repository (a skill that does not fit it, an `AGENTS.md` claim that is not true here), and some is about how the person works everywhere (how they deal with Jira, how they want branches named, a convention they carry between projects). The first belongs in the project's harness, the second in the user's global harness — `~/.config/opencode/AGENTS.md`, a global skill. Choosing between them is an integration decision, made when a lesson is handed over, by the agent and the human looking at what the lesson actually says. Not a storage question, and not something the plugin decides. *Replaces an earlier version of this decision that had lessons themselves being promoted to global scope after recurring in ≥2 workspaces. That model was wrong: it would have required a global lesson store, a cross-workspace index and a way to match the same problem across repositories, all to answer a question that belongs to the proposal rather than to the lesson.*
11. **Autonomy ladder L0–L3** (see README). v1 target is L1, and `/retro auto` is the step that makes the rest reachable: the same lessons, the same currency checks, the same `retro_decide` bookkeeping, but batched into one plan a human approves once instead of a decision per lesson. The ladder from here is about how much of that plan runs without being asked, not about new machinery. Promotion between levels is to be driven by accept/reject stats, later.
12. **Not a memory plugin.** We edit artifacts the harness already reads; we don't build a knowledge base the agent must remember to query.
13. **The prompts live in the user's project, not in the package.** Three of them, in `.retro/prompts/`: `extract.md` (what counts as a lesson), `review.md` and `review-auto.md` (what the agent treats as its job when a lesson is handed over — check currency, relay, touch nothing before a decision, record the outcome). The package ships defaults; on first run each missing one is copied in. Resolution order: project → global (`~/.config/opencode/retro/prompts/`) → packaged default → a terse built-in fallback, so a deleted file degrades rather than going silent. `options` can override the directory and the extractor model. *Narrowed in M3 to one prompt on the reasoning that there was no application step to drive, then restored: the review texts do not drive the application, but they do decide what the agent considers its job, which is exactly the semantics worth iterating on in practice.*
14. **The prompts are editable; the machine parts are compiled in.** The project files are entirely the user's — criteria, emphasis, project-specific wording. The output format the parser needs lives in the plugin's source and is wrapped around the prompt at call time. It is never written to disk, so it cannot be edited away by accident, and the prompt file has no "do not touch" region in it. `/retro check` prints the contract for anyone who wants to see it.
15. **New defaults arrive as news, never as changes.** One live file per prompt, seeded from our default, carrying `base` (the default's version) in frontmatter. We never write to it again — not even when the user has not touched it. A newer default lands in `.retro/prompts/updates/extract.v3.md`, headed by a statement that *this file is not used*, that the live file is what runs, and that if they have their own version they should keep it and consider adapting it to what changed. Named in `selfcheck.md` so it is not just a file in a directory nobody opens. Updates accumulate like release notes; deleting them is the user's call. Rejected alternative: shipping a default file plus a user override file. It forces the user to know what the default said before they can write a meaningful override, makes partial overrides ambiguous, and gives two sources of truth for one prompt.
16. **A lesson is checked for currency before it is proposed.** A lesson can sit for weeks, and by the time anyone looks the thing it complains about may be fixed, moved or gone. Proposing a fix for a problem that no longer exists wastes the attention this plugin exists to save. So `/retro` runs a cheap deterministic check first — is the target file gone, or changed since the lesson was recorded (a content fingerprint taken at extraction time) — and when it has, the proposal carries that warning at the top. It never decides on its own: a changed file is a reason to look, not proof. The other half is the agent receiving the proposal, which is told to verify the claims against the repository before relaying them, and does it well.
17. **Decided means closed, and closed means archived.** `lessons/` holds open questions only; accepting or rejecting moves the file to `archive/`. Nothing is deleted, because recurrence consults the archive: a problem that comes back after being closed is the same problem *plus* the news that the fix did not hold, so it is reopened with its history and a `reopenedFrom` marker rather than started over at recurrence 1. `later` stays open.
18. **Shadow logs are deleted once extracted.** The lesson carries the story — its body is the narrative, its evidence the step range — so the raw log has nothing left to give, and keeping it would mean ~28 KB per session forever. `keepSessions: true` holds them for plugin development. A log whose extraction failed is kept, because it may still be retried.
19. **The plugin must prove it is alive, in a file.** `.retro/selfcheck.md`. Registration proves nothing (see "Gotchas": wrong hook names register happily), so the report asserts *liveness*, not setup. It carries three timestamps — `loaded`, `heartbeat`, `verified` — because they fail separately and the gaps between them name which half broke.
20. **Everything the file needs to be understood is in the file.** `selfcheck.md` states its own cadence, its own staleness threshold, what each failing line means, what to run next, and the version and repo it came from. Nobody reads documentation to interpret a diagnostic, and a diagnostic that needs documentation is not one. Same rule for `.retro/prompts/updates/`: each update file explains in its own header what it is and that nothing was changed on the user's behalf.

## On-disk layout (in the user's project, not this repo)

```
.retro/
├── prompts/
│   ├── extract.md            # log → lessons        (user-editable, decision 13)
│   └── apply.md              # lesson → proposal    (user-editable, decision 13)
├── sessions/<sessionID>.jsonl # shadow log, one event per line
├── lessons/<lessonID>.md      # YAML frontmatter + body, one per lesson
├── archive/                   # evicted lessons
├── selfcheck.md               # is the plugin actually working (decision 19)
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
  propose a change to — so "the skill told it to run a thing that failed" is readable
  straight from the shadow log, which is why the extraction prompt can ask for it in prose.
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
   reason decision 19 exists.** What *is* detectable at load: a missing domain or method
   reads as `undefined` (`ctx.tool.nosuch`, `ctx.nosuchdomain`), and `generate.text`
   rejects a bad model loudly (`"Model unavailable: nope/nope"`).
9. **`ctx.generate.text` hangs unless a hook is running.** Measured four ways: from inside
   a command's `execute`, 1.2 s; fire-and-forget from inside the `session.prompt` hook,
   1.2 s; from plugin `setup`, never returns; from the `ctx.event.subscribe` loop, never
   returns. No error, no timeout, no log line — it simply never settles. Awaiting one
   *inside* a hook that OpenCode awaits deadlocks the session outright. This reshapes
   decision 5; see "Extraction has to run where a hook is running" below.
10. **`generate.text` needs an explicit model.** With `model` omitted it resolves to
   OpenCode's free tier and fails with *"OpenCode's free tier can only be used from within
   OpenCode"*. So `options.model` is effectively required, and its absence has to be said
   out loud rather than discovered as an empty `lessons/`.
11. **A hung `generate.text` wedges whatever guards it.** My own bug, and worth keeping as a
   warning: the drain had a `draining` flag released in a `finally`, so one call that never
   settled blocked every later drain for the life of the process — silently. Every model
   call is now bounded (`extractTimeoutMs`, default 90 s) so a hang becomes a reported
   failure and a retry instead of a stall.
12. **`session.synthetic` writes to the session's inbox, not to its messages.** Without
   `resume: true` the message sits there until the user happens to type something, so they
   never see what they asked for. With it, the session resumes, the agent receives the text
   and answers — which for `/retro` is the point.
13. **A command that throws is invisible.** It surfaces as an HTTP 500 to whoever called it
   and nowhere else — not in `plugin.log`, not in the session. `/retro` shipped broken this
   way for one commit ("currencyOf is not defined") while 118 unit tests passed, because
   none of them ran a command. Command bodies are now wrapped: the failure reaches
   `plugin.log` and the session. The lesson for this repo is narrower than "write tests":
   unit tests over exported functions cannot see a plugin that registers and dies, so
   `test/plugin.test.js` drives the real entry point against a fake OpenCode.
14. **Nothing tells the user a plugin failed to load.** A bad path, a throwing `setup`, a
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

## Customisation: the prompts

Decisions 13–15. Everything this plugin decides semantically, it decides in three prompts,
so all three are files in the user's project. What stays in source is the machinery around
them: the output contract the parser needs, the order of a lesson's fields, the
`retro_decide` instruction, the recorded-date hint.

| File | Reads | Writes | Owns the question |
|---|---|---|---|
| `.retro/prompts/extract.md` | projection of the shadow log + existing lessons + rejected ids | lessons | *If this session ran again, what should change so it goes shorter and straighter?* |
| `.retro/prompts/review.md` | one lesson, handed to the agent in the user's session | a hand-over | *Is this still true, and how do I put it to the human?* |
| `.retro/prompts/review-auto.md` | every waiting lesson | one plan | *Which of these still stand, and in what order?* |

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

## The life of a lesson

Lessons are keyed by problem, not by session, and this is the part of the design that has
to answer "what happens in a month".

```
extracted   →  lessons/<id>.md         recurrence 1, lastSeen = session N
recurs      →  same file               recurrence++, evidence appended, lastSeen = now
ignored     →  same file               score decays: halves every 10 sessions unseen
decided     →  archive/<id>.md         out of the open set
comes back  →  lessons/<id>.md         reopened with its history + reopenedFrom
```

**Freshness is counted in sessions, not days.** One session a day — which is how this
project's owner works — would make any wall-clock decay bury everything overnight. Measured
against a session counter, a lesson keeps full weight until the workspace has actually moved
on without it. The effect is the one that matters: a 100-step one-off from forty sessions ago
loses to a 6-step problem that recurred three times this week, where the raw score has it the
other way round.

**Currency is checked when the human asks, in their session** — not in the background, not
at extraction. That is the moment before someone's attention gets spent, and by then the
answer may have changed. Order: take the lesson, then ask whether it still holds.

**And we ask, rather than prescribe how to look.** The agent in that session has the
repository, the history, the harness and whatever skills this project carries. So the
lead-in puts one question to it — *is this already resolved in this workspace as it is
now? check however you normally would* — and nothing about mechanism. Earlier this ran
`git log <baseCommit>..HEAD -- <target>` inside the plugin and pasted the commit lines in.
It worked, and it was still wrong: a subprocess, a timeout, three failure modes and a git
dependency, all to do worse what the agent does as a matter of course. Removed.

What stays on our side is cheap, local and offered as fact rather than verdict: a content
hash of the target (which also catches uncommitted edits, and needs no git at all) and the
date the lesson was recorded. They reach the agent as one line — *Worth knowing before you
check: recorded 2026-10-19; `AGENTS.md` has changed since* — to bound its own check with.

We do not try to detect the *moment* a fix happens; that would mean watching for something
we cannot recognise.

**Closed is archived, not deleted,** because recurrence consults the archive. A problem that
returns after being closed is not a new problem: it is the old one plus the news that the fix
did not hold, which is worth more than either fact alone. It comes back with its recurrence
intact and a marker saying what it was closed as.

**Shadow logs are deleted once extracted.** The lesson body carries the narrative and the
evidence carries the step range, so the log has nothing left to give; keeping it would cost
~28 KB a session forever. A log whose extraction failed is kept, because it may be retried.
`keepSessions: true` holds them, which is how `fixtures/sessions/` gets filled.

## The command surface

Two commands. Everything else happens without being asked.

| | |
|---|---|
| `/retro` | Settles any extraction debt, then delivers the top undecided lesson into this session. One invocation, one lesson. |
| `/retro auto` (or `/retro-auto`) | Delivers **every** waiting lesson, ranked, and asks for one plan covering the ones that still stand. Meant for plan mode: read the plan, approve once, go. Capped at `autoLimit` (default 10) — past that a plan stops being a plan. |
| `/retro check` (or `/retro-check`) | The active self-check: `ctx` surface, model connectivity, which prompt layer is live, and a round trip of the real output contract. Costs one model call. |

The loop around them:

```
you work                →  sessions/<id>.jsonl         (no LLM, no attention)
your next session starts →  lessons/<id>.md             (one clean-context model call)
you run /retro           →  one proposal, in your session
you and the agent decide →  the change lands, or does not
                         →  retro_decide records it
```

`selfcheck.md` closes the loop by saying how much is waiting, so the stock is visible
without running anything.

What `/retro` sends is addressed to the agent first — relay this, change nothing until the
human decides, then record it. Measured in the playground, the agent did better than the
proposal: it checked the lesson's claims against the repo, found that deleting the skill
would leave `AGENTS.md` pointing at a skill that no longer exists, named the sibling trap,
changed nothing, and put the decision to the human. That is the argument for stopping at
the proposal rather than patching: the agent has the files and the human; we have neither.

## Extraction has to run where a hook is running

`ctx.generate.text` only settles when the call originates inside a hook callback
(Gotcha 9). From the event stream — which is where a session *ends* — it hangs for good.
So the trigger and the work cannot be the same moment:

```
session ends   →  session.execution.succeeded  →  queued in state.json
next session   →  session.prompt hook          →  queue drained, one model call
```

The drain is fire-and-forget, so the user's prompt is never held up. Three consequences
worth stating plainly, because they are visible to the user:

- **Lessons land one session late.** A session that is never followed by another in that
  project never gets extracted, and costs nothing. `/retro` drains the queue on demand,
  because a command is also a working context.
- **Extraction outlives the session that triggered it.** A 20 KB projection takes longer
  than a one-word session, so `selfcheck.md` can read `queued` for a few seconds after a
  short session and then be rewritten. Measured, not theoretical.
- **It is attempted at most three times.** A transient model failure deserves another go on
  the next prompt; a third would just keep paying for the same answer.

Rejected: awaiting the call inside a hook OpenCode awaits. That deadlocks the session —
the server waits for the hook, the hook waits for the server.

## Self-check

Decisions 19–20. The failure this guards against is specific and measured: **a hook whose
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

### It is about the plugin, not about the session

The liveness assertions can only be measured from real traffic, but that does not make the
report a session summary. The file states up front that it is about the plugin, cites the
session it measured on as evidence in one line, and keeps anything the human has to *act*
on — lessons waiting, sessions queued — in its own section. `sessions/` holds the sessions
and `lessons/` holds what was learned from them; the self-check holds neither.

### The file explains itself

Decision 20. This is the whole file, not an excerpt — the prose is part of the artifact:

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
- [x] Anchor detectors (`src/anchors.js`): repeat, revert, and skill→failure. **Deleted
      after M3.5** — see decision 4 and `fixtures/ab-anchors/`. Their guidance moved into
      `prompts/extract.md`.
- [x] Real shadow log saved to `fixtures/sessions/lint-trap-live.jsonl`.
- [x] The abandon and correction detectors were never built, and now never will be: they
      are two more lines of guidance in the extraction prompt.

**M2 — extraction — done** (79 tests; verified live, lesson in `fixtures/lessons/`)
- [x] Packaged default `prompts/extract.md`, seeding into `.retro/prompts/`, three-layer
      resolution, and `OUTPUT_CONTRACT` as a source constant wrapped at call time
      (`src/prompts.js`, `src/contract.js`).
- [x] Extractor (`src/extract.js`). Queued at `session.execution.*`, drained from the next
      `session.prompt` — forced by the API, see "Extraction has to run where a hook is running".
- [x] Lesson store (`src/lessons.js`): create / merge (recurrence++) / score / cap / archive,
      in the README format, via a zero-dependency YAML subset (`src/frontmatter.js`).
- [x] Rejected ids fed back into the prompt and filtered out of the result (`src/state.js`).
- [x] `base` logic: a newer default always lands in `prompts/updates/<name>.v<n>.md` and is
      named in `selfcheck.md`; the live file is never written to twice (decision 15).
- [x] `fixtures/sessions/` drives the whole pipeline offline in tests.
- [ ] Wire that round-trip into `/retro check` itself (M3).
- [x] Refuse extraction with a named remedy when no `options.model` is set, rather than
      hanging on the free tier (Gotcha 10).

**M3 — `/retro` (L1) — done** (92 tests; both commands verified live)
- [x] `/retro` via `cmds.add({ execute })`: drains the extraction queue, then delivers the
      top undecided lesson with `ctx.session.synthetic({ resume: true })` (`src/review.js`).
- [x] `retro_decide` tool — plain JSON Schema input, no dependency. Bookkeeping only;
      a rejection also lands in `state.json` so the extractor stops proposing it.
- [x] `/retro check` — the active self-check (`activeCheck` in `src/selfcheck.js`), including
      the contract round trip that M2 deferred to here.
- [x] `prompts/review.md` and `prompts/review-auto.md`. There is still no `apply.md` — nothing
      drives the application itself — but the hand-over texts were hardcoded in `src/review.js`,
      which put the semantics of "what is your job when a lesson arrives" out of the user's
      reach. Now seeded and resolved like `extract.md`.
- [ ] End-of-review summary + `git diff`: nothing to summarise while one invocation shows one
      lesson, and the change lands through the agent's normal edit flow, which already shows
      a diff. Dropped unless the review ever becomes multi-lesson again.

**M3.5 — the life of a lesson — done** (107 tests; verified live)
- [x] Detectors removed; their guidance is prose in `prompts/extract.md` (decision 4).
- [x] Freshness in the score, counted in sessions (`src/lessons.js`, `state.sessions`).
- [x] Currency check before a proposal, by target fingerprint (`src/currency.js`).
- [x] Closing archives; recurrence reopens from the archive with history.
- [x] Shadow logs deleted after a successful extraction.
- [x] Every model call bounded, so a hang is reported rather than wedging the queue.
- [x] `/retro auto` — every waiting lesson, one plan, approved once (`renderBatch`).
- [x] Currency as a question to the agent, with a local fingerprint and the record date as
      hints. `src/git.js` existed briefly and was deleted; see above for why.
- [x] Decision 10 corrected: there are no global lessons, only a global *target* for a
      proposal. Nothing to build for scoping; the choice is a line in the prompts.

**M4 — first public release** (`v0.1.0` tag → CI publishes).
- [x] README rewritten against what was built: install, the real layout, the self-check,
      and a roadmap that says what is missing.
- [x] Release path verified on a package install, not just an absolute path: OpenCode fetches
      the package into its own cache (`~/.cache/opencode/npm/<name>@latest`), ignoring the
      project's `node_modules`, so swapping that copy for a real tarball is the honest test.
      A `.tgz` path in `package` is not a supported spec and hangs startup.
- [x] Audit: the two paths never exercised by a live agent now have been. The prompt news
      flow produces `updates/<name>.vN.md` and leaves the live prompt alone; `retro_decide`
      closes a lesson into `archive/` after a real decision, twice from a clean state. The
      audit found and fixed a defect — see decision 9's note on idempotency.
- [x] Audit: `.gitignore` guidance. `lessons/` and `archive/` are project knowledge and
      belong in git; sessions, state and the self-check are machine state. Documented in all
      five READMEs and applied to this repository, which now runs the plugin on itself.
- [ ] `npm version 0.1.0` bumps `package.json`; `VERSION` in `index.js` must move with it
      (a test enforces this, so a forgotten bump fails the suite rather than shipping a
      self-check that misreports its own version).
- [ ] Known and shipping anyway, listed so nobody discovers them as surprises: subagent
      sessions are unverified (see "Still unverified"), the `compaction` payload is unknown
      and undepended-on, and extraction lands one session late by API constraint.

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
  is the failure mode decision 19 exists to kill.
- Anything a user may want to change is a file in `.retro/`, not a config key and not a
  constant in our source.
- **README.md says what the tool is and does, and nothing else.** No roadmap, no levels, no
  plans, no "what this is not", no account of what was tried or measured. Those belong here,
  in this brief. The README describes implemented behaviour, states when and with which model
  each step runs, and links to the prompt files rather than paraphrasing them, so the
  description cannot drift from the thing described.
- **README.md is canonical and has four translations** (`README.ru.md`, `README.zh-CN.md`,
  `README.es.md`, `README.ja.md`), each opening with the same language bar and a note saying
  the English version wins. A change to `README.md` means updating all four **in the same
  commit**, then `npm run i18n` to re-stamp them. `npm test` fails while any stamp is stale
  and names which ones — a translation that drifts silently is a lie told to whoever can
  only read it, and this project does not ship diagnostics that misreport themselves. CI
  does not run tests (the publish workflow only checks tag vs version), so a stale
  translation blocks the suite, not a release. Adding a language means a file plus one entry
  in `LANGUAGES` in `scripts/i18n-stamp.mjs`; the bar and the staleness check follow from it.

## Release

- Package `opencode-retro` on npm, owner `dmitriisilin`. Published placeholders: 0.0.1, 0.0.2 (no functionality). `main` is already at 0.0.3 — the next real release.
- Publishing is via npm Trusted Publishing (status: Valid) from `.github/workflows/publish.yml` on tags `v*`. Tag must match `package.json` version.
- The workflow upgrades npm before publishing: Trusted Publishing needs npm ≥ 11.5.1, Node 22 ships npm 10, and old npm fails with a misleading `E404 Not Found - PUT`. Don't remove that step.
- Release: `npm version <x.y.z> && git push --follow-tags`. No tokens anywhere.

# AGENTS.md — opencode-retro

Context for any coding agent (OpenCode, Claude Code, …) working on this repo. Read this first; the README (`README.en.md`, canonical; `README.md` is its Russian translation and the default page) is the public-facing pitch, this file is the working brief.

**What things *are* is in [`docs/concepts/`](docs/concepts/README.md), and that is the place
to change first.** This file records how things came to be — decisions, measured API facts,
gotchas, the plan. The concepts record definitions and invariants, each invariant naming the
test that pins it, and the suite checks that every cited test exists. The pattern that cost
the most time here was fixing code where no concept had been written down: "live",
"settled", "the mark", "owed" were each rewritten three times by three different hands, each
deriving the meaning again from the code and landing somewhere slightly different.

## What we are building

An OpenCode **v2** plugin that turns friction in agent sessions into proposed changes to the project's harness (skills, AGENTS.md, tools, code), reviewed by a human via `/retro`.

Owner's framing: the goal is that a human never has to read session logs, yet every next session gets *shorter and straighter*. The plugin reads the log; the human reads proposals.

Motivating example: a project carries a `lint` skill borrowed from another harness. The project doesn't use a linter. The agent runs the skill, eslint rewrites dozens of files, the agent realises the project has no linter and reverts everything. Every session. The plugin should catch this once and propose fixing the skill (precondition: check for lint config) or removing it.

## Decisions already made (don't relitigate without a reason)

1. **Name:** `opencode-retro` (retrospective). npm name reserved by `dmitriisilin`. "loop" was rejected: in the OpenCode ecosystem `/loop` already means recurring prompts / Ralph loops.
2. **v2 only.** No v1 compatibility layer.
3. **Shadow log.** Plugin writes its own append-only log of every tool call and prompt to `.retro/sessions/<sessionID>.jsonl` in real time (not under `.opencode/` — see the layout section for why). No LLM, no batching. We do *not* depend on session history surviving compaction.
4. **No detectors in front of the model.** There were three — `repeat`, `revert`, `skill-failure` — marking suspicious step ranges in the prompt. They are gone, and `fixtures/ab-anchors/` is why: given the same log, the model found the same lessons with them and without. What they encoded was never really detection, it was *guidance about what to look for*, and guidance belongs in `prompts/extract.md`, where the user can read it, disagree with it and change it — not in 196 lines of JavaScript that decide in advance what the model is allowed to notice. So the signals the detectors knew are now prose in that prompt: a call repeated with nothing changed between attempts, an edit undone, a skill followed into a dead end, a non-zero exit hiding behind a "completed" status, a task quietly dropped, a correction the user had to repeat. Stated as a place to start, explicitly not a checklist. The one mechanical thing left is a cost guard: one prompt and no tool calls at all, and no work order is written — which claims nothing about the session, only that there is nothing in it to read. A conversation with no tool calls *is* analysed, because a wrong instruction file shows up exactly there: a wrong answer and a correction, with nothing executed.
5. **Extraction runs when asked, in a clean context — and the plugin does not perform it.** `/retro` writes a **work order** per owed log (`.retro/work/<session>.md`: the criteria, which log to read and which part of it is new, the lesson lists, how to answer) and asks the agent in the session it was run in to start one subagent per order. Each subagent opens the log the order names, and answers by calling `retro_record`; when the records are in, the agent calls `retro_propose`. The order points at the log rather than carrying a rendering of it — see "The budget was the last thing left over from one model call". Core question unchanged: *"If this session were run again, what should change so it goes shorter and straighter?"* The clean context is still the point — a subagent was not in the session it reads and has nothing of its own to defend — but it now comes from OpenCode's own agent loop rather than from a session the plugin builds. **When** it runs is still a deliberate choice: see "When the analysis runs".
   *Replaces one `session.generate` call in a session of the plugin's own, with a model and a variant the plugin picked. Three things were wrong with it, and only the third was visible at the time. (a) That call returns `{ text }` and nothing else — no finish reason, no usage — so a reasoning model that spent its whole output on reasoning came back empty with no way to see why, and it took a probe against the provider's own API to find out (Gotcha 17). (b) The plugin had to choose a model and a variant, which meant an option, a fallback chain, a workspace default, a remedy to name when all of them came up empty, and a `none` variant that does not mean the same thing on every provider. (c) It had to bound the call itself, because a hang wedged whatever guarded it (Gotcha 11). All three are now OpenCode's problem, which is the right place for them: a subagent runs with the agent loop, the tools, the retries and the model of the session that asked for it. What the plugin gives up is control over the analysis model — the work is billed where the work happens — and that was never worth the three mechanisms it cost.*
6. **No separate "incident" entity.** Log → lessons. Each lesson carries `evidence` (session id + step ranges).
7. **Lesson ≠ proposal.** Extracting the lesson is mandatory; proposing where to apply it is optional. Targets `skill | instruction | tool | refactor | other` are prompt hints, not an enum the extractor must fit into. "Doesn't fit the ontology" is a normal outcome — the human decides.
8. **Lessons are workspace-scoped and keyed by problem, not by session.** One file per lesson, `lessons/<id>.md`, scoped to `location.project.id`. Sessions appear only as evidence refs, and a second session hitting the same problem increments `recurrence` and appends evidence rather than creating a second file. Score = `cost × recurrence × confidence × freshness`, where freshness halves every `halfLife` sessions (default 10) since the problem was last seen — counted in **sessions, not days**, because at one session a day a wall-clock decay buries everything. Recurrence matters more than one expensive incident: a lesson that shows up in three sessions *will* show up in the fourth. Overflow past the cap (default 30) is archived, never deleted.
9. **Integration loop is human-triggered, and the plugin stops at the proposal.** *Audit note: `retro_decide` is idempotent. A decided lesson lives in `archive/`, and the first version answered "no lesson" on a second call, which a live agent read as a failure — it then searched the filesystem for a tool it already had and called it twice more. A repeat call now reports that the decision was already recorded, and an unknown id lists what is open.* `/retro` delivers **one** lesson — the highest-scoring one still undecided — into the session the user ran it in, and stops. The human and the agent already in that session work out whether they like it and how to integrate it; the plugin does not patch files and does not drive the conversation. One invocation, one lesson: deciding is not a wizard to be stepped through. The outcome comes back through a `retro_decide` tool, which is bookkeeping only — a rejection is remembered and fed to the extractor so it is not proposed again. *Amended after M2: the earlier "accept applies the diff" could not work. The extractor's `proposal.change` comes out as prose — "add a precondition as step 1: ..." — because the model has not carefully read the target file and the file may have moved since. The agent in the session has both the file and the human; we have neither.*
10. **Lessons are always local to the workspace. There is no such thing as a global lesson.** A lesson is evidence from sessions in one project, so it lives in that project and nowhere else — this is by design, not a stage we grow out of. What *can* be global is the **target of the proposed change**: some friction is about this repository (a skill that does not fit it, an `AGENTS.md` claim that is not true here), and some is about how the person works everywhere (how they deal with Jira, how they want branches named, a convention they carry between projects). The first belongs in the project's harness, the second in the user's global harness — `~/.config/opencode/AGENTS.md`, a global skill. Choosing between them is an integration decision, made when a lesson is handed over, by the agent and the human looking at what the lesson actually says. Not a storage question, and not something the plugin decides. *Replaces an earlier version of this decision that had lessons themselves being promoted to global scope after recurring in ≥2 workspaces. That model was wrong: it would have required a global lesson store, a cross-workspace index and a way to match the same problem across repositories, all to answer a question that belongs to the proposal rather than to the lesson.*
11. **Autonomy ladder L0–L3.** v1 target is L1, and `/retro all` is the step that makes the rest reachable: the same lessons, the same currency checks, the same `retro_decide` bookkeeping, but batched into one plan a human approves once instead of a decision per lesson. The ladder from here is about how much of that plan runs without being asked, not about new machinery. Promotion between levels is to be driven by accept/reject stats, later.
12. **Not a memory plugin.** We edit artifacts the harness already reads; we don't build a knowledge base the agent must remember to query.
13. **The prompts live in the user's project, not in the package.** Two of them, in `.retro/prompts/`: `extract.md` (what counts as a lesson) and `propose.md` (what the agent treats as its job when a lesson is handed over — check currency, relay, touch nothing before a decision, record the outcome). The package ships defaults; on first run each missing one is copied in. Resolution order: project → global (`~/.config/opencode/retro/prompts/`) → packaged default → a terse built-in fallback, so a deleted file degrades rather than going silent. `options` can override the directories. *Narrowed in M3 to one prompt on the reasoning that there was no application step to drive, then restored: the hand-over texts do not drive the application, but they do decide what the agent considers its job, which is exactly the semantics worth iterating on in practice.* *Named `review.md` and `review-auto.md` until the owner pointed out that "review" says nothing: the file decides how a lesson is put to a human, and the plugin stops there, so `propose` is what it does — a verb, in a pair with `extract`.* **And there is one rule, not one per command.** `propose-all.md` was the same judgement rewritten shorter — currency, where the fix belongs, local or global, change nothing before a decision, record the outcome — which is two copies of one rule: one the user edits, and one that silently disagrees with it. What a batch actually needs from the rule is nothing, and what it adds is only the shape of the answer (one plan, grouped by file, the dropped ones named, globals separately), so that is a conditional section at the end of the same file. Both commands send the same rule. The alternative — putting the batch shape in source, next to the output contract — was rejected because it is judgement, and judgement belongs in a file the user can argue with. Nothing is published yet, so there is no migration: resolution is by name, and a file left under an old name is simply never read.*
14. **The prompts are editable; the machine parts are compiled in.** The project files are entirely the user's — criteria, emphasis, project-specific wording. The output format lives in the plugin's source and is written into each work order after the user's prose — never into the prompt file, so it cannot be edited away by accident, and the prompt file has no "do not touch" region in it. It is `OUTPUT_CONTRACT` in `src/contract.js` for anyone who wants to read it, and the seeded prompt says in one line that it is appended and is not part of the file. *This used to say `/retro check` prints it. That command was removed and this sentence was not, so the brief sent people to a command the same file says further down is gone — found by the extractor reading a session log, not by the audit.*
15. **New defaults arrive as news, never as changes.** One live file per prompt, seeded from our default, carrying `base` (the default's version) in frontmatter. We never write to it again — not even when the user has not touched it. A newer default lands in `updates/extract.v3.md` beside the live prompts — `.retro/prompts/updates/` by default, and inside an overridden `options.prompts` when there is one, since a notice written to the directory the user just stopped using is a notice nobody sees — headed by a statement that *this file is not used*, that the live file is what runs, and that if they have their own version they should keep it and consider adapting it to what changed. Named in `selfcheck.md` so it is not just a file in a directory nobody opens. Updates accumulate like release notes; deleting them is the user's call. Rejected alternative: shipping a default file plus a user override file. It forces the user to know what the default said before they can write a meaningful override, makes partial overrides ambiguous, and gives two sources of truth for one prompt.
15.1. **The decision is the third artifact, and it records the work, not the proposal.** Raw log, lesson, decision — and the decision is where `retro_decide` writes what actually happened: `status`, `note`, `decidedIn` (the session it was decided in, which is where the conversation that produced the decision can still be read), the files really changed (`changed`, often not the ones the lesson named), and `discovered`, anything the work turned up that is not in the lesson. That last field exists because the review produces knowledge the log never contained — in one live run the agent found that deleting a skill would leave an `AGENTS.md` line pointing at nothing, which was in neither the lesson nor the proposal. Without recording it, that disappears when the session ends, and the accept/reject record that decision 11 wants autonomy to be earned from is too thin to learn from.
16. **A lesson is checked for currency before it is proposed.** A lesson can sit for weeks, and by the time anyone looks the thing it complains about may be fixed, moved or gone. Proposing a fix for a problem that no longer exists wastes the attention this plugin exists to save. So `/retro` runs a cheap deterministic check first — is the target file gone, or changed since the lesson was recorded (a content fingerprint taken at extraction time) — and when it has, the proposal carries that warning at the top. It never decides on its own: a changed file is a reason to look, not proof. The other half is the agent receiving the proposal, which is told to verify the claims against the repository before relaying them, and does it well.
17. **Decided means closed, and closed means archived — and a rejection is closed for good.** A problem the user rejected does not come back, whichever way the extractor arrives at it: `state.rejected` is told to the extractor and filters its answer, and `record()` refuses to reopen a lesson the archive has as `rejected`. Both, because the list is one file away from being lost — it *was* lost here, to a stale whole-file write, and the archive is the record of the decision itself. An **accepted** lesson that comes back is a different matter and does reopen: that is the news that the fix did not hold.
17. **Decided means closed, and closed means archived.** `lessons/` holds open questions only; accepting or rejecting moves the file to `archive/`. Nothing is deleted, because recurrence consults the archive: a problem that comes back after being closed is the same problem *plus* the news that the fix did not hold, so it is reopened with its history and a `reopenedFrom` marker rather than started over at recurrence 1. `later` stays open. **Cap eviction is not a decision:** overflow past the cap also lands in `archive/`, but keeps `status: new`, and recurrence restores it as an open question without a `reopenedFrom` claim that a fix failed. That distinction is why `concludedIn()` leaves evicted lessons out of the "already concluded" note.
18. **A log lives as long as an open lesson cites it — and for a week after it was last written.** Every lesson carries `evidence` as a session id and a step range, and during review the human may ask what actually happened at those steps — a summary cannot answer that and the log can, so the reference has to resolve. Once every lesson citing a log has been decided and archived, nothing will ask about it again and the log is removed — once it has also gone a week unwritten (decision 21). Growth is therefore bounded by the number of open lessons, which is capped, and by a week of sessions, rather than by the age of the project. `keepSessions: true` keeps everything, which is how `fixtures/sessions/` gets filled. *Replaces "deleted once extracted", which made the evidence reference a dead link and threw away the only thing that could answer a follow-up question.*
19. **The plugin must prove it is alive, in a file.** `.retro/selfcheck.md`. Registration proves nothing (see "Gotchas": wrong hook names register happily), so the report asserts *liveness*, not setup. It carries three timestamps — `loaded`, `heartbeat`, `verified` — because they fail separately and the gaps between them name which half broke.
20. **Everything the file needs to be understood is in the file.** `selfcheck.md` states its own cadence, its own staleness threshold, what each failing line means, what to run next, and the version and repo it came from. Nobody reads documentation to interpret a diagnostic, and a diagnostic that needs documentation is not one. Same rule for `.retro/prompts/updates/`: each update file explains in its own header what it is and that nothing was changed on the user's behalf.
21. **The disk is the only state about a session, and a log goes after a week of silence.** What the plugin knows about a session is its log and its mark in `state.json`; nothing depends on this process having seen a session start or end. A log is owed when it grew past its mark, stopped at a gap, or failed with attempts left — computed from the file every time, so there is no queue. It is pruned when it has been read to the end, no open lesson cites it, and its file has not been written for seven days. *Replaces "live" — a session whose turn had started and not ended, as far as this process had seen — and the queue that went with it. That model was the most expensive part of the project: "live", "settled" and "owed" were each rewritten three times, the queue merged across writers through tombstones, a restart forgot what was working, a turn resumed over the API could stay live for ever, and a second instance on the project could prune a log the other was writing — the one case the model test still failed, documented as "one instance per project is the contract". The owner's framing ended it: the plugin does not need to be exact, it needs to catch ninety percent of sessions with a model simple enough to state in three sentences. The week is long enough that a session left open and returned to keeps its log, and a session picked up after it starts a new log, read from its start; nothing a lesson cites is ever removed. The rewrite also found that each instance read marks from its own memory, refreshed only by its own next save, so a second instance counted a third failure as a first and re-read what the other had just read — reads now take in what another writer saved, and the later extraction outcome wins the merge.*

## On-disk layout (in the user's project, not this repo)

```
.retro/
├── prompts/
│   ├── extract.md            # log → lessons        (user-editable, decision 13)
│   └── propose.md            # lesson → hand-over, one or many
├── sessions/<sessionID>.jsonl # shadow log, one event per line
├── work/<sessionID>.md        # a work order, while an analysis is owed (decision 5)
├── lessons/<lessonID>.md      # YAML frontmatter + body, one per lesson
├── archive/                   # evicted lessons
├── selfcheck.md               # is the plugin actually working (decision 19)
├── state.json                 # rejected ids, marks, orders issued, etc.
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
`delivery` is `steer` or `queue`. Measured (`fixtures/sessions/queue-and-steer.jsonl`): a prompt
posted into a running turn fires the hook when it is posted, either way, and is answered inside
that turn, before its end — steered into the current reply, queued as a step after it. A
`session.synthetic` hand-over into a running turn is different: it waits in the inbox and is not
taken up when the turn ends (cycle 9, and the bench's second `/retro`), until something starts
the next turn.

**`session.execution.*` is one pair per turn, not per session.** Measured directly: one
session given two prompts (`opencode run -s <id>` twice) produced two `started`/`succeeded`
pairs in one log —

```
[1] user: one      [2] session start  …  [5] session end: succeeded
[6] user: two      [7] session start  …  [10] session end: succeeded
```

This is load-bearing, because the first version of the live/settled rules read an execution
as a session. A session with two prompts was therefore marked ended for good after the first
turn: treated as finished, settled mid-work, its log prunable while it was still being
written, and the second turn's end dropped so nothing was ever queued for it. The freshness
counter moved per turn too, so a twenty-turn session aged every lesson by two half-lives
while the person was still in the session that produced them. "A session ends" means "a turn
ended"; what makes a session finished is that nothing more arrives, which is why the growth
mark rather than the end event decides whether there is anything to read.

**Subagents run in sessions of their own, and yes, we see all of it.** Measured with
`explore`: the parent calls a tool named `subagent` with `{ agent, description, prompt }`
and gets `result.metadata.sessionID` — the child's id. The child announces itself first on
`session.created`, carrying `parentID`, `agent` and a `title`. It then emits its own
`session.execution.started` and `.succeeded`, its own `durable.seq` sequence, and its own
`tool.execute.*` hook calls, which arrive with the child's `sessionID` and `agent:
"explore"`.

So nothing is hidden, and the design question is what to do with it. A subagent's work
belongs to the task that delegated it, so its records are written into the **parent's**
shadow log and the child is never analysed on its own. Three reasons: one delegation would
otherwise become a second log and a second model call; the same problem would be counted
twice against `recurrence`; and the fragment would be read without the instruction that
caused it — the child's prompt is a delegation, not the user's request. Its start and end
events are dropped for the same reason: a delegation is a step, not a session.

The child's own instruction arrives through `session.prompt` too, reading *"You are a
subagent spawned by another session…"* and then the delegation's own text — so a check for a
line the delegation begins with has to look past OpenCode's: the reader check did not, and
matched no live reader until the first bench run without the path matching that had been
catching them instead. And it arrives **before** `session.created` reveals
the parent. So by the time the link is known, that record already sits in a log of the
child's own. A live run left it there, and the instruction was lost from the task it
belonged to. Learning the link now absorbs whatever was already written: the records are
renumbered into the parent's sequence and the orphan log is removed. Either route does it,
`session.created` or the parent's own `subagent` result.

Verified live — the parent's log held one ordered sequence containing
`build/execute`, `explore/read` and `build/subagent`, with a single session end, and only
the parent queued. *The projection that rendered a delegation as the instruction it is, rather
than as a JSON blob cut at 200 characters, is gone with the rest of it: an analysis reads the
log itself now, where the delegation's prompt is a field like any other.*

**Step index.** Every *event* carries `durable: { aggregateID, seq, version }`, where
`aggregateID` is the session and `seq` is monotonic per session. Hooks carry no `seq` at
all, so indexing tool calls by it would mean joining hook data to `session.tool.called` on
the call id and racing the event stream. So the evidence coordinate (decision 6) is `n` —
our own per-session counter, assigned when a record is appended, deterministic from the log
alone — and `seq` is recorded alongside it when the event supplies it, which in practice is
every time (17/17 in a live session). Corrects an earlier claim in this file that `seq`
should be the index outright.

**Clean-context model call.** `ctx.generate.text({ prompt, model: { providerID, id } })`
returns `{ text }` — one-shot, no session, no history; `ctx.session.create({ title, location })`
plus `ctx.session.generate({ sessionID, prompt })` does the same thing inside a session, which
is the only route that works on a free-tier model (Gotcha 10). *Neither is used: the plugin
calls no model (decision 5). Recorded because both were measured, and because the reasons not
to use them are in Gotchas 9, 10, 11 and 17 rather than in the signatures.*

**A tool the plugin registers is how an analysis answers.** `ctx.tool.transform(tools => tools.add({ name, description, input, output, execute }))`
registers `retro_record`, `retro_propose` and `retro_decide`; `input` is plain JSON Schema and
OpenCode enforces it before `execute` is reached, so a malformed answer is refused with a
reason the caller can act on and there is no reply text to parse. `execute` receives
`(input, context)` and `context.sessionID` is the session the call came from — which is how a
record is attributed, and how the plugin tells its own tool calls from the user's work.

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
   *inside* a hook that OpenCode awaits deadlocks the session outright. *Kept as a measured
   fact, no longer load-bearing: the plugin calls no model at all (decision 5), so nothing of
   ours is left that could hang this way. Anybody reaching for `generate.text` in this
   codebase should read this first.*
10. **The free-tier restriction is on `generate.text`, not on plugins.** `ctx.generate.text` refuses OpenCode's own free-tier models with *"OpenCode's free tier can only be used from within OpenCode"* — with the model omitted, with it named explicitly, and from a command's `execute` just as much as from `setup`. But `ctx.session.create()` followed by `ctx.session.generate({ sessionID, prompt })` returns normally **on the very same free model**: a session *is* within OpenCode. Measured both ways against `opencode/minimax-m3.1-flash-free`. So the analysis runs through a session of its own, created for the call and removed after it, which means the plugin works with no configuration at all — verified end to end with no `options.model` on a free-tier default. `session.generate` takes no model of its own, so the model is chosen when the session is created; `generate` is its own request kind, with no agent loop, no tools and no history. No credential is involved anywhere: OpenCode holds those and performs the call. *Kept as a measured fact; no longer how the analysis runs. The plugin stopped making the call altogether (decision 5), and the property this gotcha was prized for — works with no configuration at all — now comes for free, because the work runs on the session that asked for it.*
11. **A hung `generate.text` wedges whatever guards it.** My own bug, and worth keeping as a
   warning: the drain had a `draining` flag released in a `finally`, so one call that never
   settled blocked every later drain for the life of the process — silently. The bound that
   answered it (`extractTimeoutMs`) is gone with the call it bounded: there is no model call
   of ours to hang, and a `/retro` that issues orders and returns cannot wedge anything. The
   warning is kept because the shape recurs — a guard released in a `finally` is only as
   bounded as the thing it awaits.
12. **`session.synthetic` writes to the session's inbox, not to its messages, and does not
   fire the `session.prompt` hook.** Without `resume: true` the message sits in the inbox
   until the user happens to type something, so they never see what they asked for. With it,
   the session resumes, the agent receives the text and answers — which for `/retro` is the
   point. But the hook never fires for it: measured across every session whose only input
   arrived that way, the log held tool calls, assistant text and steps and **not one prompt
   record**. So a review session's log showed an agent reading files and editing them for no
   stated reason, with the instruction that caused all of it missing — and an analysis of that
   log reads it as work nobody asked for. We are the sender, so `say()` writes the hand-over
   into the log itself, as `k: "handover"` rather than as a prompt it is not.
13. **Everything below `setup`'s `return` is a dead region for bindings.** Function
   declarations hoist out of it and work; a `const` or `let` there is never initialised, and
   every use throws `Cannot access 'x' before initialization` at call time only. `/retro`
   shipped broken for one commit on `currencyOf` this way, and `isLive` repeated it while
   248 tests passed. `test/consistency.test.js` now refuses any binding after that return.
14. **A command that throws is invisible.** It surfaces as an HTTP 500 to whoever called it
   and nowhere else — not in `plugin.log`, not in the session. `/retro` shipped broken this
   way for one commit ("currencyOf is not defined") while 118 unit tests passed, because
   none of them ran a command. Command bodies are now wrapped: the failure reaches
   `plugin.log` and the session. The lesson for this repo is narrower than "write tests":
   unit tests over exported functions cannot see a plugin that registers and dies, so
   `test/plugin.test.js` drives the real entry point against a fake OpenCode.
15. **Nothing tells the user a plugin failed to load.** A bad path, a throwing `setup`, a
   module that does not import — the session just runs without us. Hence "if `selfcheck.md`
   is older than your last session, the plugin is not running".
17. **An empty reply was reasoning, not refusal.** Measured on `deepseek/deepseek-flash`
   through `session.create` + `session.generate`: an empty string, with no error, at 40,254,
   31,993 and 19,181 characters, while the same content answered at other times. It was
   read as "the model declines large inputs", `maxInput` and a half-then-quarter retry were
   built for it, and it was documented as a quirk. The owner asked for it to be dug into
   instead, and directly against the DeepSeek API the same prompt came back with `content`
   after 90 to 272 seconds of reasoning — 14 to 45 thousand reasoning tokens for a 400-token
   answer. Through OpenCode by default: 38 s and an empty reply. With the model's `none`
   variant (reasoning off): 2 s and a valid answer, six times in six directly. The fix at the
   time was to ask for `none` when the model had it. *This gotcha is why decision 5 was
   rewritten.* `session.generate` returns `{ text }` and nothing else — no finish reason, no
   usage — which is why the cause was invisible from inside the plugin for weeks; the probe
   that found it calls the provider's API directly with the key OpenCode already holds. A
   plugin that cannot see why an answer was empty should not be the thing asking for it, and
   a variant named by hand does not mean the same thing on every provider. So there is no
   variant to choose any more: a subagent runs on the session's own settings, reasoning
   included, and a model that reasons its whole output away is visible in the session where
   it happened rather than as an empty string in `plugin.log`.
16. **`opencode run "/retro all"` does not run the command.** The text arrives as an
   ordinary prompt and the registered command never fires; the agent in that session reads
   "/retro all" as an instruction and improvises. Observed while dogfooding: the session's
   first move was `git status`, not our batch. Headless, a command has to be posted to a
   session — `POST /api/session/{sessionID}/command` with the body
   `{"name": "retro", "text": ""}` (both keys are required; a stranger got two 400s finding
   that out) — which is how the dogfooding run eventually triggered it. With the CLI:
   `opencode api post /api/session/<id>/command -d '{"name":"retro","text":""}'`. `/retro` typed in the TUI is unaffected. Worth knowing before
   believing a scripted review did anything. And the review it starts may stop to ask: the agent can put
   the decision to the human with its `question` tool, which headless means a form waiting on
   the session for ever. Cycle 7's stranger answered it through
   `/api/session/<id>/form/<formID>/reply` — with the body `{"answer": {"q0": "<option value>"}}`
   (a `{"values": …}` body is refused with `Missing key at ["answer"]`; pending forms are listed
   by `GET /api/session/<id>/form`); a scripted review that never answers is a review
   that never decides. The command returns before any of this — it returns once the hand-over
   is delivered — so "the POST came back" says nothing about whether the review has happened.
18. **An agent that restarts the service kills itself.** `opencode run` sessions run on the
   background service, so an audit agent that runs `opencode service restart` — to make the
   service pick up a freshly packed plugin — closes the socket its own session is on. Both
   attempts of cycle 4's stranger run died that way, with `Transport: The socket connection
   was closed unexpectedly`, minutes after a `service restart` in the server log. A plugin at
   a new absolute path loads fresh in a new location anyway, so there is nothing to restart
   for; audit prompts say so.
19. **A project directory recreated at the same path loads no plugin.** With the background
   service up, a project removed and created again at the path it had leaves the plugin unloaded
   there, silently: measured, the bench's second run at one path recorded nothing at all. Use a
   fresh path every time, as `bench/friction/run.sh` does.

### Still unverified

- `session.hook("compaction")` — its payload is unknown, because the plugin does not hook it
  and the M0 probe never saw it fire: no test session grew long enough to be compacted.
  Nothing depends on it. Decision 3 is precisely that the shadow log is written as the
  session runs, so compaction cannot take anything from us; this is an unexplored corner of
  the API, not a gap in behaviour. And compaction is not friction — it is routine, and the
  only thing it has to be is predictable, which from our side it already is: the log does
  not change when a session's history does.
- `ctx.storage` vs our own files. Storage is plugin-scoped JSON KV and would be the natural
  home for `state.json`, but decision 12 / the "human-readable files" convention argues
  for staying on disk. Not urgent — and `state.json` now merges with the file on every save
  rather than overwriting it, because it is read once at load and used from memory, so a
  second writer was silently clobbered. Measured: a rejection recorded out of band vanished
  when a long-running instance saved its older copy. The merge is by identity where it can
  be: rejections, extractions and counted sessions are unions, and the session counter is
  derived from the counted ids plus the anonymous calls (which take the maximum), rather than
  being a maximum itself. Two instances that each counted a different session each moved their
  own copy to one, and the maximum lost one — a workspace aged by less than it had lived. Each
  `looked` mark takes the newer view, and carries `open` when the last analysis reported
  reading only part of the log, so the next command reads on instead of calling the bytes
  "already sent".
  A mark that does not describe the file on disk — a log pruned or replaced since — does not
  survive a merge, which is what the `rebased` tombstone used to do for one writer only. Reads
  take in what another writer saved since the last look (a stat when nothing changed), and the
  later extraction outcome wins. There is no queue to merge any more (decision 21).
- Whether `/api/experimental/session/{id}/log` (the durable event log) makes the shadow log
  redundant. Decision 3 says keep our own; worth a look before M1 ships.

## Customisation: the prompts

Decisions 13–15. Everything this plugin decides semantically, it decides in two prompts,
so both are files in the user's project. What stays in source is the machinery around
them: the output contract (its prose and the `retro_record` schema), the order of a lesson's
fields, the hand-over that asks for the analyses, the `retro_decide` instruction, the
recorded-date hint.

| File | Reads | Writes | Owns the question |
|---|---|---|---|
| `.retro/prompts/extract.md` | goes into each work order, ahead of the log it names, the existing lessons and the rejected ids | lessons, via `retro_record` | *If this session ran again, what should change so it goes shorter and straighter?* |
| `.retro/prompts/propose.md` | one lesson, or every waiting one, handed to the agent in the user's session | a hand-over, or one plan | *Is this still true, and how do I put it to the human?* |

Resolution per prompt, first hit wins:

1. `<project>/.retro/prompts/<name>.md`
2. `~/.config/opencode/retro/prompts/<name>.md`
3. the packaged default

So a user can pin a prompt for one project, for all their projects, or neither. The
packaged defaults are also the seed: on first run each missing prompt is copied into
`.retro/prompts/` so there is something concrete to edit, rather than an empty directory
and a doc telling you what you could have written.

### The output contract is not in the prompt file

The prompt file is wholly the user's. The format is a constant in our source, written into
each work order after the user's prose:

```
writeFileSync(workPath(session), userPrompt + ... + OUTPUT_CONTRACT)
```

No "managed block", no marker comments, no region the user is told not to touch — because a
file with a do-not-touch region is a file someone will eventually touch. The seeded prompt
carries one line saying the plugin adds the output format after it and does not keep it in the
file.

**And the machine half is a schema, not prose.** The answer is a `retro_record` call, and
`RECORD_INPUT` in `src/contract.js` is its input schema: OpenCode refuses a malformed call
before the plugin sees it and tells the subagent why, so it can correct itself. There is no
reply to parse, which retired the whole class of failure that "unparseable reply" named — a
cheap model fencing JSON twice, trailing a comma, or answering in prose. The tolerant parser
is still there and still reachable, for one case that remains: a model handed a nested
structure will sometimes pass `lessons` as a *string* of JSON, and reading it beats refusing
a good answer.

### New defaults arrive as news

```
.retro/prompts/
├── extract.md                  # live. the only files the plugin reads
├── propose.md
└── updates/
    └── extract.v3.md           # a newer default, for you to read. nothing was changed.
```

The live file's frontmatter records where it came from:

```yaml
---
prompt: extract
base: 5            # our default version it was seeded from
---
```

That is the whole of it. One number, compared with the packaged default's:

| newer default shipped | what happens |
|---|---|
| no | nothing |
| yes | `updates/extract.v6.md` written, named in `selfcheck.md`, live file untouched |

Whether the user has touched the file makes no difference to that, because decision 15 is
that we never write to it again either way. *This table used to have a `base_sha` column and
a row saying an untouched file is "replaced silently" — contradicting decision 15 three
paragraphs above it, and describing a hash the code has never written or read. Found in cycle
10 by following it into `src/prompts.js`. If a silent upgrade for untouched files is ever
wanted, it is a new decision and needs the hash to go with it.*

Whether the file was edited is still worth **knowing**, and that is what the self-check
answers, by comparing the live body with the current default's rather than with a stored
hash: `extract prompt  project (base 5, edited)`. A person who changes their criteria
needs to see the change is in force, and the layer alone reads the same either way.

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

**A session is read from where the last analysis stopped.** The working style this is built
for is one where sessions are not finished but left open and returned to — five of them in a
workspace, one of them today's. So a log is never final, and `/retro` a fortnight later would
re-read all of it, pay for all of it, and re-derive the lessons that were already integrated.
`state.looked[session]` is the mark that stops that, and it holds two numbers because they
answer two questions: `n`, the last step actually turned into lessons, which only moves when
an analysis succeeded and is where the next one starts; and `size`, the largest log already
sent, success or not, so nothing is paid for twice. **`n` is how far the analysis says it
read.** The order asks for the whole log and `retro_record` requires `through`: a reader that
got part way says so and the rest stays owed, and a record without it keeps its lessons and
leaves the log unread.
*This used to be measured rather than reported: the projection kept a head and a tail with a
gap between them, so marking the last step* seen *would have jumped the elided middle, and
`projected()` reported the last step of its unbroken prefix instead. With the log read by the
reader, the only party that knows how far it got is the reader.* A re-read is told plainly
that steps up to `n` were analysed before, that the new material starts after it, and what
was concluded from the rest — and that the session's instructions are up there and worth
reading for context, because they say what it was for.

**And a second look at one session is not a second session.** Recurrence counts *independent*
sessions (decision 8), so re-reading a log cannot reopen a lesson closed as accepted. Without
that rule the same old evidence comes back dressed as "the fix did not hold". The extractor
is also told what this session has already been concluded to mean, so it does not re-derive a
lesson that was archived weeks ago.

**A log lives while an open lesson cites it.** The lesson body carries the narrative, but the
evidence carries a step range, and the only thing that can say what actually happened at
those steps is the log. So it stays readable for as long as the question can still be asked,
and goes once every lesson citing it has been decided. Growth is bounded by the number of
open lessons, not by the age of the project.

## The command surface

Two commands. Everything else happens without being asked, or does not happen.

| | |
|---|---|
| `/retro` | Issues a work order for every log that has accumulated and asks this session's agent to have them read; once the records are in, `retro_propose` delivers the top undecided lesson here. One invocation, one lesson. |
| `/retro all` (or `/retro-all`) | The same, and then **every** waiting lesson as one plan, approved in one pass. Meant for plan mode. |

Three tools come with them, and they are the other half of the surface: `retro_record` (a
subagent's answer to one order), `retro_propose` (hand over what the records made) and
`retro_decide` (bookkeeping, decision 9). All three only record or render; none of them
edits the user's harness.

There was a third, `/retro check`, and it is gone. Its free checks — the `ctx` surface, which
prompt layer is live, what is waiting — now run every time `selfcheck.md` is written.
Its paid checks asked whether the model answers and whether the output contract still
parses, and both questions are answered by the analysis itself, every time. (Since the
rewrite, the second question has no asker left: the contract's machine half is a tool schema
OpenCode enforces.) A command that charges to ask what the next command answers for free is a
command that should not exist.

The loop around them:

```
you work                 →  sessions/<id>.jsonl        (no LLM, no attention)
you run /retro           →  work/<id>.md               (one order per owed log)
your agent reads them    →  retro_record → lessons/<id>.md
                         →  retro_propose → one proposal, in your session
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

## When the analysis runs

A session ends in the event stream, and there is no session there to ask: an analysis is a
subagent of the session that asked for one, and the event stream belongs to no session of
ours. So the trigger and the work are not the same moment — which turned out to be what we
wanted anyway. *The older reason was narrower and is still true: the event stream is the one
place `ctx.generate.text` can never be called from, because it hangs there for good
(Gotcha 9).*

**The work happens in `/retro`.** A finished session's log is kept and nothing more. One
command then writes a work order per log, hands them over, and the analyses run in the
session the person is in. A command's `execute` is a working context and the orders are
written synchronously, so there is no fire-and-forget, no draining guard and no race; what
is asynchronous is the reading, and it is asynchronous in the place where it belongs — the
agent loop, where OpenCode already runs several subagents at once and reports when they are
done.

**"Everything accumulated" includes the sessions that have not finished** — this one among
them. Their friction is the most recent there is, so there is no reason to wait for a
session to end before reading it, and reading closes nothing: the mark says how far the log
was read, and whatever the session writes next is owed. `record()` keys evidence by session,
so recurrence does not move for having read a session twice — only the step range follows
the newer, longer read.

The gate on re-reading is **growth, not a clock**: a log no larger than when it was last read
has nothing new in it. The one clock is for removal (decision 21): a log goes after a week
unwritten, which is what makes pruning safe without knowing whether a session is working. A
server that stops takes its sessions with it and no end event ever arrives — and nothing
waits for one, so such a log is read like any other.

The reason is not the API, it is the bill. An analysis costs money, and nothing else in
this plugin spends the user's money without being asked. Lessons sitting unextracted and
lessons sitting unreviewed are the same thing from the user's side, since nothing is applied
automatically either way — so there is no value in paying earlier.

- **Bounded on request.** `extractLimit` caps the orders one command issues, with the
  remainder reported; it is unlimited by default, because a backlog that is never finished
  is a backlog that keeps asking. It counts orders rather than answers: an order is what
  costs a subagent, and a backlog of failing logs would otherwise spend without limit under a
  limit that only counted the ones that worked.
- **Cheap when there is nothing to read.** A session of one prompt with no tool calls takes
  no order. Anything more is read, including a conversation that ran no tools at all.
- **Bounded by the reader, not by us.** An order names the log and the subagent opens it.
  There is no budget: see "The budget was the last thing left over from one model call".
- **Nothing runs unasked.** There used to be an `asyncExtract` option that analysed at the
  first prompt of the next session. It is gone: an analysis now needs a session to run in and
  an agent to start it, and the first prompt of a session is neither the place to spend
  someone's money nor a context that can wait for subagents.

One claim about the old `asyncExtract` default turned out to be false, and is worth keeping
straight because it sounds plausible: the fire-and-forget drain did **not** block the user's
prompt (the hook returned immediately, nothing awaited it) and did **not** touch the
session's context. What was true was the cost.

Rejected: awaiting a model call inside a hook OpenCode awaits. That deadlocks the session —
the server waits for the hook, the hook waits for the server.

### The budget was the last thing left over from one model call

`maxInput` is gone, with the projection, the drop order, the 2,000-character floor, the
coverage rule and `src/projection.js` entire. The owner's question was the right one: *why
are we solving a problem the agent already solves?*

Every part of that machinery answered one question — **how much of this log can I afford to
show?** — and that question only exists for a caller that gets one shot and must hand over
everything up front. A subagent has read tools, a context of its own and the judgement to
use them: it can open the file, read the head, skip to the end, or read the lot, and it
decides better than any rule written out here, because it can see what it is reading. So the
order names the log and says which part is new, and reading it is the subagent's job.

What came out with it: a budget computed from the composed order, the frame measurement, the
floor for when the fixed part alone was over budget, the drop order (tool output, then steps
from the middle, then shorter prompts), gap notices, `through` as a measured prefix, and the
"an excerpt could not reach past the mark" failure. About 660 lines of source and tests.

What stays, because the reader genuinely cannot know it:

- **which log, and which part of it is new** — the mark (`n`, `size`) in `state.json`;
- **what has already been concluded** from this session, what lessons exist, what was
  rejected — the plugin's bookkeeping;
- **the criteria** (the user's prompt) and **the contract** (`retro_record`'s schema);
- **the capture clamp** (`maxOutput`), which is about the log on disk rather than about an
  analysis: it decides once, when a record is written, that a 2 MB tool result will not sit
  in the log for ever.

What changed hands: **coverage is now reported, not inferred.** The order asks for the whole
log, and the reader says how far it got with `through: n`; the rest stays owed. That is the
same mark semantics as before, decided by the only party that knows, and it is one schema
field instead of a projection that had to be measured. *It was optional at first, with silence
read as "all of it"; it is required now, and silence means unread — see M5.*

What was given up, and it is a real loss: **the plugin no longer knows what was read.** The
model test's strongest invariant used to parse `[n]` markers out of the projection to assert
that every material step reached an analysis that answered. It now believes the reader's
report. The fake subagent in `test/model.test.js` opens the log the order points at, so the
walk still covers partial reads, but the guarantee is "the mark moved as reported", not "we
know these steps were seen".

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
| `heartbeat` | whenever any hook fires — and only then — written at most once a minute | one small file write | hooks stopped firing mid-session |
| `verified` | whenever the assertions below are evaluated: the first prompt of a session, then on activity at ≤1 write/min, when a turn ends, when an outcome is recorded | one file write | nothing is being evaluated at all |

The gaps diagnose the halves. All three old → not running. `loaded` fresh and the rest old →
we load, but no hook ever fires. `verified` fresh and `heartbeat` old → the event stream or
the plugin's own tools ran since the last hook did: nothing but a hook moves the heartbeat. That
says the hooks are dead only if something that fires one — a prompt, a tool call — happened in
between; a hand-over answered in text alone fires none.

**The assertions are evaluated from the first prompt, not only when a session ends.** They
used to wait for the end, which left the file saying "nothing measured yet" for exactly as
long as somebody was working — the one time they would open it. Nothing in them needs the
session to be over: a hook having fired and a log with something non-empty in it are the
facts, and both are true from the first prompt. What *is* only knowable at the end says so
in its own line rather than being guessed at — the trigger reads `not exercised — the session
has not ended yet` instead of `BROKEN`. For the same reason the tool hook reads "no tool
calls **seen yet**" while a session runs: the counts are refreshed at most once a minute, so
a session calling tools right now would otherwise be described as having called none.

The heartbeat is what makes staleness mean something. Without it, a long session looks
identical to a dead plugin. One write per minute, into `.retro/` which provokes no watcher
rescan (measured — Gotcha 1 is about `.opencode/` only), is cheap enough to not think about.

### The assertions

Evaluated from the first prompt of a session and again when it ends, written into `verified`:

| Check | Assertion | What a failure means |
|---|---|---|
| prompt hook | a session that ran at all produced ≥1 `session.prompt` — a session whose only input was a `/retro` hand-over proves nothing, because `session.synthetic` does not fire this hook | the prompt hook is dead |
| tool hook | once the session has ended, `session.tool.called` events seen ⇒ at least as many `tool.execute.after` hook calls, counting calls the turn ended in the middle of (counts, not ids: an interrupted call has an event and no after-hook, and that is not a dead hook); while it runs, a shortfall is just calls still in flight | the tool hook is dead, or the payload shape moved |
| shadow log | the session's `.jsonl` exists and is non-empty | writing is broken (permissions, path) |
| trigger | the end-of-session event arrived | our extraction trigger is gone |
| extraction | ran, and produced either lessons or an explicit "nothing to learn" | the model call or the output contract broke |

Statuses are `ok`, `DEGRADED`, `BROKEN`, and `not exercised` — a session with no tool calls
does not prove the tool hook works and must not claim to.

### The checks a session cannot make for itself

Free, so it runs every time the file is written — evaluated only on a review, it went stale
beside the sections around it. It adds the `ctx` surface we depend on, member by member
— this part *is* detectable, since a missing member reads `undefined` (Gotcha 8) — which
resolution layer each prompt came from with any pending update named, and how much is
stocked up, so that "is it doing anything" is answered in the same place.

The surface list is only worth what it names, and it got that wrong once: it required
`generate.text`, which the plugin mentions only to explain why it does not use it, and left
out `session.create / generate / remove`, which every analysis ran through at the time. A
renamed `session.generate` would have passed. It is `REQUIRED_SURFACE` in `src/selfcheck.js`,
held to what `index.js` actually calls by `test/consistency.test.js` — which is why the same
list lost all three of those members when the plugin stopped calling a model, instead of
going on asserting that a dead dependency was alive.

It used to also ask the model whether it answers and whether the output contract still
round-trips over a fixture. Both cost a call nobody requested; the first is answered free by
every analysis, and the second is now OpenCode's to enforce.

### It is about the plugin, not about the session

The liveness assertions can only be measured from real traffic, but that does not make the
report a session summary. The file states up front that it is about the plugin, cites the
session it measured on as evidence in one line, and keeps anything the human has to *act*
on — lessons waiting, logs owed an analysis — in its own section. `sessions/` holds the sessions
and `lessons/` holds what was learned from them; the self-check holds neither.

### The file explains itself

Decision 20. This is the whole file, not an excerpt — the prose is part of the artifact:

```markdown
# retro self-check

opencode 2.0.32 · opencode-retro 0.1.0 · github.com/dmitriisilin/opencode-retro

loaded     2026-10-19 20:29 +07:00   (plugin start)
heartbeat  2026-10-19 20:31 +07:00   (moved by every hook that fires, the plugin's own readers' too; a hook writes it at most once a minute)
verified   2026-10-19 20:31 +07:00   (when the checks below were last evaluated)

**If you are working right now and `heartbeat` is more than a few minutes old, this plugin
is not running.** Nothing else will tell you: OpenCode does not report a plugin that failed
to load. Check that `opencode.json` still names the plugin — an absolute path if you run a
checkout — then start a session: a plugin that loaded rewrites this file within a minute of its
first prompt.

## Is it working

- ok              prompt hook     3 prompts seen
- ok              tool hook       12 tool-call events seen, 12 reached the hook
- ok              shadow log      sessions/ses_eabb21.jsonl, 47 entries
- ok              trigger         session.execution.succeeded
- DEGRADED        extraction      asked 2 times and no record came back
                                  → no lessons from this session yet; the next `/retro` asks again,
                                    and `plugin.log` says why. The usual reason is an order nobody
                                    answered, which is never held against the log — a hand-over
                                    waiting in the inbox of a session that is still working, or
                                    subagents that had not called `retro_record` before
                                    `retro_propose` was called.

## Checked

- ok              extract prompt  project (base 5, edited)

## Notes

- prompts/updates/extract.v6.md is a newer default waiting to be read. Nothing was changed
  for you.
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
      *Deleted in M5 — an analysis reads the log itself.*
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
      `session.prompt`, because `generate.text` only returns where a hook is running
      (Gotcha 9). *Both the queue and the model call are gone — decisions 21 and 5.*
- [x] Lesson store (`src/lessons.js`): create / merge (recurrence++) / score / cap / archive,
      in the README format, via a zero-dependency YAML subset (`src/frontmatter.js`).
- [x] Rejected ids fed back into the prompt and filtered out of the result (`src/state.js`).
- [x] `base` logic: a newer default always lands in `prompts/updates/<name>.v<n>.md` and is
      named in `selfcheck.md`; the live file is never written to twice (decision 15).
- [x] `fixtures/sessions/` drives the whole pipeline offline in tests.
- [x] Round-trip wired into `/retro check` (M3): verified live reporting "contract parsed".
- [x] Refuse extraction with a named remedy when no `options.model` is set, rather than
      hanging on the free tier (Gotcha 10).

**M3 — `/retro` (L1) — done** (92 tests; both commands verified live)
- [x] `/retro` via `cmds.add({ execute })`: drains the extraction queue, then delivers the
      top undecided lesson with `ctx.session.synthetic({ resume: true })` (`src/propose.js`).
- [x] `retro_decide` tool — plain JSON Schema input, no dependency. Bookkeeping only;
      a rejection also lands in `state.json` so the extractor stops proposing it.
- [x] `/retro check` — the active self-check (`activeCheck` in `src/selfcheck.js`), including
      the contract round trip that M2 deferred to here.
- [x] `prompts/propose.md`. There is still no `apply.md` — nothing
      drives the application itself — but the hand-over text was hardcoded in `src/propose.js`,
      which put the semantics of "what is your job when a lesson arrives" out of the user's
      reach. Now seeded and resolved like `extract.md`.
- Dropped: end-of-review summary + `git diff`. One invocation shows one lesson, and the
  change lands through the agent's normal edit flow, which already shows a diff. Revisit only
  if the review becomes multi-lesson again.

**M3.5 — the life of a lesson — done** (107 tests; verified live)
- [x] Detectors removed; their guidance is prose in `prompts/extract.md` (decision 4).
- [x] Freshness in the score, counted in sessions (`src/lessons.js`, `state.sessions`).
- [x] Currency check before a proposal, by target fingerprint (`src/currency.js`).
- [x] Closing archives; recurrence reopens from the archive with history.
- [x] Shadow logs deleted after a successful extraction. *Replaced in M4 by decision 18: a
      log lives while an open lesson cites it, because the evidence names step ranges and
      only the log can answer what happened at them.*
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
- [x] The self-check's version is read from the installed `package.json` at runtime, not copied
      into `index.js`. The copy could not survive the documented release: `npm version` commits
      only `package.json`, and the publish workflow did not run the suite, so a tag would have
      shipped a self-check reporting the previous version. A test still asserts the two agree.
**M5 — the analysis moves out of the plugin** (375 tests; run live in cycles 9–11)
- [x] Decision 5 rewritten: `/retro` issues a work order per owed log and the agent in its
      session has each read by a subagent. `composeOrder` and `recordAnswer` in
      `src/extract.js` are the plugin's two halves of an analysis; it makes no model call.
- [x] `retro_record` and `retro_propose` (`index.js`), with `RECORD_INPUT` in
      `src/contract.js` as the machine half of the output contract. OpenCode enforces it, so
      a malformed answer is refused with a reason instead of parsed.
- [x] Orders are state on disk (`state.issue / orderOf / openOrders / close`), so a round
      whose process died leaves orders the next command settles — reporting the asking and
      asking again, never holding it against the log.
- [x] Gone with the call they served: `options.model`, `extractTimeoutMs`, `asyncExtract`,
      the variant choice, the model-resolution chain, the empty-reply retry, and
      `session.create / generate / remove` from the required surface.
- [x] An analysis is never analysed. A reader's session is not logged; the rest of a round —
      the delegations, the plugin's own tool calls — is logged between its hand-overs, the
      order tells the next reader to leave it out, and it is not new material (analysis.md).
      *First built as a mechanical filter on every call, which took thirteen review rounds to
      fail at; replaced on the owner's suggestion by the markers that were already there.*
- [x] The two hand-overs are told apart in the log (`about`), because the extraction contract
      discounts work that reviews a lesson and would have discounted work done after a
      request for an analysis.
- [x] **The order points at the log instead of carrying it.** The projection, the budget
      (`maxInput`), the drop order, the floor and the measured coverage are gone —
      `src/projection.js` and its tests with them. Coverage is reported by the reader
      (`through` on a record) instead. See "The budget was the last thing left over from one
      model call"; it was the owner's question, and the right one.
- [x] **`through` is required, and silence means unread.** Saying how far it read is the
      reader's job — nothing on this side can know — so the schema demands it, and a record
      without it keeps its lessons but leaves the log owed. The alternative, reading silence
      as "all of it", is the one failure that loses material without anybody noticing.
- [x] **A decision is not reopened by evidence from before it.** Found by following the
      owner's question about what happens to integrated lessons: a backlog is the normal case,
      so accepting a lesson and then analysing the logs that were waiting behind it reported
      the fix as having failed, once per log. Measured: a clean store, one accept, one older
      session, and the lesson came back as `reopenedFrom: accepted`. Now the extractor is told
      what was fixed and when (so the reading is not spent on it), and `record()` discards
      evidence older than the decision and names it in the outcome. Undated evidence still
      reopens — putting a lesson twice costs less than dropping one.
- [x] **Run live, in cycle 9.** The hand-over does what it says: the agent starts one
      subagent per order, reads none of them itself, obeys "one at a time" (17 s between
      records), calls `retro_propose` once, and the subagents report `through`. Four bench
      runs; the last one passes every check — recall 4/4, recurrence 3 of 3, the review
      counted as a review, the control clean, no unanswered order, no `plugin.log` at all.
      The decision path too: an agent asked to record an accepted lesson checked the file
      first, found the fix had *not* been applied, and recorded `changed: []` with a note and
      a `discovered` saying so, rather than transcribing what it was told.
      Five defects, in the cycle's own commits: the proposal was handed over without being
      logged, a false `BROKEN tool hook`, recurrence unreachable in a round with a backlog,
      the lesson snapshot placed ahead of the pointer to the live set, and the bench scoring
      before the second round had run.
- [x] **Naming no agent works.** "Whichever general-purpose agent you have" was a guess;
      four bench runs and two playground runs say the agent picks something that can read a
      file and call a tool, every time. Not worth pinning a name we have not measured.
- [x] **An unanswered order concludes nothing about the log.** The owner's question: why guess
      at what happened when the only thing we know is that we asked? A `/retro` posted into a
      session whose turn has not ended leaves its hand-over in the inbox — `resume: true` does
      not resume a session that is already working — so no subagent starts and nothing is
      spent. That was charged to the log as a failed attempt, and three rounds of it retired a
      perfectly readable log under the words "given up after three failed analyses".
      Now the asking is counted on the order and reported as a fact — "asked 3 times and no
      record came back", in the hand-over and in the self-check's stock — and the log is never
      given up on for it. The attempt counter and the three-strike retirement stay where the
      plugin *observes* the failure: a log it cannot open, cannot parse, or cannot write an
      order for.
      *Three earlier attempts at this failed, all of them trying to tell "nobody came" from
      "tried and failed" — which needs a signal, and every signal was ordering-dependent or
      fragile. The answer was not to need one. What it gives up is the cap on a log no reader
      ever manages to record: that is asked about again on every `/retro`, one subagent per
      explicit command, and every report says how many times.*

Known, listed so nobody discovers them as surprises:

- A log no reader ever manages to record is asked about on every `/retro`, one subagent each
  time. Deliberate: the plugin cannot tell that from nobody having come, and it reports the
  count rather than guessing (M5).
- A log the plugin itself cannot read is retired after three goes **whatever stopped it**, and
  only growth lifts that. Three of the four causes are not about the log — the file could not
  be opened, the order could not be written, no `extract.md` resolved — and they hit every
  owed log at once, so a few runs with a deleted prompt file write off whatever has stopped
  growing. Looked at and left alone, on the owner's call: the alternatives trade a rare
  recovery for a log that is owed for ever and therefore never prunable, and over the horizon
  this plugin is for, what matters is that the next session works rather than that no session
  is ever lost. Not to be relitigated without a case from a real workspace.
- A late record satisfies whichever order is open for its log. If another `/retro` has already
  issued a new order for the same log, the old reader's record closes the new order and the
  new reader's record is refused. It takes an early `retro_propose`, a second `/retro` and a
  slow reader still running at once, and the cost is one analysis done again — the log is
  never lost, because a coverage short of the new order leaves it owed. Found by the
  pre-release review and left alone on purpose: fixing it means an order token in the schema,
  for a case the owner has said not to build for.
- Subagent sessions of the *user's* work are unverified — see "Still unverified".
- The `compaction` payload is unknown, and nothing depends on it.
- How much of a log an analysis reads is the subagent's judgement, and the plugin believes
  what it reports. A reader that answers after skimming is indistinguishable from one that
  read carefully.
- Whether the agent records a decision is prompted, not enforced. If it does not, the lesson
  stays open and comes back next time with the currency check noting that its target has
  changed — recoverable, but it is the one step the plugin cannot do for itself.
- **Call ids are taken to be unique within a session**, as measured (`call_00_<random>`), and
  the log and the pairing of hooks rest on it. A provider that numbered calls per message would lose a call's record when an id came
  round again. Not guarded against: no provider OpenCode drives has been seen doing it, and a
  finer key risks splitting a Code Mode wrapper from what it wraps.
- **What the person's agent does inside a round is left out with it.** A round — from the
  `work` hand-over to the next hand-over of another kind or the person's next prompt — is the
  plugin's own, and the reader of the next order is told to leave it out (analysis.md). The
  hand-over asks the agent to start readers and nothing else, so the only thing lost is work it
  did of its own accord in between. *This replaces thirteen review rounds of deciding, call by
  call and child by child, which work was ours — by the delegation's prompt, by its order's
  path, by what else its parent had in flight, by which delegation named which child. Every
  round found the last one's interleaving. The owner's question ended it: why not tell the
  reader where the plugin's work begins and ends, and let it leave that out?*
- **A reload in the middle of a round can leave a reader's log behind.** A reader is known by
  its first prompt, and that knowledge is in memory: reloaded mid-delegation (an edit to
  `opencode.json`, a service restart), the plugin logs the reader's later work as a session of
  its own until the delegation ends and names it, which folds it into the person's log inside
  the round. A delegation that never ends after the reload leaves that log on its own, and a
  later `/retro` reads it like a session.
- **The self-check's extraction line can describe a replaced log's last analysis.** A log
  pruned after its week of silence and written again under the same session id starts owed,
  but the outcome recorded for the old file stays in `state.json` until the new one is
  analysed, and the session's line shows it. Forgetting it would need tombstones in a file
  that merges by union; a diagnostic line wrong until the next `/retro` does not earn them.
- **`retro_propose` refuses delegated sessions, as far as the plugin knows them.** A reader is
  delegated, and a reader calling it would get the proposal — with an instruction to record a
  decision it cannot put to the human — and close every open order. So a session known to be
  delegated is refused. Known means its line was seen or `session.created` named its parent,
  both in this process's memory: a reader calling before either, or after a reload, slips
  through — and then its hand-over is written with `from` once it is folded in, which does not
  end the round. `/retro` itself refuses a delegated session, whose round could never be
  proposed. Whose call it *is* was tried as well — the session the round was handed to — and
  an ownership kept in memory went stale after an abandoned round and forgot itself on a
  reload, the same way. The refusal of `/retro` in a subagent's session is sent without
  resuming it — resumed, its agent would take the note as work — so it may wait in that
  session's inbox unseen.
- **A turn's end is taken to arrive before the next turn's hooks.** The event stream lags the
  hooks by milliseconds, and the next turn starts after a model has answered; an end delivered
  later than that would close the new turn's bookkeeping. Raised in the pre-release reviews as
  a possibility, never seen; nothing here orders the two streams.
- **A turn whose start went unlogged reads as between turns.** A process that did not own the
  session when the start event arrived — reloaded in the middle of a turn — writes no start
  record, and a `/retro` sent into that turn opens its round at once, taking the rest of the
  turn's work for the plugin's. The self-check's reading of which turn a hand-over began does
  look past an unlogged start (`turnHandovers`); the rounds do not. Raised in three review
  rounds after the ten, each time needing a reload and a `/retro` in the same turn; left alone,
  because guessing a turn from its tool calls is the kind of inference the markers replaced.
- **A long-lived service keeps what it learned about every session.** The ingest's per-session
  entry is kept across turns, since ownership must survive them, and nothing evicts it but a
  reader claimed or a child adopted; the report's own maps grow the same way. Bounded by the
  sessions one process sees, not by the active ones.
- **A report reads a log more than once.** One read per report, but the owed check and the
  rounds each sort and walk it again, and a growth check misses its cache when two callers ask
  from different offsets. Cost, not correctness; inside hooks, on a log a session left open for
  weeks.
- Whether the agent answers every order is prompted, not enforced, for the same reason. An
  order nobody answers is reported with how many times it has been asked and asked again, so
  this degrades visibly rather than going silent; it is never held against the log.

## Dev environment

- Develop **outside** your everyday OpenCode config: load the plugin by absolute path in a dedicated playground project's `opencode.json`, not globally. The path must be absolute — a relative one hangs startup and the plugin never loads.
- The **playground with planted traps** lives in `spike/playground/` (`lint` skill with no linter, `AGENTS.md` pointing at a `npm run build` that does not exist). See `spike/README.md` for how to run it. Deterministic friction → reproducible test sessions.
- The background service caches the plugin and its environment, so restart it after editing
  (`opencode service restart`). `--standalone` avoids that but is flaky here — it has hung
  at `serve --stdio` repeatedly, with an absolute-path control passing seconds later. Prefer
  restarting the service.
- Save real shadow logs from the playground into `fixtures/sessions/` — then projection, detectors and the extractor prompt can be iterated without running OpenCode. Raw hook/event captures (a layer below the shadow log) are in `fixtures/payloads/`.
- Dogfooding: once M1 works, keep the plugin enabled while developing the plugin itself. This
  repository does that, which needs an `opencode.json` of its own — and it is **not** in git,
  because the plugin path has to be absolute (Gotcha 3) and an absolute path is one machine's.
  A clone therefore loads no plugin until you write one:

  ```jsonc
  { "plugins": [{ "package": "/abs/path/to/opencode-retro" }] }
  ```
- **A live test can edit the plugin.** `/retro` delivers its message into a session and
  resumes it, so the agent there acts on what it was told — and if that message says the
  analysis failed, and this repository is reachable and writable, the agent will go and fix
  the plugin. That happened: an agent read "unparseable reply", went into `src/` and `test/`,
  wrote the queue-skip fix and the reply excerpt, ran the suite, and left the work
  uncommitted. Good work, and a hazard: those edits arrive with no author, no commit and no
  warning, and a `git checkout` in the middle of them loses what is not yet staged — which
  is how the `index.js` half of that fix was destroyed and had to be rebuilt from its tests.
  When running live tests, commit first, and check `git status` before and after.

## Conventions

- Plain ESM, TypeScript source if build is trivial; otherwise JS + JSDoc. Keep runtime deps at zero if possible (OpenCode installs the package with Bun at startup).
- Files written into user projects must be human-readable (JSONL / Markdown + YAML frontmatter). No binary DBs.
- Never write outside `.retro/` except when the user accepts a proposal in `/retro`.
- Fail silent in hooks: a broken plugin must never break the user's session. Log errors to
  `.retro/plugin.log` — and record the failure in `selfcheck.md`, because silent-and-invisible
  is the failure mode decision 19 exists to kill.
- Anything a user may want to change is a file in `.retro/`, not a config key and not a
  constant in our source.
- **`test/consistency.test.js` guards text against behaviour.** The costliest failure in this
  project is not a broken function, it is a true statement that stopped being true: removing
  a command left its name in six places in shipped code, in the seeded prompt and twice in
  every README, and nothing failed. That file checks what can be checked mechanically — every
  command named in shipped text exists, every settable option is documented in every
  language, every record kind written to the log is explained in the output contract, nothing
  exported from `src/` is unreachable. Add to it whenever a claim becomes checkable.
- **The plugin writes `.retro/.gitignore` itself**, seeded once and never rewritten. Git
  applies a `.gitignore` to the directory holding it, so everything can be decided from
  inside the one directory this plugin owns, and the user never edits theirs. Ignored:
  sessions, state, the self-check, the plugin log, prompt update notices. Not ignored:
  `lessons/`, `archive/` and the prompts — the product and the configuration.
- **`npm test` expands its glob in the shell, not in Node.** `node --test "test/*.test.js"`
  needs Node's own glob support, which is 21+, while `engines` allows 18 — so a contributor on
  18 saw the suite find nothing. The quotes are gone, so a POSIX shell expands it. A directory
  argument is not an option: Node treats every file under a directory named `test` as a test
  file, which picks up `test/replay.js` and fails.
- **Change the concept first, then the code, then the test — and cite the test in the
  concept.** `docs/concepts/` is where a word's meaning lives. If a change to the code does
  not fit the concept, stop and decide which is wrong, out loud, rather than make the code
  work and leave the concept behind. An invariant without a test is visible as such; a test
  that is renamed or deleted breaks the document that leaned on it.
- **One vocabulary, three verbs: extract → propose → decide.** The three artifacts are a raw
  log, a lesson and a decision, and each step is named the same way everywhere: `src/extract.js`,
  `src/propose.js`, `src/decide.js`, with `test/<verb>.test.js` beside each, and `prompts/extract.md`
  and `prompts/propose.md` for the two the user owns. `review` was the old word for the middle
  step — it named nothing, since the step is putting a lesson to a human and the plugin stops
  there. If it reappears anywhere, it is drift.
- **README.md says what the tool is and does, and nothing else.** No roadmap, no levels, no
  plans, no "what this is not", no account of what was tried or measured. Those belong here,
  in this brief. The README describes implemented behaviour, states when and with which model
  each step runs, and links to the prompt files rather than paraphrasing them, so the
  description cannot drift from the thing described.
- **`README.en.md` is canonical and has four translations**: `README.md` (Russian — the page
  GitHub and npm open by default, which is the owner's choice of how the project is presented),
  `README.zh-CN.md`, `README.es.md`, `README.ja.md`. Each opens with the same language bar,
  Russian first, and each translation with a note saying the English version wins. A change to
  `README.en.md` means updating all four **in the same commit**, then `npm run i18n` to
  re-stamp them. `npm test` fails while any stamp is stale
  and names which ones — a translation that drifts silently is a lie told to whoever can
  only read it, and this project does not ship diagnostics that misreport themselves. CI
  runs the suite before publishing, so a stale translation blocks a release too. Adding a
  language means a file plus one entry
  in `READMES` in `scripts/i18n-stamp.mjs`; the bar and the staleness check follow from it.

## Release

- Package `opencode-retro` on npm, owner `dmitriisilin`. Published placeholders: 0.0.1, 0.0.2 (no functionality). `main` is already at 0.0.3 — the next real release.
- Publishing is via npm Trusted Publishing (status: Valid) from `.github/workflows/publish.yml` on tags `v*`. Tag must match `package.json` version, and the workflow runs `npm test` before publishing, so a tarball, translation stamp or version mismatch stops the release.
- The workflow upgrades npm before publishing: Trusted Publishing needs npm ≥ 11.5.1, Node 22 ships npm 10, and old npm fails with a misleading `E404 Not Found - PUT`. Don't remove that step.
- Release: `npm version <x.y.z> && git push --follow-tags`. No tokens anywhere.

### Before a tag

The rule is the owner's: **while audit cycles still find defects, there is no release.** A
cycle's yield tracks the amount of code written since the previous cycle, not the age of the
project, and fixes spawn fixes — three of cycle 3's seven defects were in fixes made a day
earlier. So the signal to look for is a cycle over *unchanged* code finding nothing of
consequence, and the list below is what has to be true of the commit that gets tagged, in
the order it is cheapest to check:

1. `npm test` is green, and the tagged commit is the audited one — nothing landed after the
   last cycle except the cycle's own fixes. CI runs the suite on the tag, so a failure there
   stops the publish, but it should never be news.
2. The mechanical guards all pass, because they are the ones that caught the most: text
   names only commands that exist, every option is documented in every language with its
   real default, every record kind is projected, every concept citation resolves, every
   translation is stamped, nothing after `setup`'s `return` is a binding, and the surface
   check names exactly what the plugin calls.
3. The last audit cycle ran against code that did not change afterwards, and reported no
   defect above "documented limit". Its "wrong, but not touched" list is either empty or
   stated in the concepts as a limit.
3a. The analysis has been run live on this build: `/retro` in a real session, with real
   subagents reading real orders. The plugin no longer performs the analysis itself, so the
   hand-over's wording is load-bearing in a way no test can check — an agent that reads the
   orders itself, starts one subagent for all of them, calls `retro_propose` after each
   record, or ignores "one at a time" would all pass the suite, and the last of those was a
   real finding. The bench and the stranger's hour below both depend on this working, so it
   comes first. Done in cycle 9; redo it on any build that changes the hand-over, the
   contract, or `retro_record`.
4. A stranger's first hour was run on this exact build: the tarball packed and installed
   into a fresh project under `/tmp`, with no plugin options at all and no git; worked in,
   `/retro` run through the API (Gotcha 16), a prompt edited and seen to take effect, a
   decision recorded, `/retro` run again. Nothing confusing, silent or maintainer-only.
   Done in cycle 10, where it found three things — an edit that worked and was never
   confirmed anywhere a person looks, a table in this file describing a `base_sha` the code
   has never had, and one fact phrased three ways in the self-check. "Seen to take effect" is
   the load-bearing word: the edit reaching the work order is not the same as the person
   being able to tell, and only the second is the check.
4a. The planted-friction bench (`bench/friction/`) finds every trap, counts each recurring one
   in more than one session, does not count the review of a lesson as its recurrence, reports
   no lesson against the control, and leaves no work order unanswered. A recall number, not an
   impression: it is the one check that measures what the plugin is *for*, and it has earned
   that twice — two defects on its first run, and three more in cycle 9, including a
   recurrence of zero that every other check had passed. Read the whole scorecard, not just
   recall: `recall 4/4` with `recurrence 0` is a plugin that finds friction and cannot tell
   that it keeps happening, which is most of the point.
5. The README's install instruction is true **for the version being tagged**: what npm's
   `latest` will be after the publish, and what a reader of HEAD gets before it.
6. `npm pack --dry-run` carries `index.js`, `src/`, `prompts/`, `package.json`, `LICENSE`
   and the READMEs, and nothing else; `opencode.json` is not tracked.
7. `VERSION` is read from `package.json`, so the bump is the whole bump; the self-check on
   an installed tarball reports the tagged version.
8. The Trusted Publisher binding on npmjs still names this repository and
   `publish.yml` — not checkable from the checkout, and the one step that fails last. Nothing else needs bumping: the self-check reads its version from `package.json`.

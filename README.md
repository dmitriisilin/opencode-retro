# opencode-retro

**English** | [Русский](README.ru.md) | [简体中文](README.zh-CN.md) | [Español](README.es.md) | [日本語](README.ja.md)

Retrospectives for coding agents. An [OpenCode](https://opencode.ai) v2 plugin that reads the dialogue of a finished session, finds what would make the agent work better, and turns that into proposed changes to the project's own harness: its skills, its instructions, its tools.

An agent does not learn from its own sessions. The only record of where it struggled is the log, and logs go unread. This plugin reads the log and comes back with proposals.

> Status: complete and working, not yet released. Verified against OpenCode 2.0.32. The npm package is still a placeholder, so installation is from a path.

## The problem

The same obstacles repeat across sessions:

- A skill says to run the linter. The project has no linter. The agent runs it anyway, rewrites forty files, notices, and reverts everything.
- An instruction file requires a build command before committing. The project defines no such script, so the step fails every time it is obeyed.
- The code style is written down nowhere, so each session re-derives it by reading the sources first.
- A failing command is retried several times with nothing changed between attempts.
- A task from the plan is dropped quietly, as "not possible right now".
- The same correction is given by hand for the third week running.

All of it is in the log. None of it reaches the next session.

## How it works

Two loops, deliberately separate. One runs by itself and costs no attention. The other runs on request and produces one decision at a time.

### Capture

Every tool call and every prompt is appended to a shadow log at `.retro/sessions/<id>.jsonl`. No model is involved; the plugin only writes. The log is therefore independent of context compaction: the raw trajectory survives whatever the session does to its own history.

### Extraction

When a session ends its log is kept, and nothing further happens until asked. Analysis costs a model call, and nothing in this plugin spends that unprompted.

`/retro` is the moment it happens. One command compresses the logs that have accumulated, turns them into lessons, and only then looks for something to hand over. A long backlog is analysed up to ten logs at a time, so a single command cannot bill without limit; what is left over is reported, and another `/retro` takes the next batch.

Each log is analysed in a session of its own, created for that one call and removed afterwards: the log goes in, no agent, no history and no tools are involved, and text comes out. The agent that did the work is deliberately excluded, since it would defend its own decisions. A session with fewer than three tool calls is skipped without a call at all.

`options.autoExtract` moves the analysis to the start of the next session instead, for anyone who would rather have lessons ready before asking.

By default the analysis uses the model your own sessions run on, falling back to the workspace default. This works on OpenCode's free-tier models too, so nothing needs configuring. `options.model` pins a different one, which is worth doing if the analysis should run somewhere cheaper than the work.

That call receives a compressed view of the session. Tool output is trimmed; prompts and replies are kept whole. It answers one question:

> If this session ran again, what should change in the project so that it goes shorter and straighter?

The answer is a list of lessons in `.retro/lessons/`.

One log costs at most one call. A project that is never reviewed is never analysed.

### What guides the extraction

The criteria are not compiled into the plugin. They live in [`prompts/extract.md`](prompts/extract.md), seeded into the project as `.retro/prompts/extract.md` and editable there. They describe the shapes worth looking for:

- Work repeated for nothing: the same call made again with no file changed in between.
- An edit made and then undone, whether by a later edit or by discarding the working tree.
- A skill followed into a dead end, where a command the skill prescribed failed afterwards.
- A failure that does not look like one: a non-zero exit code behind a status that reads "completed".
- A task dropped in silence, visible only in what the agent wrote.
- A correction the user had to make more than once.

The file states that this is a starting point and not a checklist.

### Review

The plugin reads the log. The human reads proposals. It stops at the proposal and does not edit project files.

| Command | What it does |
|---|---|
| `/retro` | Delivers one lesson, the highest scoring one still undecided. |
| `/retro auto` | Delivers every waiting lesson as a single plan, to be approved in one pass. |
| `/retro check` | Reports whether the plugin is working. |

A lesson is delivered into the session the command was run in, addressed to the agent already there. The agent is asked first whether the lesson still holds, then to relay it, and to change nothing until a decision has been made.

```
# retro — lint-skill-no-config

The lint skill prescribes `npx eslint . --fix`, which this project cannot run.

Seen in 2 sessions, 9 steps spent on it, confidence 0.9, score 16.2.
Last seen 3 sessions ago.

Proposed change
  AGENTS.md — make the lint requirement conditional on a committed ESLint config.

Needs a decision
  Should this project have ESLint configured, or should the convention be dropped?
```

The decision belongs to the human and the agent in that session. The agent has the files, the history and the project's own skills, which makes it a better judge of whether a lesson still applies than the plugin can be. Once a decision is made, the agent records it through a `retro_decide` tool. That tool only keeps books: a rejection is remembered, and the lesson is not proposed again.

`/retro auto` is the same hand-over for everything at once. Waiting lessons are ranked, the ones that still hold are gathered into one plan grouped by file, and the plan is approved once.

### Where a fix belongs

A lesson records a problem. Where to fix it is decided during the hand-over, by the agent and the human, after looking at what the workspace actually has: which instruction files the harness reads here, whether skills exist at project or global level, whether something more specific already covers the task.

The options:

- Amend an instruction file, for a fact or a constraint that applies broadly.
- Amend a skill, when a skill gave the wrong steps or fired when it should not have.
- Create a skill, or an instruction file scoped to the directory where the rule applies, when the right place does not exist yet.
- Request a tool, when the gap is a missing capability rather than a missing instruction.
- Change the project's code, when the trap is in the code. Never applied without explicit agreement.
- Leave it unplaced, when the right home is genuinely unclear.

Lessons themselves are always local to one workspace. A fix may not be: when the cause is how a person works everywhere, the fix belongs in their global harness, because fixing it in one project leaves it broken in the rest. Nothing outside the project is edited without asking.

The procedure and this list live in [`prompts/review.md`](prompts/review.md), which is seeded into the project and can be edited there.

## Lessons

A lesson is a Markdown file with YAML frontmatter.

```yaml
id: lint-skill-no-config
statement: The lint skill assumes eslint; this project has no linter.
evidence:
  - session: a81f
    steps: [41, 58]
  - session: c204
    steps: [12, 19]
cost: 34
recurrence: 3
confidence: 0.9
lastSeen: 41
recordedAt: 2026-10-19T15:16:04.134Z
proposal:
  target: .opencode/skills/lint/SKILL.md
  change: |
    Before running, check for a lint config and a lint script.
    If absent, do not run; report instead.
ask: Is the linter really unused here?
status: new
```

`cost` is the number of steps the problem consumed, summed across sessions. `recurrence` is the number of independent sessions it appeared in. `lastSeen` is the workspace session count at its most recent appearance.

### Ranking

The score is `cost × recurrence × confidence × freshness`.

Freshness halves every ten sessions in which the problem has not appeared, counted in sessions rather than days. At one session a day, decay measured by the clock would bury everything overnight.

Recurrence weighs more than a single expensive incident. A problem seen in three sessions will be seen in a fourth.

### Lifecycle

A lesson is keyed by problem, not by session. A second session that hits the same thing adds its evidence and increments `recurrence` instead of creating another file.

`lessons/` holds open questions only. A decision moves the file into `archive/`, and nothing is ever deleted. A problem that returns after being closed is the same problem plus the news that the fix did not hold, so it is reopened with its history intact. A cap, thirty by default, keeps the list short; what overflows is archived as well.

## Install

The npm package is a placeholder for now, so `opencode.json` should point at a checkout. The path must be absolute; a relative one leaves session startup hanging without an error.

```jsonc
{
  "plugins": [
    {
      "package": "/abs/path/to/opencode-retro",
      "options": {
        "model": { "providerID": "deepseek", "id": "deepseek-flash" }
      }
    }
  ]
}
```

`options.model` is optional. Without it the plugin uses the model your sessions run on, falling back to the workspace default. `/retro check` reports which model was used and where it came from.

Everything else is optional: `dir` for the directory, default `.retro`; `prompts` for the prompt directory; `halfLife` in sessions, default ten; `autoLimit`, the number of lessons in one `/retro auto`, default ten; `maxOutput`, `extractTimeoutMs`, `keepSessions`.

### What appears on disk

Everything the plugin writes stays under `.retro/` in the project, and nowhere else unless a proposal is accepted. All of it is plain text.

```
.retro/
  prompts/
    extract.md       what counts as a lesson
    review.md        how a lesson is handed over
    review-auto.md   how a batch becomes one plan
  sessions/          raw logs, deleted once extracted
  lessons/           open questions
  archive/           decided and evicted lessons
  selfcheck.md       whether the plugin is working
  state.json
```

A log is deleted once its session has been extracted. The lesson carries the story and the evidence carries the step range, so the raw log has nothing further to give.

Of this, `lessons/` and `archive/` are knowledge about the project and are worth committing: they are readable, they show up in review, and they travel with the repository. The rest is machine state. A reasonable `.gitignore`:

```
.retro/sessions/
.retro/prompts/
.retro/selfcheck.md
.retro/state.json
.retro/plugin.log
```

Prompts are listed there only because a project that wants to pin its own would commit them deliberately; the seeded copies are just the packaged defaults.

### Prompts

Three prompts shape what the plugin does, and all three are files in the project: what counts as a lesson, how a lesson is handed over, and how a batch of lessons becomes one plan.

Each is seeded from the packaged default on first run and never written to again. Resolution is the project first, then `~/.config/opencode/retro/prompts/`, then the packaged default, so a prompt can be pinned for one project, for every project, or for neither.

When a newer default ships it arrives as `prompts/updates/<name>.vN.md`, with a note at the top saying that the file is not in use. Nothing is applied on the user's behalf.

What stays in the source is the machinery: the output format the parser requires, the order of a lesson's fields, and the instruction to record a decision. `/retro check` prints the output format for anyone who wants to see it.

## Checking that it works

A registered hook proves nothing. A hook registered under a name the API no longer uses registers successfully and then never fires.

`.retro/selfcheck.md` therefore reports liveness rather than setup, by comparing what the event stream saw against what the hooks received. It carries its own staleness rule:

> If work is in progress and `heartbeat` is more than a few minutes old, the plugin is not running.

`/retro check` is the active version. It reports the plugin and OpenCode versions, the API surface the plugin depends on, whether the configured model answers, which prompt layer is in force, and whether the output format still produces a parseable lesson.

## Requirements

- OpenCode v2, `@opencode/plugin` 2.0 or newer. Verified against 2.0.32.
- Nothing beyond OpenCode itself. The analysis runs on your own model by default; an inexpensive one is enough.
- No runtime dependencies.

## License

MIT

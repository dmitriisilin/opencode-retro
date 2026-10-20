# opencode-retro

**English** | [Русский](README.ru.md) | [简体中文](README.zh-CN.md) | [Español](README.es.md) | [日本語](README.ja.md)

Retrospectives for coding agents. An [OpenCode](https://opencode.ai) v2 plugin that turns friction in a session into proposed changes to the project's own harness: its skills, its instructions, its tools.

An agent does not learn from its own sessions. The only record of where it struggled is the log, and logs go unread. This plugin reads the log and comes back with proposals.

> Status: complete and working, not yet released. Verified against OpenCode 2.0.32. The npm package is still a placeholder, so installation is from a path.

## The problem

The same obstacles repeat across sessions:

- A skill says to run the linter. The project has no linter. The agent runs it anyway, rewrites forty files, notices, and reverts everything.
- A failing command is retried several times with nothing changed between attempts.
- A task from the plan is dropped quietly, as "not possible right now".
- The same correction is given by hand for the third week running.
- A tool that would have saved twenty steps is simply absent.

All of it is in the log. None of it reaches the next session.

## How it works

Two loops, deliberately separate. One runs by itself and costs no attention. The other runs on request and produces one decision at a time.

### Capture

Every tool call and every prompt is appended to a shadow log at `.retro/sessions/<id>.jsonl`. No model is involved; the plugin only writes. The log is therefore independent of context compaction: the raw trajectory survives whatever the session does to its own history.

When a session ends it is queued. The first prompt of the next session settles that queue with a single model call in a clean context, deliberately not the agent that did the work, which would defend its own decisions.

That call receives a compressed view of the session. Tool output is trimmed; prompts and replies are kept whole. It answers one question:

> If this session ran again, what should change in the project so that it goes shorter and straighter?

The answer is a list of lessons in `.retro/lessons/`.

Lessons appear one session late. A project that is never opened again costs nothing, and `/retro` settles the queue on demand.

### What guides the extraction

The criteria are not compiled into the plugin. They live in `.retro/prompts/extract.md`, a file that can be read and edited, and they describe the shapes worth looking for:

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

A proposal is a suggestion rather than a schema. The usual targets:

- A skill, corrected or extended with how the task is actually done in this project.
- An instruction for `AGENTS.md`: a fact or a constraint.
- A tool that is missing, written up as a request with the cost it has already caused.
- A change to the code itself, so that the trap is gone. Never applied automatically.
- Something that fits none of these, left for the human to place.

Lessons themselves are always local to one workspace. A lesson is evidence from sessions in a single project, so it lives in that project and nowhere else.

The fix, however, may belong elsewhere. Some friction is about the repository: a skill that does not suit it, an instruction that is not true there. Some friction is about habits that travel: how an issue tracker is used, how branches are named, a convention carried from project to project. The first belongs in the project's harness, the second in the global one at `~/.config/opencode/AGENTS.md` or a global skill.

Which of the two a lesson calls for is settled when it is handed over. The plugin does not guess, and it never edits a global harness on its own.

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

## What this is not

- **Not a memory plugin.** Memory plugins build a knowledge base that an agent has to remember to consult. This one edits the files the harness already reads. Knowledge that lives in a skill does not need to be recalled.
- **Not a loop breaker.** Loop detectors stop an agent in the moment. This plugin works on the next session instead. Both are useful.
- **Not a collector of successes.** Most self-improving-skill tools record what worked. This one records what did not, which is where the inexpensive wins are.

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

`options.model` is required. Without it OpenCode resolves its own free tier, which a plugin may not use.

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

## Roadmap

Autonomy is earned from the plugin's own record of accepted and rejected proposals, not granted up front.

| Level | The plugin | The human | |
|---|---|---|---|
| L0 | captures sessions and extracts lessons | reads `lessons/` directly | available |
| L1 | proposes one lesson at a time | decides, with the agent | available |
| L1.5 | plans every waiting lesson at once | approves the plan once | available |
| L2 | applies confirmed lessons to a branch | reviews the batch | planned |
| L3 | applies skills and instructions directly | sees only requests for tools and refactors | planned |

## Requirements

- OpenCode v2, `@opencode/plugin` 2.0 or newer. Verified against 2.0.32.
- A model for extraction, named explicitly in `options.model`. An inexpensive one is enough.
- No runtime dependencies.

## License

MIT

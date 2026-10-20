# opencode-retro

**Retrospectives for coding agents.** An [OpenCode](https://opencode.ai) v2 plugin that turns session friction — reverts, loops, abandoned tasks, user corrections — into proposed changes to your harness: skills, instructions, tools, code.

Agents don't learn from their own sessions. The only way to find out where they struggled is to read the log, and nobody reads the log. `opencode-retro` reads it for you and comes back with proposals.

> **Status: works end to end, not yet released.** Capture, extraction and review are all
> built and verified against OpenCode 2.0.32. Nothing on npm but a placeholder — install
> from a path for now. See [Roadmap](#roadmap) for what is and is not there.

## The problem

Every session, an agent walks into the same walls:

- a skill says "run the linter" — the project doesn't use one; the agent runs it, rewrites 40 files, realises its mistake, reverts everything;
- the same failing command is retried four times with no change in between;
- a task from the plan is quietly dropped as "not possible right now";
- the user says "no, we don't do it that way here" for the third week in a row;
- a tool that would have saved 20 steps simply isn't there.

All of that is in the log. None of it makes it into the next session.

## What it does

Two loops, deliberately separated.

### 1. Capture loop — automatic, every session

The plugin keeps a lightweight **shadow log** of every tool call and prompt
(`.retro/sessions/<id>.jsonl`). No LLM involved, just appends. This makes the plugin
independent of session compaction — the raw trajectory is always available. Once a session
has been extracted its log is deleted: the lesson carries the story, and a log per session
forever is a hoard.

Cheap deterministic **anchor detectors** mark suspicious windows in the trajectory:

| Anchor | Signal |
|---|---|
| revert | agent undid its own edits (`git checkout`, reverse edit) within N steps |
| repeat | same command / same output with no file changes in between |
| skill→failure | a skill prescribed a command, and that command failed later in the session |
| abandon | a planned task marked skipped / "couldn't" — *not built yet* |
| correction | user prompt contradicts the agent's previous action — *not built yet* |

When a session ends it is queued, and the **next session's first prompt** pays that debt:
one model call with a clean context (not the working agent — it would defend its own
decisions) gets a compressed projection of the log, tool outputs trimmed, prompts and
answers in full, plus the anchors. It answers one question:

> *If this session were run again, what should change so it goes shorter and straighter?*

The output is a list of **lessons** in `.retro/lessons/`.

Why the next session rather than this one: OpenCode's `generate.text` only settles when the
call comes from inside a hook, and a session ends on an event. So lessons land one session
late, and a project you never open again costs nothing. `/retro` settles the debt on demand.

### 2. Integration loop — on demand, `/retro`

The plugin reads the log. You read proposals. It stops at the proposal: it does not patch
your files.

```
/retro         one lesson — the highest-scoring one still undecided
/retro auto    every waiting lesson, as one plan to approve in one go
/retro check   is the plugin actually working
```

`/retro` delivers the lesson into the session you ran it in, as a message addressed to the
agent already there:

```
_opencode-retro: first answer one question — is this already resolved in this workspace
as it is now? A lesson can sit for weeks, and you know this project; check it however you
normally would. … change nothing until the human has decided._

# retro — `lint-skill-no-config`

The lint skill prescribes `npx eslint . --fix`, which this project cannot run.

Seen in 2 sessions, 9 steps spent on it, confidence 0.9 → score 16.2.
Last seen 3 sessions ago.

_Worth knowing before you check: recorded 2026-10-19; `AGENTS.md` has changed since._

## Proposed change
**AGENTS.md** — make the lint requirement conditional on a checked-in ESLint config.

## It needs your call
Should this project have ESLint configured, or should the lint convention be dropped?
```

Then you and the agent decide. The agent has the files, the history and this project's own
skills; it is a better judge of whether the lesson still holds than the plugin is, and in
practice it checks the claims and finds consequences the proposal missed. When you have
decided, it records the outcome with a `retro_decide` tool — bookkeeping only. A rejection
is remembered so the lesson is not proposed again.

`/retro auto` is the same thing for everything at once: every waiting lesson, ranked, with
one plan covering the ones that still stand, grouped by file. Meant for plan mode — read
the plan, approve once, go.

A lesson's proposal is a *suggestion*, not a schema. Typical targets:

- **skill** — fix or extend a `SKILL.md` with how the task is actually done here
- **instruction** — a fact or constraint for `AGENTS.md`
- **tool** — a request to the human: "X is missing; without it sessions A, B, C each lost ~N steps"
- **refactor** — a codebase change so the trap is removed, with rationale, never auto-applied
- **other** — doesn't fit; the human decides

## Lesson format

```yaml
id: lint-skill-no-config
statement: The `lint` skill assumes eslint; this project has no linter.
evidence:
  - session: a81f
    steps: [41, 58]
  - session: c204
    steps: [12, 19]
cost: 34          # steps consumed by the problem, summed over sessions
recurrence: 3     # independent sessions where it showed up
confidence: 0.9
lastSeen: 41      # the workspace's session count when it last showed up
recordedAt: 2026-10-19T15:16:04.134Z
proposal:         # optional
  target: .opencode/skills/lint/SKILL.md
  change: |
    Before running: check for a lint config (eslint.config.*, .eslintrc*)
    and a `lint` script in package.json. If absent, do not run; report.
ask: Is the linter really unused here? Remove the skill from this project?
status: new       # new | later   (decided ones move to archive/)
```

Score is `cost × recurrence × confidence × freshness`, where freshness halves every ten
sessions the problem has not shown up — counted in **sessions, not days**, because at one
session a day a wall-clock decay buries everything overnight. Recurrence matters more than
one expensive incident: a lesson that shows up in three sessions *will* show up in the
fourth.

Lessons are scoped to the workspace and keyed by problem, not by session: a second session
hitting the same thing appends evidence and increments `recurrence` rather than creating a
second file. `lessons/` holds open questions only — deciding moves the file to `archive/`,
and nothing is ever deleted, because a problem that comes back after being closed is the
old problem *plus* the news that the fix did not hold. It reopens with its history intact.
A cap (default 30) keeps the list short; overflow is archived too.

## What this is not

- **Not a memory plugin.** Memory plugins build a knowledge base the agent has to remember to query. `opencode-retro` edits the artifacts the harness already reads (`SKILL.md`, `AGENTS.md`). Knowledge that lives in a skill doesn't need to be recalled.
- **Not a loop breaker.** Loop detectors stop the agent *now*. This plugin makes sure the loop doesn't happen *next time*. Use both.
- **Not a golden-path harvester.** Most self-improving-skills tools capture what *worked*. This captures what *didn't*, which is where the cheap wins are.

## Project vs global

Everything is project-scoped by default. A lesson becomes a *candidate* for global scope only when its evidence has no project-specific files, configs or dependencies in it, and it has recurred in at least two different workspaces. Promotion is a separate `/retro` proposal showing evidence from both.

*Not implemented yet.* The rule is settled; the code is not. It matters most if you keep one session per workspace, where recurrence inside a single project accrues slowly and "I work this way everywhere" shows up across workspaces first.

## Roadmap

| Level | What the plugin does | Human does | |
|---|---|---|---|
| **L0** | capture + extract lessons | reads `lessons/` by hand | ✅ |
| **L1** | `/retro` proposes, one at a time | decides, with the agent | ✅ |
| **L1.5** | `/retro auto` plans everything waiting | approves the plan once | ✅ |
| **L2** | high-confidence lessons confirmed ≥2× applied to a branch automatically | reviews the batch | |
| **L3** | skills/instructions applied without review | sees only `tool` and `refactor` requests | |

Promotion between levels is driven by the plugin's own accept/reject statistics — it earns
autonomy, it isn't granted.

Not built yet, in rough order: the `abandon` and `correction` anchors, promotion of a lesson
from project to global scope (see above — the rule is settled, the code is not), and the
levels above.

## Design decisions

- **Separate extraction session.** The working agent is the worst judge of its own session.
- **Shadow log, not session history.** Compaction can't eat what we already wrote down.
- **Friction over success.** Reverts, repeats and corrections are rarer and higher-signal than "this went fine".
- **Artifacts over memory.** Change what the harness reads; don't add a thing to remember.
- **Human gate first.** Autonomy is a later level with its own evidence.
- **Stop at the proposal.** The agent in your session has the files, the history and this project's skills. Asking it *"is this still true?"* beats the plugin prescribing how to check.

## Install

Not on npm yet beyond a placeholder. Point `opencode.json` at a checkout — the path must be
**absolute**, a relative one hangs session startup with no error:

```jsonc
{
  "plugins": [
    {
      "package": "/abs/path/to/opencode-retro",
      "options": {
        // required: without it OpenCode resolves its free tier, which a plugin may not use
        "model": { "providerID": "deepseek", "id": "deepseek-flash" }
      }
    }
  ]
}
```

Other options, all optional: `dir` (default `.retro`), `prompts`, `halfLife` (10 sessions),
`autoLimit` (10 lessons per `/retro auto`), `maxOutput`, `extractTimeoutMs`, `keepSessions`.

Everything the plugin writes goes under `.retro/` in your project, and nowhere else unless
you accept a proposal. It is all plain text:

```
.retro/
├── prompts/extract.md   # yours to edit — how a lesson is extracted
├── sessions/<id>.jsonl  # raw material, deleted once extracted
├── lessons/<id>.md      # the product
├── archive/             # decided and evicted lessons
├── selfcheck.md         # is the plugin working
└── state.json
```

`.retro/prompts/extract.md` is seeded from the packaged default on first run and never
written to again. A newer default arrives as `prompts/updates/extract.vN.md`, headed by a
note that it is not in use — nothing is applied on your behalf.

### Is it working?

Hooks that register prove nothing: a wrong hook name registers happily and never fires. So
`.retro/selfcheck.md` asserts liveness instead, by crossing the event stream against the
hooks, and carries its own staleness rule:

> If you are working right now and `heartbeat` is more than a few minutes old, this plugin
> is not running.

`/retro check` is the active version: `ctx` surface, model connectivity, which prompt layer
is live, and a round trip of the real output contract.

## Requirements

- OpenCode **v2** (`@opencode/plugin` ≥ 2.0; verified against 2.0.32)
- a model for extraction, named explicitly in `options.model`; a cheap one is fine
- no runtime dependencies

## License

MIT

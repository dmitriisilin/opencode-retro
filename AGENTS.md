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

## OpenCode v2 plugin API — what we know and what we don't

Shape (confirmed by docs):

```ts
import { Plugin } from "@opencode/plugin"   // ⚠ see open question 1

export default Plugin.define({
  id: "opencode-retro",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (e) => { /* e.tool, e.input */ })
    await ctx.tool.hook("execute.after",  (e) => { /* e.result, e.output, e.outputPaths */ })
    await ctx.session.hook("prompt",      (e) => { /* user prompt admission */ })
    await ctx.session.hook("compaction",  (e) => { /* before compaction */ })
    await ctx.command.transform((cmds) => {
      cmds.update("retro", (c) => { c.description = "..."; c.template = "..." })
    })
    const ac = new AbortController()
    void (async () => {
      for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
        if (ev.type === "session.idle") { /* trigger extraction */ }
      }
    })()
    return () => ac.abort()
  },
})
```

Also on `ctx`: `session.create/get/prompt/command/interrupt`, `skill.list/transform/reload`, `agent.transform`, `options` (from config), `location.directory`.

Local loading: put the file in `.opencode/plugins/` of a project, or reference it in `opencode.json(c)`:
`"plugins": [{ "package": "/abs/path/to/opencode-retro", "options": { ... } }]`.
Verify loaded plugins: `opencode2 api get /api/plugin` (or the equivalent for the installed binary).

### Open questions — resolve on a real install before writing real code

1. **Package name.** Docs disagree: `@opencode/plugin` (migration guide, used by opencode-instincts ≥2.0.18) vs `@opencode-ai/plugin/v2` (v2.opencode.ai plugins page). Check what the installed OpenCode actually resolves; fix `package.json` peerDependency accordingly.
2. **Calling a model from a plugin.** No documented `generate.text`. opencode-instincts README claims `ctx.generate.text({ prompt, model })` exists. Alternative: `ctx.session.create()` a hidden session + `ctx.session.prompt()`. Pick whichever works; the extractor must run with a clean context and ideally a configurable (cheap) model.
3. **What `execute.after` and `prompt` events actually carry** — session id, step index, tool name, args, output shape, exit codes for bash. Dump real payloads to a file first.
4. **How `/retro` should interact** — one-by-one accept/reject inside a chat session. Likely a command whose template instructs the agent to walk `lessons/` and use a plugin-registered tool (`retro_decide(id, action)`) to record decisions. Verify a command template + custom tool is enough, or whether a TUI plugin is needed.
5. **Does `session.idle` fire reliably** at end of work, and is it per-session (subagents too)?

## Plan

**M0 — spikes (first session on a real OpenCode install)**
- [ ] Minimal plugin loads from a local path; logs `setup` to a file.
- [ ] Dump raw payloads of `tool.execute.after`, `session.prompt`, `session.idle`, `compaction` into a file. Commit sample payloads to `fixtures/payloads/`.
- [ ] Answer open questions 1–5 above; update this file.

**M1 — capture (L0, no LLM)**
- [ ] Shadow log writer.
- [ ] Projection: shadow log → compressed text for the extractor (deterministic, unit-tested on fixtures).
- [ ] Anchor detectors: revert, repeat. (skill→failure, abandon, correction later.)

**M2 — extraction**
- [ ] Extractor prompt + clean-context model call on `session.idle`.
- [ ] Lesson store: create / merge (recurrence++) / score / cap / archive.
- [ ] Rejected-ids fed back into the extractor prompt.

**M3 — `/retro` (L1)**
- [ ] Command + decision tool; accept applies diff, reject/later recorded.
- [ ] End-of-review summary + `git diff`.

**M4 — first public release** (`v0.1.0` tag → CI publishes).

## Dev environment

- Develop **outside** your everyday OpenCode config: load the plugin by absolute path in a dedicated playground project's `opencode.json`, not globally.
- Keep a **playground repo with planted traps** (e.g. a `lint` skill in a project with no linter, a README with a wrong build command, a missing CLI tool). Deterministic friction → reproducible test sessions.
- Save real shadow logs from the playground into `fixtures/sessions/` — then projection, detectors and the extractor prompt can be iterated without running OpenCode.
- Dogfooding: once M1 works, keep the plugin enabled while developing the plugin itself.

## Conventions

- Plain ESM, TypeScript source if build is trivial; otherwise JS + JSDoc. Keep runtime deps at zero if possible (OpenCode installs the package with Bun at startup).
- Files written into user projects must be human-readable (JSONL / Markdown + YAML frontmatter). No binary DBs.
- Never write outside `.opencode/retro/` except when the user accepts a proposal in `/retro`.
- Fail silent in hooks: a broken plugin must never break the user's session. Log errors to `.opencode/retro/plugin.log`.

## Release

- Package `opencode-retro` on npm, owner `dmitriisilin`. Published placeholders: 0.0.1, 0.0.2 (no functionality). `main` is already at 0.0.3 — the next real release.
- Publishing is via npm Trusted Publishing (status: Valid) from `.github/workflows/publish.yml` on tags `v*`. Tag must match `package.json` version.
- The workflow upgrades npm before publishing: Trusted Publishing needs npm ≥ 11.5.1, Node 22 ships npm 10, and old npm fails with a misleading `E404 Not Found - PUT`. Don't remove that step.
- Release: `npm version <x.y.z> && git push --follow-tags`. No tokens anywhere.

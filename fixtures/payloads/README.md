# fixtures/payloads

Real hook and event payloads captured from OpenCode **v2.0.32** by `spike/probe`
(M0). Produced in `spike/playground` against `deepseek/deepseek-flash`.

One JSON object per line:

```jsonc
{
  "at": "2026-10-19T13:15:…",   // probe wall clock
  "kind": "tool.execute.after",  // "<domain>.<hook>" | "event" | probe bookkeeping
  "eventType": "session.idle",   // only when kind === "event"
  "payload": { … },              // the real payload, strings truncated at 2000 chars
  "shape": { … }                 // payload with every leaf replaced by its typeof
}
```

`payload` is truncated and `shape` is derived — these are samples for building the
projection and the detectors, not a byte-exact transcript.

| File | What it is |
|---|---|
| `session-minimal.jsonl` | One-turn session, no tool calls. Shortest complete lifecycle: `setup` → hooks → events → `session.execution.succeeded` → `cleanup`. |
| `session-lint-trap.jsonl` | **The motivating example, live.** The agent edits `src/sum.js`, the project's `AGENTS.md` tells it to run the `lint` skill, the `lint` skill runs `npx eslint . --fix`, eslint exits 2 because the project has no config. Then it hits the second trap: `AGENTS.md` says `npm run build`, which does not exist. 12 tool calls. |
| `event-feedback-loop.jsonl` | 40 consecutive `skill.updated` events from the write-amplification loop described in AGENTS.md ("Writes under `.opencode/`"). Captured with no session running. |
| `command-and-generate.jsonl` | A plugin-registered command actually executing, plus `ctx.generate.text` and `ctx.session.create` returning. |

## Trimming applied

`session-lint-trap.jsonl` was captured while the probe was still writing into
`.opencode/`, so it contains the feedback loop. For legibility:

- 413 of 416 `skill.updated` events dropped (3 kept);
- 9 of 10 `session.context` payloads dropped (1 kept) — each carries the full
  system prompt and message history, ~24 KB apiece.

Nothing else was altered. The raw captures are not committed.

## Reproducing

```sh
cd spike/playground
# opencode.json must point at an ABSOLUTE path to ../probe — relative paths hang
RETRO_PROBE_DIR=/tmp/retro-probe \
  opencode run --standalone --auto -m deepseek/deepseek-flash \
  "Add a function average(numbers) to src/sum.js that returns the mean of the array. Follow the project conventions in AGENTS.md."
```

Set `RETRO_PROBE_DIR` to a path **outside** the project, or the probe triggers the
feedback loop.

## Not captured on purpose

`session.hook("http.request")` and `"http.response"` carry the provider
`Authorization` header. The probe does not hook them and neither should the plugin.

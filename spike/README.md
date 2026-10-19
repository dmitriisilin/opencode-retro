# spike/ — M0 throwaway instrumentation

Not part of the published package (`package.json#files` ships `index.js` only).

## `probe/`

A minimal OpenCode v2 plugin that registers every hook we care about and appends
each payload to a JSONL file. Used to answer the open questions in `AGENTS.md`.
Captures live in `fixtures/payloads/`.

It writes to `$RETRO_PROBE_DIR`, falling back to `<project>/.opencode/retro-probe/`.
**Always set `RETRO_PROBE_DIR` to a path outside the project** — writing under
`.opencode/` makes OpenCode rescan skills, which emits `skill.updated`, which the
probe logs, which writes again: an endless loop (see
`fixtures/payloads/event-feedback-loop.jsonl`).

## `playground/`

A tiny project with deliberately planted friction, so sessions fail the same way
every time:

| Trap | Where | What the agent does |
|---|---|---|
| `lint` skill in a project with no linter | `.opencode/skills/lint/SKILL.md` | runs `npx eslint . --fix`, eslint exits 2 — no config, no dependency |
| build command that does not exist | `AGENTS.md` → "run `npm run build`" | `package.json` has no `build` script |

`AGENTS.md` also says "always run the `lint` skill after editing `src/`", so the
first trap fires on any source edit.

### Running it

`opencode.json` references the probe by **absolute path**. A relative path makes
session startup hang with no error, so fix the path for your checkout:

```sh
cd spike/playground
sed -i "s#/home/di735/opencode-retro#$(cd ../.. && pwd)#" opencode.json
git init && git add -A && git commit -m baseline   # revert detection needs a git root
RETRO_PROBE_DIR=/tmp/retro-probe \
  opencode run --standalone --auto -m deepseek/deepseek-flash "<prompt>"
```

`--standalone` keeps the server in the foreground process; otherwise the
background service holds a stale copy of the plugin and `RETRO_PROBE_DIR` from
whenever it was started. After editing the probe, either use `--standalone` or
`opencode service restart`.

Keep `src/` pristine in git — reset it between runs so the traps stay reproducible.

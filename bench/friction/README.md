# Planted friction

Does the plugin find what it is supposed to find? This bench plants it and counts.

`project/` is a tiny library with four traps, each a false claim the agent will act on:

| Trap | Where | What happens |
|---|---|---|
| a `lint` skill in a project with no linter | `.opencode/skills/lint/SKILL.md` | `npx eslint . --fix` exits 2: no config |
| `npm run build` | `AGENTS.md` | there is no build script |
| `npm run test:unit` | `AGENTS.md` | the script is `npm test` |
| configuration in `config/settings.json` | `AGENTS.md` | it is in `src/config.js` |

and one control: "exports are named, never default" is true, so a lesson against it is a
false finding. `traps.json` lists them with the words a lesson about each would use, and the
three tasks that walk into them — the third repeats the first, so recurrence is exercised.

```sh
OPENCODE=opencode2 bench/friction/run.sh            # a fresh /tmp/retro-friction-<time>
```

It packs this checkout, installs the tarball into a fresh copy of `project/` with no git and
no plugin options, runs each task as its own session with `deepseek/deepseek-flash`, posts
`/retro` to a review session, waits for that session's agent to answer every work order and
then finish with the hand-over, posts `/retro` again, and prints:

- **recall** — which traps became lessons;
- **recurrence** — every task hits the traps, so a lesson seen in one session only means the
  extractor kept quiet about a known problem;
- **the review** — the agent checking a handed-over lesson must not count as the problem
  happening again (`UNTESTED` if its work was never analysed);
- **analysis per session** — including an order nobody answered, asked for again by the
  second `/retro`;
- **controls**, lessons about nothing planted, and whether a re-saved lesson's quoting grew.

Every run costs real model calls: three working sessions, a review, and an analysis each —
the analyses being subagents of the review session, so they are billed to that session's
model rather than to one the plugin chose. A run that reports every trap missed and leaves
files in `.retro/work/` is the agent not having done the analyses, not the extractor keeping
quiet; the script warns when any order is still unanswered.
Use a new directory every time — recreating a project at the same path while the OpenCode
service is up leaves the plugin unloaded there, silently (AGENTS.md Gotcha 15).

What it found the first time it ran: a second session that hit the same traps was analysed
as "nothing to learn", because the extractor read "already recorded" as "already answered";
and the agent's review of a handed-over lesson was counted as the problem recurring, adding a
session and 19 steps of cost to the lesson it was checking. Both are fixed in `src/contract.js`
and `src/extract.js`, with tests.

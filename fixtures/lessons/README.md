# fixtures/lessons

Lessons the plugin actually produced, kept as golden examples of the output quality to hold
the extraction prompt to.

| File | Where it came from |
|---|---|
| `lint-skill-cannot-run.md` | Extracted end to end from a live session in `spike/playground` by `deepseek/deepseek-flash` — the cheapest model available. The shadow log it was derived from is `fixtures/sessions/`-shaped; the session is the `mode(numbers)` run. |

`lint-skill-cannot-run.md` is the motivating example from AGENTS.md, found without help:
the skill is mandatory after a source edit, prescribes `npx eslint . --fix`, and the project
has no eslint config — so every source edit takes a detour that verifies nothing. It names
the harness as the problem rather than the agent, proposes a precondition on the right
`SKILL.md`, and asks the human the question the plugin cannot answer (is eslint meant to be
part of this project at all?).

That last part is the bar: a lesson that proposes a fix *and* admits which decision is not
its to make.

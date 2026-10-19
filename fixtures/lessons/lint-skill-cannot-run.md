---
id: lint-skill-cannot-run
statement: The `lint` skill is described as mandatory after editing source files and tells the agent to run `npx eslint . --fix`, but this project ships no `eslint.config.*` and no eslint dependency, so every source edit triggers a detour that dead-ends in ESLint's fatal config error instead of checking anything.
evidence:
  - session: ses_eab47324dffewhhzmK6FeIxRUY
    steps: [19, 21]
cost: 3
recurrence: 1
confidence: 0.7
proposal:
  target: .opencode/skills/lint/SKILL.md
  change: "Add a precondition as step 1: 'If the project has no eslint.config.*, report that lint is not configured and stop.' Only then run `npx eslint . --fix` and the confirmation pass."
ask: Is ESLint actually intended to be part of this project? If yes, the fix is an `eslint.config.js` plus a devDependency rather than a skill change; if not, the lint skill should be removed.
status: new
---

The skill fires at step 19 right after the src/sum.js edit, as its description says it should. Its instructions (visible at steps 10 and 19) say to run `npx eslint . --fix` and, on a config error, to fix the config. Step 21 shows the run failing with 'couldn't find an eslint.config.* file', and step 13 already showed eslint is globally present but the project has no config or dependency for it. The agent correctly declined to start rewriting project config mid-feature and simply reported the gap at step 27, but the skill still consumed the post-edit verification slot and produced no verification at all.

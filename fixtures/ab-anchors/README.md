# fixtures/ab-anchors

One measurement, kept because it contradicts part of the design.

Same shadow log (`../sessions/lint-trap-live.jsonl`), same extraction prompt, same model
(`deepseek/deepseek-flash`). The only difference between the two runs is whether the
`## Anchors` section was in the prompt — 129 characters of 14 KB. Produced by
`spike/anchors`.

| | with anchors | without |
|---|---|---|
| lessons found | 2 | 2 |
| the lint trap | yes | yes |
| the missing `build` script | yes | yes |
| targets | `SKILL.md`, `AGENTS.md` | the same |
| evidence range | `[9, 18]` — the anchor's range, copied | `[9, 23]` |
| cost | 10, which is what a 10-step span costs | 5, for a 15-step span |

**The anchor did not find the lesson.** The model found both lessons both times, with
equivalent statements and the same targets. What the anchor changed was the numbers: the
anchored run's range and cost agree with each other, the unanchored run's do not. Since
cost feeds `score = cost × recurrence × confidence × freshness`, that is a ranking input,
not a cosmetic difference.

Neither range is obviously wrong, which is worth saying: steps 9–18 are the skill and its
failing command; 19–23 are the agent going back to read the skill to understand why. Both
are defensible readings of "steps consumed by the problem".

## What this does not measure

n = 1, one model, and the easiest possible case for reading unaided: the skill invocation
and its failing command are two lines apart in the projection, with `-> exit 2` right
there. It says nothing about `revert` spread over forty steps, or `repeat` separated by a
dozen calls, which is where a detector plausibly beats reading. Do not generalise it into
"anchors are unnecessary" — generalise it into "anchors are not how the lesson gets found".

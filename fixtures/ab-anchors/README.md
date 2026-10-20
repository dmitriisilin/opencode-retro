# fixtures/ab-anchors

The measurement that retired the anchor detectors. Kept because the code it argues about no
longer exists, and this is the whole argument.

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
dozen calls, which is where a detector plausibly beats reading. It does not prove detectors can never help.

What decided it was not the measurement alone but what the measurement revealed about them:
the three detectors were not really detecting, they were encoding *an opinion about what
friction looks like* — and that belongs in a prompt the user can read and disagree with, not
in 196 lines of JavaScript that decide in advance what the model may notice. The signals they
knew are now prose in `prompts/extract.md`. Nothing was lost except the code.

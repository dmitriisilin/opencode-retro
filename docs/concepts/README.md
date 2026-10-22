# Concepts

What the plugin *means* by its words, stated once, as definitions and invariants.

`AGENTS.md` is the working brief: history, decisions, measured API facts, gotchas, the plan.
It records how things came to be. These files record what things *are*, and they are the
place to change first. The pattern that cost the most time in this project was fixing code
where a concept was never written down — "live", "settled", "the mark", "owed" were each
rewritten three times, by three different hands, each deriving the meaning again from the
code and landing somewhere slightly different. A concept that exists only in code is
re-invented at every edit.

## How to read them

Each file is definitions followed by invariants. An invariant is a sentence the code must
make true, and each one names the test that pins it, in backticks, by its exact title.
`test/consistency.test.js` checks that every cited test exists, so a renamed or deleted
test breaks the document that depends on it, and an invariant with no test is visible as
such — it says `(untested)`.

## How to change them

Change the concept first, then the code, then the test — and cite the test here. If a
change to the code does not fit the concept, that is the signal to stop and decide which
is wrong, out loud, rather than to make the code work and leave the concept behind.

| File | Owns the words |
|---|---|
| [session.md](session.md) | session, turn, live, over, invoking, foreign, delegation, root |
| [log.md](log.md) | shadow log, record, owner, step number, the mark, owed, settled, pruned |
| [analysis.md](analysis.md) | projection, budget, excerpt, coverage, attempt, failure |
| [lesson.md](lesson.md) | lesson, evidence, recurrence, score, archive, reopen, restore, cap |
| [handover.md](handover.md) | proposal, currency, decision, what a decision records |
| [state.md](state.md) | state.json, merge, append-only, tombstone, log identity |
| [selfcheck.md](selfcheck.md) | liveness, the three timestamps, what the report may claim |

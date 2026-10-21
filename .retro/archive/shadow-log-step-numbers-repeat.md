---
id: shadow-log-step-numbers-repeat
statement: A single session's shadow log can contain two blocks of records both numbered from 1, so the `n` step ranges that lessons cite as evidence do not resolve to a unique record and a review has to rebuild the file by hand before it can trust what the lesson points at.
evidence:
  - session: ses_ea293ae76ffeIr2Ev6RhjLr2TM
    steps: [26, 29]
cost: 3
recurrence: 1
confidence: 0.6
proposal:
  target: src/shadowlog.js
  change: Continue `n` from the last record already in the session's .jsonl when a writer starts (or persist the counter in state.json), rather than from a fresh in-process counter; add a test that appends, drops the writer, reopens the same session and asserts `n` keeps increasing across both writes.
ask: The log cannot say whether the second block came from a service restart resetting an in-memory counter, from an absorbed subagent that was never renumbered into the parent, or from two sessions sharing one file — each has a different fix. Which was it?
status: accepted
lastSeen: 18
recordedAt: 2026-10-21T07:54:19.213Z
targetFingerprint: f1160563ff594247
note: "Fixed. The ask is answered: it was a new plugin process appending to an existing log, so the in-memory counter started again at 1. The second cause the lesson could not see was a prune removing a live session's log, which made a file start at n=123 — fixed earlier the same day by never pruning a session that has not ended."
changed:
  - src/shadowlog.js
  - src/ingest.js
  - index.js
  - test/shadowlog.test.js
discovered: Reading the counter back from the file also makes the numbering survive a restart mid-session, which the lesson did not ask for but is the same guarantee. Two of this project's own logs had four and three blocks restarting at 1; one had no n=1 at all, which is how the prune-while-live bug showed itself in the data rather than in a report.
closedAt: 2026-10-21T08:00:24.262Z
---

Steps 19–29 were spent reading .retro/sessions/ses_ea2ab02f….jsonl through one python heredoc after another, and the file would not stay still: at step 26 the agent printed all 71 records with their `n` and timestamps only to see `n=1..20` appear twice, concluded at step 28 that 'two sessions are writing to the same log file, with `n` restarting at 1', then at step 29 printed the second block to confirm. The damage is visible in the review input itself: the log handed over restarts at [1] three more times after that, so the reviewed 'session' mixes a lesson investigation, a stretch editing src/projection.js, and a stretch editing index.js/config/extract.js and the five READMEs. AGENTS.md states the index is 'our own per-session counter… deterministic from the log alone' and decision 18 says an evidence range 'has to resolve'; here it resolves to two records, which is why every check of the evidence needed its own parser.

---
id: agents-md-drift-not-guarded
statement: AGENTS.md's account of the extractor had drifted from the code ("fewer than three tool calls" vs. the real one-prompt-no-tools skip, a prompts/apply.md that does not exist, extractLimit "default 10" vs. Infinity), and nothing in test/consistency.test.js checks those claims, so the only way to learn the brief was wrong was to re-read src/extract.js and src/config.js.
evidence:
  - session: ses_ea3652a55ffebyABl8ty0qUtWE
    steps: [134, 138]
cost: 5
recurrence: 1
confidence: 0.7
proposal:
  target: test/consistency.test.js
  change: Add mechanical checks that the documented extractor skip rule and the documented default of extractLimit match src/extract.js and src/config.js, and that every prompt filename named in AGENTS.md's on-disk layouts exists in prompts/. Then correct the four stale passages in AGENTS.md and the header comment in src/extract.js.
ask: Is AGENTS.md allowed to lag the code between releases, or should drift in it fail the suite the way a stale translation stamp does?
status: new
lastSeen: 11
recordedAt: 2026-10-21T05:17:11.500Z
targetFingerprint: cc97749ada787fb1
---

At step 134 the agent re-read the brief to place its proposal; at step 138 it reported four specific mismatches against the sources, calling it "prose drift of exactly the kind your last two commits were fixing" and noting it had not been recorded as a lesson because extraction only reads session logs. So the file every agent starts from was wrong in places, the agent had to independently verify it against src/, and the project's own consistency test did not catch any of it — which is the failure mode AGENTS.md itself names as its costliest.

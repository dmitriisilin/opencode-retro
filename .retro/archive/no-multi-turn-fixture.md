---
id: no-multi-turn-fixture
statement: The captured payloads contain no session with more than one turn and AGENTS.md never states whether `session.execution.*` is one pair per turn or per session, so an audit of the liveness rules had to reverse-engineer the OpenCode binary to answer a question the project's own fixtures should settle.
evidence:
  - session: ses_ea1833f68ffev06LykcabsYJI1
    steps: [23, 32]
cost: 6
recurrence: 1
confidence: 0.6
proposal:
  target: fixtures/payloads/README.md
  change: Capture one session given two prompts (`opencode run -s <id>` twice, the same way the existing payloads were captured with `spike/probe`) as `fixtures/payloads/session-two-turns.jsonl`, add a README line naming it as the evidence that one `started`/`succeeded` pair is one turn, and replace the "Still unverified" entry for executions in AGENTS.md with that answer.
ask: Is a second live capture worth doing, or is recording the measured answer in AGENTS.md enough for the next audit?
status: accepted
lastSeen: 29
recordedAt: 2026-10-21T14:08:45.814Z
targetFingerprint: 50acd72a13c7bd9c
note: "Both halves done, and they were cheap. The answer is measured and stated in AGENTS.md as a payload fact instead of a still-unverified question, and a real two-turn log is saved as fixtures/sessions/two-turns.jsonl with a test that pins it: two prompts, two executions, numbered once through."
changed:
  - fixtures/sessions/two-turns.jsonl
  - test/plugin.test.js
  - AGENTS.md
discovered: "The lesson asked whether a capture was worth it or whether recording the answer was enough. Recording alone would not have been: the whole reason the liveness rules were wrong is that the one-pair-per-turn question had been answered by reasoning from event names, and the fixtures could not contradict it. The fixture is 10 records."
closedAt: 2026-10-21T14:20:06.964Z
---

At [23]–[24] the agent grepped the fixture set for `session.execution` and found exactly one `started`/`succeeded` pair (in `session-lint-trap.jsonl`) — no multi-prompt session to settle turn-vs-session, which is the pivot the whole `started`/`ended`/`isLive` design turns on. It then checked the local install and version [26], grepped the entire filesystem from `/` for the event names [27], searched `~/.cache/opencode` for `.d.ts` files and found only an ELF binary [29], re-read the payloads README [31], and finally ran `strings` over the 2.0.32 binary to read its `executionEpoch`/`rootActive` state machine [32] — the conclusion it shipped as "evidence" and left marked still-unverified. The project deliberately keeps captured payloads so API questions can be answered without running OpenCode; this central one could not be, so the work went into a binary instead of a fixture.

---
id: selfcheck-cannot-see-missing-prompt-records
statement: Every live shadow log holds records but not one `k:"prompt"` entry, while the self-check only asserts that the prompt hook fired and the log is non-empty, so prompt capture can be dead and `selfcheck.md` stays green — leaving an auditor to establish it by hand from `src/ingest.js` and a single old fixture.
evidence:
  - session: ses_ea28d6c8fffeZDDJFiEiAISzWg
    steps: [42, 57]
cost: 10
recurrence: 1
confidence: 0.6
proposal:
  target: src/selfcheck.js
  change: "Extend the shadow-log assertion to cross-check the prompt record, the way the tool-hook assertion already cross-checks events against hook calls: using the `counts.prompts` already gathered, a session whose log contains zero `k:\\\"prompt\\\"` records while the hook saw ≥1 prompt is BROKEN, with the remedy stated next to it (records are being written but prompts are not — check the prompt writer on the shadow-log path in `src/ingest.js` / `index.js`)."
ask: Is prompt capture actually expected to work against this OpenCode version, or is a prompt-less shadow log a state the self-check should tolerate? The session stopped before naming the root cause, so the check may be right to fail while the writer is fixed.
status: accepted
lastSeen: 29
recordedAt: 2026-10-21T14:10:58.110Z
targetFingerprint: 66cf0b4ec0a3beea
note: "The observation was right and the cause was not what it guessed. A prompt-less log is not a broken writer: `session.synthetic` does not fire the `session.prompt` hook at all, so a session whose only input is a hand-over has nothing to write. `say()` now writes the hand-over itself as `k: \"handover\"`, which is what was actually missing from the log — the instruction behind the work."
changed:
  - src/ingest.js
  - src/projection.js
  - index.js
  - test/plugin.test.js
  - AGENTS.md
discovered: "The proposed self-check assertion is deliberately not added. It would fire when the hook saw a prompt and the log holds none, and that cannot happen: `ingest.prompt` increments the counter and appends the record in the same call. The prompt-less logs it was inferred from had zero hook calls, not a lost record. The lesson also overgeneralised to 'every live shadow log' — logs from `opencode run` do carry prompts; only the ones delivered through synthetic did not."
closedAt: 2026-10-21T14:20:06.980Z
---

At [42] the agent printed, for every file in `.retro/sessions/`, records and prompt counts: 41 records / 0 prompts for its own session, 18 / 0 for another. It then spent ten steps deciding whether that was its own misreading or a defect: grep of the hook wiring in `index.js` [44], `src/ingest.js` [45], a grep of the fixtures [47], the prompt hook path in `index.js` [49], the one surviving prompt record in `fixtures/sessions/lint-trap-live.jsonl` [50], the previous session's tool calls and final text [52]/[54] (which had ended on an unanswered 'prompt, code, or both?'), `isLive` [56], and finally the prompt-hook assertion in `src/selfcheck.js` [57]. The log ends there. AGENTS.md decision 5 says the projection carries prompts in full and decision 19 says `selfcheck.md` asserts liveness, but the shadow-log assertion as described there only checks the file exists and is non-empty, and the prompt assertion only checks the hook fired — so a write failure between the hook and the record is invisible to the one artifact built to report it.

# Hand-over and decision

## Definitions

**Proposal.** One lesson, put to the agent already in the user's session, by
`session.synthetic` with `resume: true`. `/retro` delivers the highest-scoring open
lesson and stops; `/retro all` delivers every open lesson up to `proposeLimit` and asks
for one plan. The plugin never edits the harness and never drives the conversation.

**The rule.** `.retro/prompts/propose.md`: what the agent treats as its job when a lesson
arrives — is it still true, where does the fix belong, relay it, change nothing until
the human decides, record the outcome. One rule for both commands; its last section says
what changes when several lessons arrive at once.

**Currency.** Whether a lesson is still true. The plugin offers two facts — when the
lesson was recorded, and whether its target file's content hash has changed since — and
puts the question to the agent, which has the repository. A changed target is a reason
to look, never a verdict. The hash is the baseline taken when the lesson was first recorded;
recurrence, reopening and restoring never move it, or "changed since" would compare the file
with itself.

**Decision.** The third artifact, written by the `retro_decide` tool: `status`
(`accepted` / `rejected` / `later`), `note`, `decidedIn` (the session it was taken in),
`changed` (the files really touched, often not the ones proposed), and `discovered`
(what the work turned up that the lesson did not contain), plus `closedAt` when it is
closed. Accepting or rejecting moves the file to `archive/`; `later` keeps it open.

## Invariants

- One invocation delivers one lesson, the top of the open set by score.
  `the top open lesson is picked by score`
  `one invocation delivers exactly one lesson, the top of the open set`
  `decided lessons are not shown again; later ones are`
- The hand-over text comes from the prompt file, and a missing file degrades to a terse
  hand-over rather than a silent one.
  `the hand-over instructions come from the prompt file, not from source`
  `a missing prompt degrades to a terse hand-off rather than a silent one`
- `/retro all` is one plan over every open lesson, capped, and says what it left out.
  `/retro all delivers every waiting lesson as one plan`
  `proposeLimit caps one plan and says what it left out`
- The proposal states its own facts about currency and never a conclusion.
  `a target that changed since the lesson was written is flagged, not dropped`
  `a target that cannot be read reads as unknown, never as unchanged`
- The currency baseline is recorded once and not moved by recurrence.
  `record keeps a fingerprint of the target so currency can be checked later`
  `a merge keeps the fingerprint taken when the lesson was first recorded`
  `a reopened lesson keeps the fingerprint from when the problem was first recorded`
  `a lesson whose target had no fingerprint at record time stays unknown, rather than faking a baseline`
- A decision records what was done, not what was proposed, and where it was taken.
  `the decision records what was actually done, not what was proposed`
  `the archive records which session decided it`
- Deciding twice is safe and says so.
  `deciding twice is safe and says so, instead of reading as a failure`
- Every field the decision assembles reaches the archive.
  `the decision records what was actually done, not what was proposed`
  `the archive records which session decided it`
  `a decision made without a session still records cleanly`
- A review costs nothing beyond the analysis.
  `a review costs nothing beyond the analysis itself`

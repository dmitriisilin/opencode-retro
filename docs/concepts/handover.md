# Hand-over and decision

## Definitions

**Proposal.** One lesson, put to the agent already in the user's session. `/retro` delivers
the highest-scoring open lesson and stops; `/retro all` delivers every open lesson up to
`proposeLimit` and asks for one plan. The plugin never edits the harness and never drives
the conversation.

It arrives one of two ways, and both end in the log. When the round had analyses to run, the
agent calls `retro_propose` and the text comes back as that tool's result — it asked, so
nothing is sent. When there was nothing to analyse, `/retro` delivers it with
`session.synthetic` and `resume: true`, because otherwise it would sit in the inbox until the
person happened to type something.

**Logging our own text.** Either way the hand-over is written into the session's log as a
`handover` record, with `about` saying which of the two it is: `work` for a request for
analyses, `lesson` for a lesson put to the human. A synthetic has to be logged because it
does not fire the prompt hook, and the log would otherwise show the work with the instruction
behind it missing (log.md). A tool result has to be logged for a different reason: the
extraction contract tells an analysis that work following a `handover` with
`about: "lesson"` is the review of that lesson rather than the problem happening again, and
with no such record that rule can never fire. Measured live — a review session held the
work-order hand-over, the agent checking a lesson against the repository, and its verdict,
with nothing between them saying a lesson had been handed over at all.

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
- A hand-over is written into the session's log whichever way it arrived, and says which
  kind it was.
  `the proposal retro_propose returns is written into the session's log`
  `the plugin's own analysis is not logged as the user's work`
- The hand-over text comes from the prompt file, and a missing file degrades to a terse
  hand-over rather than a silent one.
  `the hand-over instructions come from the prompt file, not from source`
  `a missing prompt degrades to a terse hand-off rather than a silent one`
- (untested) A hand-over into a session that is busy — mid-turn, or waiting on a question
  the agent put to the human — is queued by OpenCode like any other input, and appears when
  that turn ends. Measured live, but nothing pins it: no fake reproduces OpenCode's queue. `resume: true` does not resume a session that is
  already working. That is OpenCode's delivery, not something the plugin can see or change;
  headless, it means a review that stopped on a question form holds every later hand-over
  until the form is answered (AGENTS.md Gotcha 16).

  Measured in cycle 9, which is where the shape of it became clear: a second `/retro` posted
  into the same review session wrote its hand-over into the log and nothing followed — the
  session's turn had never ended (`trigger — not exercised: the session has not ended yet`,
  "still working"), so the text waited in the inbox. The order stayed owed, which is the
  right outcome and is reported, but nothing in that session ever answered it. Interactively
  the person types again and sees it; headless, nobody does, so the friction bench now posts
  its second `/retro` in a fresh session. The one hazard left is arithmetic: three such
  rounds in one busy session would retire a log that was never unanalysable, so a log owed by
  the session a command is running in is worth watching.
- An empty hand-over after a failed read says the read failed, and does not conclude that
  the sessions went straight.
  `a log that could not be read is not reported as a session that went straight`
- The evidence a hand-over offers names the log where the plugin actually keeps it, and
  follows `options.dir` when that directory moves. A bare `sessions/` is relative to
  `.retro/`, which the reader has no reason to know; a live reviewer followed it to the
  project root and found nothing.
  `the evidence names the log where the plugin keeps it, not at the project root`
  `the evidence follows options.dir when the log directory moves`
  `an empty hand-over names the plugin's files where options.dir put them`
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

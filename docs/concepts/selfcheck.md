# Self-check

## Definitions

**Liveness.** Whether the plugin is actually running and actually receiving hooks — not
whether it registered. A hook registered under a name the API no longer uses registers
successfully and never fires, so registration proves nothing. Liveness is proven only by
traffic.

**The report.** `.retro/selfcheck.md`. About the plugin, not about the session; it cites
the session it measured on as evidence. It explains itself: its cadence, its staleness
rule, what each failing line means and what to do next, and the versions and repository
it came from.

**The three timestamps.** `loaded` (setup ran), `heartbeat` (hooks are firing; refreshed
while a session works, at most once a minute), `verified` (when the assertions were last
evaluated — from the first prompt of a session onward, not only at its end).

**The assertions.** Prompt hook, tool hook, shadow log, trigger, extraction. Each is
`ok`, `DEGRADED`, `BROKEN` or `not exercised`. **The report may claim only what the
traffic proved.** A session without tool calls proves nothing about the tool hook; a turn
whose input is a hand-over proves nothing about the prompt hook — the counters are per
turn, so a session prompted earlier and handed a lesson later was not "started by a
hand-over"; a shortfall of hook calls against events is not evidence while calls are in
flight; the trigger cannot be judged before the session ends.

**Stock.** What is waiting for the human: open lessons, logs owed an analysis, logs read in
part (the next command reads on from the mark), logs asked about with no answer and how many
times, logs the plugin itself could not read, logs kept because a lesson cites them, logs
given up on, and lesson files
that cannot be read. Kept in its own section, because it is the one part a person has to act
on. An asking that came back with nothing is reported as that and not as a verdict about the
log — the plugin does not know whether anybody came (analysis.md) — while a read the plugin
could not complete is a failure and is named as one. The extraction line reports the
last analysis of the session whichever path ran it.

## Invariants

- The checked block does not count waiting logs: that is the stock's job, recomputed every
  time the file is written, so the two cannot contradict each other.
  `the checked block does not count waiting logs, so it cannot contradict the stock`
- A turn this process did not see begin — the plugin reloaded mid-turn by a restart or an
  edit to `opencode.json` — proves nothing about the prompt hook and is not reported as a
  dead one; a turn it did see begin with no prompt still is. The last analysis is read from
  disk, so a reload does not unsay it.
  `a plugin reloaded in the middle of a turn does not call the prompt hook dead`
- A log read in part is named as such, not as not analysed yet — and later growth does not
  turn the part already read back into an unopened log.
  `a log read in part is named as such, not as not analysed yet`
  `a log read in part stays read in part after the hand-over wrote into it`
- A lesson file that cannot be read is named in the stock, with what to do about it.
  `a lesson file that cannot be read is named, with what to do about it`
- The report is written from the first prompt, not once the session is over.
  `the report is written from the first prompt, not once the session is over`
- A turn with no tool calls proves nothing about the tool hook, and is described as a turn,
  not as the session having run none.
  `a turn with no tool calls does not claim the whole session had none`
- A finished session proves the hooks ran, with numbers.
  `a finished session is owed an analysis, and the report proves the hooks ran`
- Events the hooks never received are reported as a dead hook, with numbers — at the end
  of the session, not while calls are still in flight.
  `events the hooks never received are reported as a dead hook, with numbers`
  `a running session with calls still in flight is not reported as a broken tool hook`
- The report describes the last analysis and what is owed as the marks say they are: read,
  owed, or failed. A failure that a later read recovered from is not still a failure, and a
  log that was given up on and has since grown is not beyond reading.
  `a working session read by /retro is reported as read, not as unanalysed`
  `a log asked about with no answer is named as that, not as not analysed yet`
  `a successful read clears the failed-read flag the mark was carrying`
  `a log given up on and then grown is not reported as beyond reading`
- A call the turn ended in the middle of accounts for its event: an interrupted turn with a
  subagent still running is not a dead tool hook.
  `an interrupted turn with a subagent still running is not a dead tool hook`
- A turn whose input is a hand-over does not report a dead prompt hook.
  `a review session driven by a hand-over is not reported as a dead prompt hook`
- The surface check names exactly the `ctx` members the plugin calls.
  `the self-check requires exactly the ctx surface the plugin calls`
- A command that throws reaches the log and the session, never a bare 500.
  `a command that throws reports itself instead of vanishing into a 500`
- Everything below `setup`'s `return` is a function declaration, because a binding there
  is never initialised.
  `nothing after setup returns is a binding, because a binding there is never initialised`

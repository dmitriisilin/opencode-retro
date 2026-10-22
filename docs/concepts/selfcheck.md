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
traffic proved.** A session without tool calls proves nothing about the tool hook; a
session started by a hand-over proves nothing about the prompt hook; a shortfall of hook
calls against events is not evidence while calls are in flight; the trigger cannot be
judged before the session ends.

**Stock.** What is waiting for the human: open lessons, queued logs, logs kept because a
lesson cites them, logs given up on. Kept in its own section, because it is the one part
a person has to act on.

## Invariants

- The report is written from the first prompt, not once the session is over.
  `the report is written from the first prompt, not once the session is over`
- A finished session proves the hooks ran, with numbers.
  `a finished session is queued by the event stream, and the report proves the hooks ran`
- Events the hooks never received are reported as a dead hook, with numbers — at the end
  of the session, not while calls are still in flight.
  `events the hooks never received are reported as a dead hook, with numbers`
  `a running session with calls still in flight is not reported as a broken tool hook`
- A session started by a hand-over does not report a dead prompt hook.
  `a review session driven by a hand-over is not reported as a dead prompt hook`
- The surface check names exactly the `ctx` members the plugin calls.
  `the self-check requires exactly the ctx surface the plugin calls`
- A command that throws reaches the log and the session, never a bare 500.
  `a command that throws reports itself instead of vanishing into a 500`
- Everything below `setup`'s `return` is a function declaration, because a binding there
  is never initialised.
  `nothing after setup returns is a binding, because a binding there is never initialised`

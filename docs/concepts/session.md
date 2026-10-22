# Session

## Definitions

**Session.** An OpenCode session, identified by its `sessionID`. To the plugin a session is
the unit of a shadow log and of freshness: one log per session, one count per session.

**Turn (execution).** One run of the agent in response to one prompt. OpenCode reports it
as a `session.execution.started` / `.succeeded|failed|interrupted` pair. A session has one
turn per prompt; a session left open and prompted again has another turn. **An execution
is a turn, not the life of a session** — measured, see `fixtures/sessions/two-turns.jsonl`.

**Live.** A session whose current turn has started and not ended, as far as this process
has seen; plus the session the command is running in, always. A hook firing for a session
whose start event this process never saw also makes it live — after a restart the start event
has already gone by, and the hook is the older fact. Live is a property of this process's
memory, not of the file: a restart knows nothing is live until a hook arrives.

**Over.** Not live. A session is over when its last turn ended, or when the process that
would know restarted. "Over" never means "will not be prompted again": a session is over
between turns.

**Invoking session.** The session a command (`/retro`, `/retro all`) was run in. It is
live by definition, whatever the event stream said, because the command is running in it.

**Foreign session.** A session in this project but another checkout (a git worktree). The
event stream carries it here; the hooks do not. It is identified by a `session.created`
whose directory is not ours. Without that event, a session with no hook of ours is simply
not ours — silence is not evidence of another checkout (see the invariant below).

**Delegation.** A subagent's session. It is a step in its parent's task, not a session of
its own: its records go into the root session's log, its turns are not counted, its end is
not queued. The **root** is the top of the parent chain, whatever its depth. Learning the
link also makes the root ours by association, even if the root's own prompt hook was missed:
the delegation is evidence that something of ours ran.

## Invariants

- One session given two prompts produces two turns in one log, numbered once through.
  `a two-turn session is one session with two executions`
  `a session that runs again is owed a second analysis, from where the first stopped`
- A turn starting makes the session live again, whatever a previous turn's end said.
  `a session still working is read, and nothing about it is settled`
  `a session picked up again is read, never settled, while its second turn is running`
- A session whose start event this process never saw is live from its first hook.
  `a session whose start event this process never saw is live from its first hook`
- A session is counted once for freshness, however many turns it runs.
  `a session is counted once, however many times it runs`
- The invoking session is live, and its log is never pruned under it.
  `deciding a lesson never prunes the log of the session it was decided in`
- A session no hook ever fired for is not ours, and gets no log, no count and no report.
  `a session no hook ever fired for is not ours, and gets no log at all`
  `a session from another checkout of this project is not ours`
- Silence is ours: a session whose `session.created` we never saw is treated as our own,
  so a hook that genuinely stopped firing still reads as broken rather than as foreign.
  `events the hooks never received are reported as a dead hook, with numbers`
- A delegation's records land in the root's log, at any depth, in whichever order the
  links arrive.
  `a subagent's work lands in the parent's log, and is not analysed on its own`
  `a delegation inside a delegation is folded into the root when the links arrive out of order`
- A delegation's own instruction is kept even though it arrives before its parent is known.
  `the subagent's own instruction is not lost to the race that reveals its parent`
- A session that turns out to be a delegation is taken back out of the queue and the count.
  `a session that turns out to be a subagent leaves the queue`
  `a session discovered to be a subagent is taken back out of the counter`
- A hook that arrives after a session's end belongs to that session and does not make the
  report call it broken.
  `a hook that arrives after a session's end does not report the session as broken`

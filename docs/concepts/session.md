# Session

## Definitions

**Session.** An OpenCode session, identified by its `sessionID`. To the plugin a session is
the unit of a shadow log and of freshness: one log per session, one count per session.

**Turn (execution).** One run of the agent in response to one prompt. OpenCode reports it
as a `session.execution.started` / `.succeeded|failed|interrupted` pair. A session has one
turn per prompt; a session left open and prompted again has another turn. **An execution
is a turn, not the life of a session** — measured, see `fixtures/sessions/two-turns.jsonl`.

**Nothing about a session is held in memory.** What the plugin knows about a session is
what is on disk: its log, and its mark in `state.json`. Whether a session is still working
is not known and not needed. Reading a working session is safe — a mark only says how far
the log was read, and a session that writes more is simply owed the rest — and the one act
that cannot be undone, pruning a log, waits for a week of silence. So a restart, a crash,
a turn that never reports its end, or a second plugin instance on the same project changes
nothing about what is read or removed. *Replaces "live", a property of one process's memory:
a restart forgot it, a second instance never had it, and a turn resumed over the API could
hold it for ever. Each of those was a defect or a documented limit; none of them exists in a
model where the disk is the only state.*

**Quiet.** A log that has not been written for seven days, by its file's modification
time. This is the only place the plugin uses a clock. Seven days is long enough that a
session left open and returned to within a week keeps its log, and short enough that logs
do not pile up. A session picked up after that starts a new log, read from its own start;
no lesson loses anything, because only a log that was read to its end and is cited by no
open lesson is ever pruned.

**Foreign session.** A session in this project but another checkout (a git worktree). The
event stream carries it here; the hooks do not. It is identified by a `session.created`
whose directory is not ours. Without that event, a session with no hook of ours is simply
not ours — silence is not evidence of another checkout (see the invariant below).

**Delegation.** A subagent's session. It is a step in its parent's task, not a session of
its own: its records go into the root session's log, its turns are not counted, and it is never
analysed on its own. The **root** is the top of the parent chain, whatever its depth. Learning the
link also makes the root ours by association, even if the root's own prompt hook was missed:
the delegation is evidence that something of ours ran.

## Invariants

- One session given two prompts produces two turns in one log, numbered once through.
  `a two-turn session is one session with two executions`
  `a session that runs again is owed a second analysis, from where the first stopped`
- A working session is read as far as it goes, and owed the rest when it writes more.
  `a session still working is read, and owed the rest when it writes more`
- A session is counted once for freshness, however many turns it runs.
  `a session is counted once, however many times it runs`
- A log written within the last seven days is never pruned — the log of the session a
  command runs in among them.
  `deciding a lesson never prunes the log of the session it was decided in`
  `a log written in the last seven days is not pruned, whatever else is true of it`
- What is read and what is pruned is decided from the disk alone: a restart, a crash or a
  second instance on the project changes neither.
  `a restart forgets nothing about what is owed`
  `two instances on one project neither lose nor prune each other's work`
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
- A session that turns out to be a delegation is taken back out of the count, and its log
  is folded into the root's.
  `a session discovered to be a subagent is taken back out of the counter`
- A hook that arrives after a session's end belongs to that session and does not make the
  report call it broken.
  `a hook that arrives after a session's end does not report the session as broken`

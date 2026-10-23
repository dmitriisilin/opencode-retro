# The shadow log

## Definitions

**Shadow log.** `sessions/<sessionID>.jsonl`: one record per line, appended as the session
runs, by the plugin and nobody else. It is the raw material — the only account of what a
session did that does not depend on the session's own history surviving compaction.

**Record.** One line, with `k` naming its kind: `prompt`, `handover`, `tool`, `text`,
`step`, `session`. Every record the plugin can write has a rendering in the projection.

**Owner.** The session a record is written under: the root of the delegation chain.

**Opened by a hook.** A log exists only because a hook fired for its session. The event
stream reaches every session in the project, including foreign ones, so an event may
*annotate* a log that a hook opened and may never open one.

**Step number (`n`).** The plugin's own counter, one per owner, continuous for the life of
the file. It is the coordinate a lesson's evidence uses, so it must be unique within a
file and must not restart when a new process appends to an existing log. The plugin is
the only writer of its logs: the counter is read from the file when a process first
writes to a session, so a log replaced by hand *while* the plugin is writing to that
session can get duplicate numbers until the next restart. Replaced while the plugin is
down, it is a different log and is read from its own start.

**One call id, one record.** A tool call is identified by its `id`. A tool run through Code
Mode's `execute` arrives as a second `before`/`after` pair under the same id as the inner
call; it is one action, so it is recorded once, as the inner call. Two records for one id
would make the projection show work that happened once as two calls — measured live, an
extractor read a single `retro_decide` as a duplicate call and derived a lesson about it.

**Hand-over record.** `k: "handover"`: text the plugin itself delivered into the session
with `session.synthetic`, which does not fire the prompt hook. Written so the log of a
review session shows the instruction behind the work. It is not a prompt and is not
rendered as one.

**The mark.** `state.looked[session]`: how much of a log has been dealt with.
- `n` — the last step turned into lessons. Moves only on a successful analysis, and only
  as far as that analysis *covered* (see analysis.md). The next read starts after it.
- `size` — the largest byte count already sent, success or failure. A log no larger than
  this has nothing new in it.
- `open` — the analysis reported reading only part of the log. Owed now.
- `failed` — the plugin's last read of this log failed. Owed now, while attempts are left.
- `attempts` — reads the plugin could not complete at this `size`. Growth resets it: new
  material has not failed anywhere yet. An unanswered order is not counted here — it is
  counted on the order, as an asking (analysis.md).
- `id` — the identity of the file the mark describes (see state.md). A mark about a
  different file is void. A mark written before identities existed is voided by the one
  other safe signal: a byte count larger than the file on disk.

**Owed.** A log the plugin still has to read: its size grew past the mark, or the mark is
`open`, or the mark is `failed` with attempts left. Owed is computed from the file and its
mark, every time — there is no queue to fall out of step with them — and it is the only
reason an analysis happens. The plugin's own hand-over, written into a log that was read to its end,
does not make it owed: it is not material (analysis.md), and the next read carries it along
with whatever follows.

**Read to its end.** A log whose mark covers its whole size with neither flag set. Not
permanent: a session prompted again grows past its mark and is owed again.

**Retired.** A log the plugin could not read three times at the same size — could not open,
could not parse, could not write an order for. Not owed; its failure is recorded and named in
the self-check. It is owed again if it grows. An order nobody answered is not one of these
(analysis.md): it says nothing about the log, so it is reported and asked again instead.

**Pruned.** Removed from disk. A log is pruned when it is quiet (session.md: unwritten for
seven days), nothing is owed for it, and no open lesson cites it. A retired log goes the
same way, so a log no analysis could ever answer does not stay for ever. `keepSessions`
keeps everything.

## Invariants

- A log is append-only: while it is the same file, every record once in it stays. A crash
  in the middle of an append loses the record being written and nothing after it — the next
  append starts on a line of its own.
  `a crash mid-append loses only its own half-record, not the prompt after it`
- The event stream may annotate a log, never open one.
  `a session no hook ever fired for is not ours, and gets no log at all`
  `once a hook has fired, the event stream annotates that same session`
- Step numbers are unique within a file and continue across processes.
  `numbering continues from the log, so a step range resolves to one record`
  `a half-written last line does not reset the numbering`
- A call id names one call, even when a wrapper reports the same call twice.
  `a tool run through execute is one call, not two records with the same id`
- The hand-over the plugin delivers is in the session's own log, as a hand-over.
  `the hand-over the plugin delivers is in the session's own log`
- A working session is read as far as it goes, and owed the rest when it writes more.
  `a session still working is read, and owed the rest when it writes more`
- A second look reads only what is new, and carries the prompts whatever their step.
  `a second look at a session reads only what is new since the first`
- Nothing is paid for twice: a log no larger than its mark is not sent again.
  `a working session is not read again until its log has grown`
- The plugin's own hand-over does not make a log owed.
  `the plugin's own hand-over does not make a log owed`
- A log read only in part is owed now: read again without growth, and not pruned first.
  `a log read in part is read again without growing, and is not pruned first`
- A failed read is owed: tried again on the next command, up to three times at one size.
  `a failed read is owed, and tried again on the next command`
- Nothing is marked as read until the read completes. A read that never returns leaves the
  debt that started it in place, so the log is owed again rather than looking sent.
  `a read that never returns leaves the log owed, not marked as read`
- A success clears the failure on the mark; retirement clears both flags. A flag that
  outlives either makes a log owed that nobody owes.
  `a successful read clears the failed-read flag the mark was carrying`
  `a log given up on after three attempts is not retried in the same command`
- Reading a log to its end keeps the step mark, because the session may be picked up again.
  `settling keeps the step mark, because the session may be picked up again`
- A log given up on after three failures stays on disk until it is quiet, whatever else is
  pruned.
  `a log given up on stays on disk, even when another log's success runs the pruning`
  `a log given up on goes once it has been quiet for seven days`
- A log is kept while an open lesson cites it, and goes once that lesson is decided and the
  log is quiet.
  `a log survives while a lesson cites it, and goes once that lesson is decided`
- A log is pruned only when it is quiet, read to its end, and cited by no open lesson;
  anything less keeps it. A log nobody has read is never pruned, however old.
  `a log written in the last seven days is not pruned, whatever else is true of it`
  `a log nobody has read is kept, however old`
- A session picked up after its log was pruned starts a new log, read from its start.
  `a session picked up after its log was pruned is read from the start of its new log`
- A log with an unread gap, a failed read, or growth since its mark is still owed, and no
  decision may prune it.
  `a log that is still owed is not pruned by a decision`
- A log that nothing cites is still kept when `keepSessions` says so.
  `keepSessions keeps a log that nothing cites, because losing it is not recoverable`
- A log whose end was never seen — a server that stopped, a turn resumed over the API — is
  read like any other: nothing waits for an end.
  `a log left behind by a server that stopped is read like any other`
- A replaced file is a different log: read from its own start, whatever its size or
  numbering, and no mark about the old file survives.
  `a mark belongs to one log: a replaced file is read from its own start, whatever its size or numbering`
  `a mark about a different file is void even when the read sees a different file than the check did`
- An unreadable log is a failure, retried, and never reported as a clean analysis. A file
  that exists but yields no record is unreadable, not an empty session.
  `a log that cannot be read is reported as a failure, not as a clean analysis`
  `a log with no parseable record is reported as a failure, not as a clean analysis`

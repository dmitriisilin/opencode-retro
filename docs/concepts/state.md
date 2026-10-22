# State

## Definitions

**`state.json`.** The small things that must outlive a process: rejected ids, the queue,
the outcome of each extraction, the marks, the session count. Read once at load, used
from memory, and written by **merging with the file**, never by overwriting it — a second
writer (another instance on the project) must not be clobbered.

**Append-only parts.** Rejections, extractions, counted sessions, the queue. Merged as
unions. The session count is derived from the counted identities, not kept as a number.

**Monotonic parts.** Each mark's `n` and `size`. Merged as maxima, except across a change
of log identity.

**Tombstone.** A deliberate removal the data cannot otherwise express, kept so a merge
does not bring the thing back: `rebased` (the mark described a file that is gone),
`unqueued` (the session turned out to be a delegation), `uncounted` (likewise). A
tombstone is cleared by the opposite deliberate act — a fresh mark, a fresh `queue()`.

**Log identity (`id`).** A fingerprint of a log's first record, stored on its mark. Two
files under one session id are two logs, and a mark is about exactly one of them: a mark
whose `id` does not match the file on disk is void, and a merge does not max a mark
against another with a different `id`. This is what makes "a replaced log is a different
log" hold across writers, not just within one process.

**Compaction.** Bookkeeping about a session is dropped once nothing can refer to it: its
log is gone, it is not queued, it is not live. The tombstone sets do not grow for ever.

## Invariants

- A rejection is remembered once and outlives the process.
  `a rejection is remembered once, and outlives the process`
- A save merges with the file instead of overwriting another writer.
  `a save merges with the file instead of overwriting another writer`
  `two writers' queues are merged, so neither loses what the other owed`
  `two writers counting different sessions count two, not one`
- A deliberate removal survives a merge.
  `a session removed from the queue stays removed even if another writer queued it`
  `a rebased mark is not resurrected by the merge`
  `a rebase whose save failed is not undone by the next look`
- A mark about a replaced log is void everywhere, including for a writer that never saw
  the replacement.
  `a mark about a replaced log cannot be resurrected by a writer that never saw the replacement`
- Both mark flags survive a save; neither is dropped by the merge.
  `an open mark survives a save and is cleared by a read that reaches the end`
  `a failed read of a live session is owed, not forgotten`
- Bookkeeping about a session is dropped once nothing can refer to it.
  `bookkeeping about a session is dropped once nothing can refer to it`
- A corrupt or hand-broken file starts clean or is repaired, and a save that cannot
  happen is reported, never thrown at the session.
  `a corrupt state file starts clean instead of refusing to run`
  `a hand-edited file with the wrong shapes is repaired, not trusted`
  `a save that cannot happen is reported, never thrown at the session`

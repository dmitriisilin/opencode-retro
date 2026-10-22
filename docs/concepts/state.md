# State

## Definitions

**`state.json`.** The small things that must outlive a process: rejected ids, the queue,
the outcome of each extraction, the marks, the session count. Read once at load, used
from memory, and written by **merging with the file**, never by overwriting it — a second
writer (another instance on the project) must not be clobbered.

**Append-only parts.** Rejections, extractions, counted sessions, the queue. Merged as
unions. The session count is derived from the counted identities, not kept as a number.
`extracted` is a map keyed by session, so two writers' outcomes for one session cannot both
be kept: the saving writer's own outcome replaces the file's. The queue keeps a retry when
the file's extraction covered less than the entry was queued at, so that replacement cannot
silently drop new work. Two entries for one session merge to the **larger** queued size, for
the same reason: an extraction that covered the earlier entry has not answered the material
the later one was queued for.

**Monotonic parts.** Each mark's `n` and `size`. Merged as maxima, except across a change
of log identity.

**Tombstone.** A deliberate removal the data cannot otherwise express, kept so a merge
does not bring the thing back: `rebased` (the mark described a file that is gone),
`unqueued` (the session turned out to be a delegation), `uncounted` (likewise). `rebased`
is cleared by a fresh mark and `unqueued` by a fresh `queue()`. `uncounted` has no clearing
act: a delegation never becomes a session. The queue and count tombstones are never
compacted, because they are the only defence against a writer that loaded before the removal
and saves afterwards.

**Log identity (`id`).** A fingerprint of a log's first record, stored on its mark. Two
files under one session id are two logs, and a mark is about exactly one of them: a mark
whose `id` does not match the file on disk is void, and a merge does not max a mark
against another with a different `id`. This is what makes "a replaced log is a different
log" hold across writers, not just within one process.

**Compaction.** Bookkeeping about a session is dropped once nothing can refer to it: its
log is gone, it is not queued, it is not live. Marks and extraction outcomes are bookkeeping
and go. The set of counted sessions does not: a session left open can be prompted again
months later, and folding its identity away would count it twice. The queue and count
tombstones stay for the same reason, and grow with the number of delegations — one identity
per session either way — not with the age of the project.

## Invariants

- A rejection is remembered once and outlives the process.
  `a rejection is remembered once, and outlives the process`
- A save merges with the file instead of overwriting another writer.
  `a save merges with the file instead of overwriting another writer`
  `two writers' queues are merged, so neither loses what the other owed`
  `a queue entry queued again after an extraction is not lost by the merge`
  `re-queueing a session for later material records the size it is owed at`
  `two writers counting different sessions count two, not one`
- A deliberate removal survives a merge, including one that happens after compaction.
  `a session removed from the queue stays removed even if another writer queued it`
  `a deliberate removal survives a merge that happens after compaction`
  `a rebased mark is not resurrected by the merge`
  `a rebase whose save failed is not undone by the next look`
- A mark about a replaced log is void everywhere, including for a writer that never saw
  the replacement.
  `a mark about a replaced log cannot be resurrected by a writer that never saw the replacement`
- A mark's identity comes from the bytes that were read, and a file with no whole first
  record is a different log.
  `identity is the first whole record of the text that was read`
  `a replaced log whose first record cannot be read is still a different log`
- Both mark flags survive a save; neither is dropped by the merge, and at the same step the
  later mark decides which flags stand.
  `an open mark survives a save and is cleared by a read that reaches the end`
  `a failed read of a live session is owed, not forgotten`
  `a stale writer cannot clear a mark flag at the same step`
- Bookkeeping about a session is dropped once nothing can refer to it; a counted identity
  and a deliberate removal are not bookkeeping.
  `bookkeeping about a session is dropped once nothing can refer to it`
- A corrupt or hand-broken file starts clean or is repaired, and a save that cannot
  happen is reported, never thrown at the session.
  `a corrupt state file starts clean instead of refusing to run`
  `a hand-edited file with the wrong shapes is repaired, not trusted`
  `a save that cannot happen is reported, never thrown at the session`

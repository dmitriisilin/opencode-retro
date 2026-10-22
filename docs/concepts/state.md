# State

## Definitions

**`state.json`.** The small things that must outlive a process: rejected ids, the outcome of
each extraction, the marks, the session count. Read once at load, used from memory, and
written by **merging with the file**, never by overwriting it — a second writer (another
instance on the project) must not be clobbered. There is no queue: what is owed is computed
from each log and its mark (log.md), so nothing in this file can say a log is owed when it is
not, or forget one that is.

**Append-only parts.** Rejections, extractions, counted sessions. Merged as unions. The
session count is derived from the counted identities, not kept as a number. `extracted` is a
map keyed by session, so two writers' outcomes for one session cannot both be kept: the
later one wins, whoever wrote it — otherwise a writer holding an old success overwrites the
other's newer "given up on". Each writer takes in what the other saved before it reads, so
neither decides from a picture of the file older than its last change.

**Marks.** Merged per session. Two marks about the same file (the same `id`) take the
maxima of `n` and `size`; at the same step the later mark decides which flags stand, and at
the same size the higher attempt count stands. Two marks about different files keep the one
that describes the file on disk, and neither if neither does — so a mark about a replaced
log cannot come back through a writer that never saw the replacement.

**Tombstone.** A deliberate removal the data cannot otherwise express, kept so a merge does
not bring the thing back: `uncounted`, a session that turned out to be a delegation. It has
no clearing act — a delegation never becomes a session — and it is never compacted, because
it is the only defence against a writer that loaded before the removal and saves afterwards.

**Log identity (`id`).** A fingerprint of a log's first record, stored on its mark. Two
files under one session id are two logs, and a mark is about exactly one of them: a mark
whose `id` does not match the file on disk is void, and a merge does not max a mark
against another with a different `id`. This is what makes "a replaced log is a different
log" hold across writers, not just within one process.

**Compaction.** Bookkeeping about a session is dropped once its log is gone: its mark and its
extraction outcome. The set of counted sessions is not bookkeeping: a session left open can be
prompted again months later, and folding its identity away would count it twice. The
tombstones stay for the same reason, and grow with the number of delegations — one identity
per session either way — not with the age of the project.

## Invariants

- A rejection is remembered once and outlives the process.
  `a rejection is remembered once, and outlives the process`
- A save merges with the file instead of overwriting another writer.
  `a save merges with the file instead of overwriting another writer`
  `a later outcome wins the merge, whichever writer holds it`
  `a later outcome wins even when both writers land in the same millisecond`
  `a writer reads what another saved since, not only what it loaded`
  `two writers' marks are merged, so neither loses what the other read`
  `two writers counting different sessions count two, not one`
- A deliberate removal survives a merge, including one that happens after compaction.
  `a deliberate removal survives a merge that happens after compaction`
- A replaced log voids every byte count about the old file, so a smaller replacement is
  not owed for ever.
  `a log replaced by a smaller one is settled, and one command reads it once`
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
  `a failed read is owed, and tried again on the next command`
  `a stale writer cannot clear a mark flag at the same step`
- Bookkeeping about a session is dropped once nothing can refer to it; a counted identity
  and a deliberate removal are not bookkeeping.
  `bookkeeping about a session is dropped once nothing can refer to it`
- A corrupt or hand-broken file starts clean or is repaired, and a save that cannot
  happen is reported, never thrown at the session.
  `a corrupt state file starts clean instead of refusing to run`
  `a hand-edited file with the wrong shapes is repaired, not trusted`
  `a save that cannot happen is reported, never thrown at the session`
- `state.json` and every lesson file are written whole or not at all, so a crash mid-save
  leaves the previous file rather than a truncated one.
  `a write replaces the whole file and leaves nothing beside it`
  `a write that fails leaves the old file whole and no temporary behind`

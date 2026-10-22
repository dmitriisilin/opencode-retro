# Lesson

## Definitions

**Lesson.** One file in `lessons/`, keyed by *problem*, not by session: a statement of
what went wrong, the evidence, a cost, a recurrence, a confidence, and optionally a
proposal and a question for the human. Lessons are local to the workspace; what may be
global is where a *fix* belongs, decided at hand-over.

**Evidence.** `{ session, steps }` entries: which session, which step range in its log.
The log is kept on disk while the lesson is open precisely so a range resolves to real
records. A range is replaced only by a non-empty one. Evidence a lesson carried when it left
the open set — decided or evicted — is marked `released`: no open lesson kept those logs, so
they may be gone, and a lesson that comes back keeps them as history rather than offering
them to the reviewer as something to read.

**Recurrence.** The number of *independent* sessions the problem appeared in. Reading one
session twice is one session: evidence is keyed by session, and a second read updates the
step range and nothing else.

**Score.** `cost × recurrence × confidence × freshness`, where freshness halves every
`halfLife` sessions since the problem was last seen — counted in sessions, not days. The
session count advances when a session's turn ends, so a lesson drawn from a session still
running is stamped with the count before that session, and is aged by it when it ends.

**Open.** `status: new` or `later`, in `lessons/`. What `/retro` chooses from. A lesson with
no `status` at all — a file typed by hand — is open too, rather than invisible.

**Decided.** `accepted` or `rejected`, in `archive/`. A decision is a record, not a
deletion.

**Evicted.** Pushed out of `lessons/` by the cap (thirty), into `archive/`, still
`status: new`. An eviction is not a decision: it is an open question that lost its seat.
A lesson the user marked `later` is never evicted, so a workspace with many of them can
stay over the cap rather than discard a question the user asked to come back to.

**Reopen.** An accepted lesson whose problem returns in a *different* session comes back
with `reopenedFrom: accepted` — the news that the fix did not hold.

**Restore.** An evicted lesson whose problem returns comes back as the open question it
was, with no `reopenedFrom` added by the eviction. If it already carried one from an earlier
reopening, that history stays.

**Never.** A rejected lesson does not come back, from either side: `state.rejected` is
told to the extractor and filters its answer, and the store refuses to reopen an archived
`rejected` lesson whatever the extractor says.

## Invariants

- A second session hitting the same problem adds evidence and increments recurrence; it
  does not create a second file.
  `the same lesson in a second session increments recurrence instead of duplicating`
- Reading the same session again moves nothing but the step range.
  `reading the same session again is not a second session`
  `a re-read without steps does not erase the range the lesson already cites`
  `a re-read restores a cap-evicted lesson when there is room, without counting the session twice`
- Colliding ids are two problems, not one merged; an explicit `matches` is one.
  `two different lessons with the same slug do not overwrite each other`
  `an explicit match to an open lesson merges into it, instead of creating its own id`
  `an explicit match to an archived lesson beats an unrelated open lesson with the same id`
- A lesson that comes back marks its earlier evidence as released, and the hand-over offers
  only evidence whose log is kept.
  `a lesson that comes back marks its earlier evidence as released, and does not send the reviewer to it`
- An accepted lesson that returns from another session is reopened as a failed fix.
  `a lesson that was accepted and comes back is reopened, because the fix did not hold`
- A rejected lesson never returns.
  `a lesson the user rejected does not come back from the archive`
- An evicted lesson returns as an open question, can be decided, and is not called
  concluded.
  `a lesson the cap evicted comes back as an open question, not as a failed fix`
  `a lesson the cap evicted can still be decided, and is not called already decided`
  `a cap-evicted lesson is not handed back as already concluded`
- A lesson the user asked to come back to is never evicted, even if that leaves the open
  set over the cap.
  `a lesson marked later is never archived out from under the user`
- A lesson with no status is open, so a hand-written file is not invisible.
  `a hand-written lesson with no status is open, not invisible`
- Two copies of one closed lesson in a single extraction reopen it once.
  `two copies of a closed lesson in one extraction reopen it once, not twice`
- Freshness decays in sessions: a lesson unseen for `halfLife` sessions scores half.
  `a lesson that has gone unseen for a while says so, in sessions not days`
  `freshness halves the score every half-life of sessions without a recurrence`
  `freshness is measured in sessions, so a lesson seen this session is at full weight`
- The lessons already decided from a session are told to the extractor, so they are not
  derived again from the same material.
  `a second look at a session reads only what is new since the first`
  `lessons already concluded from this session are put in front of the extractor`
- Lessons extracted from a delegation before its parent was known keep their evidence
  when the delegation is folded into the root, at any depth, and the two count as one
  session.
  `lessons extracted from an orphan child keep their evidence when the child is folded into its parent`
  `evidence remapped into a middle delegation follows it into the root`
  `folding a delegation's evidence into its root counts the two as one session`

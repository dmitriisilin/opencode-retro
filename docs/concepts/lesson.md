# Lesson

## Definitions

**Lesson.** One file in `lessons/`, keyed by *problem*, not by session: a statement of
what went wrong, the evidence, a cost, a recurrence, a confidence, and optionally a
proposal and a question for the human. Lessons are local to the workspace; what may be
global is where a *fix* belongs, decided at hand-over.

**Evidence.** `{ session, steps }` entries: which session, which step range in its log.
The log is kept on disk while the lesson is open precisely so a range resolves to real
records. A range is replaced only by a non-empty one. When a lesson that left the open set —
decided or evicted — comes back, the evidence it carried then is marked `released`: no open
lesson kept those logs while it was away, so they may be gone, and the lesson keeps them as
history rather than offering them to the reviewer as something to read.

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

**Reopen.** An accepted lesson whose problem returns in a *different* session, **after the
decision was taken**, comes back with `reopenedFrom: accepted` — the news that the fix did
not hold, or not all of it. It says what the session that brought it back found: its
statement, proposal, ask and narrative are that reading's, since what is wrong now is what a
person has to act on. What was decided before is not written over but kept, oldest first, in
`decisions` — each with its status, when, the statement, proposal, ask and narrative it was
about, and the note, the session it was decided in, the files changed and what was found on
the way — and the
hand-over shows it. *The stranger's hour after the ten rounds found the old form: a lesson
reopened over the part of it that was not fixed still said the part that was had failed,
and the second decision wrote over the first.*

**Stale evidence.** The same problem reported from a session that ran *before* the decision.
Discarded, and named in the outcome. A backlog is the normal case — `/retro`, accept,
integrate, and the next command analyses the logs that were waiting behind it, written before
the fix and into the same trap — so without this, one fix is reported as having failed once
per waiting log. When the friction happened is read from the log itself (`seenAt`): the
latest record inside the cited range `[first, last]`, or inside the whole log when nothing is
cited — never past the last step its order covered, since what the session wrote after the
order was not what the reader was sent. Nothing inside the range is no date, and evidence with no date reopens, because nothing says it is
old and putting a lesson to a human twice costs less than dropping one.

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
- The extractor is told that a recorded problem met again is reported again, with `matches`:
  already recorded is not already answered, and recurrence is counted only that way.
  `a problem already recorded is asked for again, with matches, when it recurs`
- Checking or applying a lesson after it was handed over is its review, not a recurrence:
  the extractor is told not to count it, or every reviewed lesson would climb for having been
  looked at. Found on the friction bench, where one review added a recurrence and 19 steps of
  cost to the lesson it was checking.
  `the review of a handed-over lesson is not counted as the problem recurring`
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
- An accepted lesson that returns from another session, after the decision, is reopened as a
  failed fix; the same problem reported from before the decision is discarded and named.
  `a lesson that was accepted and comes back is reopened, because the fix did not hold`
  `a reopened lesson says what is wrong now, and keeps every decision taken on it`
  `a lesson that came back is handed over with what was decided before`
  `a lesson that comes back with no fix named does not bring back the fix already made`
  `a lesson that comes back aimed at another file is measured against that file`
  `a lesson reopened by a reader that told no story keeps no story from before`
  `a fix named for the first time after a reopening is measured against its own file`
  `a kept proposal that names no file is not measured against a file another reading named`
  `a decision's several-line proposal stays inside its item in the hand-over`
  `evidence from before a fix does not reopen it, and evidence from after does`
  `undated evidence reopens a decision, because nothing says it is old`
  `evidence is dated by the range it cites, not by whatever came after it in the log`
  `a recurrence after the fix inside the cited range reopens the lesson`
  `evidence that cites no steps is dated by the whole log`
  `evidence that cites no steps is dated by what its order covered, not by what came after it`
  `evidence is dated by what its order covered, not by how far the reader says it got`
  `evidence citing only steps the log does not have is undated, and reopens`
- What a human has already fixed is named in the order, with the time, to the minute, so the reading is not
  spent re-deriving an answered problem.
  `problems already fixed are named in the order, with the date they were fixed`
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
- An evicted lesson is archived with `status: new`, a hand-written one with no status
  included, so its return is a restore and never a reopened decision.
  `a lesson with no status that the cap evicts is archived as an open question`
- A lesson with no status is open, so a hand-written file is not invisible.
  `a hand-written lesson with no status is open, not invisible`
- A file in `lessons/` or `archive/` that does not read as a lesson — a frontmatter broken
  by a stray edit — is the user's: never written over, moved or removed, and named in the
  self-check, since `/retro` cannot see it.
  `a file that does not read as a lesson is never written over, and is named`
  `a lesson file broken by hand is left as the user left it`
- A new lesson's id is free in `lessons/` and `archive/` alike, by id and by file name, so
  closing it can never write over a decision already recorded.
  `a new lesson never takes an id the archive already holds`
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

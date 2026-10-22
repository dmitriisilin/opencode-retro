---
prompt: propose
base: 8
---

A lesson from an earlier session in this project is about to be handed to the human. You
are the one who hands it over.

## First: is it still true

**Is this already resolved in this workspace as it is now?**

A lesson can sit for weeks. You have the repository, its history, and whatever skills and
instructions this project carries — check however you normally would. The lesson itself
tells you when it was recorded and whether its target file has moved since, which is enough
to bound the check.

- If it is resolved, say so plainly, say in one line what settled it, and record it as
  accepted. Do not relay a proposal for a problem that no longer exists.
- If it is partly resolved, say which part still stands.

## Then: where does the fix belong

The lesson may name a target. Treat that as a guess made without looking: it was written by
a model that saw the session log, not this workspace. Check the surroundings before
accepting it.

Work out what this setup actually has:

- Which instruction files does the harness read here? There may be one at the project root,
  others nested in subdirectories, and one in the user's global configuration.
- Where do skills live in this workspace, and are there any? Project-level and global
  skills may both exist, or neither.
- Is there a more specific place than a general instruction file — a skill that already
  covers this task, a directory-scoped instruction, a tool definition?

Then pick, and say why:

- **Amend an instruction file.** For a fact or a constraint that applies broadly.
- **Amend a skill.** When a skill gave the wrong steps, or fired when it should not have.
  Add the precondition rather than deleting the skill, unless the skill has no business
  existing here.
- **Create something that is missing.** A skill for a task done repeatedly by hand, or an
  instruction file scoped to the directory where the rule actually applies. A lesson is not
  limited to editing what already exists.
- **Ask for a tool.** When the gap is a missing capability, write it up as a request with
  the cost it has already caused, rather than working around it.
- **Change the code.** When the trap is in the project itself and removing it is the real
  fix. Say so, and never apply this without explicit agreement.
- **Leave it unplaced.** If the right home is genuinely unclear, say that. It is a useful
  answer.

Local or global is part of the same decision. Friction about this repository belongs in this
repository. Friction about how this person works everywhere — their tracker, their branch
names, a convention they carry between projects — belongs in their global harness, because
fixing it here leaves it broken in every other project. Never edit anything outside this
project without asking first.

## Then: hand it over

Relay it: what the problem is, where the fix would go and why there, and what it needs from
them. Answer their questions. If they ask, show the lesson verbatim.

The lesson's evidence names a session log and a range of steps in it, and that log is still
on disk in the plugin's `sessions/` directory (`.retro/sessions/` by default). If they want
to know what actually happened — not the summary of it — read those steps and tell them. The
log is kept precisely so that question has an answer; it is removed only once the lesson has
been decided.

**Change nothing until they have decided.** If they want it, make the change here, in this
session, the way you would make any change. The lesson's `change` field is prose, not a
patch — read the target and do the right thing rather than applying the wording literally.

When they have decided, record it with the `retro_decide` tool. It is already available in
this session: there is nothing to install or look for on disk, and no command to find.

Use `accepted` if the change was made or the problem was already settled, `rejected` if it
is wrong for this project — give the reason, and it will not be proposed again — or `later`
to be asked another time. Recording the same decision twice is harmless; the tool will say
it was already recorded.

Record what actually happened, not what was proposed:

- `changed`: the files you really touched. These are often not the ones the lesson named.
- `discovered`: anything that came out of doing the work and is not in the lesson — a
  consequence the proposal missed, a second place needing the same fix, a reason the obvious
  fix was wrong. This only exists because the work happened; if it is not recorded here it
  is lost when this session ends.

Do this as the last step, before you move on. It is the only part of the review the plugin
cannot do for itself: if the decision is not recorded, the same lesson is proposed again
next time, as if nothing had been done.

## If several lessons are listed, not one

Everything above applies to each of them. What changes is only the shape of the answer: the
human wants one plan, not a conversation per lesson.

- Answer the currency question for each, and carry only the ones that still stand. A lesson
  that is simply done gets said so and recorded as accepted now, not carried into the plan.
- Give the order you would do them in, and group anything touching the same file together,
  so it is one edit and not three.
- Name the ones you dropped, one line each on why.
- List the global ones separately. They affect every other project, so they need approval of
  their own.
- Call out anything that needs a decision only the human can make. Do not guess at those.
- If two lessons disagree with each other, say so rather than quietly picking one.
- Keep it short enough to read in one go.

Change nothing until the plan is approved. Then work through it and record each lesson as you
go, rather than all at the end, so an interrupted run does not lose what was already
settled.

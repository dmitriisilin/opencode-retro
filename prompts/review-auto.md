---
prompt: review-auto
base: 4
---

Every lesson this project has waiting is listed below, highest score first. The human wants
one plan, not a conversation per lesson.

**For each one, first answer: is it already resolved in this workspace as it is now?**

You have the repository, its history, and this project's own skills and instructions — check
however you normally would. Each lesson says when it was recorded and whether its target has
moved since.

Then come back with **one plan**:

- only the lessons that still stand, in the order you would do them;
- what you would change in each file, concretely;
- anything that touches the same file grouped together, so it is one edit and not three;
- the ones you dropped, named, with one line each on why — if a lesson is simply done, say so
  and record it as accepted now rather than carrying it into the plan;
- where each fix belongs. A lesson may name a target, but that was a guess made without
  seeing this workspace. Check what this setup actually has — which instruction files the
  harness reads here, whether skills exist at project or global level, whether something
  more specific than a general instruction file already covers the task — and say why you
  chose the place. Amending an existing file, amending a skill, and creating a skill or a
  scoped instruction file that does not exist yet are all available;
- which of them are global rather than local. Friction about how this person works
  everywhere belongs in their global harness, because fixing it here leaves it broken
  elsewhere. List those separately: they affect every other project and need explicit
  approval of their own;
- anything that needs a decision only the human can make, called out separately. Do not
  guess at those.

Keep the plan short enough to read in one go. If two lessons disagree with each other, say
so rather than picking one quietly.

**Change nothing until the human approves the plan.** Once they do, work through it and
record each lesson with the `retro_decide` tool as you go, so an interrupted run does not
lose what was already settled. The tool is already available in this session — nothing to
install or look for — and recording the same decision twice is harmless.

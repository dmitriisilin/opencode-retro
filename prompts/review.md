---
prompt: review
base: 3
---

A lesson from an earlier session in this project is about to be handed to the human. You
are the one who hands it over.

**First answer one question: is this already resolved in this workspace as it is now?**

A lesson can sit for weeks. You have the repository, its history, and whatever skills and
instructions this project carries — check however you normally would. The lesson itself
tells you when it was recorded and whether its target file has moved since, which is enough
to bound the check.

- If it is resolved, say so plainly and in one line say what settled it, then record it as
  accepted. Do not relay a proposal for a problem that no longer exists.
- If it is partly resolved, say which part still stands.

Otherwise relay it: what the problem is, what is proposed, and what it needs from them.
Answer their questions about it. If they ask, show it verbatim.

**Say where the fix belongs.** Most lessons are about this project and the change goes in a
file here. But some are about how this person works everywhere — their tracker, their
branch names, a convention they carry between repositories — and fixing those in one project
leaves them broken in the rest; those belong in the global harness
(`~/.config/opencode/AGENTS.md`, or a global skill). The lesson may already name a target;
check whether it picked the right side. Ask yourself whether the lesson would still be true
in a different repository, and if the answer is yes, say so. Never edit anything outside this
project without asking first — a global change affects every other project they have.

**Change nothing until they have decided.** If they want it, make the change here, in this
session, the way you would make any change. The proposal is prose, not a patch — read the
target file and do the right thing, rather than applying the wording literally.

When they have decided, record it with the `retro_decide` tool. It is already available in
this session: there is nothing to install or look for on disk, and no command to find.

Use `accepted` if the change was made or the problem was already settled, `rejected` if it
is wrong for this project — give the reason, and it will not be proposed again — or `later`
to be asked another time. Recording the same decision twice is harmless; the tool will say
it was already recorded.

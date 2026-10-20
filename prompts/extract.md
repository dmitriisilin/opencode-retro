---
prompt: extract
base: 3
---

You are reviewing one coding session that has just finished. You were not in it. The agent
that ran it is not here to defend its choices, and you are not here to grade it.

Answer one question:

**If this session ran again from the same starting point, what should change in the project
so that it goes shorter and straighter?**

The thing that changes is the *harness* — the files the agent reads and the tools it has:

- a skill that gave bad instructions, or fired when it should not have;
- an `AGENTS.md` claim that is not true of this project;
- a missing tool, or a command nobody can run;
- a convention the agent could not have known and had to be told.

## What counts

Look for work that produced nothing. The log is a list of numbered steps; read it for these
shapes, and when you find one, ask what in the project made it happen.

**The same call made again with nothing changed in between.** Retrying a command after an
edit is ordinary work. Retrying it when no file changed between the attempts is the agent
hoping the world moved on its own, and usually means it had no way to find out what was
actually wrong.

**An edit made and then undone.** Either a later edit removes the lines an earlier one
added, or a `git checkout -- .`, `git restore`, `git reset --hard` or `git stash` throws away
work this session did. Everything between the two is time spent for nothing.

**A skill followed into a dead end.** A `skill` call puts the skill's own text into the log,
commands and all. If something the skill told the agent to run fails afterwards — however
many steps later, and with unrelated work in between — the skill is the thing to fix, and
its directory is in the call's result.

**A failure that does not look like one.** A shell step reports `exit 2` while its status is
still "completed". Read the exit codes, not the statuses: in this log a non-zero exit is the
only mark a failed command leaves.

**A task quietly dropped,** or an answer that ends in "I could not", "this is not possible
right now", "I skipped". Nothing in the log marks these — they exist only in what the agent
wrote, which is why you have every message in full.

**A correction the user had to make.** A prompt that contradicts what the agent just did,
and especially one the user has clearly had to repeat. The fix is rarely "the agent should
have known" — it is that nothing in the project told it.

This list is a place to start, not a checklist. A stretch that matches one of these may be
perfectly fine, and the real lesson may be somewhere none of them point.

## What does not count

- The agent's reasoning, tone, or style. Only what the harness made it do.
- Anything you cannot point at a specific stretch of this log for.
- A fix to the code it was asked to write. That was the task, not a lesson.
- Restating a lesson that is already listed below. Match it instead.
- Advice that would be true of any project anywhere. If it does not name something in
  *this* project, it is not a lesson.

One session usually contains zero or one lessons. Two is unusual. If the session went
straight, say so with an empty list — that is the common case and the right answer.

Prefer naming the problem over guessing the fix. A lesson with no proposal is useful; a
confident proposal aimed at the wrong file is not.

## Whose problem is it

If you do propose a fix, say which harness it belongs to.

Most friction is about **this project**: a skill that does not fit it, an instruction that is
not true here, a command that does not exist in this repository. The target is a file in the
project.

Some friction is not about the project at all — it is about how this person works wherever
they work: how they deal with their issue tracker, how they want branches named or commits
written, a convention they clearly carry between projects. The target is then their global
harness (`~/.config/opencode/AGENTS.md`, or a global skill), and you should say so, because
fixing it in one project leaves it broken in the rest.

The test is simple: would this lesson still be true in a different repository? If yes, it is
not a lesson about this one. Say which you think it is; the human decides.

The output format is appended automatically by the plugin. Run `/retro check` to see it.

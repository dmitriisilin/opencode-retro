---
prompt: extract
base: 1
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

Look for work that produced nothing: a command retried with nothing changed between
attempts, an edit made and then undone, a skill followed into a dead end, a task quietly
dropped, a correction the user had to make twice.

The anchors below point at stretches of the log a cheap detector already found suspicious.
They are hints with evidence attached, not a list of answers. A stretch may be fine, and
something they missed may be the real lesson.

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

The output format is appended automatically by the plugin. Run `/retro check` to see it.

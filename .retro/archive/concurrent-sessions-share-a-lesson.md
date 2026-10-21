---
id: concurrent-sessions-share-a-lesson
statement: A lesson stays "undecided" while it is being reviewed, so /retro can hand the same lesson to a second session and nothing in the hand-over or the checkout tells either agent that another one is already verifying and editing the same files.
evidence:
  - session: ses_ea2ab02f8ffeNFJ5mN3ttZfJcr
    steps: [1, 9]
  - session: ses_ea28d6c8fffeZDDJFiEiAISzWg
    steps: [50, 57]
cost: 18
recurrence: 2
confidence: 0.55
proposal:
  target: prompts/propose.md
  change: "Add a step 0 to the hand-over rule: before anything else, run `git status`. If files you did not touch are modified, or a commit you did not make appears while you work, another session is on this checkout or this lesson — name it, stop, and ask the human instead of editing or re-verifying."
ask: "Is a prompt-level check enough, or should the plugin record `proposed: { session, at }` in the lesson frontmatter and refuse to hand the same lesson to a second session while that marker is fresh? The second is the real fix but it is code, and the prompt is a one-paragraph edit."
status: rejected
lastSeen: 21
recordedAt: 2026-10-21T07:46:59.310Z
targetFingerprint: cd040389a2c67e2c
note: "The premise does not hold here: the owner does not work in two sessions at once. Sessions accumulate open in a workspace and one is picked up at a time, so the plugin handing a lesson to a second session while the first still has it is not a situation that arises. Warning about it would cost a frontmatter field and a line of hand-over for nothing."
discovered: "The real problem next to it was the opposite one, and the owner named it: the same *log* being read again, not the same lesson being handed out twice. With sessions left open and never finished, a log is never settled, so `/retro` weeks later re-read all of it and re-derived lessons that had already been integrated — and the store reopened them as though the fix had not held. Fixed in ef00929 with a step mark the analysis starts from, a rule that a re-read of one session is not a recurrence, and the archived lessons from that session handed to the extractor. The half of this lesson that was worth keeping was its smaller half: a decision now records `decidedIn`, the session it was taken in."
closedAt: 2026-10-21T12:35:44.150Z
---

The second block of the log opens on a tree the session did not dirty (`M AGENTS.md`, `M test/consistency.test.js` at [1]), and steps [2]–[5] are spent working out whose changes they are: the diff of `test/consistency.test.js` adds a comment naming `agents-md-drift-not-guarded`, the very lesson this session was handed. Step [7] quantifies false positives and checks for a live session, step [8] enumerates which `/retro` spellings exist, and step [9] finds an `opencode2 run --auto` process — a live dogfooding run that had been given the same lesson and was applying it. The same interference is already visible in the first block: at [20] a commit (`c6fc5eb`) the agent did not author appears mid-read, at [33]–[34] it runs `pgrep -af opencode` and diffs author vs committer dates and the reflog to decide whether another agent is active, and the hand-over at [51] closes with "another session committed into it while I was reading". So the lesson was verified twice, in parallel, and one session's recommendation arrived after the other had already begun the edit. AGENTS.md's dev-environment bullet already warns that a live test can edit the plugin and says commit first and check `git status` before and after — it knows this hazard exists but scopes it to losing uncommitted work, not to two sessions holding the same lesson at once, and nothing in the hand-over asks the receiving agent to look.

---
id: release-audit-parts-share-one-tree
statement: The pre-release audit is split into three parts that all edit README.md, its four translations and index.js, but nothing in the project says the parts must not run concurrently in the same working tree or how to tell another pass's edits from your own.
evidence:
  - session: ses_ea37a69b9ffeWaE6XgHeUf6t4c
    steps: [20, 28]
  - session: ses_ea37a68b0ffeNMpIBCv3c2vJMM
    steps: [46, 77]
cost: 20
recurrence: 2
confidence: 0.85
proposal:
  target: AGENTS.md
  change: "In the Release section, add: the pre-release audit runs as three parts that overlap on README.md, the four translations and index.js, so they must not run concurrently in one working tree — run them one after another, or give each a worktree. If the tree is already dirty before you start, run `git status` and read the file mtimes before editing: an `edit` that fails to find its oldString, or a hunk in `git diff` you did not write, is another pass working beside you. Leave those changes alone and do not count them as your findings."
ask: Should the three audit parts be made strictly sequential, or is a worktree per part the intended pattern?
status: new
lastSeen: 5
recordedAt: 2026-10-21T04:01:27.229Z
targetFingerprint: 94871a247ea45394
---

The session was 'part 2 of 3'. At [20] an edit failed with 'Could not find oldString' because README.md had changed under it, and [22] re-read the file to recover. At [26] `git status` showed eight modified files, three of which this session never touched (publish.yml, index.js, test/package.test.js), and the agent ran `ls -l --time-style=full-iso` plus `date` to establish which changes were its own. [28] then spent a diff on those foreign files to see what the other pass had done, and [180] and [284] repeated the timestamp check. The final report says plainly that another release-prep pass was editing the same tree and that three of its findings had already been fixed by it — audit effort spent on claims being corrected simultaneously in the same files. Nothing in AGENTS.md warns about this; `worktree_create` exists and was never suggested.

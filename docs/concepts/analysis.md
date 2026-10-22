# Analysis

## Definitions

**Analysis.** One model call over one session's log, in a session of the plugin's own —
no agent, no tools, no history — asking: *if this session ran again, what should change
so it goes shorter and straighter?* The criteria are the user's, in
`.retro/prompts/extract.md`; the output format is the plugin's, appended at call time.
The session is created for the call and removed after it, and it runs through
`session.generate` rather than `generate.text`, which refuses OpenCode's free-tier models.

**Projection.** The log rendered as text for the model. Prompts, hand-overs and assistant
text in full up to a few thousand characters each; tool output trimmed; tool calls and
steps one line each. Deterministic: the same records always project the same way.

**Capture clamp.** Tool output is already clamped head-and-tail to `maxOutput` (8,000
characters by default) when the record is written, with the loss stated in the record. The
log is therefore an excerpt of a very large result before the projection ever sees it; the
projection may trim it again.

**Budget.** The most characters one analysis may send, `maxInput`. The log gets what is
left after the prompt, the contract and the lesson lists, and the composed input never
exceeds it except when the fixed part alone does (see the floor below). It is a bound on
cost, **not** a guarantee of an answer: on the model this was built against, an empty reply
is more likely the larger the input, and has been observed at 40,254 characters, at 31,993
and at 19,181 — the same content answered at 26,034 and 32,034 on other occasions. No
number is safe; the empty reply is handled by the retry, not by the budget. Those fixed parts are not negotiable: if
they alone exceed `maxInput`, no request can honour it, so a small (2,000-character) log
section is still sent rather than none, and the request goes over the budget by that floor.
The guarantee therefore applies whenever the fixed part fits, which is every normal run.

**Excerpt.** A projection that had to drop something to fit. It drops in the order that
loses least — less tool output, then whole tool steps from the middle outward, then
shorter prompts — and never drops a prompt, a hand-over or an assistant reply entirely.
Every gap says how many steps went, so the model knows it is reading an excerpt and so
does the human (`from an excerpt` in the outcome).

**Coverage (`through`).** The last step of an excerpt's unbroken prefix. An excerpt keeps
a head and a tail with a gap between; it *covers* only the head. The mark advances to the
coverage, never to the last step seen, so the gap is read next time rather than skipped.
A projection that covers no step past the mark has covered nothing new: it is a failed read,
not an excerpt.

**Attempt.** One analysis of one queued log. A log gets three *on the same input*; a
successful excerpt is progress, not an attempt, and a log that grows is a different input —
the count starts again, because the cap exists so a fourth try does not pay for the same
answer, and new material has not failed anywhere yet. After three failures the log is retired: its outcome recorded
as failed, the log kept on disk, and the self-check names it. Retirement is decided before
the queue is scanned, so a log that has grown since the third failure is new work and is
read in the same command rather than waiting for the next one.

**Limit (`extractLimit`).** The most analyses one command attempts. Unlimited by default.
It counts attempts rather than successes, because a failed attempt is what costs a model
call; a log skipped as one exchange never reaches the model, so it does not spend one.
Whatever is left stays queued and is named in the command's message.

**Auto-extraction (`autoExtract`).** Off by default. Nothing is analysed without a command.
When on, the next queued log is analysed at the next prompt instead — one per prompt, so a
backlog of four costs four prompts and never an unbounded spend in a hook. Only one of
these runs at a time: a prompt that arrives while an analysis is in flight does not start a
second.

**Empty reply.** This model's way of declining an input, more often the larger it is. It
is answered by halving the budget and asking again, and once more at a quarter if the
second reply is empty too — at most three calls, each changing the one thing that
correlates with the failure. A log that cannot be answered at a quarter of the budget is
reported as a failure with the model's own silence as the reason, and the attempt counts.
A caller with no finite budget has nothing to halve, so there an empty reply is reported
rather than retried.

**Skipped.** A session of one prompt and no tool calls is not analysed: it cannot hold
evidence of anything. Everything else is, including a conversation that ran no tools —
that is where a wrong instruction file shows up. On a re-read the rule is about what is
*new*: a new reply is material even with no prompt and no tool call of its own, while a
slice that is nothing but the prompts it carries, a hand-over the plugin wrote itself, or
an end marker, still proves nothing.

## Invariants

- Tool output is clamped head-and-tail when captured, and says how much went missing.
  `output is clamped head-and-tail with the loss stated`
- The composed input never exceeds `maxInput` when the fixed part fits; the log takes the
  rest and is cut to fit. When the fixed part alone is over budget, no request can be
  bounded, and the smallest useful log is sent rather than none.
  `the composed input stays inside maxInput, and says when it had to`
  `prompts are shortened before a projection is allowed over budget`
  `a budget that leaves no room for the log still leaves room for the log`
- An excerpt loses tool output before it loses steps, and steps from the middle before
  the ends; prompts and replies are never dropped.
  `a log over budget loses tool output before it loses steps`
  `when trimming is not enough, steps go from the middle and the gap says how many`
- Step numbers are left alone in an excerpt, so evidence still points at real steps.
  `the numbering is left alone, so evidence still points at real steps`
- An excerpt reports how far it covers, not how far it looked.
  `an excerpt reports how far it actually goes, not how far it looked`
  `a truncation reports only the steps that survived the cut`
- A projection that covers no step past the mark is a failed read: it is reported, never
  settled as done, and charged against the attempt budget when the log is queued.
  `an excerpt that cannot reach past the mark is reported, not settled as done`
- An empty reply is answered by asking again with less, at half and then at a quarter,
  and never more than that.
  `an empty reply is answered by asking again with less, not by asking again`
  `an empty reply with nothing left to trim is reported, not retried for ever`
  `a second empty reply is answered once more, at a quarter of the budget`
- A failed log is tried again on the next command, and given up on after three.
  `a log that failed stays queued, and is tried again on the next command`
  `a session is given up on after three attempts, not billed forever`
- One failing log does not hold up the ones behind it, and both commands report it.
  `a log the model could not answer does not hold up the logs behind it`
  `/retro all reports a log it could not analyse, as well as the plan`
- An entry that used its three attempts is retired and reported, never silently skipped.
  `an entry that used its three attempts is retired and reported, not skipped for ever`
  `a log given up on after three attempts is not retried in the same command`
- One command makes at most `extractLimit` attempts; the rest stay queued and are named.
  A skipped log makes no attempt, because there is no model call to bound.
  `extractLimit caps what one command analyses and leaves the rest queued`
  `the per-command log limit is unlimited by default and can be capped`
  `a log skipped as one exchange does not spend the command's limit`
- With `autoExtract` the next queued log is analysed at the next prompt; without it, only
  a command analyses anything.
  `autoExtract analyses at the start of the next session, and is off by default`
- The model is `options.model` when set, otherwise the one the user's own session is
  running on (learned from primary model requests — a subagent's or the analysis session's
  do not set it), otherwise the workspace default; with none of them the analysis refuses
  and names the remedy.
  `the model the user is actually working with is the one used for analysis`
  `with no model configured, the workspace default is used`
  `a workspace default that cannot be read refuses with the remedy, not a hang`
- A skip covers nothing: a session skipped as one exchange is read from its start once it
  does real work.
  `a session skipped as one exchange is read from its start once it does real work`
- Attempts belong to the input they were spent on; material that arrives after failures
  gets attempts of its own.
  `material that arrives after failures gets attempts of its own`
- One command reads each log at most once, whatever the outcome, so a command always ends.
  `a log replaced by a smaller one is settled, and one command reads it once`
- A session of one prompt and nothing done is skipped; anything more is read. On a re-read
  the question is what is *new*: a new reply is material even with no prompt or tool call,
  while a slice that is only the prompts it carries proves nothing.
  `a conversation with no tool calls is still analysed`
  `a single exchange that did nothing costs no model call`
  `a re-read with a reply is analysed even when it has no prompt or tool call of its own`
  `a re-read of a session that did work is analysed even when the new material is a reply alone`

# Analysis

## Definitions

**The shape of the work.** Delegated, not interactive: the person asks for a retrospective
and comes back for the result, and nothing in it is tuned for an answer within seconds. The
plugin is written for throughput — how much gets read, and how well — not for latency.

**Analysis.** One subagent, reading one work order, asking: *if this session ran again,
what should change so it goes shorter and straighter?* The agent in the session `/retro` was
run in starts it, so it runs on that session's model and that session's settings — reasoning
included — with OpenCode's own agent loop, and in a context of its own: it was not in the
session it reads, and has nothing of its own to defend. The plugin makes no model call and
chooses no model. *Replaces a one-shot `session.generate` in a session of the plugin's own,
with a model and a variant the plugin picked. That call returned only text, so a reasoning
model that spent its output on reasoning came back empty with no way to see why; and a
variant chosen by name does not mean the same thing on every provider (AGENTS.md decision
5, Gotcha 17).*

**Work order.** What one analysis is asked to read: a file, `work/<session>.md` in the
plugin's directory, holding the criteria (`prompts/extract.md`, the user's), the lessons
already recorded, concluded from this session and rejected, the projection of the log from
its mark, and what to do with the answer. The plugin remembers each order it issued — the
log's identity, the size it was read at, and how far the projection covers — so a record
is applied to exactly what was read. An order is reissued by the next `/retro` while the log
is still owed; a record answers only the order it was issued for.

**Record.** The answer, given by calling `retro_record` with the session and its lessons.
The tool's schema is the output contract: a malformed answer is refused by OpenCode before
it reaches the plugin, and the subagent is told why and can try again. A record with no
lessons is an answer — the session went straight.

**Late record.** A record that arrives after its round was closed. Calling `retro_propose`
is how the agent says the analyses are done, so an order still open then is charged as a
failed attempt — the plugin cannot tell a subagent that died from one still reading, and
will not guess with a clock. Which makes calling it early possible, and so a record for an
order settled that way is still applied, against the coverage of the order it answers, and
the attempt is given back. Only `unanswered` reopens: an order already answered must not be
answered twice, and one voided because its log was replaced is about a session that is gone.

**Projection.** The log rendered as text for the work order. Prompts, hand-overs and
assistant text in full up to a few thousand characters each; tool output trimmed; tool calls
and steps one line each. Deterministic: the same records always project the same way.

**Capture clamp.** Tool output is already clamped head-and-tail to `maxOutput` (8,000
characters by default) when the record is written, with the loss stated in the record. The
log is therefore an excerpt of a very large result before the projection ever sees it; the
projection may trim it again.

**Budget.** The most characters one work order may hold, `maxInput`. The log gets what is
left after the criteria, the instructions and the lesson lists, and the order never exceeds
it except when the fixed part alone does (see the floor below). It bounds what one subagent
is asked to read, which is what it costs. Those fixed parts are not negotiable: if they
alone exceed `maxInput`, a small (2,000-character) log section is still written rather than
none, and the order goes over the budget by that floor.

**Excerpt.** A projection that had to drop something to fit. It drops in the order that
loses least — less tool output, then whole tool steps from the middle outward, then
shorter prompts — and never drops a prompt, a hand-over or an assistant reply entirely.
Every gap says how many steps went, so the reader knows it is reading an excerpt and so
does the human (`from an excerpt` in the outcome).

**Coverage (`through`).** The last step of an excerpt's unbroken prefix. An excerpt keeps
a head and a tail with a gap between; it *covers* only the head. The mark advances to the
coverage, never to the last step seen, so the gap is read next time rather than skipped.
A projection that covers no step past the mark has covered nothing new: no order is issued
for it, and it counts as a failed attempt.

**Attempt.** One work order issued for one owed log. An order that was not answered by the
next `/retro` failed — the subagent was never started, ran out, or never called
`retro_record`. A log gets three *on the same input*, counted on its mark; a log that grows
is a different input and the count starts again. After three the log is retired (log.md):
its outcome recorded as failed, the log kept until it is quiet, and the self-check names it.

**Limit (`extractLimit`).** The most work orders one `/retro` issues. Unlimited by default.
Whatever is left stays owed and is named in the hand-over.

**Skipped.** A session of one prompt and no tool calls is not analysed: it cannot hold
evidence of anything, and no order is issued for it. Everything else is, including a
conversation that ran no tools — that is where a wrong instruction file shows up. On a
re-read the rule is about what is *new*: a new prompt, a tool call, or a reply to a person
is material, even a reply with no prompt of its own; a slice that is nothing but the
prompts it carries, a hand-over the plugin wrote itself and the agent's answer to it with
nothing done, or an end marker, still proves nothing.

**The plugin's own work.** The subagents it asks for and the calls to its own tools are its
work, not the user's: they are not written to any log, so an analysis is never analysed and
the plugin's bookkeeping never turns into a lesson about the plugin.

## Invariants

- Tool output is clamped head-and-tail when captured, and says how much went missing.
  `output is clamped head-and-tail with the loss stated`
- A work order never exceeds `maxInput` when the fixed part fits; the log takes the rest
  and is cut to fit. When the fixed part alone is over budget, the smallest useful log is
  written rather than none.
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
- A projection that covers no step past the mark is not issued, is reported, and is charged
  against the log's attempts.
  `an excerpt that cannot reach past the mark is reported, not settled as done`
- The plugin makes no model call: `/retro` issues work orders and hands them to the agent in
  its session, which starts one subagent per order.
  `/retro issues a work order per owed log and asks the agent to analyse them`
  `the plugin never calls a model itself`
- A record is applied to the order it answers, and to nothing else: a record for a session
  with no order, or for a log replaced since the order, is refused and changes nothing.
  `a record moves the mark to what its order covered`
  `a record with no order behind it is refused`
  `a record for a log replaced since its order is refused`
- A record with no lessons is an answer: the log is read, and the session went straight.
  `a record with no lessons settles the log as read`
- A record that arrives after its round was closed is still applied, and the attempt the
  log was charged is given back — unless its log was replaced since.
  `a record that arrives after its round was closed is still recorded`
  `a record is refused once its log was replaced, even if its round is still closeable`
- An order not answered by the next `/retro` is a failed attempt; three on the same input
  retire the log, and both commands report it.
  `an order nobody answered is a failed attempt, and the log is asked for again`
  `a log is given up on after three unanswered orders, not asked for forever`
  `/retro all reports a log it could not analyse, as well as the plan`
- One command issues at most `extractLimit` orders; the rest stay owed and are named. A
  skipped log takes no order.
  `extractLimit caps what one command analyses and leaves the rest owed`
  `the per-command log limit is unlimited by default and can be capped`
  `a log skipped as one exchange does not spend the command's limit`
- `retro_propose` hands over what the records made, after they are in.
  `retro_propose hands over the top lesson once the records are in`
  `retro_propose for all delivers the plan`
- The plugin's own subagents and tool calls are not written to any log.
  `the plugin's own analysis is not logged as the user's work`
- A skip covers nothing: a session skipped as one exchange is read from its start once it
  does real work.
  `a session skipped as one exchange is read from its start once it does real work`
- Attempts belong to the input they were spent on; material that arrives after failures
  gets attempts of its own.
  `material that arrives after failures gets attempts of its own`
- A session of one prompt and nothing done is skipped; anything more is read. On a re-read
  the question is what is *new*.
  `a conversation with no tool calls is still analysed`
  `a single exchange that did nothing takes no work order`
  `a re-read of a session that did work is analysed even when the new material is a reply alone`
  `a reply to the plugin's own hand-over, with nothing done, takes no work order`

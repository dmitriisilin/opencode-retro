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

**Work order.** What one analysis is asked for: a file, `work/<session>.md` in the plugin's
directory, holding the criteria (`prompts/extract.md`, the user's), **which log to read and
which part of it is new**, the lessons already recorded, concluded from this session and
rejected, and what to do with the answer.

It does not contain the log. It names it, absolutely, and the subagent opens it — that is
what read tools are for, and an agent decides better than any rule written out here whether
to read a log whole, from the head, or from the end. The plugin remembers each order it
issued — the log's identity, the size it was read at, and the last step in it — so a record
is applied to the log it was issued for and no other. An order is reissued by the next
`/retro` while the log is still owed.

*Replaces an order that carried a rendering of the log, compressed to fit one model call.
That brought a budget, a drop order, a floor, a coverage rule and a failure mode of its own
("the excerpt could not reach past the mark"), all to answer a question — how much of this
can I afford to show? — that only exists when the reader cannot turn the page itself.*

**One at a time.** When a round has several logs, the analyses are asked for in sequence,
each waiting for the one before it to record. They are not independent: a problem that
appears in several of those sessions has to be reported as one recurring problem rather than
as several new ones, and the only way an analysis can tell is by reading what the ones before
it recorded. The orders also name the lessons directory, because the list each one carries is
a snapshot taken when it was written.

*Measured on the friction bench, which is what it is for: with the analyses run in parallel,
three sessions that hit the same two traps produced five lessons under five ids with a
recurrence of 1 apiece — every order had been written before any of them recorded, so each
read "None yet". Recall was 4/4 and recurrence was 0, and recurrence is the strongest signal
in a lesson's score. Sequence costs wall-clock, which this is explicitly not tuned for.*

**Record.** The answer, given by calling `retro_record` with the session and its lessons.
The tool's schema is the output contract: a malformed answer is refused by OpenCode before
it reaches the plugin, and the subagent is told why and can try again. A record with no
lessons is an answer — the session went straight.

**Late record.** A record that arrives after its round was closed. Calling `retro_propose`
is how the agent says the analyses are done, so an order still open then is settled as
unanswered — the plugin cannot tell a subagent that died from one still reading, and will not
guess with a clock. Which makes calling it early possible, and so a record for an order
settled that way is still applied, against the coverage of the order it answers. Only `unanswered` reopens: an order already answered must not be
answered twice, and one voided because its log was replaced is about a session that is gone.

**Capture clamp.** Tool output is clamped head-and-tail to `maxOutput` (8,000 characters by
default) when the record is written, with the loss stated in the record. This is about the
log on disk, not about any analysis: a single 2 MB tool result would otherwise sit in the
log for as long as the log does. It is the one place the plugin still decides what an
analysis can see, and it decides it once, at capture, where the alternative is keeping
everything for ever.

**Coverage (`through`).** How far a log was read, **as the reader reports it**, and required
of every record: the plugin does not render what is read, so there is nothing on this side
that could know. Reading the log is the reader's job and so is saying how much of it it read.

A reader that got part way says so, the mark stops there, and the rest stays owed. Silence is
not "read it all": an unreported coverage leaves the step mark where it was and the log owed
now, so the lessons are kept and the log is asked about again. Assuming a full read would be
the one failure that loses material without anybody noticing, which is the failure this
plugin exists to end. (The schema requires it, so silence is a backstop rather than a path.)

It is clamped to the order's own range. A `through` past the last step would mark steps as
read that were not in the log when the order was written; one at or below the old mark says
nothing new was read at all, which is a failed attempt rather than a settled log.

**Asked.** An order issued for a log and handed to a session, counted on the order. A fact,
and the only thing the plugin knows about it: it wrote the order, and it asked. Nothing is
concluded from the asking.

**Unanswered.** No record came back by the time the next `/retro` runs. Reported, with how
many times this log has been asked about, and asked again. It is **not** held against the
log, because it says nothing about the log. There are two causes and the plugin cannot tell
them apart: nobody came — a hand-over into a session that is still working waits in its
inbox, so no subagent is started and nothing is spent — or a reader tried and could not
record. Guessing picked the wrong one: three rounds of nobody-came retired a perfectly
readable log under the words "given up after three failed analyses", when no analysis had
been attempted at all (cycle 9). So it does not guess. It says what it did — asked, *n*
times, no answer — and leaves the conclusion to the person reading the report.

*What this gives up: a log no reader ever manages to record is asked about again on every
`/retro`, one subagent each time. Each of those is an explicit command, and every one of them
says how many times it has asked, so the spend is requested and visible rather than capped by
a guess about whose fault it was.*

**Attempt.** A read the plugin itself could not complete: a log it cannot open, cannot parse,
or cannot write an order for. Observed, not inferred — which is why this one does count. A log
gets three *on the same input*, counted on its mark; a log that grows is a different input and
the count starts again. After three the log is retired (log.md): its outcome recorded as
failed, the log kept until it is quiet, and the self-check names it.

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
- An order points at its log and does not contain it, and it says which steps are new.
  `the work order points at the log instead of carrying it`
  `a second look at a session reads only what is new since the first`
  `an order with no log to point at is refused`
- A round with several orders asks for them in sequence, and every order says where the
  current lessons are, so a problem seen in more than one session is reported as recurring.
  `a round with several orders asks for them one at a time, and says why`
  `already-recorded lessons are shown so the reader matches instead of re-stating`
  `an order with nothing recorded yet still says where the lessons will be`
- The plugin makes no model call: `/retro` issues work orders and hands them to the agent in
  its session, which starts one subagent per order.
  `/retro issues a work order per owed log and asks the agent to analyse them`
  `the plugin never calls a model itself`
- `through` is required, and a record moves the mark only as far as it claims. Unreported,
  the log counts as unread: the lessons are kept and the log is owed now.
  `a record moves the mark to what the order asked for`
  `a log read in part is read again without growing, and is not pruned first`
  `a record that does not say how far it read leaves the log unread`
  `a record must say how far it read, because nothing else knows`
- A reported coverage no further than the mark is a failed attempt, not a settled log.
  `a read that got no further than the mark is reported, not settled as done`
- A record is applied to the order it answers, and to nothing else: a record for a session
  with no order, or for a log replaced since the order, is refused and changes nothing.
  `a record with no order behind it is refused`
  `a record for a log replaced since its order is refused`
- A record with no lessons is an answer: the log is read, and the session went straight.
  `a record with no lessons settles the log as read`
- A record that arrives after its round was closed is still applied — unless its log was
  replaced since. (A limit, not an invariant: if another `/retro` has already issued a new
  order for the same log, the late record satisfies the new one, and the new reader's record
  is then refused. Reaching it takes an early `retro_propose`, a second `/retro` and a slow
  reader still running at once; the cost is one analysis done again, never a lost log.)
  `a record that arrives after its round was closed is still recorded`
  `a record is refused once its log was replaced, even if its round is still closeable`
- An order not answered by the next `/retro` is reported with how many times the log has been
  asked about, and asked again. It never retires the log: the plugin does not know whether
  anybody came.
  `an order nobody answered is reported and asked again, not held against the log`
  `a log asked about many times is never given up on for it, and says how many`
  `/retro all reports a log it could not read, as well as the plan`
- A read the plugin could not complete is an attempt, and three on one input retire the log.
  A reader that reported reading nothing new is one of these — an answer that covered nothing —
  and is never also reported as no answer. A retired log is called the same thing everywhere,
  and nothing says it will be tried again.
  `a failed read is owed, and tried again on the next command`
  `a session is given up on after three attempts, not billed forever`
  `a reader that reported reading nothing new is not reported as no answer`
  `a log set aside is described in the same words everywhere it is reported`
  `the third read that covered nothing new says the log is set aside, not that it will be asked again`
  `nothing to review does not promise another try for a log set aside`
- What decides that a call or a session is the plugin's own is decided when it starts, and
  never again when it ends — per session and call id, and for a Code Mode wrapper the same as
  for what it wraps. A session a person types into is never taken for ours by anything short
  of the prescribed line — or, for a fresh session, the very prompt one of our own delegations
  is handing its reader at that moment, or a parent with a delegation of ours in flight and
  nothing of the person's in flight beside it.
  A call is remembered while it is in flight; one that never finishes is bounded, not swept
  with its turn, and an after-hook whose start was never seen is decided by what it says.
  `talking about work orders does not stop a session being logged`
  `a person who names an open order's path in a new session is still logged`
  `a reworded delegation of a work order stays out of the person's log`
  `a fresh session given the prescribed line is recognised as the plugin's own reader`
  `a reworded delegation's reader stays out of the person's log, in the order the events arrive`
  `a person's own delegation stays logged even if an order naming its path is issued while it runs`
  `own calls that never finish are bounded, so a later session quoting one is logged in the end`
  `an own delegation whose after-hook outlives its turn is still ours`
  `an own call run through Code Mode's execute is ours in both of its hook pairs`
  `a reader whose prompt reads nothing like the delegation is still recognised by its parent`
  `a person's call is not taken for ours because one of ours elsewhere has the same id`
  `a call id reused in a later message of the same session is decided afresh`
  `a turn's end arriving late does not make the next turn's own calls the person's`
  `a child is not taken for a reader while anything of the person's runs beside our delegation`
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

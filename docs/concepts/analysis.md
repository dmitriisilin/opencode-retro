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
it recorded. So every order still waiting is rewritten after each record, its list of
recorded lessons brought up to date, and it also names the lessons directory, with how to open
it: by path, with a read tool — a file search does not look inside `.retro/`.

*Measured on the bench after the ten rounds: readers in sequence, and the third filed both of
its session's problems under new ids a minute after the first had recorded them. It had looked
with `glob ".retro/lessons/*"`, which came back "No files found" over four lesson files —
reproduced on 2.0.32 — and its order's list was the one written before anybody recorded.*

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
work, not the person's, and an analysis must never be analysed. Two kinds, handled two ways:

1. **A reader's session is not logged.** A fresh session whose first prompt starts with the
   prescribed line at its first column, or has it — indented or not — right after OpenCode's
   own first line ("You are a subagent…", which only a subagent's prompt starts with), is one
   of ours, and so is anything such a session starts. No
   deeper than that: a person pasting the hand-over, where the line sits indented inside it,
   is not a reader. Its whole job is reading
   other sessions' logs, so its own log would be copies of them. Recognised by the line alone,
   because a session is never taken for ours by anything less.
2. **Everything else is logged, and what is certain is named.** The plugin names as its own
   only what it knows to be: its hand-overs, its calls to `retro_record` and `retro_propose`,
   a `subagent` call whose prompt is a work order's line, and everything a reader did — a
   session such a delegation started, a delegated session that called `retro_record` (only a
   reader does), whatever those started, at any depth, and the delegation that started any of
   them, wherever in the log each of these lands. None of it can be the person's. The order
   names these steps and the reader leaves them out.
3. **The round is the reader's to recognise.** After a `handover` with `about: "work"`, until
   the person next speaks, what the agent does to start readers, wait for them and hand the
   results over is the plugin's too — but where that stretch begins and ends in a turn can only
   be guessed from the order of the log, and OpenCode does not guarantee it: events lag hooks
   and arrive twice, a turn's start goes unlogged, a prompt is steered into a running turn, a
   hand-over waits in the inbox, a send fails. So the contract describes the round and the
   reader, who sees the hand-overs and the prompts, judges it — keeping for the person
   anything their own task needed in that stretch.
4. **A guess is used only for cost, and kept narrow enough to be right**: whether a log that
   grew is worth an order, and — the same rule — whether a quiet log may go. Growth the order of
   the log shows to be the plugin's exchange takes no order: a turn that a `work` hand-over sent
   between turns resumed, to its end or until the person speaks in it — the only way a
   hand-over starts a turn, since one sent into a running turn waits and is not taken up when
   the turn ends (measured, cycle 9), so what that turn goes on with is the person's; and what
   the agent says after a hand-over of another kind, to the end of its turn or until the person
   speaks. Nothing is credited as read on a guess, and the person speaking always makes the log
   owed.

*Replaces two dozen review rounds of inferring the round from the order of the log, in three
functions and the contract's prose at once. Each round found an ordering the rules had not
met, the fix for it opened the next, and a wrong inference told a reader to skip the person's
work — the one failure that loses material unseen. The rule that cost nothing to get wrong
kept its guess; the rule that could lose a step stopped guessing (decision 4: judging a
stretch of log is the reader's job).*

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
  `an order still waiting lists the lessons a reader before it recorded`
  `an order's lesson list is found by its own marks, not by a heading the person may write`
  `a lesson that quotes the list's own mark does not multiply the list`
  `a rejection reason quoting the list's mark does not stop the list being brought up to date`
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
  asked about, and asked again — on the session's own line as in the stock, not as "waiting". It never retires the log: the plugin does not know whether
  anybody came. The count starts again only when the log grew by something to read — not by
  the plugin's own hand-overs and rounds, which lengthen the session `/retro` runs in every
  time — or is another file: a log pruned and written again under the same id was never asked
  about, whatever its size. And only askings nobody answered add up: one a record came back
  for — whole, partial or covering nothing — starts the count again.
  `an order nobody answered is reported and asked again, not held against the log`
  `the session's line reports an asking nobody answered, not just that the log waits`
  `a log asked about many times is never given up on for it, and says how many`
  `the askings add up in the session /retro runs in, which its own rounds lengthen`
  `the askings start again for a log replaced under the same id`
  `an asking that was answered is not counted among those nobody answered`
  `/retro all reports a log it could not read, as well as the plan`
- A read the plugin could not complete is an attempt, and three on one input retire the log.
  A reader that reported reading nothing new is one of these — an answer that covered nothing —
  and is never also reported as no answer. A retired log is called the same thing everywhere,
  and nothing says it will be tried again. One input is the log until it grows by something to
  read: the plugin's own hand-overs and rounds are no new input, here as for the askings.
  `a failed read is owed, and tried again on the next command`
  `a session is given up on after three attempts, not billed forever`
  `a reader that reported reading nothing new is not reported as no answer`
  `a log set aside is described in the same words everywhere it is reported`
  `the third read that covered nothing new says the log is set aside, not that it will be asked again`
  `reads that covered nothing add up in the session /retro runs in, and set it aside`
  `nothing to review does not promise another try for a log set aside`
- A reader's session is not logged; a session a person types into is never taken for one by
  anything short of the prescribed line, and what a reader starts is ours with it.
  `talking about work orders does not stop a session being logged`
  `a person who names an open order's path in a new session is still logged`
  `a fresh session given the prescribed line is recognised as the plugin's own reader`
  `a reader's helper is ours however it was told what to do`
- What is the plugin's for certain is logged and named, and the order tells the reader to leave
  it out; the round around it is described for the reader to recognise; and growth the log's
  order suggests is the plugin's exchange takes no order — a guess allowed there only, since a
  wrong one delays a read and never loses a step.
  `a round of the plugin's own is logged, and a log grown by nothing else takes no order`
  `the order tells the reader where the plugin's own work is and to leave it out`
  `what the plugin names as its own is certain, and never the person's work around it`
  `a growth that is the plugin's exchange takes no order, and a guess wrong that way loses nothing`
  `a hand-over that never arrived opens no exchange`
  `the contract names the certain steps and leaves the round to the reader`
  `a log is not pruned on a guess: work after a hand-over that nobody read is kept`
  `a session that ended with a /retro and its answer goes once it is quiet`
  `a stretch of the plugin's exchange lasts to the end of the turn it is taken up in`
  `the contract counts the plugin's stretches a reader left out as read`
  `a re-read names every one of the plugin's own steps, those before the mark included`
  `a reworded reader is folded into the person's log inside the round`
  `a reader whose prompt OpenCode prefixed with its own line is still not logged`
  `a delegation of ours written after an early retro_propose is still ours`
  `a reader that read everything but a trailing round has read it all`
  `a hand-over that could not be delivered is followed by a notice saying so`
  `a person who pastes the hand-over into a new session is still logged`
  `a person's first message quoting the work line after a blank line is still logged`
  `a reader whose delegation copied the indented line is still recognised`
  `a long first prompt is checked for the reader line in linear time`
  `a reader that read up to a trailing turn's end has read it all`
  `orders whose hand-over could not be delivered are voided, not reported as unanswered`
  `a turn that added only a round does not report its log as waiting`
  `a hand-over that was never delivered leaves the rest of the turn the person's`
  `the person speaking before a waiting hand-over's turn makes that turn theirs`
  `the contract says the agent's text answering a notice is not the session's`
  `a subagent started to answer a hand-over is the person's again in a turn after`
  `prompts posted into a running turn, queued or steered, are answered in that turn`
  `a /retro sent between the person's prompt and the turn it opens takes nothing of that turn`
  `a prompt that opens the next turn, after a turn whose end was lost, is the person's turn`
  `an undelivered notice cancels the hand-over it names, not the latest one`
  `a notice of a failed send names the hand-over by its step`
- `retro_propose` is not a delegated session's to call: a reader — known by its line or worded
  its own way — or any other subagent calling it is told so, with nothing recorded, nothing
  closed and no order removed; and `/retro` itself issues nothing in a delegated session, whose
  round could never be proposed. (Limit, AGENTS.md "Known": the plugin knows a session as
  delegated by what it has seen, so a reader calling before its creation is known, or after a
  reload, slips through.)
  `a reader calling retro_propose is told it is not its call, and nothing happens`
  `/retro in a subagent's session issues nothing`
  `a work hand-over noted for a subagent opens no round`
  `a session stays the plugin's across turns, so a turn resumed by a hand-over is logged from its start`
  `a subagent's text, delegated in answer to a plugin notice, is part of that reply`
  `a subagent of the person's already running when a hand-over arrives stays theirs`
  `a turn resumed by a hand-over that arrived in the previous turn is not a dead prompt hook`
  `a log pruned between turns starts its numbering again`
  `a reader started by a work order's line is the plugin's, recognised by its prompt or not`
  `a delegated session that recorded an analysis is the plugin's, wherever its prompt fell`
  `a subagent's prompt does not end a reply to the plugin's hand-over`
  `a reader's call to retro_propose writes nothing into any log`
  `a reworded reader calling retro_propose is told so too`
- One command issues at most `extractLimit` orders; the rest stay owed and are named. A
  skipped log takes no order.
  `extractLimit caps what one command analyses and leaves the rest owed`
  `the per-command log limit is unlimited by default and can be capped`
  `a log skipped as one exchange does not spend the command's limit`
- `retro_propose` hands over what the records made, after they are in.
  `retro_propose hands over the top lesson once the records are in`
  `retro_propose for all delivers the plan`
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

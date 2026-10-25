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
work, not the person's, and an analysis must never be analysed. Two kinds, handled two ways:

1. **A reader's session is not logged.** A fresh session whose first prompt starts with the
   prescribed line at its first column, or has it — indented or not — right after OpenCode's
   own first line ("You are a subagent…", which only a subagent's prompt starts with), is one
   of ours, and so is anything such a session starts. No
   deeper than that: a person pasting the hand-over, where the line sits indented inside it,
   is not a reader. Its whole job is reading
   other sessions' logs, so its own log would be copies of them. Recognised by the line alone,
   because a session is never taken for ours by anything less.
2. **Everything else is logged, and marked.** A **round** is the turn a `handover` with
   `about: "work"` starts — from the next turn start after it, since a hand-over delivered
   into a turn still running waits for that turn, and what the turn does is the person's —
   to the next `prompt` of the person's (one without `from`, log.md) or the place the answer
   to a `handover` of another kind begins, whichever comes first: the agent starting readers,
   the records coming back, `retro_propose`. One read of a hand-over's turn serves rounds and
   replies alike: answered at once when handed back as a tool result or sent between turns,
   from the next turn start when sent into a running one — so a hand-over waiting for the
   round's own turn leaves the turn the round's — and never when the plugin failed to send it,
   whose notice names it by its step (another hand-over can be logged while the send is
   awaited) and is written to the log and to nobody else, so it ends nothing and starts no
   reply, nor does the `work` hand-over it is about open a round — a `/retro` run again after
   it has the round. One still waiting when the person speaks is not answered either: that
   turn answers them — told by the log, a prompt the next turn start follows having opened that
   turn, while one steered into the running turn is followed by its end and leaves the
   hand-over waiting for the turn after. Each round runs from its own beginning, so a `/retro` run again while
   one reads, waiting for that turn to end, has its round even when the first ends before it. Every turn start is logged, since a session stays the plugin's across
   turns. With none to go by, a hand-over that came between turns starts its round itself, and
   one that landed in a running turn opens an empty one. The
   `work` hand-overs themselves are named with it — the plugin's own text, holding nothing to
   read — and only the person's session ends it: a hand-over or a prompt with `from` does
   not. (A delegated session's hand-over should never be written — `retro_propose` refuses
   them — but one that slipped past must not close the round for the rest of it.) Calls to
   `retro_record` and `retro_propose`, and a `subagent` call whose prompt is a work order's
   line, are ours wherever they are — a delegation is written when its reader is done, which
   an early `retro_propose` puts after the round has closed. A reader whose delegation was
   worded its own way is an ordinary child, folded into the person's log like any subagent —
   inside the round, its reading of other logs with it, and ours in full: a delegated session
   whose first prompt lies inside a round is ours to its last record, which may come after an
   early `retro_propose` has closed the round. The order tells the reader to leave a
   round out (no lesson, no cost, no recurrence), and the plugin does not count a round as new
   material, so a log that grew by nothing but a round takes no order.

*Replaces thirteen review rounds of deciding mechanically, call by call, which work was ours —
by the delegation's prompt, by its open order's path, by what else its parent had in flight, by
which delegation named which child. Each round found the last one's interleaving. The markers
were in the log all along, and judging what a stretch of log is is the reader's job (decision
4). A limit, stated: whatever the person's agent does inside a round that is not the round —
rare, since the hand-over asks it to start readers and nothing else — is left out with it.*

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
- A round is logged and marked, and is not new material: a log that grew by nothing but a
  round takes no order, and the order tells the reader to leave rounds out.
  `a round of the plugin's own is logged, and a log grown by nothing else takes no order`
  `the order tells the reader where the plugin's own work is and to leave it out`
  `a reworded reader is folded into the person's log inside the round`
  `a reader whose prompt OpenCode prefixed with its own line is still not logged`
  `a /retro posted into a turn still running leaves the rest of that turn the person's`
  `a delegation of ours written after an early retro_propose is still ours`
  `a reader that read everything but a trailing round has read it all`
  `a hand-over that could not be delivered is followed by a notice saying so`
  `a hand-over that landed in a running turn with no turn after it takes nothing of the person's`
  `a person who pastes the hand-over into a new session is still logged`
  `a person's first message quoting the work line after a blank line is still logged`
  `a reader whose delegation copied the indented line is still recognised`
  `a long first prompt is checked for the reader line in linear time`
  `a notice sent into a running turn leaves the rest of that turn the person's`
  `a reader that read up to a trailing turn's end has read it all`
  `a reworded reader still reading after an early retro_propose is ours to its last record`
  `orders whose hand-over could not be delivered are voided, not reported as unanswered`
  `the rounds an order names include a reworded reader's records after the round closed`
  `a second /retro inside a running round continues it`
  `a turn that added only a round does not report its log as waiting`
  `a hand-over that was never delivered leaves the rest of the turn the person's`
  `a hand-over waiting for the round's turn to end leaves that turn the round's`
  `a /retro run again after an undelivered one has its round`
  `the person speaking before a waiting hand-over's turn makes that turn theirs`
  `the contract says the agent's text answering a notice is not the session's`
  `a /retro waiting behind a round keeps its own round when the first one ends first`
  `the contract describes a round as the code reads it, and defers to the order's list`
  `the person steering into the running turn leaves a waiting /retro its round`
  `a prompt that opens the next turn, after a turn whose end was lost, is the person's turn`
  `an undelivered notice cancels the hand-over it names, not the latest one`
  `a notice of a failed send names the hand-over by its step`
  `the contract explains the field a round's start is read from`
- `retro_propose` is not a delegated session's to call: a reader — known by its line or worded
  its own way — or any other subagent calling it is told so, with nothing recorded, nothing
  closed and no order removed; and `/retro` itself issues nothing in a delegated session, whose
  round could never be proposed. (Limit, AGENTS.md "Known": the plugin knows a session as
  delegated by what it has seen, so a reader calling before its creation is known, or after a
  reload, slips through — and then its hand-over does not end the round.)
  `a reader calling retro_propose is told it is not its call, and nothing happens`
  `a delegated hand-over in a log does not end the round`
  `/retro in a subagent's session issues nothing`
  `a work hand-over noted for a subagent opens no round`
  `a /retro posted into a running turn has its round begin at the turn it resumes`
  `a session stays the plugin's across turns, so a turn resumed by a hand-over is logged from its start`
  `a subagent's text, delegated in answer to a plugin notice, is part of that reply`
  `a subagent of the person's already running when a hand-over arrives stays theirs`
  `a turn resumed by a hand-over that arrived in the previous turn is not a dead prompt hook`
  `a log pruned between turns starts its numbering again`
  `a reworded reader's delegation is ours wherever it lands`
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

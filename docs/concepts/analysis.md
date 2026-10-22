# Analysis

## Definitions

**Analysis.** One model call over one session's log, in a session of the plugin's own —
no agent, no tools, no history — asking: *if this session ran again, what should change
so it goes shorter and straighter?* The criteria are the user's, in
`.retro/prompts/extract.md`; the output format is the plugin's, appended at call time.

**Projection.** The log rendered as text for the model. Prompts, hand-overs and assistant
text in full up to a few thousand characters each; tool output trimmed; tool calls and
steps one line each. Deterministic: the same records always project the same way.

**Budget.** The most characters one analysis may send, `maxInput`. Measured on the model
this was built against, an input past roughly 40,000 characters comes back as an empty
string with no error, so the budget is a guarantee, not an aim. The log gets what is left
after the prompt, the contract and the lesson lists.

**Excerpt.** A projection that had to drop something to fit. It drops in the order that
loses least — less tool output, then whole tool steps from the middle outward, then
shorter prompts — and never drops a prompt, a hand-over or an assistant reply entirely.
Every gap says how many steps went, so the model knows it is reading an excerpt and so
does the human (`from an excerpt` in the outcome).

**Coverage (`through`).** The last step of an excerpt's unbroken prefix. An excerpt keeps
a head and a tail with a gap between; it *covers* only the head. The mark advances to the
coverage, never to the last step seen, so the gap is read next time rather than skipped.

**Attempt.** One analysis of one queued log. A log gets three; a successful excerpt is
progress, not an attempt. After three failures the log is retired: its outcome recorded
as failed, the log kept on disk, and the self-check names it.

**Empty reply.** This model's way of declining an over-long input. It is answered once,
by halving the budget and asking again — the one retry that changes the thing that
correlates with the failure.

**Skipped.** A session of one prompt and no tool calls is not analysed: it cannot hold
evidence of anything. Everything else is, including a conversation that ran no tools —
that is where a wrong instruction file shows up.

## Invariants

- The composed input never exceeds `maxInput`, whatever the log contains.
  `the composed input stays inside maxInput, and says when it had to`
  `prompts are shortened before a projection is allowed over budget`
- An excerpt loses tool output before it loses steps, and steps from the middle before
  the ends; prompts and replies are never dropped.
  `a log over budget loses tool output before it loses steps`
  `when trimming is not enough, steps go from the middle and the gap says how many`
- Step numbers are left alone in an excerpt, so evidence still points at real steps.
  `the numbering is left alone, so evidence still points at real steps`
- An excerpt reports how far it covers, not how far it looked.
  `an excerpt reports how far it actually goes, not how far it looked`
  `a truncation reports only the steps that survived the cut`
- An empty reply is answered by asking again with less, exactly once.
  `an empty reply is answered by asking again with less, not by asking again`
  `an empty reply with nothing left to trim is reported, not retried for ever`
- A failed log is tried again on the next command, and given up on after three.
  `a log that failed stays queued, and is tried again on the next command`
  `a session is given up on after three attempts, not billed forever`
- One failing log does not hold up the ones behind it.
  `a log the model could not answer does not hold up the logs behind it`
- An entry that used its three attempts is retired and reported, never silently skipped.
  `an entry that used its three attempts is retired and reported, not skipped for ever`
- The model is the one the user works with, unless `options.model` says otherwise.
  `the model the user is actually working with is the one used for analysis`
- A session of one prompt and nothing done is skipped; anything more is read.
  `a conversation with no tool calls is still analysed`

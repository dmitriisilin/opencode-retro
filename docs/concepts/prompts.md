# Prompts

## Definitions

**Prompt.** A file that decides what the plugin means by its words: `extract.md`, what
counts as a lesson; `propose.md`, what the agent treats as its job when a lesson arrives,
one or many. Everything the plugin decides *semantically* it decides in these two files.
What stays in source is machinery: the output format the parser needs, the order of a
lesson's fields, the `retro_decide` instruction.

**Layer.** Where a prompt is read from, first hit wins: the project (`.retro/prompts/`),
the user's global config (`~/.config/opencode/retro/prompts/`), the packaged default. A
prompt can be pinned for one project, for every project, or for neither.

**Seed.** On first run each missing project prompt is copied from the packaged default,
so there is something concrete to edit. A seed never overwrites what is already there, and
a file that cannot be written is reported, with nothing half-written left behind.

**Base.** The frontmatter of a live prompt records which packaged default it was seeded
from (`base`). The live file is the user's from the moment it exists and is never written
to again — not even when they have not touched it.

**News.** A newer packaged default does not change the live file. It lands beside the
prompts, in `updates/<name>.v<n>.md`, headed by a statement that the file is not in use,
and is named in `selfcheck.md`. Updates accumulate like release notes; deleting them is
the user's call. They live inside an overridden prompt directory when there is one, since
a notice written where the user stopped looking is a notice nobody sees.

**The contract.** How an analysis must answer. Two halves: `RECORD_INPUT`, the schema of
the `retro_record` tool, which OpenCode enforces before a call reaches the plugin, and
`OUTPUT_CONTRACT`, the prose that says what the fields mean. Both are constants in source,
and the prose is written into each work order after the user's prompt rather than into the
prompt file, so an edited prompt cannot remove it and no file the user owns carries a
region they are told not to touch. Only the user's prose, with the frontmatter stripped,
goes into the order.

**Fallback.** When no layer resolves at all — the file deleted, the package broken — the
hand-over degrades to a terse built-in text rather than to silence.

## Invariants

- A missing prompt is seeded from the packaged default, and a present one is never
  overwritten. A seed that fails part-way takes its own half-written file with it.
  `the default is seeded into the project so there is something to edit`
  `seeding never overwrites what is already there`
  `a prompt that cannot be seeded reports it and leaves nothing behind`
  `a seed that fails half-way leaves no partial prompt behind`
- Resolution is project, then global, then packaged, and the report says whether the live
  file was edited — not only which layer it came from. "Edited" is only claimed against the
  default it was seeded from: after a newer default ships, the plugin no longer has the text
  the file started as, so it says nothing either way rather than call an untouched file edited.
  `resolution is project, then global, then packaged`
  `an edited prompt is reported as edited, not only as the layer it came from`
- Only the user's prose reaches the model.
  `the frontmatter is stripped, so only the user's prose reaches the model`
- A newer default is news, never a change: a news file beside the prompts, the live file
  untouched, the news written once and reported until the user deletes it.
  `an older base gets a news file, and the live file is left alone`
  `a current base produces no news`
  `the news file is written once, and keeps being reported`
  `update notices land beside the prompts, including when the directory is overridden`
- No prompt file carries the contract: it is a constant in source, written into every work
  order after the user's prose.
  `no prompt file carries the contract; it is written into the work order`
- Lessons that arrive as a string instead of an array are read, not refused.
  `lessons that arrive as a string are parsed rather than refused`
- The extractor's reply is parsed tolerantly and fails loudly, never silently.
  `prose around the json, a trailing comma, and a missing fence all survive`
  `an unparseable reply fails loudly rather than silently returning nothing`
  `an empty list is a valid answer, not a failure`
- There are two prompts, and one rule covers a batch rather than a second file.
  `both prompts seed, resolve and carry a base`
  `one rule covers a batch, instead of a second file repeating it`
- The hand-over comes from the prompt file, and a missing file degrades to a terse
  hand-over rather than silence.
  `the hand-over instructions come from the prompt file, not from source`
  `a missing prompt degrades to a terse hand-off rather than a silent one`
- The hand-over names the session logs where the plugin actually keeps them, so a reviewer
  sent to the evidence can find it.
  `the hand-over names the session logs where the plugin actually keeps them`
- The shipped prompts make the local-or-global call explicit, survey the setup rather
  than assume a target, and put the currency question without prescribing how.
  `every prompt makes the local-or-global call explicit`
  `the propose prompt surveys the setup instead of assuming a target`
  `the propose prompt asks the currency question without prescribing how`
  `no prompt suggests lessons themselves are global`

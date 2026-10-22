# Configuration and the project directory

## Definitions

**Options.** `plugins[].options` in `opencode.json`, delivered verbatim. Every option has
a default in `DEFAULTS` (`src/config.js`), and every settable option is documented in all
five READMEs with its real default — the suite checks the names and the values against
the code. Anything a user may want to change is an option or a file in `.retro/`, never
a constant in source.

| Option | Means |
|---|---|
| `dir` | where everything lives; `.retro` under the project, or an absolute path |
| `prompts` | the prompt directory; `prompts` under `dir`, or an absolute path |
| `model` | the analysis model; absent, the user's session model, then the workspace default |
| `maxOutput` | characters of tool output kept per captured step, head and tail |
| `maxInput` | characters one analysis may send (see analysis.md) |
| `heartbeatMs` | the shortest gap between self-check writes while a session works |
| `halfLife` | sessions without a recurrence before a lesson's score halves |
| `keepSessions` | keep every log, including ones nothing cites |
| `extractTimeoutMs` | how long one analysis may take before it is given up on |
| `proposeLimit` | lessons in one `/retro all` |
| `extractLimit` | attempts one `/retro` makes; unlimited by default |
| `autoExtract` | analyse at the start of the next session instead of when asked |

**The layout.** Everything the plugin writes is under `dir`, in plain text: the prompts,
`sessions/`, `lessons/`, `archive/`, `selfcheck.md`, `state.json`, `plugin.log`, and the
plugin's own `.gitignore`. Never `.opencode/`: a write there makes OpenCode rescan skills
and emit events, and a plugin that writes on events then writes for ever.

**Resolution.** `dir` resolves against the project directory, not the process's working
directory; an absolute `dir` or `prompts` is used as given; a context with no location
still yields a usable layout.

**Capture clamp.** `maxOutput` applies when a tool result is *captured*: the head and the
tail are kept and a notice says how much of the middle went, unless the notice would
cost more than it saves. This happens before projection, which trims again.

**The project's git.** The plugin writes `.retro/.gitignore` once and never again. Git
applies it to the directory holding it, so the decision is made inside the one directory
the plugin owns and the user's own `.gitignore` is never touched. Ignored: sessions,
state, the self-check, the plugin log, prompt update notices. Not ignored: `lessons/`,
`archive/`, the live prompts — the product and the configuration, which travel with the
repository.

**Per-machine.** The plugin path in `opencode.json` must be absolute, so that file cannot
be shared; this repository does not track its own.

## Invariants

- The defaults are the documented layout, in one place, and every settable option is
  carried through.
  `defaults are the documented layout, in one place`
  `every settable option is carried through, and omitted ones take the default`
  `every option the plugin reads is documented, in every language`
- The layout is resolved under the project, and absolute paths are used as given.
  `the layout is resolved under the project, not under the process`
  `an absolute dir or prompt path is used as given`
  `a context without a location still yields a usable layout`
- The capture clamp keeps the head and the tail, says how much went, and refuses to elide
  when the notice would cost more than it saves.
  `clamp keeps the head and the tail, and says how much went missing`
  `clamp refuses to elide when the notice would cost more than it saves`
  `short text and non-strings are handed back untouched`
- The plugin decides what git sees without touching the project's own gitignore, once.
  `the plugin decides what git sees without touching the project's own gitignore`
  `machine state is ignored and the product is not`
  `it is seeded once and never rewritten`
  `a seed that cannot happen is reported, not thrown`
- The version the self-check reports is the version shipped, and the tarball carries
  everything the entry point imports.
  `the version the self-check reports is the version we ship`
  `the published tarball carries everything the entry point imports`
- The model is the user's session model unless an option says otherwise, and the
  workspace default after that.
  `the model the user is actually working with is the one used for analysis`
  `with no model configured, the workspace default is used`

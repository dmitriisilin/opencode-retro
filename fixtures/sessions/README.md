# fixtures/sessions

Shadow logs — the format the plugin itself writes, one JSON record per line. A layer above
`fixtures/payloads/`, which holds the raw OpenCode hook and event payloads these are built
from.

| File | What it is |
|---|---|
| `lint-trap-live.jsonl` | Written by the real plugin during a live session in `spike/playground`. 17 tool calls. The agent hit both planted traps (`npm run build` exits 1, the `lint` skill's `npx eslint . --fix` exits 2) and wandered through nine unrelated steps in between. |

`lint-trap-live.jsonl` is the regression case for the skill→failure lesson: the skill is
invoked at step 9 and its prescribed command fails at step 18, which is why
`prompts/extract.md` tells the model to follow a skill into its own command rather than
judging by proximity.

It also contains the plugin reading its own output — the agent got curious about `.retro/`
mid-session. Left in deliberately: dogfooding noise is what real logs look like.

## Replaying

```js
import { parseShadowLog } from "../../src/shadowlog.js"
import { project } from "../../src/projection.js"

const records = parseShadowLog(readFileSync("lint-trap-live.jsonl", "utf8"))
project(records)       // => the text the extractor will read
```

Record kinds: `session` (start/end), `prompt`, `tool`, `text`, `step`. `n` is the step
index — monotonic per session, assigned when the record is appended. `seq` on a tool record
is OpenCode's own `durable.seq`, joined in from the event stream when available.

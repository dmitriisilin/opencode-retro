# fixtures/sessions

Shadow logs — the format the plugin itself writes, one JSON record per line. A layer above
`fixtures/payloads/`, which holds the raw OpenCode hook and event payloads these are built
from.

| File | What it is |
|---|---|
| `queue-and-steer.jsonl` | Measured on 2.0.32: a turn running `sleep 40`, and while it ran a prompt posted with `delivery: "queue"` and another with `delivery: "steer"`. Both hooks fired when posted (steps 3 and 4, inside the turn), and both were answered before the turn's single end — the steered one in the same reply, the queued one in a step of its own. |
| `two-turns.jsonl` | `opencode run -s <id>` twice: one log, two start/end pairs, numbered once through. |
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

const records = parseShadowLog(readFileSync("lint-trap-live.jsonl", "utf8"))
// what a reader opens: the log itself, which a work order points at
```

Record kinds: `session` (start/end), `prompt`, `tool`, `text`, `step`. `n` is the step
index — monotonic per session, assigned when the record is appended. `seq` on a tool record
is OpenCode's own `durable.seq`, joined in from the event stream when available.

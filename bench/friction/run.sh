#!/bin/bash
# Plant friction, work in it, run /retro, and score what the plugin found.
#
#   bench/friction/run.sh [workdir] [model]
#
# Packs this checkout, installs the tarball into a fresh copy of project/ (no git, no plugin
# options), runs every task in traps.json as its own session, then one `/retro` over the API,
# and prints which planted traps became lessons. Costs real model calls — and since the
# analyses are subagents of the review session, they are billed to the model that session
# runs on.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
# A fresh directory every run. Recreating a project directory at the same path while the
# OpenCode service is up leaves the plugin unloaded there, silently (AGENTS.md Gotcha 15):
# measured, the second run at one path recorded nothing at all.
WORK=${1:-/tmp/retro-friction-$(date +%s)}
MODEL=${2:-deepseek/deepseek-flash}
OC=${OPENCODE:-opencode}

if [ -e "$WORK" ]; then echo "$WORK exists; use a new directory (see above)" >&2; exit 1; fi
mkdir -p "$WORK/pack" "$WORK/plugin"
(cd "$REPO" && npm pack --silent --pack-destination "$WORK/pack" >/dev/null) || exit 1
tar xzf "$WORK"/pack/*.tgz -C "$WORK/plugin"
cp -r "$HERE/project" "$WORK/project"
# Absolute path: a relative one hangs session startup (AGENTS.md Gotcha 3).
printf '{ "plugins": [{ "package": "%s" }] }\n' "$WORK/plugin/package" > "$WORK/project/opencode.json"
cd "$WORK/project" || exit 1
echo "work: $WORK"

i=0
node -e 'for (const t of require(process.argv[1]).tasks) console.log(t)' "$HERE/traps.json" | while IFS= read -r task; do
  i=$((i + 1))
  echo "session $i: $task"
  # stdin from /dev/null: `opencode run` reads it, and would swallow the rest of the task list.
  timeout 900 "$OC" run --auto -m "$MODEL" "$task" < /dev/null > "$WORK/session-$i.log" 2>&1
  echo "  exit $? — $(ls .retro/sessions 2>/dev/null | wc -l) logs"
done

# A review session to run the command in: `opencode run "/retro"` would only type the text
# at the agent (Gotcha 16), so the command is posted to a session over the API.
before=$(ls .retro/sessions)
timeout 300 "$OC" run -m "$MODEL" "Reply with the single word: ready." < /dev/null > "$WORK/review.log" 2>&1
review=$(comm -13 <(echo "$before") <(ls .retro/sessions) | head -1 | sed 's/\.jsonl$//')
echo "review session: $review"
timeout 900 "$OC" api post "/api/session/$review/command" -H "x-opencode-directory: $WORK/project" \
  -d '{"name":"retro","text":""}' > "$WORK/retro.json" 2>&1
echo "retro: exit $?"
# The command returns once the hand-over is delivered; the agent then works on it — first the
# analyses, then the proposal. Two things have to settle before the next command, and the
# plugin's own work is deliberately absent from the logs, so the review session's log is not
# enough on its own: wait for `.retro/work/` to empty, which happens as each order is
# answered, and then for that log to stop growing (or the second /retro reads the review
# before it exists and the check below proves nothing — measured: it did, once).
for _ in $(seq 1 90); do
  [ -z "$(ls -A .retro/work 2>/dev/null)" ] && break
  sleep 10
done
left=$(ls -A .retro/work 2>/dev/null | wc -l)
[ "$left" != "0" ] && echo "WARNING: $left work order(s) unanswered; the agent never analysed them"
prev=-1
for _ in $(seq 1 60); do
  now=$(stat -c %s ".retro/sessions/$review.jsonl" 2>/dev/null || echo 0)
  [ "$now" = "$prev" ] && break
  prev=$now
  sleep 10
done
# Once more, as a person would after the hand-over was discussed: it asks again about any log
# whose order went unanswered, and reads the review session itself — whose checking of the
# lesson must not be counted as the problem recurring.
timeout 900 "$OC" api post "/api/session/$review/command" -H "x-opencode-directory: $WORK/project" \
  -d '{"name":"retro","text":""}' > "$WORK/retro2.json" 2>&1
echo "retro again: exit $?"
# And wait for *this* round too, or the review check below is scored before the analysis of
# the review session has run — which is the whole point of the second command. Measured: it
# read `UNTESTED` twice while the order for the review session sat unanswered on disk.
for _ in $(seq 1 90); do
  [ -z "$(ls -A .retro/work 2>/dev/null)" ] && break
  sleep 10
done
left=$(ls -A .retro/work 2>/dev/null | wc -l)
[ "$left" != "0" ] && echo "WARNING: $left work order(s) unanswered after the second /retro"

node "$HERE/score.mjs" "$HERE/traps.json" "$WORK/project/.retro" "$review" | tee "$WORK/score.txt"

#!/bin/bash
# Records a real Claude Code run into fixtures/<name>.json.
# Usage: scripts/record.sh <name> <prompt> [allowedTools...]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="$1"; PROMPT="$2"; shift 2
PORT=47822
WORK="$(mktemp -d)"
node "$ROOT/hooks/settings.mjs" ${RECORD_ANNOTATE:+--annotate} > "$WORK/settings.json"

SWARMTRACER_PORT=$PORT SWARMTRACER_DB="$WORK/rec.db" npx --prefix "$ROOT" tsx "$ROOT/server/src/index.ts" > "$WORK/server.log" 2>&1 &
SERVER=$!
sleep 1.5
# RECORD_DIR runs the session elsewhere (e.g. a scratch project with the atl skill installed).
# cli/bin goes on PATH so agents can call atl.
(cd "${RECORD_DIR:-$ROOT}" && PATH="$ROOT/cli/bin:$PATH" env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
  -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
  -u CLAUDE_PID -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_EFFORT -u AI_AGENT \
  SWARMTRACER_PORT=$PORT claude -p "$PROMPT" --settings "$WORK/settings.json" --model "${RECORD_MODEL:-sonnet}" \
    --output-format json --allowedTools "$@" </dev/null > "$WORK/result.json" 2>"$WORK/stderr")
echo "exit=$?"
sleep 3
RUN=$(curl -s "http://127.0.0.1:$PORT/runs" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d)[0]?.run_id??""))')
curl -s "http://127.0.0.1:$PORT/runs/$RUN/events" > "$ROOT/fixtures/$NAME.json"
kill $SERVER; wait $SERVER 2>/dev/null
# Keep uploaded artifacts with the fixtures (content-addressed, so names never clash).
[ -d "$WORK/artifacts" ] && mkdir -p "$ROOT/fixtures/artifacts" && cp "$WORK"/artifacts/* "$ROOT/fixtures/artifacts/" 2>/dev/null
cat "$WORK/server.log"; head -c 400 "$WORK/result.json"; echo
echo "saved fixtures/$NAME.json ($(node -e "console.log(require('$ROOT/fixtures/$NAME.json').length)") events)"

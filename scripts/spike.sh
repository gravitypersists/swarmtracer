#!/bin/bash
# M0 spike: run real Claude Code sessions that spawn 3 parallel subagents, with the server
# up and then down. Writes a fixture and prints a verification report.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SWARMTRACER_PORT:-47821}"
WORK="$(mktemp -d)"
SETTINGS="$WORK/settings.json"
DB="$WORK/spike.db"
node "$ROOT/hooks/settings.mjs" > "$SETTINGS"

# MODE=foreground asks for blocking Agent calls; the default lets Claude Code choose (it backgrounds them under -p).
MODE="${MODE:-default}"
BG=""
[ "$MODE" = foreground ] && BG=' Run them in the foreground (run_in_background: false) so you block until each returns.'
PROMPT='Spawn exactly 3 general-purpose subagents in parallel, all in one message (three Agent tool calls in the same response).'"$BG"'  Give them the descriptions "probe A", "probe B", "probe C". Each subagent must: (1) run the Bash command `env | grep -E "^(CLAUDE|AI_AGENT)" | sort`, (2) run `sleep 3`, (3) reply with the env output verbatim. After all three return, reply with one line: "done".'

# Run outside this session's env so the child looks like a fresh top-level session.
run_claude() {
  (cd "$WORK" && env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
    -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
    -u CLAUDE_PID -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_EFFORT -u AI_AGENT \
    claude -p "$PROMPT" --settings "$SETTINGS" --model sonnet --output-format json \
      --allowedTools "Bash(env:*)" "Bash(sleep:*)" "Agent" </dev/null 2>"$1.stderr" >"$1.json")
  echo "exit=$?"
}

echo "== run 1: server up"
SWARMTRACER_PORT=$PORT SWARMTRACER_DB="$DB" npx --prefix "$ROOT" tsx "$ROOT/server/src/index.ts" > "$WORK/server.log" 2>&1 &
SERVER=$!
sleep 1.5
start=$(date +%s); run_claude "$WORK/up"; echo "wall=$(( $(date +%s) - start ))s"
sleep 3 # let late correlation retries land
RUN=$(curl -s "http://127.0.0.1:$PORT/runs" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d)[0]?.run_id??""))')
curl -s "http://127.0.0.1:$PORT/runs/$RUN/events" > "$WORK/events.json"
kill $SERVER; wait $SERVER 2>/dev/null
echo "-- server log"; cat "$WORK/server.log"

echo "== run 2: server down"
start=$(date +%s); run_claude "$WORK/down"; echo "wall=$(( $(date +%s) - start ))s"

node "$ROOT/scripts/verify-m0.mjs" "$WORK/events.json" "$WORK/up.json" "$WORK/down.json" "$WORK/down.stderr" "$WORK/server.log"
mkdir -p "$ROOT/fixtures"
cp "$WORK/events.json" "$ROOT/fixtures/m0-parallel-3-$MODE.json"
echo "work dir: $WORK"

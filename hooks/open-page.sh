#!/bin/sh
# Opens the SwarmTracer page at this session's run: once per session, on its first subagent (or at
# session start, per the plugin's open_browser option), and only if no page is open already, since
# an open page follows new runs by itself. Always exits 0.
root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${CLAUDE_PLUGIN_OPTION_OPEN_BROWSER:-first subagent}"
[ "$mode" = "never" ] && exit 0
[ "$mode" = "session start" ] && [ -z "$SWARMTRACER_OPEN_NOW" ] && exit 0
session=$(sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -1)
[ -n "$session" ] || exit 0
# mkdir is atomic: parallel subagents starting together open one tab, not three.
mkdir -p "$root/data/opened"
mkdir "$root/data/opened/$session" 2>/dev/null || exit 0
find "$root/data/opened" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null
pages=$(curl -s --max-time 0.5 "http://127.0.0.1:${SWARMTRACER_PORT:-47821}/health" | sed -n 's/.*"pages":\([0-9]*\).*/\1/p')
[ "${pages:-0}" -gt 0 ] && exit 0
"$root/bin/swarmtracer" open "$session" --quiet >/dev/null 2>&1
exit 0

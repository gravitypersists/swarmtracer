#!/bin/sh
# Plugin SessionStart: make sure the server is running, then record the event (so the session's
# first event isn't lost to a cold start). Optionally opens the page right away. Always exits 0.
root="$(cd "$(dirname "$0")/.." && pwd)"
input=$(cat)
"$root/bin/swarmtracer" start --quiet >/dev/null 2>&1
printf '%s' "$input" | "$root/hooks/adapter.sh"
if [ "${CLAUDE_PLUGIN_OPTION_OPEN_BROWSER:-first subagent}" = "session start" ]; then
  printf '%s' "$input" | SWARMTRACER_OPEN_NOW=1 "$root/hooks/open-page.sh"
fi
exit 0

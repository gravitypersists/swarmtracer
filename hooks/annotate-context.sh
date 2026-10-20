#!/bin/sh
# Opt-in SessionStart/SubagentStart hook: tells a traced agent that `atl` exists. A skill alone
# isn't enough: agents see it listed but don't load it, since annotating doesn't help their own
# task. Outside the plugin it speaks only when SwarmTracer is running and atl is on PATH.
# Phrased as facts, not orders, per the hooks docs. Always exits 0.
event=$(sed -n 's/.*"hook_event_name" *: *"\([A-Za-z]*\)".*/\1/p' | head -1)
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  # As a plugin: atl is on the Bash PATH and session-start.sh is starting the server.
  [ "${CLAUDE_PLUGIN_OPTION_ANNOTATE:-true}" = "false" ] && exit 0
else
  command -v atl >/dev/null 2>&1 || exit 0
  curl -s -o /dev/null --connect-timeout 0.2 --max-time 0.5 "http://127.0.0.1:${SWARMTRACER_PORT:-47821}/runs" || exit 0
fi
cat <<JSON
{"hookSpecificOutput":{"hookEventName":"${event:-SessionStart}","additionalContext":"This session is traced live by SwarmTracer, which records timing and tool calls automatically but not reasons. Agents here add those with the \`atl\` command (see the atl skill), run as its own Bash command with the text written literally, never chained or behind a \`command -v\` check: \`atl decision \\"what\\" --why \\"why\\"\` when choosing between real alternatives, \`atl note \\"…\\"\` at a handoff whose reason isn't obvious, \`atl artifact <path> \\"what it is\\"\` for a deliverable file, \`atl blocked \\"…\\"\` when unable to continue. Typical tasks need 0–3 annotations; progress narration isn't wanted."}}
JSON
exit 0

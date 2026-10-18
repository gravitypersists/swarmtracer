#!/bin/sh
# SwarmTracer hook adapter. Claude Code runs this for every hook event with the hook JSON on stdin.
# Forwards it to the local server and always exits 0 with no output, so it can never fail,
# block, or alter the hook. If the server is down, curl's connect fails in milliseconds.
curl -s -o /dev/null --connect-timeout 0.2 --max-time 1 \
  -H 'content-type: application/json' --data-binary @- \
  "http://127.0.0.1:${SWARMTRACER_PORT:-47821}/events" >/dev/null 2>&1
exit 0

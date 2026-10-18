#!/usr/bin/env node
// Prints a Claude Code settings snippet that registers the adapter on every event SwarmTracer reads.
// Paste the output into a project's .claude/settings.json (or pass it to `claude --settings`).
// Usage: node hooks/settings.mjs [--annotate]
import { fileURLToPath } from "node:url";

const adapter = fileURLToPath(new URL("./adapter.sh", import.meta.url));
const EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure",
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "PermissionRequest",
  "SubagentStart", "SubagentStop",
];

const hook = { type: "command", command: JSON.stringify(adapter), timeout: 5 };
const hooks = Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [hook] }]]));
const settings = { hooks };

// --annotate: also tell each traced agent about `atl` when it starts (see annotate-context.sh).
if (process.argv.includes("--annotate")) {
  const context = { type: "command", command: JSON.stringify(fileURLToPath(new URL("./annotate-context.sh", import.meta.url))), timeout: 5 };
  for (const e of ["SessionStart", "SubagentStart"]) hooks[e][0].hooks.push(context);
  Object.assign(settings, { permissions: { allow: ["Bash(atl:*)"] } }); // annotating should never stop for approval
}
console.log(JSON.stringify(settings, null, 2));

#!/usr/bin/env node
// Prints a Claude Code settings snippet that registers the adapter on every event SwarmTracer reads.
// Paste the output into a project's .claude/settings.json (or pass it to `claude --settings`).
import { fileURLToPath } from "node:url";

const adapter = fileURLToPath(new URL("./adapter.sh", import.meta.url));
const EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure",
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "PermissionRequest",
  "SubagentStart", "SubagentStop",
];

const hook = { type: "command", command: JSON.stringify(adapter), timeout: 5 };
const hooks = Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [hook] }]]));
console.log(JSON.stringify({ hooks }, null, 2));

// Checks an M0 spike run: every event arrived, every child is linked to the right spawn,
// and the server-down run behaved like a normal run.
import { readFileSync } from "node:fs";

const [eventsPath, upPath, downPath, downStderr, serverLog] = process.argv.slice(2);
const events = JSON.parse(readFileSync(eventsPath, "utf8"));
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);

const root = events[0]?.session_id;
const hook = (name) => events.filter((e) => e.payload.hook_event_name === name);
const spawns = hook("PreToolUse").filter((e) => e.payload.tool_name === "Agent");
const starts = hook("SubagentStart");
const stops = hook("SubagentStop");
const links = events.filter((e) => e.kind === "link");

console.log(`\n== verification (${events.length} events, run ${root})`);
const counts = {};
for (const e of events) counts[e.payload.hook_event_name ?? e.kind] = (counts[e.payload.hook_event_name ?? e.kind] ?? 0) + 1;
console.log(counts);

ok(hook("SessionStart").length === 1 && hook("SessionEnd").length === 1, "one SessionStart and one SessionEnd");
ok(spawns.length === 3 && starts.length === 3 && stops.length === 3, `3 spawns / starts / stops (got ${spawns.length}/${starts.length}/${stops.length})`);

const spawnTs = spawns.map((e) => e.ts), startTs = starts.map((e) => e.ts);
ok(Math.max(...spawnTs) < Math.min(...startTs) + 5000, "spawns were parallel (all PreToolUse before children ran long)");

for (const pre of hook("PreToolUse")) {
  const post = events.find((e) => e.payload.tool_use_id === pre.payload.tool_use_id && e.kind === "tool_end");
  if (!post) ok(false, `PreToolUse ${pre.payload.tool_name} ${pre.payload.tool_use_id} has a matching PostToolUse`);
}
ok(true, "checked Pre/Post pairing (failures listed above, if any)");

for (const s of starts) {
  const childId = s.payload.agent_id;
  const childLinks = links.filter((l) => l.agent_id === childId);
  const methods = childLinks.map((l) => l.payload.method);
  const spawn = spawns.find((p) => p.payload.tool_use_id === childLinks[0]?.payload.tool_use_id);
  // Ground truth: the PostToolUse for the Agent call names the agentId it ran.
  const post = events.find((e) => e.payload.hook_event_name === "PostToolUse" && e.payload.tool_use_id === spawn?.payload.tool_use_id);
  const truth = post?.payload.tool_response?.agentId;
  ok(childLinks.length === 1 && truth === childId,
    `child ${childId} (${spawn?.payload.tool_input?.description}) linked via [${methods}] at +${childLinks[0] ? childLinks[0].ts - s.ts : "?"}ms after SubagentStart; tool_response.agentId=${truth}`);
  const childEvents = events.filter((e) => e.agent_id === childId && e.kind === "tool_start");
  ok(childEvents.length >= 2, `child ${childId} tool events tagged with its agent_id (${childEvents.length} tool_start)`);
}

const log = readFileSync(serverLog, "utf8");
ok(!/MISMATCH|UNLINKED/.test(log), "correlation sources agree (no MISMATCH/UNLINKED in server log)");
const firstMethod = Object.fromEntries(links.map((l) => [l.agent_id, l.payload.method]));
const metaConfirms = (log.match(/confirm \S+ via meta|via meta/g) ?? []).length;
ok(metaConfirms === 3, `meta file resolved all 3 children (${metaConfirms}); first link methods: ${JSON.stringify(Object.values(firstMethod))}`);
const bg = spawns.map((p) => events.find((e) => e.kind === "tool_end" && e.payload.tool_use_id === p.payload.tool_use_id)?.payload.tool_response?.status);
console.log(`-- Agent call statuses: ${JSON.stringify(bg)}`);

const envOut = hook("PostToolUse").filter((e) => e.agent_id !== root && String(e.payload.tool_input?.command ?? "").startsWith("env"));
console.log("\n-- env visible to a subagent's Bash:");
console.log(envOut[0]?.payload.tool_response?.stdout ?? JSON.stringify(envOut[0]?.payload.tool_response));
console.log("-- that subagent's agent_id:", envOut[0]?.agent_id, " session_id:", envOut[0]?.session_id);

const up = JSON.parse(readFileSync(upPath, "utf8"));
let down; try { down = JSON.parse(readFileSync(downPath, "utf8")); } catch { down = null; }
const stderr = readFileSync(downStderr, "utf8");
console.log("\n-- server-down run");
ok(up.is_error === false, `server-up run succeeded: ${JSON.stringify(up.result).slice(0, 60)}, ${up.duration_ms}ms`);
ok(down && down.is_error === false, `server-down run succeeded: ${JSON.stringify(down?.result).slice(0, 60)}, ${down?.duration_ms}ms`);
ok(!/hook/i.test(stderr), `server-down stderr has no hook errors (${stderr.length} bytes)`);

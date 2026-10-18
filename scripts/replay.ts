// Replays a recorded fixture into a running server as a new live run: re-posts the raw hook
// payloads with their original spacing (scaled by --speed) under a fresh session id.
// Usage: npx tsx scripts/replay.ts fixtures/m1-two-wave.json [--speed 4] [--port 47821]
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../shared/events.ts";

const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const speed = Number(flag("speed", "1"));
const port = flag("port", process.env.SWARMTRACER_PORT ?? "47821");
const events: AgentEvent[] = JSON.parse(readFileSync(args[0], "utf8"));
const session = randomUUID();
const hooks = events.filter((e) => e.source === "hook");

console.log(`replaying ${hooks.length} hook events as run ${session} at ${speed}x`);
const start = Date.now();
for (const e of hooks) {
  const due = start + (e.ts - hooks[0].ts) / speed;
  await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
  // Only session_id changes: transcript_path still points at the real files, so the
  // correlator's meta-file lookup works exactly as it did live.
  const body = JSON.stringify({ ...e.payload, session_id: session });
  await fetch(`http://127.0.0.1:${port}/events`, { method: "POST", headers: { "content-type": "application/json" }, body });
}
console.log("done");

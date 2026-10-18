// Adds `reasoning` events to a recorded fixture from its transcripts on disk, as the live tailer
// would have. Their ts is the transcript timestamp (the tailer would use receipt time); layout
// attributes reasoning by tool_use id or transcript time, never by ts, so tests are unaffected.
// Usage: npx tsx scripts/backfill-reasoning.ts fixtures/*.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentEvent } from "../shared/events.ts";
import { parseTranscriptRecord, subagentTranscriptPath } from "../shared/transcript.ts";

for (const file of process.argv.slice(2)) {
  const events: AgentEvent[] = JSON.parse(readFileSync(file, "utf8")).filter((e: AgentEvent) => e.kind !== "reasoning");
  const root = events[0];
  const transcript = events.find((e) => e.payload.transcript_path)?.payload.transcript_path as string | undefined;
  if (!transcript) continue;
  const lanes = [root.session_id, ...new Set(events.filter((e) => e.payload.hook_event_name === "SubagentStart").map((e) => e.agent_id))];
  let nextId = Math.max(...events.map((e) => Number(e.id))) + 1;
  let added = 0;
  for (const lane of lanes) {
    const path = lane === root.session_id ? transcript : subagentTranscriptPath(transcript, lane);
    if (!existsSync(path)) { console.warn(`missing ${path}`); continue; }
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const payload = parseTranscriptRecord(line);
      if (!payload) continue;
      events.push({
        id: String(nextId++), ts: payload.transcript_ts, client_ts: payload.transcript_ts,
        run_id: root.run_id, session_id: root.session_id, agent_id: lane,
        kind: "reasoning", source: "transcript", payload: { ...payload },
      });
      added++;
    }
  }
  writeFileSync(file, JSON.stringify(events));
  console.log(`${file}: +${added} reasoning events`);
}

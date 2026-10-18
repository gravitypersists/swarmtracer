// Loads fixture runs into the local database so the UI can show them. Skips runs already present.
// Usage: npm run seed [-- fixtures/a.json ...]   (default: every fixture)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../server/src/db.ts";
import type { AgentEvent } from "../shared/events.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const dbPath = process.env.SWARMTRACER_DB ?? `${root}data/swarmtracer.db`;
const db = openDb(dbPath);
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(`${root}fixtures`).filter((f) => f.endsWith(".json")).map((f) => `${root}fixtures/${f}`);

const known = new Set(db.runs().map((r: any) => r.run_id));
for (const f of files) {
  const events: AgentEvent[] = JSON.parse(readFileSync(f, "utf8"));
  if (!events.length || known.has(events[0].run_id)) continue;
  for (const { id, ...e } of events) db.append(e);
  console.log(`seeded ${f} (${events.length} events)`);
}

// Artifact bytes recorded alongside the fixtures.
const from = `${root}fixtures/artifacts`, to = process.env.SWARMTRACER_ARTIFACTS ?? `${dirname(dbPath)}/artifacts`;
if (existsSync(from)) {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from)) copyFileSync(`${from}/${f}`, `${to}/${f}`);
}

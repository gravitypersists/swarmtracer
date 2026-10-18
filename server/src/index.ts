import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { isHookInput, normalizeHook } from "./normalize.ts";
import { createCorrelator } from "./correlate.ts";

const PORT = Number(process.env.SWARMTRACER_PORT ?? 47821);
const DB_PATH = process.env.SWARMTRACER_DB ?? fileURLToPath(new URL("../../data/swarmtracer.db", import.meta.url));
const VERBOSE = process.env.SWARMTRACER_VERBOSE === "1";

const db = openDb(DB_PATH);
const correlator = createCorrelator(db, (msg) => console.log(`[correlate] ${msg}`));
const indexHtml = readFileSync(new URL("../static/index.html", import.meta.url));

function ingest(body: unknown, ts: number) {
  for (const item of Array.isArray(body) ? body : [body]) {
    if (!isHookInput(item)) continue; // CLI events arrive in M4
    db.append(normalizeHook(item, ts));
    correlator.observe(item);
    if (VERBOSE) console.log(`[event] ${item.hook_event_name} ${item.agent_id ?? "root"} ${item.tool_name ?? ""}`);
  }
}

function json(res: ServerResponse, value: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function onEvents(req: IncomingMessage, res: ServerResponse) {
  const ts = Date.now(); // stamp on receipt, before reading the body
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    // Answer first: hooks wait on this response.
    res.writeHead(204).end();
    try {
      ingest(JSON.parse(Buffer.concat(chunks).toString("utf8")), ts);
    } catch (err) {
      console.error("[ingest] bad body:", (err as Error).message);
    }
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const runMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);

  if (req.method === "POST" && url.pathname === "/events") return onEvents(req, res);
  if (req.method === "GET" && url.pathname === "/runs") return json(res, db.runs());
  if (req.method === "GET" && runMatch) {
    return json(res, db.events(decodeURIComponent(runMatch[1]), Number(url.searchParams.get("after") ?? 0)));
  }
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(indexHtml);
  }
  res.writeHead(404).end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`swarmtracer listening on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);
});

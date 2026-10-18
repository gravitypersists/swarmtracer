import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "../../shared/events.ts";
import { openDb } from "./db.ts";
import { isHookInput, normalizeHook } from "./normalize.ts";
import { createCorrelator } from "./correlate.ts";

const PORT = Number(process.env.SWARMTRACER_PORT ?? 47821);
const DB_PATH = process.env.SWARMTRACER_DB ?? fileURLToPath(new URL("../../data/swarmtracer.db", import.meta.url));
const VERBOSE = process.env.SWARMTRACER_VERBOSE === "1";

const db = openDb(DB_PATH);
const correlator = createCorrelator(db, (msg) => console.log(`[correlate] ${msg}`));
const WEB = new URL("../../web/", import.meta.url);
// Read per request so `npm run dev` picks up rebuilt bundles without a restart.
const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/log": ["log.html", "text/html; charset=utf-8"],
  "/app.js": ["dist/app.js", "text/javascript; charset=utf-8"],
  "/app.js.map": ["dist/app.js.map", "application/json"],
};

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

// Server-Sent Events. `run` limits the stream to one run; without it every new event is sent
// (the UI uses that to notice new runs). Resumes from Last-Event-ID or `after`.
function onStream(req: IncomingMessage, res: ServerResponse, url: URL) {
  const run = url.searchParams.get("run");
  const resumeFrom = req.headers["last-event-id"] ?? url.searchParams.get("after");
  let after = resumeFrom === null || resumeFrom === undefined ? (run ? 0 : db.maxSeq()) : Number(resumeFrom);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });

  const send = (e: AgentEvent) => {
    if ((run && e.run_id !== run) || Number(e.id) <= after) return;
    after = Number(e.id);
    res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const unsubscribe = db.subscribe(send);
  for (const e of run ? db.events(run, after) : db.eventsAfter(after)) send(e);

  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    unsubscribe();
    clearInterval(ping);
  });
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
  if (req.method === "GET" && url.pathname === "/stream") return onStream(req, res, url);
  if (req.method === "GET" && url.pathname === "/runs") return json(res, db.runs());
  if (req.method === "GET" && runMatch) {
    return json(res, db.events(decodeURIComponent(runMatch[1]), Number(url.searchParams.get("after") ?? 0)));
  }
  const file = req.method === "GET" ? STATIC[url.pathname] : undefined;
  if (file) {
    try {
      const body = readFileSync(new URL(file[0], WEB));
      res.writeHead(200, { "content-type": file[1], "cache-control": "no-store" });
      return res.end(body);
    } catch {
      res.writeHead(404).end(`${file[0]} missing; run npm run build`);
      return;
    }
  }
  res.writeHead(404).end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`swarmtracer listening on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);
});

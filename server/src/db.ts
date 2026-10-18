import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent } from "../../shared/events.ts";

export type NewEvent = Omit<AgentEvent, "id">;

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      client_ts INTEGER,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      parent_agent_id TEXT,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_run ON events (run_id, seq);
  `);

  const insert = db.prepare(`
    INSERT INTO events (ts, client_ts, run_id, session_id, agent_id, parent_agent_id, kind, source, payload)
    VALUES (@ts, @client_ts, @run_id, @session_id, @agent_id, @parent_agent_id, @kind, @source, @payload)
  `);
  const byRun = db.prepare(`SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq`);
  const runs = db.prepare(`
    SELECT run_id, MIN(ts) AS started, MAX(ts) AS last, COUNT(*) AS events,
           COUNT(DISTINCT agent_id) AS agents
    FROM events GROUP BY run_id ORDER BY started DESC
  `);

  const toEvent = (row: any): AgentEvent => ({
    id: String(row.seq),
    ts: row.ts,
    client_ts: row.client_ts ?? undefined,
    run_id: row.run_id,
    session_id: row.session_id,
    agent_id: row.agent_id,
    parent_agent_id: row.parent_agent_id ?? undefined,
    kind: row.kind,
    source: row.source,
    payload: JSON.parse(row.payload),
  });

  return {
    append(e: NewEvent): AgentEvent {
      const info = insert.run({
        ...e,
        client_ts: e.client_ts ?? null,
        parent_agent_id: e.parent_agent_id ?? null,
        payload: JSON.stringify(e.payload),
      });
      return { ...e, id: String(info.lastInsertRowid) };
    },
    events(runId: string, afterSeq = 0): AgentEvent[] {
      return byRun.all(runId, afterSeq).map(toEvent);
    },
    runs() {
      return runs.all();
    },
  };
}

export type Db = ReturnType<typeof openDb>;

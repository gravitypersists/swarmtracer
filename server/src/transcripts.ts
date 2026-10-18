import { open, stat } from "node:fs/promises";
import type Database from "better-sqlite3";
import { parseTranscriptRecord } from "../../shared/transcript.ts";
import type { Db } from "./db.ts";

// Tails the transcript of every lane the hooks have told us about and appends a `reasoning`
// event per assistant record. Offsets persist, so a restart resumes instead of re-emitting.
// The table doubles as the allowlist for GET /transcript: only paths hooks reported are readable.

interface Tracked { path: string; run_id: string; session_id: string; agent_id: string; offset: number; closeAt?: number }

const POLL_MS = 500;

export function createTranscripts(sql: Database.Database, db: Db) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS transcripts (
      path TEXT NOT NULL,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      offset INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (path, run_id) -- a replayed run re-reads the same file as its own run
    );
  `);
  const insert = sql.prepare(
    `INSERT OR IGNORE INTO transcripts (path, run_id, session_id, agent_id) VALUES (@path, @run_id, @session_id, @agent_id)`,
  );
  const setOffset = sql.prepare(`UPDATE transcripts SET offset = ? WHERE path = ? AND run_id = ?`);
  const byKey = sql.prepare(`SELECT * FROM transcripts WHERE path = ? AND run_id = ?`);
  const byPath = sql.prepare(`SELECT 1 FROM transcripts WHERE path = ?`);
  const key = (path: string, run: string) => `${run}\0${path}`;
  // Resume tailing for runs that hadn't ended when the server last stopped.
  const unfinished = sql.prepare(`
    SELECT t.* FROM transcripts t WHERE NOT EXISTS (
      SELECT 1 FROM events e WHERE e.run_id = t.run_id AND e.kind = 'session_end' AND e.agent_id = e.run_id)
  `);

  const active = new Map<string, Tracked>();
  for (const row of unfinished.all() as Tracked[]) active.set(key(row.path, row.run_id), row);
  let busy = false;

  async function drain(t: Tracked) {
    let size: number;
    try {
      size = (await stat(t.path)).size;
    } catch {
      return; // not written yet
    }
    if (size <= t.offset) return;
    const fh = await open(t.path, "r");
    try {
      const buf = Buffer.alloc(size - t.offset);
      await fh.read(buf, 0, buf.length, t.offset);
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) return; // no complete line yet
      const now = Date.now();
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        const payload = parseTranscriptRecord(line);
        if (!payload) continue;
        db.append({
          ts: now,
          client_ts: payload.transcript_ts || undefined,
          run_id: t.run_id,
          session_id: t.session_id,
          agent_id: t.agent_id,
          kind: "reasoning",
          source: "transcript",
          payload: { ...payload },
        });
      }
      t.offset += end + 1;
      setOffset.run(t.offset, t.path, t.run_id);
    } finally {
      await fh.close();
    }
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      // The only reader: finish() just schedules the last read, so no record is emitted twice.
      for (const t of active.values()) {
        await drain(t).catch((err) => console.error("[transcripts]", t.path, err.message));
        if (t.closeAt && Date.now() >= t.closeAt) active.delete(key(t.path, t.run_id));
      }
    } finally {
      busy = false;
    }
  }
  setInterval(poll, POLL_MS).unref();

  return {
    register(path: string, lane: Omit<Tracked, "path" | "offset">) {
      const k = key(path, lane.run_id);
      if (active.has(k)) return;
      insert.run({ path, ...lane });
      active.set(k, byKey.get(path, lane.run_id) as Tracked);
    },
    // A lane ended: keep reading briefly so its last records land, then stop watching it.
    finish(path: string, runId: string) {
      const t = active.get(key(path, runId));
      if (t) t.closeAt = Date.now() + 1500;
    },
    isKnown(path: string): boolean {
      return byPath.get(path) !== undefined;
    },
  };
}

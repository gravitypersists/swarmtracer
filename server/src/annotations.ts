import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { EventKind } from "../../shared/events.ts";
import type { Db } from "./db.ts";
import type { HookInput } from "./normalize.ts";

// Annotations from the `atl` CLI. The CLI only knows its session (subagents share the root's
// CLAUDE_CODE_SESSION_ID), so the lane comes from the Bash call that ran it: that call's
// PreToolUse hook is synchronous, so it has always reached us before atl's own request.

export interface OpenCall { toolUseId: string; agentId: string; command: string; ts: number }

export interface CliRequest {
  session_id: string;
  kind: "note" | "decision" | "blocked" | "artifact";
  text?: string;
  why?: string;
  argv?: string[];
  cwd?: string;
  client_ts?: number;
  // artifact only
  path?: string;
  name?: string;
  mime?: string;
  content_b64?: string;
}

const KINDS = new Set<EventKind>(["note", "decision", "blocked", "artifact"]);

export function isCliRequest(x: unknown): x is CliRequest {
  const r = x as CliRequest;
  return typeof r === "object" && r !== null && typeof r.session_id === "string" && KINDS.has(r.kind as EventKind);
}

// Quoting differs between the shell command and argv, so compare with quotes, backslashes and
// whitespace removed.
const norm = (s: string) => s.replace(/["'\\\s]/g, "");

// Which open Bash call ran this atl invocation? Prefer the one whose command contains every
// argument; among equals, the most recent. Calls that don't mention atl at all are never chosen.
export function resolveCaller(open: OpenCall[], argv: string[]): { call?: OpenCall; by: "command" | "recent" | "none" } {
  const candidates = open.filter((c) => /\batl\b/.test(c.command));
  if (!candidates.length) return { by: "none" };
  const args = argv.map(norm).filter(Boolean);
  const full = candidates.filter((c) => args.every((a) => norm(c.command).includes(a)));
  const latest = (cs: OpenCall[]) => cs.reduce((a, b) => (b.ts > a.ts ? b : a));
  return full.length ? { call: latest(full), by: "command" } : { call: latest(candidates), by: "recent" };
}

export function createAnnotations(db: Db, artifactDir: string) {
  const open = new Map<string, OpenCall & { sessionId: string }>(); // tool_use_id → open Bash call
  mkdirSync(artifactDir, { recursive: true });

  return {
    observe(h: HookInput) {
      const id = h.tool_use_id;
      if (h.hook_event_name === "PreToolUse" && h.tool_name === "Bash" && id) {
        open.set(id, {
          toolUseId: id, agentId: h.agent_id ?? h.session_id, sessionId: h.session_id,
          command: String((h.tool_input as any)?.command ?? ""), ts: Date.now(),
        });
      } else if ((h.hook_event_name === "PostToolUse" || h.hook_event_name === "PostToolUseFailure") && id) {
        open.delete(id);
      } else if (h.hook_event_name === "SessionEnd") {
        for (const [k, c] of open) if (c.sessionId === h.session_id) open.delete(k);
      }
    },

    record(req: CliRequest, ts: number) {
      const calls = [...open.values()].filter((c) => c.sessionId === req.session_id);
      const { call, by } = resolveCaller(calls, req.argv ?? []);
      const payload: Record<string, unknown> = {
        text: req.text ?? "", why: req.why, cwd: req.cwd, argv: req.argv,
        tool_use_id: call?.toolUseId, resolved_by: by,
      };
      if (req.kind === "artifact" && req.content_b64 !== undefined) {
        const bytes = Buffer.from(req.content_b64, "base64");
        const sha = createHash("sha256").update(bytes).digest("hex");
        writeFileSync(`${artifactDir}/${sha}`, bytes);
        Object.assign(payload, { sha256: sha, size: bytes.length, name: req.name, mime: req.mime, path: req.path });
      }
      // Without a matching call (e.g. --session from outside Claude Code) the root lane gets it.
      return db.append({
        ts, client_ts: req.client_ts, run_id: req.session_id, session_id: req.session_id,
        agent_id: call?.agentId ?? req.session_id, kind: req.kind, source: "cli", payload,
      });
    },
  };
}

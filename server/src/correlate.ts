import { readFile } from "node:fs/promises";
import { SPAWN_TOOLS } from "../../shared/events.ts";
import type { Db } from "./db.ts";
import type { HookInput } from "./normalize.ts";

// Links each subagent lane to the Agent tool call that spawned it.
//
// Primary: Claude Code writes <session transcript dir>/subagents/agent-<agent_id>.meta.json
// with the spawning call's `toolUseId`, which matches PreToolUse.tool_use_id in the parent.
// Confirmation/fallback: the Agent tool's PostToolUse carries tool_response.agentId.
// Last resort: if exactly one spawn in the session is unclaimed, take it.

type Method = "meta" | "tool_response" | "heuristic";

interface Spawn { parentAgentId: string; sessionId: string; childAgentId?: string }

const RETRY_MS = [0, 25, 50, 100, 200, 400, 800, 1600];

export function createCorrelator(db: Db, onLink: (msg: string) => void = () => {}) {
  const spawns = new Map<string, Spawn>(); // tool_use_id → spawn
  const linked = new Map<string, string>(); // child agent_id → tool_use_id

  function link(childAgentId: string, toolUseId: string, method: Method) {
    const spawn = spawns.get(toolUseId);
    if (!spawn) return false;
    const prior = linked.get(childAgentId);
    if (prior) {
      onLink(prior === toolUseId
        ? `confirm ${childAgentId} via ${method}`
        : `MISMATCH child=${childAgentId} ${prior} vs ${toolUseId} (${method})`);
      return true;
    }
    if (spawn.childAgentId && spawn.childAgentId !== childAgentId) {
      onLink(`MISMATCH spawn=${toolUseId} already has ${spawn.childAgentId}, got ${childAgentId} (${method})`);
      return false;
    }
    spawn.childAgentId = childAgentId;
    linked.set(childAgentId, toolUseId);
    db.append({
      ts: Date.now(),
      run_id: spawn.sessionId,
      session_id: spawn.sessionId,
      agent_id: childAgentId,
      parent_agent_id: spawn.parentAgentId,
      kind: "link",
      source: "server",
      payload: { tool_use_id: toolUseId, method },
    });
    onLink(`link ${spawn.parentAgentId} → ${childAgentId} via ${method}`);
    return true;
  }

  async function readMetaToolUseId(h: HookInput): Promise<string | undefined> {
    if (!h.transcript_path || !h.agent_id) return;
    const dir = h.transcript_path.replace(/\.jsonl$/, "");
    try {
      const meta = JSON.parse(await readFile(`${dir}/subagents/agent-${h.agent_id}.meta.json`, "utf8"));
      return typeof meta.toolUseId === "string" ? meta.toolUseId : undefined;
    } catch {
      return;
    }
  }

  async function onSubagentStart(h: HookInput) {
    const child = h.agent_id!;
    // Read meta even when tool_response already linked the child: link() then reports confirm/MISMATCH.
    for (const delay of RETRY_MS) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const id = await readMetaToolUseId(h);
      if (id && link(child, id, "meta")) return;
    }
    // No meta file. A foreground child's agentId only reaches PostToolUse when it finishes,
    // so guess now to get a live link; a later tool_response link reports any MISMATCH.
    if (linked.has(child)) return;
    const open = [...spawns.entries()].filter(([, s]) => s.sessionId === h.session_id && !s.childAgentId);
    if (open.length === 1) link(child, open[0][0], "heuristic");
    else onLink(`UNLINKED child=${child} (${open.length} open spawns)`);
  }

  return {
    observe(h: HookInput) {
      if (h.hook_event_name === "PreToolUse" && SPAWN_TOOLS.has(h.tool_name ?? "") && h.tool_use_id) {
        spawns.set(h.tool_use_id, { parentAgentId: h.agent_id ?? h.session_id, sessionId: h.session_id });
      } else if (h.hook_event_name === "SubagentStart" && h.agent_id) {
        void onSubagentStart(h);
      } else if (
        (h.hook_event_name === "PostToolUse" || h.hook_event_name === "PostToolUseFailure") &&
        SPAWN_TOOLS.has(h.tool_name ?? "") && h.tool_use_id
      ) {
        const agentId = (h.tool_response as any)?.agentId;
        if (typeof agentId === "string") link(agentId, h.tool_use_id, "tool_response");
      }
    },
  };
}

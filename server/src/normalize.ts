import { SPAWN_TOOLS, type EventKind } from "../../shared/events.ts";
import type { NewEvent } from "./db.ts";

// Raw hook input as Claude Code sends it on stdin. Only the fields we read are typed.
export interface HookInput {
  hook_event_name: string;
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  agent_transcript_path?: string;
  [k: string]: unknown;
}

export function isHookInput(x: unknown): x is HookInput {
  return (
    typeof x === "object" && x !== null &&
    typeof (x as any).hook_event_name === "string" &&
    typeof (x as any).session_id === "string"
  );
}

function kindFor(h: HookInput): EventKind {
  switch (h.hook_event_name) {
    case "SessionStart":
    case "SubagentStart":
      return "session_start";
    case "SessionEnd":
    case "SubagentStop":
      return "session_end";
    case "UserPromptSubmit":
      return "turn_start";
    case "Stop":
    case "StopFailure":
      return "turn_end";
    case "PreToolUse":
      return SPAWN_TOOLS.has(h.tool_name ?? "") ? "spawn" : "tool_start";
    case "PostToolUse":
    case "PostToolUseFailure":
      return "tool_end";
    case "PermissionRequest":
      return "permission_wait";
    default:
      return "other";
  }
}

// SubagentStart/SubagentStop describe the subagent itself, so agent_id is the lane.
// Every other event's agent_id (when present) is the subagent the event came from.
export function normalizeHook(h: HookInput, ts: number): NewEvent {
  return {
    ts,
    run_id: h.session_id,
    session_id: h.session_id,
    agent_id: h.agent_id ?? h.session_id,
    kind: kindFor(h),
    source: "hook",
    payload: h,
  };
}

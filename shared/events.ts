// Event schema v1. See BRIEF.md §4, plus the adjustments in docs/m0-findings.md.

export type EventKind =
  | "session_start" // root session started, or a subagent started
  | "session_end" // root session ended, or a subagent stopped
  | "turn_start" // UserPromptSubmit: the agent starts generating for a new prompt
  | "turn_end" // Stop / StopFailure: the agent finished responding and is idle
  | "tool_start"
  | "tool_end"
  | "spawn" // PreToolUse of the Agent tool: parent spawned a child
  | "link" // server-resolved parent/child correlation
  | "permission_wait" // PermissionRequest: blocked on the human
  | "reasoning" // transcript-derived text/thinking (M3)
  | "note"
  | "decision"
  | "artifact"
  | "blocked"
  | "unblocked"
  | "other"; // any hook event we record but don't interpret

export type EventSource = "hook" | "cli" | "transcript" | "server";

export interface AgentEvent {
  id: string; // server-assigned
  ts: number; // server receipt time, ms epoch — the ONLY time used for layout
  client_ts?: number; // informational
  run_id: string; // root session_id
  session_id: string; // Claude Code session_id (shared by a root and all its subagents)
  agent_id: string; // lane identity: the subagent's agent_id, or session_id for the root
  parent_agent_id?: string; // set on events whose parent is known at ingest time
  kind: EventKind;
  source: EventSource;
  payload: Record<string, unknown>;
}

// Tool names that spawn a subagent. "Task" is the pre-rename name.
export const SPAWN_TOOLS = new Set(["Agent", "Task"]);

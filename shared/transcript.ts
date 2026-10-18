// Parses Claude Code transcript JSONL records into the payload of `reasoning` events.
// Each assistant content block is written as its own record; blocks from one API response share
// message.id. Thinking is often stored empty (display "omitted"), which we keep and flag.

export type ReasoningBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; omitted: boolean }
  | { type: "tool_use"; id: string; name: string };

export interface ReasoningPayload {
  message_id: string;
  uuid: string;
  transcript_ts: number;
  blocks: ReasoningBlock[];
}

export function parseTranscriptRecord(line: string): ReasoningPayload | null {
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (rec?.type !== "assistant" || !Array.isArray(rec.message?.content)) return null;
  const blocks: ReasoningBlock[] = [];
  for (const b of rec.message.content) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
      blocks.push({ type: "text", text: b.text });
    } else if (b?.type === "thinking") {
      const text = typeof b.thinking === "string" ? b.thinking : "";
      blocks.push({ type: "thinking", text, omitted: !text });
    } else if (b?.type === "redacted_thinking") {
      blocks.push({ type: "thinking", text: "", omitted: true });
    } else if (b?.type === "tool_use" && typeof b.id === "string") {
      blocks.push({ type: "tool_use", id: b.id, name: String(b.name ?? "") });
    }
  }
  if (!blocks.length) return null;
  return {
    message_id: String(rec.message.id ?? rec.uuid),
    uuid: String(rec.uuid ?? ""),
    transcript_ts: Date.parse(rec.timestamp) || 0,
    blocks,
  };
}

// Where Claude Code keeps a subagent's transcript, next to its session's transcript.
export function subagentTranscriptPath(sessionTranscript: string, agentId: string): string {
  return `${sessionTranscript.replace(/\.jsonl$/, "")}/subagents/agent-${agentId}.jsonl`;
}

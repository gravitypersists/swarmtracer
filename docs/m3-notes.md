# M3 notes

Click any segment, lane label, marker or connector to open the side panel. Escape closes it.

## Transcript tailing (server)

- Hooks name every transcript we may read. The session's `transcript_path` comes with every event, and a subagent's file is `<session>/subagents/agent-<agent_id>.jsonl`, registered at `SubagentStart`. The tailer polls those files every 500 ms and emits one `reasoning` event per assistant record (text, thinking, and tool_use ids). It keeps partial lines for the next read.
- Offsets live in the `transcripts` table, so a restart resumes instead of re-emitting. The same table is the allowlist for `GET /transcript?path&from&to`; any other path gets a 403.
- A lane's file is read for 1.5 s after it ends, then dropped.
- **Live check** (`fixtures/m3-live-tail.json`, one real run, reported `total_cost_usd` 0.21): reasoning events arrived 0.15–2.1 s after Claude Code wrote each record. They matched a clean re-read of the finished files exactly, with nothing lost or duplicated.

## Attributing reasoning to segments (layout)

Each API response (records sharing `message.id`) goes to exactly one generating segment, in this order:

1. **By tool_use id (exact):** a response that called a tool belongs to the generation that ends at its first call's `PreToolUse`.
2. **By order:** a response with no tool call (a final answer, or a call the harness blocked before `PreToolUse`) must land after the previous tool-calling response's generation, and no later than the next one's.
3. **By time, within that window:** the transcript timestamp is mapped onto the hook clock by a line fitted through the step-1 matches. Live this is close to identity. For a replay it absorbs the time shift and speed-up, and tests check both.

Reasoning never affects geometry; a test checks this for every fixture. All responses in all fixtures are attributed, 46 of them by exact tool_use id.

## Panel

- **Generating:** thinking (or a note that Claude Code didn't keep it), text, and the calls the response made.
- **Tool:** each call's input and result, failures, and calls that needed permission but never returned.
- **Waiting:** the children being waited on, with links.
- **Lane:** a time-by-state breakdown (where the time went), the spawn prompt (task), and `last_assistant_message` (what it handed back).
- **Raw transcript:** a button fetches the excerpt for the span.

## Known limits

- In fixtures recorded before `PostToolBatch` was registered, a permission-denied call can hold a lane in "tool" until its next call. A response made during that time lands on the nearest generating segment.
- With a replay, the raw-transcript button's window is in replay time, so it usually comes back empty. Attribution is unaffected.

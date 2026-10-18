# M0 findings

Checked against the Claude Code hooks docs (code.claude.com/docs/en/hooks) and Claude Code 2.1.302 on 2026-10-17, then confirmed with real `claude -p` runs (`npm run spike`, `MODE=foreground npm run spike`).

## VERIFY items

| Brief assumption | Finding |
| --- | --- |
| Hook events | `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, and many more all exist. **There is a subagent-start event.** |
| Payload fields | Common: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id`, `agent_id`, `agent_type`. Tool events add `tool_name`, `tool_input`, `tool_use_id`; Post adds `tool_response`, `duration_ms`. `SubagentStop` adds `agent_transcript_path`, `last_assistant_message`. |
| Subagent tool name | `Agent` (`Task` is the old name; both are treated as spawns). |
| HTTP hooks | Native `type: "http"` exists. A connection failure is a "non-blocking error", not silent, so we use a command hook running `curl` that always exits 0. |
| Can hooks modify tool input | Yes: `PreToolUse` → `hookSpecificOutput.updatedInput` (replaces the whole input). Not needed for correlation. |
| Session ID in child shells | `CLAUDE_CODE_SESSION_ID` is set for Bash. **Subagents get the parent's value and no agent ID**, so `atl` cannot tell which subagent called it from env alone (see below). |
| Transcript format | JSONL, one record per message with `uuid`, `parentUuid`, `timestamp`, `sessionId`, `agentId`. Subagents write `<session>/subagents/agent-<agentId>.jsonl` plus a `.meta.json`. Thinking blocks are sometimes summarized text and sometimes empty with `thinkingDisplay: "omitted"`, so reasoning panels must handle both. |

## Correlation (§5.1): option 1 works, no prompt injection needed

Subagents do **not** get their own `session_id`. Every hook event inside a subagent carries the root's `session_id` plus its own `agent_id`. So:

- **Lane identity = `agent_id ?? session_id`.**
- **Parent link, live:** at `SubagentStart`, read `<transcript dir>/<session_id>/subagents/agent-<agent_id>.meta.json`. Its `toolUseId` equals the parent's `PreToolUse.tool_use_id` for the `Agent` call. It was readable 26–33 ms after `SubagentStart` in every run.
- **Parent link, confirmation:** the `Agent` call's `PostToolUse.tool_response.agentId`. This arrives immediately for background agents and at completion for foreground ones.
- The timing heuristic remains as a last resort and never fired.

Spike results: 3 parallel subagents in each mode. All children linked correctly, the two sources agreed in every case, and every child tool event carried the child's `agent_id`. With the server down, both runs succeeded with no hook errors and no slowdown (server-down runs: 13.1 s vs 15.3 s with the server up in foreground mode, 1.2 s vs 1.6 s in background mode).

## Design adjustments

1. **Schema:** add `agent_id` (the lane) and rename `parent_session_id` to `parent_agent_id`. `run_id` is just `session_id`. Add the kinds `turn_start` (UserPromptSubmit), `turn_end` (Stop/StopFailure), `link` (server-resolved parent/child, `source: "server"`), `permission_wait`, and `other`.
2. **`Stop` is not lane end.** It ends a *turn*. The root lane ends at `SessionEnd`, a subagent at `SubagentStop`.
3. **Background agents change `waiting_on_child`.** Under `-p` Claude backgrounded the agents by default. `Agent` Pre→Post took about 30 ms, the parent hit `Stop`, and each child's completion re-woke the parent with a fresh `UserPromptSubmit`. So "waiting on child" is: foreground = `Agent` Pre→Post; background = parent idle after `Stop` while it has live children. The meta file's `requestShape` (`foreground`/`background`) tells which.
4. **`atl` lane resolution (M4):** since the env has no agent ID, the server should match an `atl` POST (session id + argv) to the open `Bash` `tool_start` in that session whose command invoked `atl`. That event carries `agent_id`. A fallback is a PreToolUse hook that injects `SWARMTRACER_AGENT=<agent_id>` into `atl` commands via `updatedInput`.

## Fixtures

- `fixtures/m0-parallel-3-foreground.json`: blocking spawns, linked via meta.
- `fixtures/m0-parallel-3-default.json`: background spawns, linked via tool_response and confirmed by meta.
- `fixtures/m0-rate-limited-partial.json`: a run cut off by a usage limit. Two children never got `SubagentStop`, which tests lanes with no end.

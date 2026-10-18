# M1 notes

Static timeline: `npm run seed && npm start`, then open http://127.0.0.1:47821. The raw M0 log is at `/log`.

- `web/src/layout.ts`: the pure layout engine `(events, options) → lanes, segments, connectors, markers, gaps, scale`. It's tested in `layout.test.ts` against every fixture: segments tile each lane, overlapping lanes never share a column, no lane changes column as events arrive one at a time, and plus targeted cases.
- `web/src/render.ts`: a keyed SVG renderer that culls to the visible range. Hovering any element lists the events behind it. Clicking a gap expands it.

## What real runs taught the layout

- **Background spawns:** after `Stop`, the parent is `waiting_on_child` (not idle) while it has live children. The return connector lands where the parent wakes (`UserPromptSubmit`).
- **Subagent `StopFailure`** (e.g. a rate limit) is that lane's end. The lane is marked failed and never gets `SubagentStop`.
- **Denied tool calls never get `PostToolUse`.** Without handling, a lane looks stuck in "tool". `PostToolBatch` (now registered) closes the whole batch. In older recordings that lack it, a call that hit `PermissionRequest` closes at the lane's next tool call. `PermissionRequest` has no `tool_use_id`, so it is matched by tool name and input.
- **Claude Code blocks a standalone `sleep N`.** Long waits in practice are slow tools or idle time between turns.

## Fixtures

| File | Shows |
| --- | --- |
| `m0-parallel-3-foreground.json` | 3 blocking parallel spawns |
| `m0-parallel-3-default.json` | 3 background spawns, parent idle-waiting |
| `m0-rate-limited-partial.json` | 2 subagents killed by a usage limit |
| `m1-two-wave.json` | 2 parallel reviewers, then a third agent reusing a freed column; permission denials |
| `m1-long-wait.json` | a 40s blocking tool → one compressed gap |
| `m1-tool-failure.json` | a failing tool, `PostToolBatch` |

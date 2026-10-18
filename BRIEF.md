# SwarmTracer — Project Brief

A live, browser-based visualizer for multi-agent runs. Think of it as a vertical Gantt chart: time flows downward, each agent is a lane, and active agents grow in real time. Built first for Claude Code sessions (including subagents), with an agent-authored annotation layer on top.

This document is the kickoff spec. Read it fully before writing code. Sections marked **VERIFY** contain assumptions about external tools that must be checked against current documentation before building on them.

---

## 1. What it is

A small local server plus a browser page. You start it with one command and it opens a tab. Agents run normally; their activity streams into the page.

### The view

- **Vertical axis is time.** "Now" sits at the bottom. History scrolls up.
- **Each agent is a column (lane).** A lane starts when the agent starts and grows downward while it is alive. When the agent finishes, the lane stops growing and shows a terminal cap. The lane's height is its duration.
- **Lane segments encode state**, visually distinct:
  - `generating`: the LLM is producing output ("crunching"). Solid and bright, with a subtle animated texture while live.
  - `tool`: waiting on a tool call (file I/O, shell, web). Hatched or dimmer.
  - `waiting_on_child`: blocked on a spawned subagent. A thin dashed line.
  - `idle` / `sleeping`: an explicit wait. A faint dotted line.
- **Handoffs are drawn as connectors.** A parent's spawn point links to the child lane's start, and the child's completion links back to where the parent resumes.
- **Markers are dropped onto lanes at the moment they happen:** notes, decisions, artifacts, and blocked flags. Each kind has its own glyph. Clicking one opens a side panel with the full content.
- **Reasoning is inspectable.** Clicking a `generating` segment opens the transcript excerpt for that span (assistant text and thinking, where available).

### Questions it must answer at a glance

1. Where did the wall-clock time go?
2. Who is waiting on whom right now?
3. Is the orchestrator bottlenecked on its own generation between dispatches?
4. What did agent X know or decide at the moment it handed off?

If a design choice doesn't help answer one of these, cut it.

---

## 2. Core architectural principle

**The agent is not the source of truth for its own timeline.** Agents forget to report, have no reliable clock, and can't perceive their own generation time. So the work is split across two inputs:

| Input            | Source                                                                   | Provides                                                              |
| ---------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Ground truth** | Harness instrumentation (Claude Code hooks, plus tailing the transcript) | Lifecycle, timing, generating vs. tool states, spawns, reasoning text |
| **Annotations**  | Agent-authored, through a tiny CLI described in a skill                  | Notes, decisions, artifacts, blocked flags                            |

The server stamps every event with its own clock (`ts`) on receipt. Timestamps supplied by clients are stored but never used for layout.

### Deriving state from hooks

- `PreToolUse` → `PostToolUse` = **tool** segment
- `PostToolUse` → next `PreToolUse`, or `Stop` = **generating** segment
- The session's first prompt or start → first `PreToolUse` = **generating**
- `PreToolUse` where the tool is the subagent-spawning tool (Task/Agent) = **spawn** event. The parent enters `waiting_on_child` until the matching `PostToolUse`.
- `Stop` / `SubagentStop` = lane end

**VERIFY:** the exact hook event names, which ones exist (e.g. `SessionStart`, `SessionEnd`, `SubagentStop`, and whether there is a subagent-start event), payload fields (`session_id`, `transcript_path`, `tool_name`, `tool_input`, etc.), and the current name of the subagent tool. Also check whether hooks support an HTTP type natively or need a command hook that runs `curl`. Read the current Claude Code hooks documentation before implementing the ingestion layer.

---

## 3. Components

### 3.1 Server (`/server`)

- Node + TypeScript.
- HTTP endpoints:
  - `POST /events`: ingest a single event or a batch. Fire-and-forget from hooks. It must return quickly and never block the agent.
  - `GET /stream`: Server-Sent Events, which push new events to the browser.
  - `GET /runs`, `GET /runs/:id/events`: history for reloads and scrollback.
  - `GET /transcript?path=…&from=…&to=…`: transcript excerpt for a span. Restrict reads to known transcript paths reported by hooks; do not allow arbitrary file reads.
  - `POST /artifacts`: upload an artifact file or its contents.
- Storage: SQLite (`better-sqlite3`). One `events` table, append-only. Derived segments are computed on read or kept in memory; don't over-model early.
- Transcript tailing: when a session's `transcript_path` first appears, watch that JSONL file and emit `reasoning` events (assistant text and thinking blocks) linked to the session. **VERIFY** the transcript JSONL format and whether thinking appears raw, summarized, or not at all.
- Binds to `127.0.0.1` only. Default port configurable; pick something unlikely to collide.

### 3.2 Hook adapter (`/hooks`)

- A single script (Node or shell) that Claude Code invokes for every hook event. It reads the hook JSON from stdin, wraps it as an event, and POSTs it to the server with a short timeout.
- **It must never fail the hook.** If the server is down, it exits 0 silently. Instrumentation must not break the agent.
- Includes a ready-to-paste settings snippet for project-level Claude Code settings that registers the adapter on all relevant hook events.

### 3.3 Agent CLI + skill (`/cli`, `/skill`)

A tiny CLI so annotation costs the agent one shell call:

```
atl note "text"                 # free-form note to self/observers
atl decision "chose B" --why "A requires a migration"
atl artifact ./path/to/file     # attach a produced file
atl blocked "waiting on API key from user"
```

- It finds its session through an environment variable if one is available; otherwise it accepts `--session`. **VERIFY** whether Claude Code exposes the session ID to child shell processes. If not, decide on the correlation strategy described in §5.
- The skill (`SKILL.md`) is short. It says when to annotate: at decisions, at handoffs, when producing a deliverable, and when blocked. It also says when not to: no running commentary. Cap the vocabulary at these four verbs for v1.

### 3.4 Web UI (`/web`)

**No UI framework.** This UI is one large SVG redrawn as time advances. A virtual-DOM framework works against that, and the timeline would end up bypassing it anyway. The UI is vanilla TypeScript.

- **Build:** esbuild bundles `/web` into one JS file. The server serves a static `index.html` plus that bundle. The dev script runs esbuild in watch mode alongside the server. No framework in the dependency tree.
- **Layout engine** as a **pure function**: `(events, viewport, now) → { lanes, segments, connectors, markers }`. No DOM access. Unit-tested against fixture runs. This is where most of the logic lives.
- **Renderer:** a `requestAnimationFrame` loop that keys SVG elements by event/segment ID. It creates elements on first sight, updates attributes only when they change, and removes elements culled from the viewport. Finished segments are never touched again after their final update. Per frame, only live tips and the now-line change.
- **Rendering target:** SVG for v1, since it's simplest to inspect and style. Move hot paths to Canvas only if profiling shows a need, for example past about 50 lanes or 10k segments.
- **Side panel and run picker:** plain DOM with template strings. Adopt `lit-html` only if hand-written updates become tedious.
- **Escape hatch:** if the inspection side grows substantially (search across reasoning, run diffing, rich artifact previews), Preact or Solid may wrap the panel UI. The timeline core stays hand-rolled regardless.

---

## 4. Event schema (v1)

```ts
type EventKind =
  | "session_start"
  | "session_end"
  | "tool_start"
  | "tool_end"
  | "spawn" // parent spawned a child
  | "reasoning" // transcript-derived text/thinking
  | "note"
  | "decision"
  | "artifact"
  | "blocked"
  | "unblocked";

interface AgentEvent {
  id: string; // server-assigned
  ts: number; // server receipt time, ms epoch — the ONLY time used for layout
  client_ts?: number; // informational
  run_id: string; // top-level orchestration run
  session_id: string; // this agent
  parent_session_id?: string;
  kind: EventKind;
  source: "hook" | "cli" | "transcript";
  payload: Record<string, unknown>; // raw hook JSON, note text, artifact ref, etc.
}
```

`run_id` is the root session's ID. A child's `run_id` is inherited once it has been correlated to its parent.

---

## 5. Known hard problems (prototype these first)

### 5.1 Parent ↔ child correlation (highest risk)

The parent's spawn tool call and the child's own session ID may not be linked in any payload. Options, in order of preference:

1. A field in the hook payload links them directly. **VERIFY** first; this may already exist.
2. Inject a correlation token: a `PreToolUse` hook on the spawn tool rewrites or annotates the subagent prompt with `[atl:corr=<id>]`. The child's first event carries it, either from its prompt or its first `atl` call. **VERIFY** whether hooks can modify tool input.
3. Timing heuristic: a new session that appears within N ms of a spawn, in the same working directory, is that spawn's child. This is a fallback only, and it breaks with parallel spawns.

**Milestone 0 is proving one of these works with a real Claude Code session spawning 3 parallel subagents.**

### 5.2 Time scale

Linear time fails when one long wait dwarfs everything else. Implement **gap compression**: any span longer than a threshold where no lane changes state collapses to a fixed-height break marker labeled with its duration, for example "⋯ 18m". Active periods stay linear. The user can expand a gap. Add a zoom control that adjusts pixels per second.

### 5.3 Lane packing

Allocate columns with interval packing so finished lanes free their column for reuse. Constraint: place children near their parent, preferring adjacent free columns, so connectors stay short. The packing must be **stable**. A lane must never jump columns once placed, even while live.

### 5.4 Scroll behavior

Stick to the bottom (now) by default. When the user scrolls up, stop auto-scrolling and show a "↓ Live" pill. Clicking the pill, or scrolling back to the bottom, re-engages auto-scroll.

---

## 6. Milestones

**M0: Spike (correlation + ingestion).** Hook adapter, then the server, then a raw event log printed as a plain HTML list. Run Claude Code with 3 parallel subagents. Success means every event arrives, every child is correctly linked to its parent, and the agent's behavior is unaffected when the server is off.

**M1: Static timeline.** The layout engine and an SVG render of a _completed_ run loaded from SQLite: lanes, state segments, spawn connectors, gap compression. Layout engine unit tests written against recorded fixture runs. Commit 2–3 real recorded runs as fixtures.

**M2: Live.** SSE streaming, growing lanes, now-line, scroll stick and release behavior, run picker.

**M3: Inspectability.** Transcript tailing, reasoning segments, click-to-open side panel.

**M4: Annotations.** `atl` CLI, skill, marker glyphs, artifact upload and preview.

**M5: Polish.** Generating-state animation, legend, keyboard navigation, a summary strip (total wall time, generating vs. tool vs. waiting breakdown per agent).

Each milestone ends with a recorded fixture run and a screenshot committed to `/docs`.

---

## 7. Non-goals for v1

- Token or cost tracking. Add it later from transcript usage data if it's cheap.
- Non-Claude-Code harnesses. Keep the event schema generic, but only build the Claude Code adapter. A LangGraph or OpenTelemetry adapter can come later.
- Multi-user, auth, remote hosting. This is localhost only.
- Editing or controlling agents from the UI. It is read-only.

---

## 8. Design notes

- Visual language: think of a seismograph or rain on a window more than a corporate dashboard. Lanes should feel alive while running and settled when done. Keep color for _state_; identify agents by label, not hue.
- Dark mode first. People will leave this open beside a terminal.
- Live animation must be cheap: animate the live tip only, never re-layout the whole history every frame.
- Every visual element should be traceable to an event. Hovering anything shows the event(s) behind it. This makes the tool trustworthy and debuggable.

---

## 9. First session instructions (for Claude Code)

1. Read this whole brief.
2. Resolve every **VERIFY** item against current Claude Code documentation and report what you found, especially for §5.1, _before_ writing code. If an assumption is wrong, propose the adjusted design.
3. Propose the repo layout and dependency list. Keep dependencies minimal.
4. Build M0 only. Stop and show the results before starting M1.

// Layout engine: (events, options) → geometry. Pure; no DOM. See BRIEF.md §3.4 and §5.
//
// Time runs downward. Every y comes from a TimeScale that is linear in active periods and
// compresses long quiet spans (§5.2). Lanes get stable columns by interval packing (§5.3).
// Every output element lists the event ids behind it, for hover-to-trace.

import { SPAWN_TOOLS, type AgentEvent } from "../../shared/events.ts";

export type SegmentState = "generating" | "tool" | "waiting_on_child" | "idle" | "sleeping";

export interface Lane {
  id: string; // agent_id
  label: string;
  parentId?: string;
  column: number;
  start: number;
  end: number | null; // null while live
  truncated: boolean; // never reported its end (e.g. the run was cut off)
  failed: boolean; // ended on an API error (StopFailure)
  eventIds: string[];
}

export interface Segment {
  id: string;
  laneId: string;
  state: SegmentState;
  start: number;
  end: number | null; // null = live tip, grows with `now`
  label?: string; // tool name, sleep command, …
  eventIds: string[];
}

export interface Connector {
  id: string;
  kind: "spawn" | "return";
  fromLane: string;
  toLane: string;
  fromTs: number;
  toTs: number;
  eventIds: string[];
}

export type MarkerKind = "prompt" | "permission" | "error";

export interface Marker {
  id: string;
  laneId: string;
  kind: MarkerKind;
  ts: number;
  text: string;
  eventIds: string[];
}

export interface Gap {
  id: string;
  t0: number;
  t1: number;
  y0: number;
  y1: number;
  expanded: boolean;
  live?: boolean; // the quiet tail of a live run; t1 is `now`
}

export interface LayoutOptions {
  now: number; // live tips and live lanes extend to here
  pxPerSec: number;
  // A quiet span longer than this is drawn as if it lasted exactly this long. A live quiet tail
  // therefore grows smoothly up to that height and then holds, and no span ever shrinks when the
  // next event lands. Zoom scales gaps along with everything else.
  gapThresholdMs: number;
  expandedGaps: ReadonlySet<string>; // gap ids the user expanded
}

export const DEFAULT_OPTIONS: Omit<LayoutOptions, "now"> = {
  pxPerSec: 16,
  gapThresholdMs: 10_000,
  expandedGaps: new Set(),
};

export interface Layout {
  t0: number;
  lanes: Lane[];
  segments: Segment[];
  connectors: Connector[];
  markers: Marker[];
  gaps: Gap[];
  columns: number;
  scale: TimeScale;
  options: LayoutOptions;
}

// The quiet span after the last change, once it is long enough to count as a gap. It grows with
// `now`, so it lives outside layout() and the renderer asks for it every frame.
export function trailingGap(L: Layout, now: number): Gap | null {
  const t0 = L.scale.lastKnot;
  if (t0 === undefined || now - t0 <= L.options.gapThresholdMs) return null;
  const id = `gap-${t0}`;
  return { id, t0, t1: now, y0: L.scale.y(t0), y1: L.scale.y(now), expanded: L.options.expandedGaps.has(id), live: true };
}

// ---------------------------------------------------------------------------
// Time scale

interface Knot { t: number; y: number }

export class TimeScale {
  constructor(
    private knots: Knot[],
    readonly pxPerMs: number,
    private tailCapPx: number, // after the last knot (live quiet tail): Infinity = linear
  ) {}

  get lastKnot(): number | undefined {
    return this.knots.at(-1)?.t;
  }

  y(t: number): number {
    const k = this.knots;
    if (k.length === 0) return 0;
    if (t <= k[0].t) return k[0].y - (k[0].t - t) * this.pxPerMs;
    const last = k[k.length - 1];
    if (t >= last.t) return last.y + Math.min((t - last.t) * this.pxPerMs, this.tailCapPx);
    let lo = 0, hi = k.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (k[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = k[lo], b = k[hi];
    return a.y + ((t - a.t) / (b.t - a.t)) * (b.y - a.y);
  }
}

// Knots at every moment something changes; spans between consecutive change times longer than
// the threshold become gaps. The tail after the last change is linear, so live tips grow smoothly.
function buildScale(changeTimes: number[], o: LayoutOptions): { scale: TimeScale; gaps: Gap[] } {
  const times = [...new Set(changeTimes)].sort((a, b) => a - b);
  const pxPerMs = o.pxPerSec / 1000;
  const knots: Knot[] = [];
  const gaps: Gap[] = [];
  let y = 0;
  for (let i = 0; i < times.length; i++) {
    if (i > 0) {
      const t0 = times[i - 1], t1 = times[i], dt = t1 - t0;
      const id = `gap-${t0}`;
      if (dt > o.gapThresholdMs) {
        const expanded = o.expandedGaps.has(id);
        const y0 = y;
        y += (expanded ? dt : o.gapThresholdMs) * pxPerMs;
        gaps.push({ id, t0, t1, y0, y1: y, expanded });
      } else {
        y += dt * pxPerMs;
      }
    }
    knots.push({ t: times[i], y });
  }
  const last = times.at(-1);
  const tailCap = last !== undefined && o.expandedGaps.has(`gap-${last}`) ? Infinity : o.gapThresholdMs * pxPerMs;
  return { scale: new TimeScale(knots, pxPerMs, tailCap), gaps };
}

// ---------------------------------------------------------------------------
// Lanes

const hook = (e: AgentEvent) => e.payload.hook_event_name as string | undefined;

function laneLabel(events: AgentEvent[], spawn: AgentEvent | undefined, isRoot: boolean): string {
  if (isRoot) return "main";
  const desc = (spawn?.payload.tool_input as any)?.description;
  const type = events.find((e) => hook(e) === "SubagentStart")?.payload.agent_type;
  return String(desc ?? type ?? "subagent");
}

// ---------------------------------------------------------------------------
// Segments: a per-lane state machine over its hook events

function isSleep(e: AgentEvent): boolean {
  const input = e.payload.tool_input as any;
  return e.payload.tool_name === "Bash" && /^\s*sleep\s/.test(String(input?.command ?? ""));
}

function laneSegments(
  lane: Lane,
  events: AgentEvent[],
  liveChildren: (t: number) => boolean,
  childChange: number[],
  now: number,
): Segment[] {
  const out: Segment[] = [];
  const end = lane.end ?? now;
  type S = { state: SegmentState; label?: string };
  let cur: (S & { start: number; eventIds: string[] }) | null = null;

  const open = new Map<string, AgentEvent>(); // tool_use_id → tool_start/spawn
  const askedPermission = new Set<string>(); // open tool_use_ids that hit a PermissionRequest
  let turnActive = lane.parentId !== undefined; // subagents start generating at SubagentStart

  const stateAt = (t: number): S => {
    if (open.size > 0) {
      const tools = [...open.values()];
      // A blocking Agent call dominates: the lane is waiting on its child.
      const spawn = tools.find((e) => e.kind === "spawn");
      if (spawn) return { state: "waiting_on_child", label: "Agent" };
      if (tools.every(isSleep)) return { state: "sleeping", label: String((tools[0].payload.tool_input as any).command) };
      return { state: "tool", label: [...new Set(tools.map((e) => e.payload.tool_name))].join(", ") };
    }
    if (turnActive) return { state: "generating" };
    return liveChildren(t) ? { state: "waiting_on_child" } : { state: "idle" };
  };

  const transition = (t: number, ev?: AgentEvent) => {
    const next = stateAt(t);
    if (cur && cur.state === next.state && cur.label === next.label) {
      if (ev) cur.eventIds.push(ev.id);
      return;
    }
    // A zero-length state hands its events to the next segment instead of vanishing.
    const carried = cur && t <= cur.start ? cur.eventIds : [];
    if (cur && t > cur.start) out.push(finish(cur, t));
    cur = { ...next, start: t, eventIds: ev ? [...carried, ev.id] : carried };
  };
  const finish = (s: NonNullable<typeof cur>, t: number | null): Segment => ({
    id: `${lane.id}:${s.start}`,
    laneId: lane.id,
    state: s.state,
    label: s.label,
    start: s.start,
    end: t,
    eventIds: s.eventIds,
  });

  // Interleave the lane's own events with child start/end times (which can flip idle ↔ waiting).
  type Step = { t: number; ev?: AgentEvent };
  const steps: Step[] = [
    ...events.map((ev) => ({ t: ev.ts, ev })),
    ...childChange.filter((t) => t > lane.start && t < end).map((t) => ({ t })),
  ].sort((a, b) => a.t - b.t);

  transition(lane.start);
  for (const { t, ev } of steps) {
    if (t > end) break;
    if (ev) {
      const id = ev.payload.tool_use_id as string | undefined;
      switch (ev.kind) {
        case "turn_start": turnActive = true; break;
        case "turn_end": turnActive = false; open.clear(); break;
        case "tool_start":
        case "spawn":
          // A denied call never gets tool_end. Without PostToolBatch (older recordings), treat
          // the lane's next tool call as proof that a call stuck on permission was resolved.
          for (const k of askedPermission) open.delete(k);
          askedPermission.clear();
          if (id) open.set(id, ev);
          break;
        case "tool_end":
          if (id) open.delete(id);
          break;
        case "tool_batch_end":
          open.clear();
          askedPermission.clear();
          break;
        case "permission_wait": {
          // PermissionRequest has no tool_use_id; match the open call by tool and input.
          const key = JSON.stringify([ev.payload.tool_name, ev.payload.tool_input]);
          for (const [k, t] of open) {
            if (JSON.stringify([t.payload.tool_name, t.payload.tool_input]) === key) askedPermission.add(k);
          }
          break;
        }
      }
    }
    transition(t, ev);
  }
  if (cur) {
    const c = cur as NonNullable<typeof cur>;
    const final = lane.end === null ? null : lane.end;
    if (final === null || final > c.start) out.push(finish(c, final));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Column packing: lanes in start order; children prefer the free column nearest their parent.
// A column is free for a lane if every earlier occupant ended before the lane started. That
// depends only on facts known at the lane's start, so re-running layout never moves a lane.

function packColumns(lanes: Lane[]): number {
  const occupants: Lane[][] = [];
  const byId = new Map(lanes.map((l) => [l.id, l]));
  const isFree = (col: number, start: number) =>
    (occupants[col] ?? []).every((o) => o.end !== null && o.end < start);

  for (const lane of lanes) {
    const parent = lane.parentId ? byId.get(lane.parentId) : undefined;
    const home = parent ? parent.column : 0;
    let chosen = -1;
    for (let d = parent ? 1 : 0; chosen < 0; d++) {
      // Right of the parent first, then left; never beyond what's been used + 1.
      for (const c of d === 0 ? [home] : [home + d, home - d]) {
        if (c >= 0 && c <= occupants.length && isFree(c, lane.start)) { chosen = c; break; }
      }
    }
    lane.column = chosen;
    (occupants[chosen] ??= []).push(lane);
  }
  return occupants.length;
}

// ---------------------------------------------------------------------------

export function layout(all: AgentEvent[], o: LayoutOptions): Layout {
  const events = [...all].sort((a, b) => a.ts - b.ts || Number(a.id) - Number(b.id));
  const t0 = events[0]?.ts ?? o.now;
  const rootId = events[0]?.session_id;

  const byLane = new Map<string, AgentEvent[]>();
  for (const e of events) {
    if (e.kind === "link") continue;
    (byLane.get(e.agent_id) ?? byLane.set(e.agent_id, []).get(e.agent_id)!).push(e);
  }
  const links = new Map(events.filter((e) => e.kind === "link").map((e) => [e.agent_id, e]));
  const spawnsByToolUse = new Map(
    events.filter((e) => e.kind === "spawn").map((e) => [e.payload.tool_use_id as string, e]),
  );

  // Lanes
  const rootEvents = rootId ? byLane.get(rootId) ?? [] : [];
  const rootEnd = rootEvents.find((e) => e.kind === "session_end")?.ts ?? null;
  const lanes: Lane[] = [];
  for (const [id, evs] of byLane) {
    const isRoot = id === rootId;
    const link = links.get(id);
    const spawn = link ? spawnsByToolUse.get(link.payload.tool_use_id as string) : undefined;
    const startEv = evs.find((e) => e.kind === "session_start");
    // A subagent that hits an API error gets StopFailure and never SubagentStop.
    const failEv = isRoot ? undefined : evs.find((e) => hook(e) === "StopFailure");
    const endEv = evs.find((e) => e.kind === "session_end") ?? failEv;
    let end = endEv?.ts ?? null;
    let truncated = false;
    // A child that never reported its end is cut off where its run ended.
    if (end === null && !isRoot && rootEnd !== null) {
      end = Math.max(rootEnd, evs[evs.length - 1].ts);
      truncated = true;
    }
    lanes.push({
      id,
      label: laneLabel(evs, spawn, isRoot),
      parentId: link?.parent_agent_id ?? (isRoot ? undefined : rootId),
      column: 0,
      start: (startEv ?? evs[0]).ts,
      end,
      truncated,
      failed: !!failEv && endEv === failEv,
      eventIds: [startEv, endEv, link].filter(Boolean).map((e) => e!.id), // [start, end?, link?]
    });
  }
  lanes.sort((a, b) => a.start - b.start || (a.id === rootId ? -1 : 1));
  const columns = packColumns(lanes);
  const laneById = new Map(lanes.map((l) => [l.id, l]));

  // Segments
  const segments: Segment[] = [];
  for (const lane of lanes) {
    const kids = lanes.filter((l) => l.parentId === lane.id);
    const liveChildren = (t: number) => kids.some((k) => k.start <= t && (k.end === null || k.end > t));
    const childChange = kids.flatMap((k) => (k.end === null ? [k.start] : [k.start, k.end]));
    segments.push(...laneSegments(lane, byLane.get(lane.id) ?? [], liveChildren, childChange, o.now));
  }

  // Connectors: spawn point → child start; child end → where the parent resumes.
  const connectors: Connector[] = [];
  for (const lane of lanes) {
    const link = links.get(lane.id);
    const parent = lane.parentId ? laneById.get(lane.parentId) : undefined;
    if (!parent) continue;
    const spawn = link ? spawnsByToolUse.get(link.payload.tool_use_id as string) : undefined;
    connectors.push({
      id: `spawn:${lane.id}`,
      kind: "spawn",
      fromLane: parent.id,
      toLane: lane.id,
      fromTs: spawn?.ts ?? lane.start,
      toTs: lane.start,
      eventIds: [spawn, link].filter(Boolean).map((e) => e!.id),
    });
    if (lane.end === null || lane.truncated) continue;
    const parentEvents = byLane.get(parent.id) ?? [];
    // Foreground: the Agent call's PostToolUse. Background: the parent's next wake-up.
    const toolEnd = spawn && parentEvents.find(
      (e) => e.kind === "tool_end" && e.payload.tool_use_id === spawn.payload.tool_use_id && e.ts >= lane.end!,
    );
    const resume = toolEnd ?? parentEvents.find((e) => e.kind === "turn_start" && e.ts >= lane.end!);
    if (!resume) continue;
    connectors.push({
      id: `return:${lane.id}`,
      kind: "return",
      fromLane: lane.id,
      toLane: parent.id,
      fromTs: lane.end,
      toTs: resume.ts,
      eventIds: [lane.eventIds[1], resume.id],
    });
  }

  // Markers
  const markers: Marker[] = [];
  for (const e of events) {
    const h = hook(e);
    let kind: MarkerKind | null = null;
    let text = "";
    if (e.kind === "turn_start" && e.agent_id === rootId) {
      kind = "prompt";
      text = String(e.payload.prompt ?? "");
    } else if (e.kind === "permission_wait") {
      kind = "permission";
      text = `permission: ${e.payload.tool_name ?? ""}`;
    } else if (h === "PostToolUseFailure" || h === "StopFailure") {
      kind = "error";
      text = String(e.payload.error ?? h);
    }
    if (kind) markers.push({ id: `m:${e.id}`, laneId: e.agent_id, kind, ts: e.ts, text, eventIds: [e.id] });
  }

  // Scale: every segment boundary and event is a change. Live segments add no end time.
  const changes = [
    ...events.map((e) => e.ts),
    ...lanes.flatMap((l) => (l.end === null ? [l.start] : [l.start, l.end])),
  ];
  const { scale, gaps } = buildScale(changes, o);

  return { t0, lanes, segments, connectors, markers, gaps, columns, scale, options: o };
}

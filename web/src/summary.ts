// Summary strip: wall time, then one row per agent showing how long it ran (bar length, relative
// to the whole run) and how that time split across states (bar colors). Answers "where did the
// time go" and "is the orchestrator busy generating or waiting" without scrolling the timeline.
import { familyOf } from "./bots.ts";
import type { Layout, SegmentState } from "./layout.ts";
import { esc } from "./panel.ts";
import { fmtDur } from "./render.ts";

const ORDER: SegmentState[] = ["generating", "tool", "waiting_on_child", "sleeping", "idle"];
const SHORT: Record<SegmentState, string> = { generating: "gen", tool: "tool", waiting_on_child: "wait", sleeping: "sleep", idle: "idle" };

export function renderSummary(L: Layout, now: number): string {
  const end = L.lanes.reduce((m, l) => Math.max(m, l.end ?? now), L.t0);
  const wall = Math.max(1, end - L.t0);
  const rows = L.lanes.map((lane) => {
    const totals = new Map<SegmentState, number>();
    for (const s of L.segments) {
      if (s.laneId === lane.id) totals.set(s.state, (totals.get(s.state) ?? 0) + (s.end ?? now) - s.start);
    }
    const dur = Math.max(1, (lane.end ?? now) - lane.start);
    const parts = ORDER.filter((st) => totals.get(st));
    const bar = parts.map((st) => `<i class="bar-${st}" style="flex:${totals.get(st)}"></i>`).join("");
    const pct = parts.filter((st) => st !== "idle")
      .map((st) => `${SHORT[st]} ${Math.round((totals.get(st)! / dur) * 100)}%`).join(" · ");
    const fam = familyOf(lane.model);
    return `<button class="row${lane.end === null ? " running" : ""}" data-open-lane="${esc(lane.id)}" title="${esc(lane.model ?? "")}">
      <span class="name">${esc(lane.label)}</span><span class="fam">${fam === "claude" ? "" : fam}</span>
      <span class="track"><span class="fill" style="margin-left:${((lane.start - L.t0) / wall) * 100}%;width:${(dur / wall) * 100}%">${bar}</span></span>
      <span class="nums">${fmtDur(dur)} <span class="dim">${pct}</span></span>
    </button>`;
  });
  return rows.join("");
}

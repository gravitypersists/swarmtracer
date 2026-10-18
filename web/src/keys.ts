// Keyboard navigation over the timeline. Pure: given the layout and the current selection,
// returns the next selection; main.ts applies it and scrolls it into view.
import type { Layout, Segment } from "./layout.ts";
import type { Selection } from "./panel.ts";

export const HELP: [string, string][] = [
  ["↑ ↓  or  k j", "previous / next segment in the lane"],
  ["← →  or  h l", "same moment in the neighbouring lane"],
  ["Enter", "switch between a segment and its lane"],
  ["Esc", "close the panel"],
  ["g  /  G", "jump to the start / back to live"],
  ["+  /  −", "zoom in / out"],
  ["s", "show or hide the summary"],
  ["?", "this help"],
];

const laneSegs = (L: Layout, laneId: string) => L.segments.filter((s) => s.laneId === laneId);

function current(L: Layout, sel: Selection | null): Segment | undefined {
  if (sel?.kind === "segment") return L.segments.find((s) => s.id === sel.id);
  if (sel?.kind === "lane") return laneSegs(L, sel.id)[0];
  if (sel?.kind === "marker") {
    const m = L.markers.find((x) => x.id === sel.id);
    return m && laneSegs(L, m.laneId).find((s) => s.start <= m.ts && m.ts <= (s.end ?? Infinity));
  }
  return undefined;
}

export function navigate(L: Layout, sel: Selection | null, key: string): Selection | null {
  const seg = current(L, sel);
  if (!seg) {
    // Nothing selected yet: start from the main lane's latest segment.
    const root = L.lanes.find((l) => !l.parentId) ?? L.lanes[0];
    const last = root && laneSegs(L, root.id).at(-1);
    return last ? { kind: "segment", id: last.id } : null;
  }
  if (key === "Enter") {
    return sel?.kind === "lane" ? { kind: "segment", id: seg.id } : { kind: "lane", id: seg.laneId };
  }
  if (key === "ArrowUp" || key === "ArrowDown" || key === "k" || key === "j") {
    const segs = laneSegs(L, seg.laneId);
    const i = segs.indexOf(seg) + (key === "ArrowUp" || key === "k" ? -1 : 1);
    return segs[i] ? { kind: "segment", id: segs[i].id } : sel;
  }
  if (key === "ArrowLeft" || key === "ArrowRight" || key === "h" || key === "l") {
    const lane = L.lanes.find((l) => l.id === seg.laneId)!;
    const dir = key === "ArrowLeft" || key === "h" ? -1 : 1;
    const t = (seg.start + (seg.end ?? seg.start)) / 2;
    // Nearest lane in that direction that exists at this moment; else the nearest one at all.
    const side = L.lanes.filter((l) => Math.sign(l.column - lane.column) === dir)
      .sort((a, b) => Math.abs(a.column - lane.column) - Math.abs(b.column - lane.column));
    const target = side.find((l) => l.start <= t && t <= (l.end ?? Infinity)) ?? side[0];
    if (!target) return sel;
    const segs = laneSegs(L, target.id);
    const at = segs.find((s) => s.start <= t && t <= (s.end ?? Infinity)) ??
      segs.reduce((a, b) => (Math.abs(b.start - t) < Math.abs(a.start - t) ? b : a));
    return { kind: "segment", id: at.id };
  }
  return sel;
}

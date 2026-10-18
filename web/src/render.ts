// Keyed SVG renderer. Elements are created on first sight, touched only when an attribute
// changes, and removed when they leave the view. Geometry comes from layout.ts.

import { trailingGap, type Gap, type Layout, type Segment, type SegmentState } from "./layout.ts";

const SVG = "http://www.w3.org/2000/svg";

export const GEOMETRY = {
  axisWidth: 72, // time labels on the left
  pitch: 128, // px between lane centers
  top: 44, // room above t0 for the first lane label
  bottom: 48,
  barWidth: 10,
};

const STATE_CLASS: Record<SegmentState, string> = {
  generating: "seg-gen",
  tool: "seg-tool",
  waiting_on_child: "seg-wait",
  idle: "seg-idle",
  sleeping: "seg-sleep",
};

type Attrs = Record<string, string | number>;

export class Renderer {
  private els = new Map<string, { el: SVGElement; attrs: Attrs; text?: string }>();
  private seen = new Set<string>();
  readonly root: SVGSVGElement;
  private layers: Record<"gaps" | "axis" | "conn" | "lanes" | "marks" | "now", SVGGElement>;
  private L: Layout | null = null;
  private laneX = new Map<string, number>();
  private width = 0;

  constructor(container: HTMLElement) {
    this.root = document.createElementNS(SVG, "svg");
    this.root.innerHTML = `<defs>
      <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="4" height="4" class="hatch-bg"/><line x1="0" y1="0" x2="0" y2="4" class="hatch-line"/>
      </pattern></defs>`;
    const layer = (name: string) => {
      const g = document.createElementNS(SVG, "g");
      g.setAttribute("class", name);
      this.root.append(g);
      return g;
    };
    this.layers = {
      gaps: layer("gaps"), axis: layer("axis"), conn: layer("conn"), lanes: layer("lanes"), marks: layer("marks"), now: layer("now"),
    };
    container.append(this.root);
  }

  colX(column: number) {
    return GEOMETRY.axisWidth + GEOMETRY.pitch * (column + 0.5);
  }

  // Full pass, run when the layout or the scroll position changes. `view` is the visible y range
  // (plus margin); anything outside it is culled. Live elements are drawn by tick().
  render(L: Layout, now: number, view: { y0: number; y1: number }, live: boolean) {
    this.seen.clear();
    this.L = L;
    const y = (t: number) => GEOMETRY.top + L.scale.y(t);
    const visible = (a: number, b: number) => b >= view.y0 && a <= view.y1;
    const laneX = (this.laneX = new Map(L.lanes.map((l) => [l.id, this.colX(l.column)])));
    const width = (this.width = GEOMETRY.axisWidth + GEOMETRY.pitch * Math.max(L.columns, 1) + 24);
    this.root.setAttribute("width", String(width));

    for (const g of L.gaps) {
      if (visible(y(g.t0), y(g.t1))) this.gap(g);
    }

    // Time axis: a tick every `step` seconds, skipped inside compressed gaps.
    const end = Math.max(now, L.t0);
    const step = tickStep(L.scale.pxPerMs);
    for (let t = L.t0; t <= end; t += step) {
      if (L.gaps.some((g) => !g.expanded && t > g.t0 && t < g.t1)) continue;
      const ty = y(t);
      if (!visible(ty, ty)) continue;
      const k = `tick:${t - L.t0}`;
      this.put(k, "line", this.layers.axis, { x1: GEOMETRY.axisWidth - 6, x2: width, y1: ty, y2: ty, class: "tick" });
      this.put(`${k}:l`, "text", this.layers.axis, { x: GEOMETRY.axisWidth - 10, y: ty + 4, class: "tick-label" }, fmtDur(t - L.t0));
    }

    // Connectors
    for (const c of L.connectors) {
      const x0 = laneX.get(c.fromLane)!, x1 = laneX.get(c.toLane)!;
      const y0 = y(c.fromTs), y1 = y(c.toTs);
      if (!visible(Math.min(y0, y1), Math.max(y0, y1))) continue;
      const bend = Math.max(12, Math.abs(x1 - x0) * 0.35);
      // Leave and enter horizontally so near-simultaneous handoffs still read as a hop.
      const d = `M${x0},${y0} C${x0 + Math.sign(x1 - x0) * bend},${y0} ${x1 - Math.sign(x1 - x0) * bend},${y1} ${x1},${y1}`;
      this.put(`c:${c.id}`, "path", this.layers.conn, { d, class: `conn conn-${c.kind}`, "data-ids": c.eventIds.join(",") });
    }

    // Lanes: settled segments (live tips are tick()'s), a label at the start, a cap at the end.
    for (const s of L.segments) {
      if (s.end === null) continue;
      const y0 = y(s.start), y1 = y(s.end);
      if (!visible(y0, y1)) continue;
      this.segment(s, laneX.get(s.laneId)!, y0, y1);
    }
    for (const l of L.lanes) {
      const x = laneX.get(l.id)!;
      const ys = y(l.start);
      if (visible(ys - 30, ys)) {
        this.put(`lbl:${l.id}`, "text", this.layers.marks, {
          x, y: ys - 8, class: l.parentId ? "lane-label" : "lane-label root", "data-ids": l.eventIds.join(","),
        }, l.label);
      }
      if (l.end !== null && visible(y(l.end), y(l.end))) {
        const ye = y(l.end);
        const cls = l.failed ? "cap cap-failed" : l.truncated ? "cap cap-truncated" : "cap";
        this.put(`cap:${l.id}`, "line", this.layers.marks, {
          x1: x - 8, x2: x + 8, y1: ye, y2: ye, class: cls, "data-ids": l.eventIds.join(","),
        });
      }
    }

    // Markers sit just left of their lane.
    for (const m of L.markers) {
      const my = y(m.ts);
      if (!visible(my, my)) continue;
      const x = laneX.get(m.laneId);
      if (x === undefined) continue;
      const glyph = { prompt: "▸", permission: "◆", error: "✕" }[m.kind];
      this.put(m.id, "text", this.layers.marks, {
        x: x - GEOMETRY.barWidth - 4, y: my + 4, class: `marker marker-${m.kind}`, "data-ids": m.eventIds.join(","),
      }, glyph);
    }

    this.tick(now, live);

    // Cull everything not drawn this pass.
    for (const [k, v] of this.els) {
      if (!this.seen.has(k)) { v.el.remove(); this.els.delete(k); }
    }
  }

  // Per-frame pass: only what moves with the clock. Live tips, the quiet tail, the now-line, height.
  tick(now: number, live: boolean) {
    const L = this.L;
    if (!L) return;
    const y = (t: number) => GEOMETRY.top + L.scale.y(t);
    for (const s of L.segments) {
      if (s.end === null) this.segment(s, this.laneX.get(s.laneId)!, y(s.start), y(now));
    }
    const tail = live ? trailingGap(L, now) : null;
    if (tail) this.gap(tail);
    const end = Math.max(now, ...L.lanes.map((l) => l.end ?? now));
    if (live) {
      const ny = y(now);
      this.put("now", "line", this.layers.now, { x1: GEOMETRY.axisWidth - 6, x2: this.width, y1: ny, y2: ny, class: "now-line" });
      this.put("now:l", "text", this.layers.now, { x: GEOMETRY.axisWidth - 10, y: ny + 4, class: "now-label" }, "now");
    }
    this.root.setAttribute("height", String(y(end) + GEOMETRY.bottom));
  }

  // A band across all lanes with the duration it hides. A live tail's label counts up.
  private gap(g: Gap) {
    this.put(`gap:${g.id}`, "rect", this.layers.gaps, {
      x: 0, y: g.y0 + GEOMETRY.top, width: this.width, height: g.y1 - g.y0,
      class: g.expanded ? "gap gap-open" : g.live ? "gap gap-live" : "gap", "data-gap": g.id,
    });
    this.put(`gaplabel:${g.id}`, "text", this.layers.gaps, {
      x: 8, y: GEOMETRY.top + (g.y0 + g.y1) / 2 + 4, class: "gap-label", "data-gap": g.id,
    }, `${g.expanded ? "▾" : "⋯"} ${fmtDur(g.t1 - g.t0)}`);
  }

  private segment(s: Segment, x: number, y0: number, y1: number) {
    const live = s.end === null;
    const cls = `seg ${STATE_CLASS[s.state]}${live ? " live" : ""}`;
    const ids = s.eventIds.join(",");
    if (s.state === "generating" || s.state === "tool") {
      const w = GEOMETRY.barWidth;
      this.put(`s:${s.id}`, "rect", this.layers.lanes, {
        x: x - w / 2, y: y0, width: w, height: Math.max(1, y1 - y0), class: cls, "data-ids": ids, "data-seg": s.id,
      });
    } else {
      this.put(`s:${s.id}`, "line", this.layers.lanes, {
        x1: x, x2: x, y1: y0, y2: y1, class: cls, "data-ids": ids, "data-seg": s.id,
      });
    }
  }

  private put(key: string, tag: string, parent: SVGGElement, attrs: Attrs, text?: string) {
    this.seen.add(key);
    let entry = this.els.get(key);
    if (!entry) {
      const el = document.createElementNS(SVG, tag);
      parent.append(el);
      entry = { el, attrs: {} };
      this.els.set(key, entry);
    }
    for (const k in attrs) {
      if (entry.attrs[k] !== attrs[k]) {
        entry.el.setAttribute(k, String(attrs[k]));
        entry.attrs[k] = attrs[k];
      }
    }
    if (text !== undefined && entry.text !== text) {
      entry.el.textContent = text;
      entry.text = text;
    }
  }
}

// Pick the smallest "nice" step whose ticks are at least 48px apart in linear regions.
function tickStep(pxPerMs: number): number {
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]) {
    if (s * 1000 * pxPerMs >= 48) return s * 1000;
  }
  return 3600_000;
}

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m${String(s % 60).padStart(2, "0")}` : `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

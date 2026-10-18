// M1: static timeline of a completed run. Live updates arrive in M2.
import type { AgentEvent } from "../../shared/events.ts";
import { DEFAULT_OPTIONS, layout, type Layout, type LayoutOptions } from "./layout.ts";
import { fmtDur, Renderer } from "./render.ts";

interface RunSummary { run_id: string; started: number; last: number; events: number; agents: number }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scroller = $("timeline");
const tip = $("tip");
const runSel = $<HTMLSelectElement>("run");
const zoom = $<HTMLInputElement>("zoom");
const renderer = new Renderer(scroller);

let events: AgentEvent[] = [];
let byId = new Map<string, AgentEvent>();
let current: Layout | null = null;
const expanded = new Set<string>();

function options(now: number): LayoutOptions {
  return { ...DEFAULT_OPTIONS, now, pxPerSec: Number(zoom.value), expandedGaps: expanded };
}

function now() {
  return events.length ? events[events.length - 1].ts : Date.now();
}

function draw() {
  current = layout(events, options(now()));
  const top = scroller.scrollTop;
  renderer.render(current, now(), { y0: top - 400, y1: top + scroller.clientHeight + 400 });
  const end = current.lanes.reduce((m, l) => Math.max(m, l.end ?? now()), current.t0);
  $("summary").textContent = `${current.lanes.length} agents · ${fmtDur(end - current.t0)} wall`;
}

async function loadRun(id: string) {
  events = await (await fetch(`/runs/${encodeURIComponent(id)}/events`)).json();
  byId = new Map(events.map((e) => [e.id, e]));
  expanded.clear();
  history.replaceState(null, "", `?run=${encodeURIComponent(id)}`);
  draw();
}

async function init() {
  const runs: RunSummary[] = await (await fetch("/runs")).json();
  runSel.innerHTML = runs
    .map((r) => `<option value="${r.run_id}">${new Date(r.started).toLocaleString()} · ${r.agents} agents · ${fmtDur(r.last - r.started)}</option>`)
    .join("");
  const wanted = new URLSearchParams(location.search).get("run");
  const id = runs.find((r) => r.run_id === wanted)?.run_id ?? runs[0]?.run_id;
  if (id) { runSel.value = id; await loadRun(id); }
}

runSel.onchange = () => loadRun(runSel.value);
zoom.oninput = draw;
scroller.addEventListener("scroll", () => requestAnimationFrame(draw), { passive: true });
window.addEventListener("resize", draw);

// Gaps expand/collapse on click.
renderer.root.addEventListener("click", (e) => {
  const gap = (e.target as Element).closest("[data-gap]")?.getAttribute("data-gap");
  if (!gap) return;
  expanded.has(gap) ? expanded.delete(gap) : expanded.add(gap);
  draw();
});

// Hover anything: list the events behind it.
renderer.root.addEventListener("pointermove", (e) => {
  const el = (e.target as Element).closest("[data-ids]");
  const seg = el?.getAttribute("data-seg");
  const ids = el?.getAttribute("data-ids")?.split(",").filter(Boolean) ?? [];
  if (!el || !current) { tip.hidden = true; return; }
  const s = seg ? current.segments.find((x) => x.id === seg) : undefined;
  const t0 = current.t0;
  const head = s
    ? `<b>${s.state.replace(/_/g, " ")}</b>${s.label ? ` · ${esc(s.label)}` : ""} · ${fmtDur((s.end ?? now()) - s.start)} <span class="dim">(+${fmtDur(s.start - t0)})</span>`
    : "";
  const rows = ids.map((id) => byId.get(id)).filter(Boolean).map((ev) => {
    const p = ev!.payload as any;
    const what = [p.hook_event_name ?? ev!.kind, p.tool_name, p.tool_input?.description ?? p.tool_input?.command]
      .filter(Boolean).map((x) => esc(String(x).slice(0, 80))).join(" · ");
    return `<div><span class="dim">#${ev!.id} +${((ev!.ts - t0) / 1000).toFixed(2)}s</span> ${what}</div>`;
  });
  tip.innerHTML = head + rows.join("");
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.min(e.clientY + 14, innerHeight - r.height - 8)}px`;
});
renderer.root.addEventListener("pointerleave", () => (tip.hidden = true));

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

init();

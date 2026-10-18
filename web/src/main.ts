// Timeline page: loads a run, follows it live over SSE, and keeps "now" in view.
import type { AgentEvent } from "../../shared/events.ts";
import { DEFAULT_OPTIONS, layout, type Layout, type LayoutOptions } from "./layout.ts";
import { fmtDur, Renderer } from "./render.ts";
import { renderExcerpt, renderPanel, type Selection } from "./panel.ts";

interface RunSummary { run_id: string; started: number; last: number; events: number; agents: number; ended: number }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scroller = $("timeline");
const tip = $("tip");
const runSel = $<HTMLSelectElement>("run");
const zoom = $<HTMLInputElement>("zoom");
const pill = $<HTMLButtonElement>("live-pill");
const panel = $("panel");
const panelBody = $("panel-body");
let selection: Selection | null = null;
const renderer = new Renderer(scroller);

let runId: string | null = null;
let events: AgentEvent[] = [];
let byId = new Map<string, AgentEvent>();
let live = false; // the run's root session hasn't ended
let current: Layout | null = null;
let dirty = false; // events or options changed: re-run layout on the next frame
let lastFull = 0; // time of the last full render pass
let renderedTop = 0; // scrollTop at the last full render pass
let stream: EventSource | null = null;
let sticky = true; // follow "now" at the bottom
let runs: RunSummary[] = [];
const expanded = new Set<string>();

const lastTs = () => (events.length ? events[events.length - 1].ts : Date.now());
const now = () => (live ? Math.max(Date.now(), lastTs()) : lastTs());

function options(): LayoutOptions {
  return { ...DEFAULT_OPTIONS, now: now(), pxPerSec: Number(zoom.value), expandedGaps: expanded };
}

function view() {
  const top = (renderedTop = scroller.scrollTop);
  return { y0: top - 400, y1: top + scroller.clientHeight + 400 };
}

// One loop for everything. Layout only runs when events or options changed; between those, a
// live run costs one tick() per frame (live tips, quiet tail, now-line) plus a full pass a second
// to refresh axis ticks.
function frame(t: number) {
  if (dirty) {
    current = layout(events, options());
    renderer.render(current, now(), view(), live);
    updateSummary();
    if (selection) showPanel(); // new events can change what the open panel shows
    dirty = false;
    lastFull = t;
  } else if (current && live) {
    if (t - lastFull > 1000) {
      renderer.render(current, now(), view(), live);
      updateSummary();
      lastFull = t;
    } else {
      renderer.tick(now(), live);
    }
  }
  if (sticky) scroller.scrollTop = scroller.scrollHeight;
  requestAnimationFrame(frame);
}

function updateSummary() {
  if (!current) return;
  const end = current.lanes.reduce((m, l) => Math.max(m, l.end ?? now()), current.t0);
  $("summary").textContent = `${live ? "● live · " : ""}${current.lanes.length} agents · ${fmtDur(end - current.t0)} wall`;
}

function ingest(e: AgentEvent) {
  if (byId.has(e.id)) return;
  byId.set(e.id, e);
  events.push(e);
  if (e.kind === "session_end" && e.agent_id === e.run_id) live = false;
  dirty = true;
}

async function loadRun(id: string) {
  stream?.close();
  runId = id;
  events = [];
  byId = new Map();
  expanded.clear();
  select(null);
  sticky = true;
  history.replaceState(null, "", `?run=${encodeURIComponent(id)}`);
  const past: AgentEvent[] = await (await fetch(`/runs/${encodeURIComponent(id)}/events`)).json();
  if (runId !== id) return; // another run was picked meanwhile
  live = !past.some((e) => e.kind === "session_end" && e.agent_id === e.run_id);
  past.forEach(ingest);
  dirty = true;
  if (!live) return;
  const after = past.length ? past[past.length - 1].id : "0";
  stream = new EventSource(`/stream?run=${encodeURIComponent(id)}&after=${after}`);
  stream.onmessage = (m) => ingest(JSON.parse(m.data));
}

async function refreshRuns() {
  runs = await (await fetch("/runs")).json();
  runSel.innerHTML = runs
    .map((r) => `<option value="${r.run_id}">${r.ended ? "" : "● "}${new Date(r.started).toLocaleString()} · ${r.agents} agents · ${fmtDur(r.last - r.started)}</option>`)
    .join("");
  if (runId) runSel.value = runId;
}

async function init() {
  await refreshRuns();
  const wanted = new URLSearchParams(location.search).get("run");
  const id = runs.find((r) => r.run_id === wanted)?.run_id ?? runs[0]?.run_id;
  if (id) await loadRun(id);

  // Watch for new runs. With nothing selected yet, jump to the first one that appears.
  const all = new EventSource("/stream");
  all.onmessage = (m) => {
    const e: AgentEvent = JSON.parse(m.data);
    if (runs.some((r) => r.run_id === e.run_id)) return;
    runs.push({ run_id: e.run_id } as RunSummary); // placeholder until the refresh lands
    refreshRuns().then(() => { if (!runId) loadRun(e.run_id); });
  };
}

runSel.onchange = () => loadRun(runSel.value);
zoom.oninput = () => (dirty = true);
window.addEventListener("resize", () => (dirty = true));

// Scrolling: any scroll that leaves the bottom releases the stick; reaching the bottom re-engages.
scroller.addEventListener("scroll", () => {
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4;
  sticky = atBottom;
  pill.hidden = atBottom || !live;
  // Sticky following scrolls every frame; only re-cull once the view has moved past the margin.
  if (current && Math.abs(scroller.scrollTop - renderedTop) > 200) renderer.render(current, now(), view(), live);
}, { passive: true });
pill.onclick = () => {
  sticky = true;
  pill.hidden = true;
};

// Clicks: gaps expand/collapse; segments, lanes and markers open the panel.
renderer.root.addEventListener("click", (e) => {
  const t = e.target as Element;
  const gap = t.closest("[data-gap]")?.getAttribute("data-gap");
  if (gap) {
    expanded.has(gap) ? expanded.delete(gap) : expanded.add(gap);
    dirty = true;
    return;
  }
  const seg = t.closest("[data-seg]")?.getAttribute("data-seg");
  const lane = t.closest("[data-lane]")?.getAttribute("data-lane");
  const marker = t.closest("[data-marker]")?.getAttribute("data-marker");
  select(seg ? { kind: "segment", id: seg } : marker ? { kind: "marker", id: marker } : lane ? { kind: "lane", id: lane } : null);
});

function select(sel: Selection | null) {
  selection = sel;
  renderer.selected = !sel ? null : sel.kind === "lane" ? `lane:${sel.id}` : sel.id;
  panel.hidden = !sel;
  if (sel) showPanel();
  dirty = true; // redraw the selection highlight
}

function showPanel() {
  if (!selection || !current) return;
  // Keep an excerpt the user already opened; it is fetched on demand and doesn't change live.
  const excerpt = panelBody.querySelector(".excerpt-out")?.innerHTML;
  const key = `${selection.kind}:${selection.id}`;
  const scroll = panelBody.dataset.key === key ? panelBody.scrollTop : 0;
  panelBody.innerHTML = renderPanel(selection, { L: current, byId, events, now: now() });
  const out = panelBody.querySelector(".excerpt-out");
  if (excerpt && out && panelBody.dataset.key === key) out.innerHTML = excerpt;
  panelBody.dataset.key = key;
  panelBody.scrollTop = scroll;
}

panel.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("#panel-close")) return select(null);
  const lane = t.closest("[data-open-lane]")?.getAttribute("data-open-lane");
  if (lane) {
    e.preventDefault();
    return select({ kind: "lane", id: lane });
  }
  const btn = t.closest<HTMLButtonElement>("[data-excerpt]");
  if (btn) {
    const q = new URLSearchParams({ path: btn.dataset.excerpt!, from: btn.dataset.from!, to: btn.dataset.to! });
    const out = btn.nextElementSibling as HTMLElement;
    out.innerHTML = `<p class="dim">Loading…</p>`;
    const res = await fetch(`/transcript?${q}`);
    out.innerHTML = res.ok ? renderExcerpt(await res.json()) : `<p class="err">Couldn't read the transcript (${res.status}).</p>`;
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selection) select(null);
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
    ? `<b>${s.state.replace(/_/g, " ")}</b>${s.label ? ` · ${esc(s.label)}` : ""} · ${fmtDur((s.end ?? now()) - s.start)}${s.end === null ? " (live)" : ""} <span class="dim">(+${fmtDur(s.start - t0)})</span>`
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
requestAnimationFrame(frame);
setInterval(refreshRuns, 5000); // picker labels: agent counts and durations of live runs

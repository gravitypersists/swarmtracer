// Timeline page: loads a run, follows it live over SSE, and keeps "now" in view.
import type { AgentEvent } from "../../shared/events.ts";
import { DEFAULT_OPTIONS, layout, type Layout, type LayoutOptions } from "./layout.ts";
import { fmtDur, GEOMETRY, Renderer } from "./render.ts";
import { esc as escHtml, renderExcerpt, renderPanel, type Selection } from "./panel.ts";
import { renderSummary } from "./summary.ts";
import { HELP, navigate } from "./keys.ts";

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

const strip = $("strip");
function updateSummary() {
  if (!current) return;
  const end = current.lanes.reduce((m, l) => Math.max(m, l.end ?? now()), current.t0);
  $("summary").textContent = `${live ? "● live · " : ""}${current.lanes.length} agents · ${fmtDur(end - current.t0)} wall`;
  if (!strip.hidden) strip.innerHTML = renderSummary(current, now());
}

// The strip's open/closed state is a per-viewer convenience; storage may be unavailable.
function setStrip(open: boolean) {
  strip.hidden = !open;
  try { localStorage.setItem("swarmtracer.strip", open ? "1" : "0"); } catch {}
  updateSummary();
}
try { strip.hidden = localStorage.getItem("swarmtracer.strip") === "0"; } catch {}
$("strip-toggle").onclick = () => setStrip(strip.hidden !== false);
strip.addEventListener("click", (e) => {
  const lane = (e.target as Element).closest("[data-open-lane]")?.getAttribute("data-open-lane");
  if (lane) select({ kind: "lane", id: lane });
});

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
  // Opened as an app window by `swarmtracer open`: size it once (a tab ignores this). loadRun's
  // replaceState drops the flag, so a reload keeps whatever size you've since chosen.
  if (new URLSearchParams(location.search).has("popup")) window.resizeTo(900, 600);
  await refreshRuns();
  const wanted = new URLSearchParams(location.search).get("run");
  const id = runs.find((r) => r.run_id === wanted)?.run_id ?? runs[0]?.run_id;
  if (id) await loadRun(id);

  // Watch for new runs and follow one when it starts, unless you're watching a run that's still
  // live: a finished run on screen shouldn't hide a new one starting.
  const all = new EventSource("/stream");
  all.onmessage = (m) => {
    const e: AgentEvent = JSON.parse(m.data);
    if (runs.some((r) => r.run_id === e.run_id)) return;
    runs.push({ run_id: e.run_id } as RunSummary); // placeholder until the refresh lands
    const follow = !runId || !live;
    refreshRuns().then(() => { if (follow) loadRun(e.run_id); });
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
  for (const pre of panelBody.querySelectorAll<HTMLElement>("[data-preview]")) {
    const src = pre.dataset.preview!;
    if (previews.has(src)) { pre.textContent = previews.get(src)!; continue; }
    fetch(src).then((r) => (r.ok ? r.text() : Promise.reject(r.status))).then(
      (t) => { previews.set(src, t); pre.textContent = t; },
      () => { pre.textContent = "Preview unavailable."; },
    );
  }
}
const previews = new Map<string, string>(); // artifacts are content-addressed, so cache forever

panel.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("#panel-close")) return select(null);
  const lane = t.closest("[data-open-lane]")?.getAttribute("data-open-lane");
  if (lane) {
    e.preventDefault();
    return select({ kind: "lane", id: lane });
  }
  const marker = t.closest("[data-open-marker]")?.getAttribute("data-open-marker");
  if (marker) {
    e.preventDefault();
    return select({ kind: "marker", id: marker });
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
// Keyboard: see HELP in keys.ts.
const help = $("help");
help.innerHTML = `<h2>Keyboard</h2><dl>${HELP.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join("")}</dl>`;
$("help-toggle").onclick = () => (help.hidden = !help.hidden);
window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof Element && e.target.closest("input, select, textarea");
  if (e.metaKey || e.ctrlKey || e.altKey || typing) return;
  if (e.key === "Escape") {
    if (!help.hidden) help.hidden = true;
    else if (selection) select(null);
    return;
  }
  if (e.key === "?") { help.hidden = !help.hidden; return; }
  if (e.key === "s") { setStrip(strip.hidden !== false); return; }
  if (e.key === "+" || e.key === "=" || e.key === "-") {
    zoom.value = String(Number(zoom.value) * (e.key === "-" ? 0.8 : 1.25));
    dirty = true;
    return;
  }
  if (e.key === "g") { sticky = false; scroller.scrollTop = 0; return; }
  if (e.key === "G" || e.key === "End") { sticky = true; pill.hidden = true; return; }
  if (!current || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "h", "j", "k", "l", "Enter"].includes(e.key)) return;
  e.preventDefault();
  const next = navigate(current, selection, e.key);
  if (!next) return;
  select(next);
  revealSelection();
});

// Scroll a keyboard-chosen segment into view, releasing the live stick if it's off-screen.
function revealSelection() {
  if (!current || selection?.kind !== "segment") return;
  const s = current.segments.find((x) => x.id === selection!.id);
  if (!s) return;
  const y0 = GEOMETRY.top + current.scale.y(s.start), y1 = GEOMETRY.top + current.scale.y(s.end ?? now());
  const top = scroller.scrollTop, h = scroller.clientHeight;
  if (y0 >= top + 20 && y1 <= top + h - 20) return;
  sticky = false;
  scroller.scrollTop = Math.max(0, (y0 + y1) / 2 - h / 2);
}

// Hover anything: list the events behind it.
renderer.root.addEventListener("pointermove", (e) => {
  const bot = (e.target as Element).closest(".bot");
  if (bot && current) {
    const lane = current.lanes.find((l) => l.id === bot.getAttribute("data-lane"));
    const state = [...bot.classList].find((c) => c.startsWith("bot-") && c !== `bot-${bot.getAttribute("data-family")}`)?.slice(4) ?? "";
    tip.innerHTML = `<b>${esc(lane?.label ?? "")}</b> · ${esc(bot.getAttribute("data-model") || "model not known yet")} · ${esc(state.replace(/_/g, " "))}`;
    tip.hidden = false;
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14}px`;
    return;
  }
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
    const what = [p.hook_event_name ?? ev!.kind, p.tool_name, p.tool_input?.description ?? p.tool_input?.command ?? p.name ?? p.text]
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

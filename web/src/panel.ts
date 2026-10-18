// Side panel: details for a clicked segment, lane, or marker. Plain template strings.
import type { AgentEvent } from "../../shared/events.ts";
import type { ReasoningBlock } from "../../shared/transcript.ts";
import { subagentTranscriptPath } from "../../shared/transcript.ts";
import { ANNOTATIONS, type Lane, type Layout, type Segment, type SegmentState } from "./layout.ts";
import { fmtDur } from "./render.ts";

export type Selection = { kind: "segment" | "lane" | "marker"; id: string };

interface Ctx { L: Layout; byId: Map<string, AgentEvent>; events: AgentEvent[]; now: number }

const STATE_LABEL: Record<SegmentState, string> = {
  generating: "generating", tool: "tool", waiting_on_child: "waiting on child", idle: "idle", sleeping: "sleeping",
};

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const clip = (s: string, n = 3000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s);
const when = (c: Ctx, t: number) => `+${fmtDur(t - c.L.t0)}`;
const laneLink = (l: Lane) => `<a href="#" data-open-lane="${esc(l.id)}">${esc(l.label)}</a>`;

export function renderPanel(sel: Selection, c: Ctx): string {
  if (sel.kind === "lane") {
    const lane = c.L.lanes.find((l) => l.id === sel.id);
    return lane ? lanePanel(lane, c) : "";
  }
  if (sel.kind === "marker") {
    const m = c.L.markers.find((x) => x.id === sel.id);
    if (!m) return "";
    const lane = c.L.lanes.find((l) => l.id === m.laneId);
    const ev = c.byId.get(m.eventIds[0]);
    if (ev && ANNOTATIONS.has(ev.kind)) return annotationPanel(ev, lane, c);
    return `<header><span class="badge badge-${m.kind}">${m.kind}</span><h2>${lane ? laneLink(lane) : ""}</h2>
      <p class="dim">${when(c, m.ts)}</p></header><pre class="body">${esc(clip(m.text))}</pre>`;
  }
  const seg = c.L.segments.find((s) => s.id === sel.id);
  return seg ? segmentPanel(seg, c) : "";
}

const ANNOTATION_LABEL: Record<string, string> = { note: "note", decision: "decision", artifact: "artifact", blocked: "blocked" };

function annotationPanel(ev: AgentEvent, lane: Lane | undefined, c: Ctx): string {
  const p = ev.payload as any;
  const head = `<header><span class="badge badge-${ev.kind}">${ANNOTATION_LABEL[ev.kind]}</span>
    <h2>${lane ? laneLink(lane) : ""}</h2><p class="dim">${when(c, ev.ts)}${p.resolved_by === "recent" ? " · lane matched by timing, not by command" : p.resolved_by === "none" ? " · no calling agent found; shown on the main lane" : ""}</p></header>`;
  if (ev.kind === "artifact") {
    return head + `${p.text ? `<div class="prose">${esc(p.text)}</div>` : ""}
      <p><a href="/artifacts/${esc(p.sha256)}" target="_blank" rel="noopener">${esc(p.name)}</a> <span class="dim">${fmtBytes(p.size)} · ${esc(p.mime)}</span></p>
      <p class="dim">${esc(p.path)}</p>${artifactPreview(p)}`;
  }
  return head + `<div class="prose">${esc(p.text)}</div>${p.why ? `<h3>Why</h3><div class="prose">${esc(p.why)}</div>` : ""}`;
}

// Images inline; text-like files are fetched into a <pre> by main.ts; anything else is a link.
function artifactPreview(p: any): string {
  const mime = String(p.mime ?? "");
  if (mime.startsWith("image/")) return `<img class="artifact-img" src="/artifacts/${esc(p.sha256)}" alt="${esc(p.name)}">`;
  if ((mime.startsWith("text/") || mime === "application/json") && p.size <= 256 * 1024) {
    return `<pre class="artifact-text" data-preview="/artifacts/${esc(p.sha256)}">Loading…</pre>`;
  }
  return "";
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

function segmentPanel(s: Segment, c: Ctx): string {
  const lane = c.L.lanes.find((l) => l.id === s.laneId)!;
  const end = s.end ?? c.now;
  const head = `<header>
    <span class="badge badge-${s.state}">${STATE_LABEL[s.state]}</span>
    <h2>${laneLink(lane)}</h2>
    <p class="dim">${when(c, s.start)} → ${s.end === null ? "now" : when(c, end)} · ${fmtDur(end - s.start)}${s.end === null ? " · live" : ""}</p>
  </header>`;
  let body = "";
  if (s.state === "generating") body = generatingBody(s, c);
  else if (s.state === "tool" || s.state === "sleeping") body = toolBody(s, c);
  else if (s.state === "waiting_on_child") body = waitingBody(s, lane, c);
  else body = `<p class="dim">Idle: the turn ended and the agent is waiting for its next prompt.</p>`;
  return head + body + excerptButton(lane, s, c);
}

function generatingBody(s: Segment, c: Ctx): string {
  const records = (c.L.reasoning[s.id] ?? []).map((id) => c.byId.get(id)!).filter(Boolean);
  if (!records.length) {
    return `<p class="dim">${s.end === null ? "Nothing from the transcript yet; it arrives as Claude Code writes it." : "No transcript record for this span."}</p>`;
  }
  const blocks = records.flatMap((r) => r.payload.blocks as ReasoningBlock[]);
  return blocks.map((b) => {
    if (b.type === "thinking") {
      return b.omitted
        ? `<p class="note">Thinking happened here, but Claude Code didn't keep the text.</p>`
        : `<details class="thinking" open><summary>thinking</summary><div class="prose">${esc(b.text)}</div></details>`;
    }
    if (b.type === "text") return `<div class="prose">${esc(b.text)}</div>`;
    return `<p class="call">→ ${esc(b.name)}</p>`;
  }).join("");
}

function toolBody(s: Segment, c: Ctx): string {
  const starts = s.eventIds.map((id) => c.byId.get(id)!).filter((e) => e && (e.kind === "tool_start" || e.kind === "spawn"));
  // A segment that began mid-batch lists no tool_start of its own; show what was open at its start.
  const calls = starts.length ? starts : c.events.filter((e) =>
    e.agent_id === s.laneId && e.kind === "tool_start" && e.ts <= s.start &&
    !c.events.some((x) => x.kind === "tool_end" && x.payload.tool_use_id === e.payload.tool_use_id && x.ts <= s.start));
  if (!calls.length) return `<p class="dim">No tool call recorded for this span.</p>`;
  return calls.map((pre) => {
    const p = pre.payload as any;
    const post = c.events.find((e) => e.kind === "tool_end" && e.payload.tool_use_id === p.tool_use_id);
    const denied = !post && c.events.some((e) => e.kind === "permission_wait" && e.agent_id === pre.agent_id &&
      JSON.stringify(e.payload.tool_input) === JSON.stringify(p.tool_input));
    const status = post
      ? post.payload.hook_event_name === "PostToolUseFailure" ? `<span class="err">failed</span> after ${fmtDur(post.ts - pre.ts)}` : `took ${fmtDur(post.ts - pre.ts)}`
      : denied ? `<span class="err">needed permission; no result recorded</span>` : s.end === null ? "running" : "no result recorded";
    return `<section class="call-detail">
      <h3>${esc(p.tool_name)} <span class="dim">${status}</span></h3>
      <pre>${esc(clip(describeInput(p.tool_input)))}</pre>
      ${post ? `<pre class="result">${esc(clip(describeResult(post.payload as any)))}</pre>` : ""}
    </section>`;
  }).join("");
}

function waitingBody(s: Segment, lane: Lane, c: Ctx): string {
  const end = s.end ?? c.now;
  const kids = c.L.lanes.filter((l) => l.parentId === lane.id && l.start < end && (l.end ?? Infinity) > s.start);
  if (!kids.length) return `<p class="dim">Waiting on a subagent call.</p>`;
  return `<p>Waiting on:</p><ul>${kids.map((k) => `<li>${laneLink(k)} <span class="dim">${k.end === null ? "running" : `done ${when(c, k.end)}`}</span></li>`).join("")}</ul>`;
}

function lanePanel(lane: Lane, c: Ctx): string {
  const end = lane.end ?? c.now;
  const own = c.events.filter((e) => e.agent_id === lane.id);
  const parent = c.L.lanes.find((l) => l.id === lane.parentId);
  const link = c.events.find((e) => e.kind === "link" && e.agent_id === lane.id);
  const spawn = link && c.events.find((e) => e.kind === "spawn" && e.payload.tool_use_id === link.payload.tool_use_id);
  const type = own.find((e) => e.payload.agent_type)?.payload.agent_type;
  const result = lane.parentId
    ? own.find((e) => e.payload.hook_event_name === "SubagentStop")?.payload.last_assistant_message
    : [...own].reverse().find((e) => e.payload.hook_event_name === "Stop")?.payload.last_assistant_message;
  const status = lane.failed ? `<span class="err">failed</span>` : lane.truncated ? "cut off" : lane.end === null ? "running" : "done";

  // Where this lane's time went, by state.
  const totals = new Map<SegmentState, number>();
  for (const s of c.L.segments) if (s.laneId === lane.id) totals.set(s.state, (totals.get(s.state) ?? 0) + (s.end ?? c.now) - s.start);
  const span = Math.max(1, end - lane.start);
  const bar = [...totals].map(([st, ms]) => `<span class="bar-${st}" style="flex:${ms}" title="${STATE_LABEL[st]} ${fmtDur(ms)}"></span>`).join("");
  const legend = [...totals].sort((a, b) => b[1] - a[1])
    .map(([st, ms]) => `<li><i class="bar-${st}"></i>${STATE_LABEL[st]} <b>${fmtDur(ms)}</b> <span class="dim">${Math.round((ms / span) * 100)}%</span></li>`).join("");
  const kids = c.L.lanes.filter((l) => l.parentId === lane.id);
  const notes = c.L.markers.filter((m) => m.laneId === lane.id && ANNOTATIONS.has(m.kind));

  return `<header>
      <span class="badge">${lane.parentId ? "subagent" : "main"}</span>
      <h2>${esc(lane.label)}</h2>
      <p class="dim">${type ? `${esc(type)} · ` : ""}${status} · ${when(c, lane.start)} → ${lane.end === null ? "now" : when(c, end)} · ${fmtDur(end - lane.start)}${parent ? ` · spawned by ${laneLink(parent)}` : ""}</p>
    </header>
    <div class="bar">${bar}</div><ul class="breakdown">${legend}</ul>
    ${spawn ? `<h3>Task</h3><pre class="body">${esc(clip(String((spawn.payload.tool_input as any)?.prompt ?? "")))}</pre>` : ""}
    ${result ? `<h3>${lane.parentId ? "Handed back" : "Last reply"}</h3><div class="prose">${esc(clip(String(result)))}</div>` : ""}
    ${notes.length ? `<h3>Annotations</h3><ul class="annotations">${notes.map((m) => {
      const ev = c.byId.get(m.eventIds[0])!;
      const why = (ev.payload as any).why;
      return `<li><a href="#" data-open-marker="${esc(m.id)}"><span class="marker-${m.kind}">${m.kind}</span></a> <span class="dim">${when(c, m.ts)}</span> ${esc(m.text)}${why ? ` <span class="dim">— ${esc(why)}</span>` : ""}</li>`;
    }).join("")}</ul>` : ""}
    ${kids.length ? `<h3>Subagents</h3><ul>${kids.map((k) => `<li>${laneLink(k)} <span class="dim">${fmtDur((k.end ?? c.now) - k.start)}</span></li>`).join("")}</ul>` : ""}`;
}

function transcriptPath(lane: Lane, c: Ctx): string | undefined {
  const root = c.events.find((e) => e.payload.transcript_path)?.payload.transcript_path as string | undefined;
  if (!root) return;
  return lane.parentId ? subagentTranscriptPath(root, lane.id) : root;
}

function excerptButton(lane: Lane, s: Segment, c: Ctx): string {
  const path = transcriptPath(lane, c);
  if (!path) return "";
  // Small margins catch records written just before the hook that opened the span.
  return `<button class="excerpt" data-excerpt="${esc(path)}" data-from="${s.start - 2000}" data-to="${(s.end ?? c.now) + 2000}">Show raw transcript for this span</button><div class="excerpt-out"></div>`;
}

export function renderExcerpt(records: { ts: number; role: string; blocks: { type: string; text: string }[] }[]): string {
  if (!records.length) return `<p class="dim">No transcript records in this span.</p>`;
  return records.map((r) => `<div class="rec rec-${esc(r.role)}">${r.blocks.map((b) =>
    `<div><span class="dim">${esc(r.role)} · ${esc(b.type)}</span><pre>${esc(b.text)}</pre></div>`).join("")}</div>`).join("");
}

function describeInput(input: any): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  if (typeof input.command === "string") return input.command;
  if (typeof input.prompt === "string") return `${input.description ?? ""}\n\n${input.prompt}`.trim();
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return `${input.pattern}${input.path ? `  in ${input.path}` : ""}`;
  return JSON.stringify(input, null, 2);
}

function describeResult(p: any): string {
  if (p.error) return String(p.error);
  const r = p.tool_response;
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (typeof r.stdout === "string") return [r.stdout, r.stderr].filter(Boolean).join("\n");
  if (typeof r.file?.content === "string") return r.file.content;
  if (Array.isArray(r.content)) return r.content.map((b: any) => b.text ?? "").join("\n");
  if (Array.isArray(r.filenames)) return r.filenames.join("\n");
  return JSON.stringify(r, null, 2);
}

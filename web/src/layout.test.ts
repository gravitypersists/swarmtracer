import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { AgentEvent } from "../../shared/events.ts";
import { DEFAULT_OPTIONS, layout, type LayoutOptions } from "./layout.ts";

const dir = new URL("../../fixtures/", import.meta.url);
const fixtures = Object.fromEntries(
  readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(f, dir), "utf8")) as AgentEvent[]]),
);
const last = (evs: AgentEvent[]) => evs[evs.length - 1].ts;
const opts = (evs: AgentEvent[], extra: Partial<LayoutOptions> = {}): LayoutOptions =>
  ({ ...DEFAULT_OPTIONS, now: last(evs), ...extra });

for (const [name, events] of Object.entries(fixtures)) {
  test(`${name}: segments tile each lane exactly`, () => {
    const L = layout(events, opts(events));
    for (const lane of L.lanes) {
      const segs = L.segments.filter((s) => s.laneId === lane.id);
      assert.ok(segs.length > 0, `${lane.label} has segments`);
      assert.equal(segs[0].start, lane.start, `${lane.label} first segment starts with the lane`);
      for (let i = 1; i < segs.length; i++) assert.equal(segs[i].start, segs[i - 1].end, `${lane.label} contiguous at ${i}`);
      assert.equal(segs[segs.length - 1].end, lane.end, `${lane.label} last segment ends with the lane`);
    }
  });

  test(`${name}: every child is linked and gets a spawn connector`, () => {
    const L = layout(events, opts(events));
    const root = L.lanes.find((l) => !l.parentId)!;
    for (const child of L.lanes.filter((l) => l !== root)) {
      assert.equal(child.parentId, root.id);
      assert.ok(L.connectors.some((c) => c.kind === "spawn" && c.toLane === child.id), `spawn connector for ${child.label}`);
      if (!child.truncated) assert.ok(L.connectors.some((c) => c.kind === "return" && c.fromLane === child.id), `return for ${child.label}`);
    }
  });

  test(`${name}: lanes that overlap in time never share a column`, () => {
    const { lanes } = layout(events, opts(events));
    for (const a of lanes) for (const b of lanes) {
      if (a === b || a.column !== b.column) continue;
      const overlap = a.start < (b.end ?? Infinity) && b.start < (a.end ?? Infinity);
      assert.ok(!overlap, `${a.label} and ${b.label} overlap in column ${a.column}`);
    }
  });

  test(`${name}: a lane never changes column as the run unfolds`, () => {
    const final = new Map(layout(events, opts(events)).lanes.map((l) => [l.id, l.column]));
    for (let n = 1; n <= events.length; n++) {
      const prefix = events.slice(0, n);
      for (const lane of layout(prefix, opts(prefix)).lanes) {
        assert.equal(lane.column, final.get(lane.id), `${lane.label} after ${n} events`);
      }
    }
  });
  test(`${name}: history never moves as the run unfolds`, () => {
    const full = layout(events, opts(events)).scale;
    for (let n = 1; n < events.length; n++) {
      const prefix = events.slice(0, n);
      const partial = layout(prefix, opts(prefix)).scale;
      for (const e of prefix) assert.ok(Math.abs(partial.y(e.ts) - full.y(e.ts)) < 1e-9, `event ${e.id} after ${n} events`);
      // The live tail at the moment the next event arrives is exactly where that event lands.
      const next = events[n].ts;
      assert.ok(Math.abs(partial.y(next) - full.y(next)) < 1e-9, `tail meets event ${events[n].id}`);
    }
  });
}

test("live lanes and tips stay open until their end arrives", () => {
  const evs = fixtures["m1-long-wait"];
  const cut = evs.findIndex((e) => e.payload.hook_event_name === "PreToolUse" && e.payload.tool_name === "Bash");
  const prefix = evs.slice(0, cut + 1);
  const L = layout(prefix, opts(prefix, { now: last(prefix) + 5000 }));
  const child = L.lanes.find((l) => l.parentId)!;
  assert.equal(child.end, null);
  const tip = L.segments.filter((s) => s.laneId === child.id).at(-1)!;
  assert.equal(tip.state, "tool");
  assert.equal(tip.end, null);
  const root = L.segments.filter((s) => s.laneId === L.lanes[0].id).at(-1)!;
  assert.equal(root.state, "waiting_on_child");
});

test("a long quiet span compresses to a gap, and expands on request", () => {
  const evs = fixtures["m1-long-wait"];
  const L = layout(evs, opts(evs));
  assert.equal(L.gaps.length, 1);
  const g = L.gaps[0];
  assert.ok(g.t1 - g.t0 > 30_000, "the 40s build is the gap");
  assert.equal(L.scale.y(g.t1) - L.scale.y(g.t0), (DEFAULT_OPTIONS.gapThresholdMs / 1000) * DEFAULT_OPTIONS.pxPerSec);

  const open = layout(evs, opts(evs, { expandedGaps: new Set([g.id]) }));
  const px = open.scale.y(g.t1) - open.scale.y(g.t0);
  assert.ok(Math.abs(px - ((g.t1 - g.t0) / 1000) * DEFAULT_OPTIONS.pxPerSec) < 1e-6);
});

test("foreground spawns: the parent waits on its children for the whole Agent call", () => {
  const evs = fixtures["m0-parallel-3-foreground"];
  const L = layout(evs, opts(evs));
  const root = L.lanes[0];
  const waits = L.segments.filter((s) => s.laneId === root.id && s.state === "waiting_on_child");
  const lastChildEnd = Math.max(...L.lanes.filter((l) => l.parentId).map((l) => l.end!));
  assert.ok(waits.some((s) => s.end! >= lastChildEnd), "a wait segment reaches the last child's end");
});

test("background spawns: the idle parent counts as waiting while children run", () => {
  const evs = fixtures["m0-parallel-3-default"];
  const L = layout(evs, opts(evs));
  const root = L.lanes[0];
  const stop = evs.find((e) => e.agent_id === root.id && e.kind === "turn_end")!;
  const after = L.segments.find((s) => s.laneId === root.id && s.start === stop.ts)!;
  assert.equal(after.state, "waiting_on_child");
  assert.ok(!L.segments.some((s) => s.laneId === root.id && s.state === "idle" && s.start > stop.ts && s.end! < L.lanes[1].end!));
});

test("subagents that die on an API error end there, marked failed", () => {
  const evs = fixtures["m0-rate-limited-partial"];
  const L = layout(evs, opts(evs));
  const failed = L.lanes.filter((l) => l.failed);
  assert.equal(failed.length, 2);
  for (const l of failed) {
    const fail = evs.find((e) => e.agent_id === l.id && e.payload.hook_event_name === "StopFailure")!;
    assert.equal(l.end, fail.ts);
  }
  assert.ok(L.markers.filter((m) => m.kind === "error").length >= 2);
});

test("permission-denied calls close instead of hanging open", () => {
  const evs = fixtures["m1-two-wave"];
  const L = layout(evs, opts(evs));
  const lane = L.lanes.find((l) => l.label === "hooks review")!;
  const longest = Math.max(...L.segments.filter((s) => s.laneId === lane.id && s.state === "tool").map((s) => s.end! - s.start));
  assert.ok(longest < 5000, `longest tool segment ${longest}ms`);
});

test("failed tools become error markers", () => {
  const evs = fixtures["m1-tool-failure"];
  const L = layout(evs, opts(evs));
  assert.ok(L.markers.some((m) => m.kind === "error" && /Exit code 1/.test(m.text)));
});

test("finished lanes free their column for later lanes", () => {
  const evs = fixtures["m1-two-wave"];
  const { lanes, columns } = layout(evs, opts(evs));
  assert.equal(columns, 3);
  assert.equal(lanes.find((l) => l.label === "slow check")!.column, lanes.find((l) => l.label === "server review")!.column);
});

for (const [name, events] of Object.entries(fixtures)) {
  test(`${name}: reasoning never changes geometry`, () => {
    const bare = events.filter((e) => e.kind !== "reasoning");
    const a = layout(events, opts(bare)), b = layout(bare, opts(bare));
    assert.deepEqual(a.segments, b.segments);
    for (const e of bare) assert.equal(a.scale.y(e.ts), b.scale.y(e.ts));
  });

  test(`${name}: every response lands on a generating segment of its own lane`, () => {
    const L = layout(events, opts(events));
    const segOf = new Map<string, string>();
    for (const [seg, ids] of Object.entries(L.reasoning)) for (const id of ids) segOf.set(id, seg);
    for (const r of events.filter((e) => e.kind === "reasoning")) {
      const seg = L.segments.find((s) => s.id === segOf.get(r.id));
      assert.ok(seg, `reasoning #${r.id} attributed`);
      assert.equal(seg!.laneId, r.agent_id);
      assert.equal(seg!.state, "generating");
    }
  });
}

// m1-two-wave is left out: it predates PostToolBatch, so its permission-denied calls stay open
// until the lane's next call and the response that made that call has no generation to land on.
for (const name of ["m0-parallel-3-default", "m0-parallel-3-foreground", "m0-rate-limited-partial", "m1-long-wait", "m1-tool-failure"]) test(`${name}: a response that calls tools belongs to the generation that ends at its first call`, () => {
  const evs = fixtures[name];
  const L = layout(evs, opts(evs));
  const preTs = new Map(evs.filter((e) => e.kind === "tool_start" || e.kind === "spawn").map((e) => [e.payload.tool_use_id, e.ts]));
  let checked = 0;
  for (const [segId, ids] of Object.entries(L.reasoning)) {
    const seg = L.segments.find((s) => s.id === segId)!;
    const byMessage = Map.groupBy(ids.map((id) => evs.find((e) => e.id === id)!), (r) => r.payload.message_id);
    for (const records of byMessage.values()) {
      const calls = records.flatMap((r) => (r.payload.blocks as any[]).filter((b) => b.type === "tool_use" && preTs.has(b.id)));
      if (!calls.length) continue;
      assert.equal(seg.end, Math.min(...calls.map((b) => preTs.get(b.id)!)));
      checked++;
    }
  }
  assert.ok(checked >= 2, `${checked} tool-calling responses checked`);
});

test("a subagent's final answer lands on its last generation", () => {
  const evs = fixtures["m0-parallel-3-foreground"];
  const L = layout(evs, opts(evs));
  for (const lane of L.lanes.filter((l) => l.parentId)) {
    const last = L.segments.filter((s) => s.laneId === lane.id && s.state === "generating").at(-1)!;
    const texts = (L.reasoning[last.id] ?? []).map((id) => evs.find((e) => e.id === id)!)
      .flatMap((r) => (r.payload.blocks as any[]).filter((b) => b.type === "text"));
    assert.ok(texts.length > 0, `${lane.label} final text on its last segment`);
  }
});

test("attribution survives a clock shift between hooks and transcripts (replays)", () => {
  const evs = fixtures["m1-two-wave"];
  const shifted = evs.map((e) => (e.kind === "reasoning" ? e : { ...e, ts: e.ts + 3_600_000 }));
  const a = layout(evs, opts(evs));
  const b = layout(shifted, opts(shifted));
  const key = (L: typeof a) => Object.entries(L.reasoning).map(([seg, ids]) => {
    const s = L.segments.find((x) => x.id === seg)!;
    return `${s.laneId}#${L.segments.filter((x) => x.laneId === s.laneId).indexOf(s)}:${ids.join(",")}`;
  }).sort();
  assert.deepEqual(key(b), key(a));
});

test("attribution survives a sped-up replay (hook time compressed 4x)", () => {
  for (const name of ["m1-two-wave", "m0-parallel-3-default", "m0-rate-limited-partial"]) {
    const evs = fixtures[name];
    const t0 = Math.min(...evs.map((e) => e.ts));
    const fast = evs.map((e) => (e.kind === "reasoning" ? e : { ...e, ts: t0 + 3_600_000 + (e.ts - t0) / 4 }));
    const key = (L: ReturnType<typeof layout>) => Object.entries(L.reasoning).map(([seg, ids]) => {
      const s = L.segments.find((x) => x.id === seg)!;
      return `${s.laneId}#${L.segments.filter((x) => x.laneId === s.laneId).indexOf(s)}:${ids.join(",")}`;
    }).sort();
    assert.deepEqual(key(layout(fast, opts(fast))), key(layout(evs, opts(evs))), name);
  }
});

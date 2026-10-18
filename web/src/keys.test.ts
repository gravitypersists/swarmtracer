import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AgentEvent } from "../../shared/events.ts";
import { DEFAULT_OPTIONS, layout } from "./layout.ts";
import { navigate } from "./keys.ts";
import { familyOf } from "./bots.ts";

const events: AgentEvent[] = JSON.parse(readFileSync(new URL("../../fixtures/m1-two-wave.json", import.meta.url), "utf8"));
const L = layout(events, { ...DEFAULT_OPTIONS, now: Math.max(...events.map((e) => e.ts)) });
const seg = (id: string) => L.segments.find((s) => s.id === id)!;
const lane = (id: string) => L.lanes.find((l) => l.id === id)!;

test("with nothing selected, a key starts at the main lane's latest segment", () => {
  const sel = navigate(L, null, "j")!;
  const root = L.lanes.find((l) => !l.parentId)!;
  assert.equal(sel.id, L.segments.filter((s) => s.laneId === root.id).at(-1)!.id);
});

test("up and down walk a lane's segments in time order and stop at the ends", () => {
  const root = L.lanes.find((l) => !l.parentId)!;
  const segs = L.segments.filter((s) => s.laneId === root.id);
  let sel = { kind: "segment" as const, id: segs[0].id };
  assert.deepEqual(navigate(L, sel, "k"), sel);
  for (let i = 1; i < segs.length; i++) {
    sel = navigate(L, sel, i % 2 ? "j" : "ArrowDown") as typeof sel;
    assert.equal(sel.id, segs[i].id);
  }
  assert.equal(navigate(L, sel, "ArrowUp")!.id, segs.at(-2)!.id);
});

test("left and right move to the same moment in the neighbouring lane", () => {
  const review = L.lanes.find((l) => l.label === "server review")!;
  const mid = L.segments.find((s) => s.laneId === review.id && s.state === "generating")!;
  const left = navigate(L, { kind: "segment", id: mid.id }, "h")!;
  assert.equal(lane(seg(left.id).laneId).column, review.column - 1);
  const t = (mid.start + mid.end!) / 2;
  assert.ok(seg(left.id).start <= t && t <= seg(left.id).end!, "lands on the segment covering that moment");
  const right = navigate(L, { kind: "segment", id: mid.id }, "l")!;
  assert.equal(lane(seg(right.id).laneId).label, "hooks review");
});

test("Enter switches between a segment and its lane", () => {
  const s = L.segments[5];
  const laneSel = navigate(L, { kind: "segment", id: s.id }, "Enter")!;
  assert.deepEqual(laneSel, { kind: "lane", id: s.laneId });
  assert.equal(navigate(L, laneSel, "Enter")!.kind, "segment");
});

test("model names map to robot families", () => {
  assert.equal(familyOf("claude-opus-5-5"), "opus");
  assert.equal(familyOf("sonnet"), "sonnet");
  assert.equal(familyOf("claude-haiku-5-5"), "haiku");
  assert.equal(familyOf(undefined), "claude");
  assert.equal(familyOf("<synthetic>"), "claude");
});

test("every lane in the recordings knows its model", () => {
  for (const l of L.lanes) assert.match(l.model ?? "", /sonnet/);
});

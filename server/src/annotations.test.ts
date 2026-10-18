import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCaller, type OpenCall } from "./annotations.ts";

const call = (agentId: string, command: string, ts: number): OpenCall => ({ toolUseId: `t-${agentId}-${ts}`, agentId, command, ts });

test("parallel subagents annotating at once are told apart by their arguments", () => {
  const open = [
    call("A", `atl note "found the race in correlate.ts"`, 1),
    call("B", `atl decision "use meta files" --why "they link at start"`, 2),
    call("C", `npm test`, 3),
  ];
  assert.equal(resolveCaller(open, ["note", "found the race in correlate.ts"]).call?.agentId, "A");
  const b = resolveCaller(open, ["decision", "use meta files", "--why", "they link at start"]);
  assert.equal(b.call?.agentId, "B");
  assert.equal(b.by, "command");
});

test("shell quoting and escaping don't defeat the match", () => {
  const open = [call("A", `atl note 'it'"'"'s done'`, 1), call("B", `atl note "other"`, 2)];
  assert.equal(resolveCaller(open, ["note", "it's done"]).call?.agentId, "A");
  const esc = [call("A", `atl note "say \\"hi\\""`, 1), call("B", `atl note "x"`, 2)];
  assert.equal(resolveCaller(esc, ["note", `say "hi"`]).call?.agentId, "A");
});

test("atl inside a compound command still matches", () => {
  const open = [call("A", `cd /tmp && atl artifact ./report.md "final report"`, 1)];
  assert.equal(resolveCaller(open, ["artifact", "./report.md", "final report"]).call?.agentId, "A");
});

test("without an argument match, the latest atl call wins; non-atl calls never do", () => {
  const open = [call("A", `atl note "a"`, 1), call("B", `atl note "$MSG"`, 5), call("C", `echo atlas`, 9)];
  const r = resolveCaller(open, ["note", "expanded variable text"]);
  assert.equal(r.call?.agentId, "B");
  assert.equal(r.by, "recent");
  assert.deepEqual(resolveCaller([call("C", "ls", 1)], ["note", "x"]), { by: "none" });
});

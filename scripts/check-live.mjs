// End-to-end check of live mode: replays a fixture into a fresh server and drives headless Chrome
// over the DevTools protocol. Verifies auto-pickup of a new run, growth, stick/release scrolling,
// the Live pill, and the end-of-run transition. Screenshots land in docs/.
// Usage: node scripts/check-live.mjs [fixture] [speed]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = process.argv[2] ?? "fixtures/m1-two-wave.json";
const speed = process.argv[3] ?? "4";
const PORT = 47840, CDP = 9333;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "st-live-"));
const kids = [];
const run = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
  kids.push(p);
  return p;
};
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };

try {
  run("npx", ["tsx", "server/src/index.ts"], { SWARMTRACER_PORT: String(PORT), SWARMTRACER_DB: join(tmp, "live.db") });
  run(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP}`, `--user-data-dir=${join(tmp, "chrome")}`, "--window-size=1000,800", "about:blank"]);
  await sleep(2500);

  const target = await (await fetch(`http://127.0.0.1:${CDP}/json/new?http://127.0.0.1:${PORT}/`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const cdp = (method, params = {}) => new Promise((r) => {
    const id = ++nextId;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.result.value;
  const shot = async (name) => {
    const { result } = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(root, "docs", name), Buffer.from(result.data, "base64"));
  };
  const state = () => js(`(() => { const s = document.getElementById("timeline"); return {
    summary: document.getElementById("summary").textContent,
    gap: s.scrollHeight - s.scrollTop - s.clientHeight, top: s.scrollTop,
    height: Number(s.querySelector("svg").getAttribute("height")), overflow: s.scrollHeight > s.clientHeight,
    pill: !document.getElementById("live-pill").hidden, now: !!document.querySelector(".now-line"),
    live: document.querySelectorAll(".seg.live").length };})()`);

  await sleep(1500);
  ok((await state()).summary === "", "page starts empty with no runs");

  const replay = run("npx", ["tsx", "scripts/replay.ts", fixture, "--speed", speed, "--port", String(PORT)]);
  await sleep(4000);
  let s = await state();
  ok(s.summary.startsWith("● live"), `new run picked up live: "${s.summary}"`);
  ok(s.now && s.live > 0, `now-line drawn, ${s.live} live tip(s)`);
  // Zoom in so the timeline overflows the window and there is something to scroll.
  await js(`(() => { const z = document.getElementById("zoom"); z.value = 120; z.dispatchEvent(new Event("input")); })()`);
  await sleep(500);
  const h0 = (await state()).height;
  await sleep(2000);
  s = await state();
  ok(s.height > h0, `timeline grows (${h0} → ${s.height}px)`);
  ok(s.overflow && s.gap < 4, `overflowing and stuck to the bottom (${s.gap}px from it)`);
  await shot("m2-live.png");

  await js(`document.getElementById("timeline").scrollTop = 0`);
  await sleep(1500);
  s = await state();
  ok(s.top === 0 && s.pill, `scrolling up releases the stick and shows the pill (top=${s.top}, pill=${s.pill})`);
  await shot("m2-scrolled-up.png");

  await js(`document.getElementById("live-pill").click()`);
  await sleep(500);
  s = await state();
  ok(s.gap < 4 && !s.pill, `the pill re-sticks to now (${s.gap}px from bottom, pill=${s.pill})`);

  await new Promise((r) => replay.on("exit", r));
  await sleep(1000);
  s = await state();
  ok(!s.summary.startsWith("●") && !s.now && s.live === 0, `run end settles the view: "${s.summary}", now-line=${s.now}, live tips=${s.live}`);
  await shot("m2-finished.png");

  // M3: transcripts were tailed into reasoning events, and the side panel shows them.
  const panel = () => js(`document.getElementById("panel").hidden ? null : document.getElementById("panel-body").innerText`);
  const click = (sel) => js(`(() => { const el = ${sel}; if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; })()`);
  const reasoning = await js(`fetch("/runs").then(r => r.json()).then(rs => fetch("/runs/" + rs[0].run_id + "/events"))
    .then(r => r.json()).then(es => es.filter(e => e.kind === "reasoning").length)`);
  ok(reasoning > 0, `transcripts tailed into ${reasoning} reasoning events`);

  await js(`(() => { const z = document.getElementById("zoom"); z.value = 24; z.dispatchEvent(new Event("input")); })()`);
  await sleep(300);
  await click(`[...document.querySelectorAll(".lane-label")].find(e => e.textContent === "server review")`);
  await sleep(300);
  let text = await panel();
  ok(text && /Task/.test(text) && /Handed back/.test(text) && /generating/.test(text),
    `lane panel shows its time breakdown, task, and result`);

  // Find a generating segment whose panel has transcript content.
  // Prefer one with written text (most responses here go straight to a tool call).
  const found = await js(`(async () => {
    for (const want of ["#panel-body .prose", "#panel-body .call"]) {
      for (const el of [...document.querySelectorAll("rect.seg-gen")].reverse()) {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise(r => requestAnimationFrame(r));
        if (document.querySelector(want)) return true;
      }
    } return false; })()`);
  ok(found, "a generating segment's panel shows the transcript behind it");
  await shot("m3-reasoning.png");

  // A replay's spans are in replay time while the transcript keeps the original timestamps, so
  // the button's window is usually empty here; check it loads cleanly, then read the whole file.
  await click(`document.querySelector(".excerpt")`);
  await sleep(800);
  ok(await js(`!!document.querySelector(".excerpt-out .rec, .excerpt-out .dim") && !document.querySelector(".excerpt-out .err")`),
    "raw transcript button loads without error");
  const records = await js(`fetch("/transcript?" + new URLSearchParams({ path: document.querySelector(".excerpt").dataset.excerpt, from: 0 }))
    .then(r => r.json()).then(rs => rs.length)`);
  ok(records > 0, `transcript endpoint returns records for a known path (${records})`);

  await click(`document.querySelector("rect.seg-tool")`);
  await sleep(300);
  ok(await js(`!!document.querySelector("#panel-body .call-detail pre")`), "a tool segment's panel shows the call");

  const status = await js(`fetch("/transcript?path=" + encodeURIComponent("/etc/hosts")).then(r => r.status)`);
  ok(status === 403, `transcript endpoint refuses unknown paths (${status})`);

  await js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await sleep(200);
  ok((await panel()) === null, "Escape closes the panel");
  ws.close();
} finally {
  for (const k of kids) k.kill();
}
process.exit(failures ? 1 : 0);

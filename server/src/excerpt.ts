import { readFile } from "node:fs/promises";

// A readable slice of a transcript: user and assistant records whose timestamps fall in [from, to].
// Long strings are clipped; the panel shows excerpts, not whole tool outputs.

const CLIP = 4000;
const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}… (${s.length - CLIP} more chars)` : s);

export async function readTranscriptExcerpt(path: string, from: number, to: number) {
  const out: { ts: number; role: string; blocks: { type: string; text: string }[] }[] = [];
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== "user" && rec?.type !== "assistant") continue;
    const ts = Date.parse(rec.timestamp);
    if (!(ts >= from && ts <= to)) continue;
    const content = rec.message?.content;
    const blocks = (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [])
      .map((b: any) => ({
        type: String(b.type),
        text: clip(
          b.type === "text" ? b.text
          : b.type === "thinking" ? b.thinking || "(thinking not recorded)"
          : b.type === "tool_use" ? `${b.name} ${JSON.stringify(b.input)}`
          : b.type === "tool_result" ? (typeof b.content === "string" ? b.content : JSON.stringify(b.content))
          : "",
        ),
      }))
      .filter((b: { text: string }) => b.text);
    if (blocks.length) out.push({ ts, role: rec.type, blocks });
  }
  return out;
}

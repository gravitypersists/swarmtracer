# M4 notes

## Pieces

- **`cli/bin/atl`:** plain Node, no dependencies, about 40 ms to start. Its four verbs are `note`, `decision --why`, `artifact <path> [what]` and `blocked`. A down server prints a warning and exits 0. A usage mistake exits 1, so the agent can correct itself.
- **Which agent called it?** Subagents share the root's `CLAUDE_CODE_SESSION_ID`, so `atl` can't tell. The server matches the CLI's arguments against the open Bash calls in that session, normalising quotes and escapes. A `PreToolUse` hook is synchronous, so the calling command always reaches the server before `atl` does. Each annotation records how it was matched: `command`, `recent`, or `none` (the panel says so when it wasn't `command`). Unit tests cover parallel callers, quoting, compound commands and fallbacks.
- **Artifacts:** files up to 10 MB are stored content-addressed under `data/artifacts/`. They are served with `CSP: sandbox` and `nosniff`, and HTML is sent as plain text. The panel previews images and text up to 256 KB.
- **UI:** annotation glyphs sit on the right of the lane and harness markers on the left; markers that land too close together stack outward. Annotation panels show the text, the reason and an artifact preview. The lane panel lists the lane's annotations.

## The skill alone wasn't enough

Same task and prompt, no mention of `atl`, real runs (reported `total_cost_usd` 0.27 and 0.29):

| Setup | Result |
| --- | --- |
| Skill installed (listed in the orchestrator's and both subagents' context) | **0 annotations.** No agent loaded the skill. Annotating doesn't help an agent's own task, so a model-invoked skill gets skipped. |
| Skill + `--annotate` start hook (`additionalContext` on `SessionStart`/`SubagentStart`) | **3 `atl` calls without being asked:** the orchestrator's decision with a reason, a subagent's deliverable, and a second subagent's artifact. Each landed on the right lane, matched by command. |

The third call was lost to a permission denial. The agent chained it (`command -v atl && atl …`), so the `Bash(atl:*)` rule didn't match. The skill and the context text now say to run `atl` as its own command, and `--annotate` adds the permission rule.

The context hook only speaks when SwarmTracer is running and `atl` is on PATH. Its text is phrased as facts, as the hooks docs recommend.

Fixture: `fixtures/m4-annotations.json` (artifact bytes in `fixtures/artifacts/`). Screenshots: `docs/m4-decision.png`, `docs/m4-artifact.png`.

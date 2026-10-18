# SwarmTracer

A live, browser-based timeline of Claude Code runs, including subagents. Time flows down, each agent is a lane, and lanes grow while agents work. See `BRIEF.md` for the design and `docs/` for per-milestone notes and screenshots.

## Run it

```sh
npm install
npm start            # builds the UI and serves http://127.0.0.1:47821
npm run seed         # optional: load the recorded fixture runs
```

`npm run dev` rebuilds the UI and restarts the server on change. Set `SWARMTRACER_PORT` to use another port; the hooks and `atl` read the same variable.

## Trace a project

1. Generate the hook settings and merge them into the project's `.claude/settings.json`:

   ```sh
   node hooks/settings.mjs --annotate
   ```

   `--annotate` adds a start hook that tells each traced agent about `atl`, plus a `Bash(atl:*)` permission. Without it you get timing only. The hooks never fail or slow a session: if SwarmTracer isn't running, they exit silently.

2. For annotations, put `atl` on PATH and install the skill:

   ```sh
   ln -s "$PWD/cli/bin/atl" ~/.local/bin/atl                   # or any directory on PATH
   ln -s "$PWD/skill/atl" <project>/.claude/skills/atl         # or ~/.claude/skills/atl
   ```

3. Start Claude Code in that project. The run appears in the open page.

## Annotations

```sh
atl note "text"
atl decision "chose B" --why "A requires a migration"
atl artifact ./path/to/file ["what it is"]
atl blocked "waiting on API key from user"
```

## Checks

- `npm test`: unit tests (layout against recorded runs, annotation matching).
- `npm run check:live`: replays a run into a fresh server and drives headless Chrome through the live view, panels and annotations.
- `npm run replay -- fixtures/<run>.json --speed 4`: watch a recorded run live, using no usage.

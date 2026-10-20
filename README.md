# SwarmTracer

A live, browser-based timeline of Claude Code runs, including subagents. Time flows down, each agent is a lane, and lanes grow while agents work. See `BRIEF.md` for the design and `docs/` for per-milestone notes and screenshots.

## Run it by hand

```sh
npm install
npm start            # builds the UI and serves http://127.0.0.1:47821
npm run seed         # optional: load the recorded fixture runs
```

`npm run dev` rebuilds the UI and restarts the server on change. Set `SWARMTRACER_PORT` to use another port; the hooks and `atl` read the same variable.

## Use it with Claude Code (plugin)

SwarmTracer is a Claude Code plugin. Once it's enabled, a session starts the SwarmTracer server if it isn't running, and opens the timeline in your browser the first time the session spawns a subagent. If a SwarmTracer tab is already open, it doesn't open another; the open page follows new runs. `atl` and `swarmtracer` are on the agents' PATH, and `/swarmtracer:open` opens the page on demand.

One-time setup:

```sh
npm install --prefix /path/to/swarmtracer
```

Then pick a scope:

```sh
# For one launch (e.g. alongside another plugin)
claude --plugin-dir /path/to/swarmtracer ...

# Everywhere, or for one project (run from that project for --scope project)
claude plugin marketplace add /path/to/swarmtracer
claude plugin install swarmtracer@swarmtracer-local --scope user      # or: project, local
```

Options are set in `/config` once the plugin is enabled:
- `open_browser`: `first subagent` (default), `session start`, or `never`.
- `annotate`: tell agents about `atl`; default on.

Plugins can't grant permissions. So that `atl` never stops for approval, allow `Bash(atl:*)` in your settings, or pass `--allowedTools "Bash(atl:*)"` for `claude -p` runs.

From a terminal: `bin/swarmtracer start | stop | status | open [run]`.

### Without the plugin

`node hooks/settings.mjs --annotate` prints a hooks block to merge into a project's `.claude/settings.json`. With that route, you start the server yourself (`npm start`) and put `bin/` on PATH for `atl`.

## Annotations

```sh
atl note "text"
atl decision "chose B" --why "A requires a migration"
atl artifact ./path/to/file ["what it is"]
atl blocked "waiting on API key from user"
```

## Using the page

- Click any segment, lane, marker or connector for details. Hover anything to see the events behind it.
- Keyboard: `↑↓`/`jk` segments, `←→`/`hl` lanes, `Enter` segment↔lane, `Esc` close, `g`/`G` start/live, `+`/`−` zoom, `s` summary, `?` help.
- Running agents get a robot at their lane's tip: headphones for Opus, a beret for Sonnet, a sprout for Haiku.

## Checks

- `npm test`: unit tests (layout against recorded runs, annotation matching).
- `npm run check:live`: replays a run into a fresh server and drives headless Chrome through the live view, panels and annotations.
- `npm run replay -- fixtures/<run>.json --speed 4`: watch a recorded run live, using no usage.

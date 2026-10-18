# M2 notes

Live mode: open the page, start a Claude Code session with the hooks installed, and the run appears and grows. To try it without spending usage, replay a recording: `npm run replay -- fixtures/m1-two-wave.json --speed 4`.

## How it works

- **Server:** `GET /stream?run=<id>` sends that run's backlog and then live events as SSE. `GET /stream` with no run sends only new events; the UI uses that to notice new runs. Streams resume from `Last-Event-ID`. Listeners fire synchronously inside the SQLite append, so the backlog read and the subscription can't race.
- **Client frame loop:** layout runs only on frames where events (or zoom, or an expanded gap) changed. Otherwise a live run costs one `tick(now)` per frame, which moves only the live tips, the quiet tail and the now-line. A full render pass runs once a second to refresh axis ticks.
- **Scrolling:** the view sticks to the bottom. Scrolling away releases it and shows a "↓ Live" pill. Clicking the pill or scrolling back to the bottom re-engages.

## Gap compression, revised for live

Any quiet span longer than `gapThresholdMs` (10 s) is drawn as if it lasted exactly 10 s, labelled with its real duration, and expandable. During a live run, the quiet tail grows normally for 10 s, then holds and becomes a gap whose label keeps counting. When the next event arrives, it lands exactly where the tail was. **Drawn history never moves.** The test suite checks this for every prefix of every fixture.

This differs from M1, where a gap collapsed to a fixed 36 px. That would have made a live tail shrink suddenly when activity resumed. A pixel-based threshold, tried along the way, made zooming in compress more of the run, which is backwards.

## Checks

- `npm test`: 38 layout tests, including "history never moves".
- `npm run check:live`: replays a fixture into a fresh server and drives headless Chrome over the DevTools protocol. It covers auto-pickup of a new run, growth, sticking and releasing, the pill, and the end-of-run transition. Screenshots: `docs/m2-live.png`, `docs/m2-scrolled-up.png`, `docs/m2-finished.png`.

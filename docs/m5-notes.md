# M5 notes

## Robots

A small robot rides the tip of every running lane. The lane looks like a seismograph trace it's drawing, and while you follow live, the robots all stand along the bottom of the screen. Each model family has its own look, and the robot's behaviour follows the lane's state:

| | generating | tool | waiting on child | idle |
| --- | --- | --- | --- | --- |
| **opus** (headphones) / **sonnet** (beret) / **haiku** (sprout) / unknown (antenna) | sways with music notes | a gear spins, it tinkers | glances sideways, taps a foot | eyes shut, z's float up |

- **Model detection:** each assistant record in the transcript carries the model, so a lane shows the model it actually ran. Before the first response arrives, the robot uses the spawn call's `model`, `SessionStart.model`, or the Agent result's `resolvedModel`. Hovering a robot shows its model and state; clicking it opens the lane.
- **Animation:** pure CSS on a few small SVG shapes, switched off under reduced motion. Robots are created once per lane, and each frame only moves them.
- **Live texture:** a live generating segment has light streaks running down it. These are SMIL, which ignores reduced-motion, so the renderer removes them by hand when reduced motion is set.

Gallery of every model × state: `docs/m5-robot-gallery.png`. Live: `docs/m5-robots.png`. Recording: `fixtures/m5-mixed-models.json`, an Opus orchestrator with Haiku and Sonnet subagents (reported `total_cost_usd` 0.27).

## Summary strip

One row per agent. The bar's position and length show when the agent ran and for how long, relative to the whole run; its colors show the split across states. The numbers give duration and percentages. Click a row to open that lane. Press `s` to toggle the strip; the choice is remembered per browser.

## Keyboard

`↑↓`/`jk` walk a lane's segments. `←→`/`hl` jump to the same moment in the neighbouring lane. `Enter` switches between a segment and its lane. `Esc` closes. `g`/`G` jump to the start or back to live. `+`/`−` zoom. `?` shows help. A keyboard selection scrolls into view and releases the live stick if it has to. Navigation is a pure function (`keys.ts`) with unit tests.

## Checks

`npm test`: 89 tests. `npm run check:live`: 29 checks in headless Chrome, including:
- one robot per running agent, each with the right model;
- robots leaving when their agents finish;
- the strip;
- every shortcut.

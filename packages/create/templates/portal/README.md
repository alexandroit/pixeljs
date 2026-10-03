# {{PROJECT_NAME}}

A 2D pixel game created with [PixelJS](https://pixeljs.com) and ready for the PixelJS portal: three levels, leaderboards, stars, achievements and a cloud save.

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm run dev
   ```

3. Build for production:
   ```bash
   npm run build
   ```

Outside the portal the game plays the same: every portal call still answers, nothing is recorded and the save lasts until the page closes. The menu says so.

## What's inside

| File                  | What it does                                                                         |
| --------------------- | ------------------------------------------------------------------------------------ |
| `public/pixeljs.json` | The manifest the portal reads: levels, leaderboards, achievements and the save slot  |
| `src/main.js`         | Connects to the portal, starts the engine and lets the portal pause, resume and mute |
| `src/game.js`         | The level menu, play and results; every call to the portal is marked `PORTAL:`       |
| `src/world.js`        | The three levels and the hero's movement, in whole numbers                           |

Every attempt at a level is a **run**: `portal.levelStart(id)` when play starts, and `portal.levelEnd(run, { outcome, scores, timeMs, stars })` when it ends, also when the player leaves a level. The portal ranks runs on three leaderboards (the best score and the fastest time of each level, and the total of the best scores), unlocks the two achievements from the rules in `pixeljs.json` and shows the results under the game. Progress is saved in the slot `progress`.

Arrow keys or A and D move, Space or W jumps and Escape leaves a level; gamepads and touch screens work too.

## Make it your own

Draw your levels in `src/world.js`, one character per tile, and keep their ids in step with `levels` in `public/pixeljs.json`. Ids are permanent once the game is published: add levels with new ids instead of renaming old ones. Set each leaderboard's `min` and `max` from your real game balance.

## Publish on PixelJS

1. Build the game with `npm run build`.
2. Zip the contents of `dist/`, so that `index.html` and `pixeljs.json` are at the root of the archive:

   ```bash
   cd dist && zip -r ../game.zip . && cd ..
   ```

3. In the PixelJS studio, create your game, upload the archive and open the preview. It runs in test mode, with a bridge inspector that lists every message between the game and the portal.
4. Submit the version for review.

The [single-player tutorial](https://pixeljs.com/developers/tutorial/single-player) walks through every step, and the [developer guide](https://pixeljs.com/developers) documents `pixeljs.json` and the portal. The [PixelJS API reference](https://github.com/alexandroit/pixeljs/blob/main/docs/api.md) lists everything else.

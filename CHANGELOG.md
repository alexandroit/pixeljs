# Changelog

All notable changes to `@pixeljs/core` and `@pixeljs/create` are documented here. Both packages share one version number.

## 0.0.4 — 2026-10-03

Games can now be published on the PixelJS portal at pixeljs.com.

### Portal

- `@pixeljs/core/portal`, a new entry point of `@pixeljs/core` without dependencies, connects a game to the PixelJS portal: levels and runs, scores on leaderboards, achievements, cloud saves, the player's public handle and online play. Games that do not import it do not load it.
- `connectPortal()` speaks the portal's message protocol (version 2) from the game's frame. Anywhere else it resolves at once with `inPortal` false and every call still answers (results are not recorded and saves stay in memory), so the same build runs on any site and in Node.
- `portal.launch` tells the game which play mode the player chose in the portal: `solo`, `local` or `online`.
- `portal.multiplayer` joins quick matches and private rooms, starts matches, relays messages between the players' games and reports results.
- `attachEngine(portal, engine)` lets the portal's pause, resume and mute controls drive an engine.
- `createRandom(seed)` generates the same numbers from the same seed in every browser, for the seed that all the players of an online match receive and for replays.

### Tools

- Two new JavaScript starters: `portal`, a three-level platformer with leaderboards, stars, two achievements and a cloud save, and `board`, a two-player board game with play against the computer, two players on one device and online play, built around a small rules interface (tic-tac-toe as a placeholder).
- `npm create @pixeljs@latest` asks which starter to create when it runs in an interactive terminal.
- A guide, [Publish on PixelJS](docs/portal.md), and API reference entries for the portal module.

## 0.0.3 — 2026-09-30

The first release.

### Engine

- An indexed framebuffer of up to 1024 × 1024 pixels with a palette of 1 to 256 colors (16 by default), replaceable between frames or changed together with a frame.
- Drawing: pixels, lines, rectangles, circles, ellipses and triangles (outlined and filled), flood fill, color remapping, sprites with source rectangles, flips, transparency, rotation and scaling, tilemaps, built-in and custom bitmap text, camera and clipping.
- Integer-only rasterization in C, so every browser draws the same pixels. Every frame is validated in full and its work budgeted before anything is drawn; an invalid frame leaves the screen unchanged.
- WebGL2 presentation with a Canvas2D fallback, recovery from a lost WebGL context, and `fit` and `integer` display scaling.
- A fixed-step game loop with bounded catch-up, pausing with hidden pages and with the `pause` and `resume` events of Capacitor and Cordova apps.

### Audio

- A four-voice synthesizer in its own WebAssembly instance inside an AudioWorklet: square, triangle, sine and noise waves, envelopes, and slide, vibrato and fade-out effects.
- Single-note sounds, jingles of up to 64 notes and music of up to four tracks, sequenced on the audio clock.
- Loaded only after `audio.unlock()`; compatible with a strict Content-Security-Policy. Audio failures are reported without pausing the game.

### Input

- Keyboard, up to 10 pointer contacts (mouse, pen and touch) mapped to game pixels, the mouse wheel and up to four standard gamepads, all read as a stable snapshot per update.

### Assets and capture

- Bounded loaders for PNG (mapped to the palette) and JSON images, tilemaps, bitmap fonts, sounds, music and JSON data, with cancellation.
- Asset manifests that load every listed file or none of them.
- PNG screenshots and GIF recordings of the displayed frames.

### Tools

- `npm create @pixeljs@latest`: JavaScript and strict TypeScript starter projects built with Vite.
- PixelJS Studio: a browser editor for sprites, palettes, tilemaps, sound effects and music, with PNG import and export of ready-to-load assets.
- A Pac-Man example, a tutorial and a complete API reference.

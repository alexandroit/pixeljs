# Changelog

All notable changes to `@pixeljs/core` and `@pixeljs/create` are documented here. Both packages share one version number.

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

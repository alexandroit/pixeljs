# @pixeljs/core

An independent C17/WebAssembly pixel engine for JavaScript and TypeScript. Game code stays in JavaScript or TypeScript; drawing is validated and rasterized by C compiled to WASM and presented with WebGL2 (Canvas2D fallback), and a four-voice synthesizer plays sounds and music in an AudioWorklet. No runtime dependencies, no install scripts, no C toolchain needed.

[Play the demo](https://pixeljs.com) · [Tutorial](https://github.com/alexandroit/pixeljs/blob/main/docs/tutorial.md) · [API reference](https://github.com/alexandroit/pixeljs/blob/main/docs/api.md) · [Publish on PixelJS](https://github.com/alexandroit/pixeljs/blob/main/docs/portal.md) · [Editor](https://pixeljs.com/editor/) · [Source](https://github.com/alexandroit/pixeljs)

## Install

```sh
npm create @pixeljs@latest my-game   # new project (Vite, JS or strict TS, or a portal starter)
npm install @pixeljs/core            # existing project
```

The package contains JavaScript ESM, TypeScript declarations, `engine.wasm`, `audio.wasm` and the AudioWorklet module.

## Start a game

```js
import { createEngine } from '@pixeljs/core';

const engine = await createEngine({
  canvas: document.querySelector('canvas'),
  width: 256,
  height: 144,
});
const hero = engine.createImage({ width: 2, height: 2, pixels: new Uint8Array([10, 10, 10, 10]) });
let x = 24;
engine.start({
  update(dt) {
    if (engine.input.isDown('ArrowRight')) x += 60 * dt;
  },
  draw() {
    const g = engine.graphics;
    g.clear(0);
    g.sprite(hero, Math.round(x), 64);
    g.text(4, 4, 'HELLO', 7);
  },
});
// On teardown: await engine.dispose();
```

TypeScript uses the same import; types such as `Engine`, `GameCallbacks` and `ImageResource` are included. Runtime validation protects JavaScript callers too.

## API overview

- **Engine:** `createEngine({ canvas, width?, height?, updateHz?, renderer?, scaling?, palette?, wasmUrl?, audioWasmUrl?, audioWorkletUrl?, signal?, onError? })`, then `start`, `pause`, `resume`, `dispose`, `resize`, `setPalette`, `readPixel`, `getStats`.
- **Graphics (inside `draw()` only):** `clear`, `pixel`, `line`, `rect`, `rectb`, `circle`, `circleFill`, `ellipse`, `ellipseFill`, `triangle`, `triangleFill`, `fill` (flood fill), `remap`/`resetRemap` (draw one color as another), `sprite` (source rectangle, flips, `rotation` in degrees and `scale`), `tilemap`, `glyph`, `text`, `setPaletteColor`, `setCamera`, `setClip`, `resetClip`. Coordinates are integers; negative sizes are errors, zero sizes draw nothing. Rasterization uses integer arithmetic only, so every browser draws the same pixels.
- **Resources (between callbacks):** `createImage`, `createTilemap`, `createFont`, `release`; async `loadImage` (PNG or JSON), `loadTilemap`, `loadJson`, `loadFont` (a `pixeljs-font` file) and `loadAssets` (a manifest, below). A tilemap keeps its tileset alive; releasing the tileset first fails with `RESOURCE_IN_USE`. `EMPTY_TILE` (65535) marks an empty map cell. `measureText(text, font?)` returns the `{ width, height }` that `text()` draws.
- **Capture:** `capture({ scale? })` resolves to a PNG `Blob` of the last presented frame (scale 1–8, nearest neighbor, either renderer). `startRecording({ maxSeconds?, scale? })`, `stopRecording()` (a looping GIF `Blob`) and `recording` keep the last seconds of presented frames; recording costs nothing per frame until started.
- **Input:** keyboard (`isDown`, `wasPressed`, `wasReleased`), pointers (`pointer`, `pointers`), `wheel` and gamepads (`gamepads`, `isButtonDown`, `wasButtonPressed`, `wasButtonReleased`, `axis`); see [Input](#input).
- **Audio (optional):** `audio.unlock()` from a user gesture, then `play`, `stop`, `setVolume`, `createSound`, `loadSound`, `createMusic`, `loadMusic`, `playMusic`, `stopMusic`, `musicPlaying`. Four voices; square, triangle, sine and noise waveforms with attack/decay/sustain/release and slide, vibrato and fade-out effects. A sound is one note or a jingle of up to 64 notes; music has up to four tracks of 512 notes, sequenced on the audio clock. Notes played before unlock or while paused are dropped, not queued; music requested before unlock starts once audio runs.
- **Portal (`@pixeljs/core/portal`, a separate entry point):** `connectPortal`, `attachEngine` and `createRandom`; see [Publish on PixelJS](#publish-on-pixeljs).
- **Errors:** `PixelJSError` with a `code` such as `RANGE`, `ARGUMENT`, `HANDLE`, `STATE`, `CAPACITY`, `RESOURCE_IN_USE`, `ASSET_LOAD`, `ASSET_DATA`, `ABORTED`, `UNSUPPORTED` or `AUDIO_ERROR`. Callback and audio errors are delivered to `onError`.

## Asset manifests and font files

```json
{
  "format": "pixeljs-assets",
  "version": 1,
  "images": { "tiles": { "src": "img/tiles.png", "transparentIndex": 0 } },
  "tilemaps": { "level1": { "src": "maps/level1.json", "tileset": "tiles" } },
  "fonts": { "small": { "src": "fonts/small.json" } },
  "sounds": { "jump": { "src": "sfx/jump.json" } },
  "music": { "theme": { "src": "music/theme.json" } },
  "data": { "levels": { "src": "levels.json" } }
}
```

```js
const assets = await engine.loadAssets('assets/manifest.json', {
  onProgress: (loaded, total) => console.log(`${loaded}/${total}`),
});
const map = assets.tilemap('level1');
engine.audio.playMusic(assets.music('theme'));
// Later, between callbacks: assets.release();
```

Paths are relative to the manifest (or to `document.baseURI` for a manifest object) and can never leave its directory. Loading is all or nothing: any failure cancels the other requests, releases what was already created and rejects with that entry's error code. A font file is `{ "format": "pixeljs-font", "version": 1, "glyphWidth": 5, "glyphHeight": 7, "firstChar": 32, "charCount": 96, "glyphs": [["..#..", ...], ...] }` with `#` for lit pixels, or a base64 `"bitmap"` in the `createFont` layout instead of `"glyphs"`. Both formats reject unknown and duplicate keys.

## Input

Input is sampled once per fixed update, so read it in `update()`. Events between two ticks are latched by the next tick: reading never consumes an edge, catch-up ticks do not repeat one, and a press and release between two ticks report both `pressed` and `released` with `down` false. Window blur, a hidden page, `pause()`/`resume()` and `start()` reset held input, so nothing stays stuck down; `resize()` drops held pointers. A hidden page pauses the game and its audio until the page is visible again; in Capacitor and Cordova shells the `pause`/`resume` document events count as hiding and showing the page, because Android WebView keeps it visible in the background.

- **Keyboard** (the canvas needs focus): `isDown(code)`, `wasPressed(code)` and `wasReleased(code)` with `KeyboardEvent.code` values such as `'ArrowLeft'` or `'KeyA'`.
- **Pointers:** `pointers` is a new frozen array each tick with every mouse, pen or touch contact that is down or was released during the tick, in order of first contact. Each snapshot is `{ id, type, x, y, buttons, down, pressed, released }`: `id` stays the same for one contact, `x`/`y` are integer logical pixels clamped to the framebuffer, and `buttons` is a bitmask (1 primary, 2 secondary, 4 middle). `pointer` is the primary pointer (the mouse, the first touch or the pen); a hovering mouse keeps updating its `x`/`y`. Cancelled contacts and lost pointer capture end as released. The context menu is suppressed only for presses on the canvas.
- **Wheel:** `wheel` is `{ x, y }` in lines accumulated since the previous tick (16 pixels per line; a page is height / 8 lines), positive to the right and down. Page scrolling is prevented only while the canvas has focus, so an embedded game never captures the page's scrolling.
- **Gamepads:** `gamepads` lists connected pads 0–3, polled once per tick, as `{ index, id, mapping, buttons, axes }` with 17 buttons and 4 axes in standard-mapping order. `isButtonDown(button, pad = 0)`, `wasButtonPressed` and `wasButtonReleased` take `'A'`, `'B'`, `'X'`, `'Y'`, `'LB'`, `'RB'`, `'LT'`, `'RT'`, `'Back'`, `'Start'`, `'LS'`, `'RS'`, `'Up'`, `'Down'`, `'Left'`, `'Right'` or `'Home'`; `axis('leftX' | 'leftY' | 'rightX' | 'rightY', pad = 0)` returns −1 to 1 after a 0.15 dead zone. Triggers count as pressed beyond half their travel. A missing pad reads as not pressed and 0, and without the Gamepad API the list is empty. Edges compare consecutive ticks, so a press shorter than one tick is not seen.

```js
function update() {
  const input = engine.input;
  for (const touch of input.pointers) if (touch.pressed) sparks.push({ x: touch.x, y: touch.y });
  if (input.wasPressed('Space') || input.wasButtonPressed('A')) player.jump();
  player.vx = input.axis('leftX') + (input.isDown('ArrowRight') ? 1 : 0);
  zoom = Math.max(1, zoom - input.wheel.y);
}
```

### Display scaling

`createEngine({ scaling })` controls the canvas's CSS size; the framebuffer itself stays at the logical size.

- `'manual'` (default): the page sizes the canvas with CSS. Pointer input follows the canvas's computed `object-fit` (`fill`, `contain`, `cover`, `none`, `scale-down`), a two-value length or percentage `object-position` (anything else counts as centered) and its border and padding.
- `'fit'`: the canvas takes the largest size with the framebuffer's aspect ratio that fits the content box of its parent element, in whole device pixels, with `image-rendering: pixelated`.
- `'integer'`: like `'fit'`, with the largest whole number of device pixels per logical pixel; when not even one fits, it falls back to `'fit'`.

With `'fit'` or `'integer'`, give the parent a definite size that does not depend on the canvas and center the canvas with CSS, for example `display: grid; place-items: center`. The canvas's own border and padding are taken into account with either `box-sizing`; its margins are not. Fitting follows parent resizes and devicePixelRatio changes (zoom, another monitor) and runs again on `resize()`; a canvas without a parent keeps its size until it is attached. In every mode, a press that starts in a letterbox margin or on the canvas's border or padding is ignored, and a drag that leaves the image is clamped to its edge. `dispose()` restores the canvas's original inline styles and attributes.

## Limits

Framebuffers and images up to 1024 × 1024 (1,048,576 pixels); 256 resources per engine; 4,096 draw commands and 16,000,000 work units per frame; palettes of 1–256 opaque colors, fixed per engine; tiles and glyphs up to 256 and 64 pixels; image files up to 16 MiB, JSON data and font files up to 1 MiB. Manifests: 1 MiB, 1,024 entries, ids of 1–64 characters `[A-Za-z0-9_.-]` (not `__proto__`, `constructor` or `prototype`), paths of up to 512 characters, 4 requests at a time and 16 MiB of `data` entries per bundle. Capture scale 1–8, one capture at a time. Recording: 1–60 seconds (default 10) of game time (a pause counts at most 0.25 s), at most 50 frames per second and 64 MiB of copied frames, GIF scale 1–4 and output up to 256 MiB; one recording, or its encoding, at a time. Each engine reserves 64 MiB of WASM memory; `getStats().coreBytes` counts C allocations only, not total browser memory.

Input: 256 held or pending keys with codes up to 64 characters (a full queue resets held keys); 10 pointer contacts at once, counting released ones until their tick (further contacts are ignored); both overflows are counted in `getStats().inputOverflows`. The wheel reports at most ±100 lines per axis and tick. Four gamepads (indices 0–3) with 17 buttons and 4 axes each; device ids are cut to 128 characters.

## Publish on PixelJS

The PixelJS portal at [pixeljs.com](https://pixeljs.com) gives games levels, leaderboards, achievements, cloud saves and online play. A game declares what it uses in `pixeljs.json` and connects through `@pixeljs/core/portal`, an entry point without dependencies that games load only when they import it:

```js
import { attachEngine, connectPortal, createRandom } from '@pixeljs/core/portal';

const portal = await connectPortal({ capabilities: ['pause', 'mute', 'levels', 'scores'] });
attachEngine(portal, engine); // after engine.start(): the portal's pause, resume and mute
const run = await portal.levelStart('1-1');
const answer = await portal.levelEnd(run, { outcome: 'complete', scores: { 'level-score': 4200 } });
portal.multiplayer.on('start', ({ seed }) => startMatch(createRandom(seed)));
```

Outside the portal every call still answers (`inPortal` is false, results are not recorded and saves stay in memory), so the same build runs on any site and in Node. `createRandom(seed)` uses only 32-bit integer arithmetic, so a seed gives the same numbers in every browser; it is not cryptographic. `npm create @pixeljs@latest my-game -- --template portal` (levels) or `--template board` (solo, local and online play for two) starts a project ready for the portal. The [guide](https://github.com/alexandroit/pixeljs/blob/main/docs/portal.md) covers the manifest and the workflow, and the [developer guide](https://pixeljs.com/developers) on pixeljs.com every field and limit.

## Deployment and CSP

Serve `.wasm` files as `application/wasm`. A strict policy works: `script-src 'self' 'wasm-unsafe-eval'` plus `connect-src 'self'` for the WASM and asset fetches. No `unsafe-eval`, `SharedArrayBuffer`, threads or cross-origin isolation is required. Captures are `Blob`s; showing one through an object URL in an `<img>` needs `img-src blob:`. Bundlers such as Vite emit the WASM and AudioWorklet files automatically; with plain ESM, serve the package's `dist` folder as is, or pass `wasmUrl`, `audioWasmUrl` and `audioWorkletUrl`.

## Status and license

PixelJS is tested in Chromium, Firefox and WebKit and in the Android emulator's WebView (through a Capacitor shell); physical Android and iPhone devices are not yet validated, and multitouch and gamepads are tested with synthetic, DevTools-dispatched and mocked input, not on physical touch screens or real controllers. Released under the MIT License; see `LICENSE`, and `THIRD_PARTY_NOTICES.md` for the Emscripten runtime.

# PixelJS API reference

This is the complete public API of `@pixeljs/core`. Everything is exported from the package root, except the [portal](#portal) module, `@pixeljs/core/portal`; TypeScript declarations are included and every argument is also validated at runtime, so plain JavaScript gets the same errors. Types named here are exported (`import type { Engine, SpriteOptions } from '@pixeljs/core'`). New to PixelJS? Start with the [tutorial](tutorial.md).

- [Creating an engine](#creating-an-engine)
- [The game loop](#the-game-loop)
- [Graphics](#graphics)
- [Images, tilemaps and fonts](#images-tilemaps-and-fonts)
- [Loading files](#loading-files)
- [Input](#input)
- [Audio](#audio)
- [Palette](#palette)
- [Capture](#capture)
- [Portal](#portal)
- [Errors](#errors)
- [Limits](#limits)

## Creating an engine

```js
import { createEngine } from '@pixeljs/core';

const engine = await createEngine({ canvas, width: 256, height: 144, scaling: 'integer' });
```

`createEngine(options): Promise<Engine>` loads the engine's WebAssembly, creates a framebuffer and a renderer on `canvas`, and resolves to an engine in state `READY`.

| Option                                       | Type                                   | Default             | Notes                                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `canvas`                                     | `HTMLCanvasElement`                    | required            | Must be in an active document. The engine owns its context.                                                                                                                                                              |
| `width`, `height`                            | integer 1–1024                         | 256 × 144           | Logical framebuffer size; width × height ≤ 1,048,576.                                                                                                                                                                    |
| `updateHz`                                   | integer 1–240                          | 60                  | Fixed update rate.                                                                                                                                                                                                       |
| `renderer`                                   | `'auto'` \| `'webgl2'` \| `'canvas2d'` | `'auto'`            | `auto` prefers WebGL2 and falls back to Canvas2D. Both present identical pixels.                                                                                                                                         |
| `scaling`                                    | `'manual'` \| `'fit'` \| `'integer'`   | `'manual'`          | `manual`: your CSS sizes the canvas. `fit`: the largest aspect-preserving size inside the parent. `integer`: the largest whole number of device pixels per game pixel (crisp), falling back to `fit` when it cannot fit. |
| `palette`                                    | flat RGBA array                        | 16 original colors  | 1–256 opaque colors (`[r, g, b, 255, …]`); the count is fixed for the engine.                                                                                                                                            |
| `wasmUrl`, `audioWasmUrl`, `audioWorkletUrl` | `string` \| `URL`                      | next to the package | Only needed when serving the package's files from another place.                                                                                                                                                         |
| `signal`                                     | `AbortSignal`                          |                     | Cancels creation (`ABORTED`).                                                                                                                                                                                            |
| `onError`                                    | `(error: Error) => void`               | `console.error`     | Receives callback errors and optional audio failures.                                                                                                                                                                    |

`engine.width`, `engine.height`, `engine.state` and `engine.capabilities` (`{ renderer, audio, workers: false }`) describe the instance.

## The game loop

```js
engine.start({
  update(dt) {
    /* fixed step: dt is 1 / updateHz seconds */
  },
  draw() {
    /* queue drawing commands */
  },
});
```

| Method                     | Notes                                                                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start({ update, draw })`  | Starts or restarts the loop; also ends a manual pause. Both callbacks are synchronous.                                                                                                                                                                    |
| `pause()`, `resume()`      | Manual pause. The engine also pauses, with its audio, while the page is hidden, while a Capacitor or Cordova app is in the background (their `pause`/`resume` events) or while the WebGL context is lost, and resumes only when every reason has cleared. |
| `dispose(): Promise<void>` | Stops everything immediately; cleanup waits for a running callback to return. Always returns the same promise.                                                                                                                                            |
| `resize(width, height)`    | Replaces the framebuffer between callbacks (cleared to index 0); resources stay valid.                                                                                                                                                                    |
| `getStats()`               | `{ frames, updates, droppedUpdates, commands, inputOverflows, coreBytes, coreAllocations, renderer }`. `coreBytes` counts C allocations only, not browser memory.                                                                                         |
| `readPixel(x, y)`          | Palette index at (x, y) of the last submitted frame. During `draw()` that is still the previous frame.                                                                                                                                                    |

States: `READY` → `RUNNING` ⇄ `PAUSED` → `DISPOSING` → `DISPOSED`, or `FAILED` after an unrecoverable error. `update` runs at most five times per displayed frame; a slower device drops the rest and counts them in `droppedUpdates`. An exception in a callback pauses the loop and is reported to `onError`; the previous complete frame stays on screen.

**Phases.** Drawing calls are allowed only inside `draw()`. Creating and releasing resources, `setPalette`, `resize` and `start` are allowed only between callbacks. Anything else throws `STATE`.

## Graphics

`engine.graphics` queues commands during `draw()`; the C core validates and draws the whole frame after `draw()` returns, atomically: if any command is invalid, nothing of that frame is drawn and the previous frame stays. Coordinates and sizes are integers (int32); colors are palette indices. Rectangles are half-open (`rect(0, 0, 2, 2)` covers four pixels); zero sizes draw nothing; negative sizes throw `RANGE`. A frame holds at most 4,096 commands and a bounded amount of work (see [Limits](#limits)).

| Method                                                         | Draws                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clear(color)`                                                 | The whole framebuffer.                                                                                                                                                                                                        |
| `pixel(x, y, color)`                                           | One pixel.                                                                                                                                                                                                                    |
| `line(x0, y0, x1, y1, color)`                                  | An all-octant Bresenham line. Clipping, the camera and the canvas size never move its pixels.                                                                                                                                 |
| `rect(x, y, w, h, color)`, `rectb(...)`                        | A filled rectangle; its one-pixel outline.                                                                                                                                                                                    |
| `circle(x, y, r, color)`, `circleFill(...)`                    | A midpoint circle of radius `r`; filled.                                                                                                                                                                                      |
| `ellipse(x, y, w, h, color)`, `ellipseFill(...)`               | The ellipse inscribed in the box (sizes 0–16,384): the pixels whose centers are inside. The outline is that set's boundary, so it matches the fill.                                                                           |
| `triangle(x0, y0, x1, y1, x2, y2, color)`, `triangleFill(...)` | The three edges as lines; filled: every pixel whose center is inside or on the triangle, plus the edges. Each takes two of the 4,096 records.                                                                                 |
| `fill(x, y, color)`                                            | Flood-fills the 4-connected area of (x, y)'s current color, inside the clip, as drawn so far in this frame.                                                                                                                   |
| `sprite(image, x, y, options?)`                                | An image. Options: `sourceX`, `sourceY`, `width`, `height` (a source rectangle), `flipX`, `flipY`, `rotation` (degrees, clockwise) and `scale` (1/16–64) about the sprite's center. The image's transparent index is skipped. |
| `tilemap(map, x, y, options?)`                                 | A tilemap; `startCol`, `startRow`, `cols`, `rows` select a window. Offscreen cells cost nothing.                                                                                                                              |
| `glyph(x, y, charCode, color, font?, background?)`             | One character of the built-in 8 × 8 font or of `font`; `background` fills the glyph cell.                                                                                                                                     |
| `text(x, y, string, color, options?)`                          | Characters left to right; `\n` starts a new line, `\r` is ignored. Options: `font`, `background`.                                                                                                                             |
| `setCamera(x, y)`                                              | Subtracts (x, y) from the coordinates of the commands that follow.                                                                                                                                                            |
| `setClip(x, y, w, h)`, `resetClip()`                           | Restricts the commands that follow to a screen rectangle.                                                                                                                                                                     |
| `remap(from, to)`, `resetRemap()`                              | From here to the end of the frame, drawing that would write index `from` writes `to` (fills, lines, text, sprite and tile pixels). Sprite transparency is decided before remapping.                                           |
| `setPaletteColor(index, r, g, b)`                              | Changes a palette color together with this frame (see [Palette](#palette)).                                                                                                                                                   |

Camera, clip and remap reset at the start of every frame. Rotated and scaled sprites need their source rectangle inside the image and sample the nearest source pixel with integer arithmetic, so every browser draws the same pixels.

## Images, tilemaps and fonts

Resources are created between callbacks and belong to their engine. Keep the returned object and pass it to drawing calls; `engine.release(resource)` frees it (later use throws `HANDLE`).

- `createImage({ width, height, pixels, transparentIndex? })`: `pixels` is a `Uint8Array` of `width × height` palette indices, copied. At most 1024 × 1024 pixels.
- `createTilemap({ cols, rows, tileWidth, tileHeight, tileset, tiles })`: `tiles` lists `cols × rows` tile IDs row by row. Tiles are numbered left to right, top to bottom across the tileset's whole tiles; `EMPTY_TILE` (65535, exported) leaves a cell empty. A tilemap keeps its tileset alive: releasing the tileset first throws `RESOURCE_IN_USE`.
- `createFont({ glyphWidth, glyphHeight, firstChar?, charCount?, fallbackChar?, bitmap })`: 1-bit glyphs up to 64 × 64, rows padded to whole bytes with the most significant bit leftmost; `bitmap` holds `charCount × glyphHeight × ceil(glyphWidth / 8)` bytes. Characters outside the font draw `fallbackChar`, which must be one of its characters.

At most 256 resources exist per engine.

## Loading files

Loaders read at most a fixed number of bytes, check cancellation and disposal after every step and never publish half a resource. Relative URLs resolve against the page. Pass `{ signal }` to cancel (`ABORTED`).

| Method                                           | Reads                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadImage(src, { transparentIndex?, signal? })` | A PNG (≤ 16 MiB, ≤ 1024 × 1024, not animated), mapped to the nearest palette colors (alpha below 128 becomes `transparentIndex`), or a JSON image `{ width, height, pixels, transparentIndex? }` (≤ 4 MiB).                                                                                       |
| `loadTilemap(src, { tileset, signal? })`         | `{ cols, rows, tileWidth, tileHeight, tiles }` JSON.                                                                                                                                                                                                                                              |
| `loadJson(src, { signal? })`                     | Any JSON of at most 1 MiB, as untrusted data.                                                                                                                                                                                                                                                     |
| `loadFont(src, { signal? })`                     | A `pixeljs-font` file (≤ 1 MiB): `{ "format": "pixeljs-font", "version": 1, glyphWidth, glyphHeight, firstChar?, charCount?, fallbackChar? }` as `createFont`, plus either `bitmap` (base64 of the `createFont` bitmap) or `glyphs` (`charCount` arrays of `glyphHeight` strings of `#` and `.`). |
| `loadAssets(manifest, { signal?, onProgress? })` | A manifest (a URL or an object): everything it lists, or nothing, as described below.                                                                                                                                                                                                             |
| `audio.loadSound(src)`, `audio.loadMusic(src)`   | See [Audio](#audio).                                                                                                                                                                                                                                                                              |

`measureText(text, font?)` returns the `{ width, height }` that `graphics.text` draws: the glyph width per character and the glyph height per line (8 × 8 for the built-in font).

**Asset manifests.** `loadAssets` reads a `pixeljs-assets` file (≤ 1 MiB and 1,024 entries; unknown keys and sections are errors) and loads its entries four at a time: images and data first, then fonts, sounds and music, then tilemaps once their tileset exists. Paths are relative to the manifest file (to the page for a manifest object) and may not leave its directory. If anything fails, the other requests are cancelled, everything already created is released and the promise rejects with that entry's error code; `onProgress(loaded, total)` reports each finished entry.

```json
{
  "format": "pixeljs-assets",
  "version": 1,
  "images": {
    "tiles": { "src": "tiles.png" },
    "hero": { "src": "hero.png", "transparentIndex": 0 }
  },
  "tilemaps": { "level1": { "src": "level1.json", "tileset": "tiles" } },
  "fonts": { "hud": { "src": "hud-font.json" } },
  "sounds": { "jump": { "src": "sounds/jump.json" } },
  "music": { "theme": { "src": "music/theme.json" } },
  "data": { "levels": { "src": "levels.json" } }
}
```

```js
const assets = await engine.loadAssets('assets/assets.json');
const hero = assets.image('hero');
engine.audio.playMusic(assets.music('theme'));
```

The bundle's getters (`image`, `tilemap`, `font`, `sound`, `music`, `data`) throw `ARGUMENT` for an unknown id; `ids(kind)` lists a section; `release()` frees every resource, tilemaps before their tilesets. Bundle resources are ordinary engine resources.

## Input

`engine.input` is a snapshot per update tick: events that arrive between ticks become visible together at the next tick, so reading the same key twice in one `update` gives the same answer, and a press and release between two ticks yields both edges. Keys need the canvas to have focus (the engine makes it focusable). Blur, hiding the page, pause, resume and `start()` reset held input, so nothing gets stuck.

| Member                                                                          | Notes                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isDown(code)`, `wasPressed(code)`, `wasReleased(code)`                         | `KeyboardEvent.code` values such as `'ArrowLeft'`, `'KeyA'`, `'Space'`.                                                                                                                   |
| `pointer`                                                                       | The primary pointer: `{ id, type, x, y, buttons, down, pressed, released }` in game pixels. A hovering mouse keeps updating `x`/`y`.                                                      |
| `pointers`                                                                      | Every contact down in this tick or released during it (up to 10), in order of first contact, each with an engine-assigned `id`. `buttons` is a bitmask: 1 primary, 2 secondary, 4 middle. |
| `wheel`                                                                         | `{ x, y }` wheel movement since the previous tick, in lines, clamped to ±100.                                                                                                             |
| `gamepads`                                                                      | Connected gamepads (standard mapping, at most four): `{ index, id, mapping, buttons, axes }`.                                                                                             |
| `isButtonDown(button, pad?)`, `wasButtonPressed(...)`, `wasButtonReleased(...)` | `button` is one of `'A' 'B' 'X' 'Y' 'LB' 'RB' 'LT' 'RT' 'Back' 'Start' 'LS' 'RS' 'Up' 'Down' 'Left' 'Right' 'Home'`; `pad` 0–3 (default 0). Triggers count as pressed above 0.5.          |
| `axis(name, pad?)`                                                              | `'leftX' 'leftY' 'rightX' 'rightY'` in [-1, 1] after a 0.15 dead zone.                                                                                                                    |

Pointer coordinates follow the region that actually shows the game, including CSS `object-fit: contain` letterboxing; a contact that starts in a letterbox margin is ignored and a captured drag is clamped to the edge.

## Audio

Audio is optional and lazy: nothing is downloaded or created until `engine.audio.unlock()`, which browsers only allow from a user gesture (a click or key press). Four voices synthesize square, triangle, sine and noise waves with an attack/decay/sustain/release envelope in a C DSP running in an AudioWorklet. Audio failures go to `onError` and never pause the game.

| Member                                                       | Notes                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unlock(): Promise<void>`                                    | Starts audio. Rejects with `BLOCKED` (try again from another gesture), `UNSUPPORTED`, `AUDIO_ERROR` or `STATE`. A device that never answers fails as `BLOCKED` after 5 s.                                                   |
| `capabilities`                                               | `{ supported, state }`: `uninitialized`, `running`, `suspended`, `blocked`, `failed` or `disposed`.                                                                                                                         |
| `play(sound?, voice?): SoundInstance`                        | Plays a sound (options or a resource) on `voice` 0–3, or round robin. While audio is not running the note is dropped, never replayed later. `instance.stop()` ends only that note, also while paused.                       |
| `stop(instance?)`                                            | Stops one instance, or everything (including music).                                                                                                                                                                        |
| `setVolume(v)`                                               | Output volume 0–1.                                                                                                                                                                                                          |
| `createSound(options)`, `loadSound(src)`                     | A reusable sound (JSON ≤ 64 KiB, optionally `{ "format": "pixeljs-sound", "version": 1, … }`).                                                                                                                              |
| `createMusic(options)`, `loadMusic(src)`                     | Music (JSON ≤ 256 KiB, `{ "format": "pixeljs-music", "version": 1, … }`).                                                                                                                                                   |
| `playMusic(music, { loop? })`, `stopMusic()`, `musicPlaying` | Plays a piece from its start, replacing the current one. Requested before `unlock()` or while paused, it starts once audio runs. `musicPlaying` stays true until `stopMusic()`, `stop()` or the end of a non-looping piece. |

**Sounds.** A single note: `{ waveform, frequency (Hz, ≤ 24,000), volume, attack, decay, sustain, release, duration (≤ 60 s), effect?, slideTo? }`. A multi-note sound (a jingle): `{ notes, bpm (20–400, default 120), stepsPerBeat (1–16, default 4), waveform, volume, attack, decay, sustain, release }` with up to 64 notes.

**Notes** are `{ step, length?, pitch, volume?, waveform?, effect? }`: `step` and `length` count tempo steps, `pitch` is a MIDI note (C4 = 60, A4 = 440 Hz) or a name such as `'C4'`, `'F#3'` or `'Bb5'`. Effects: `'slide'` glides to the next note of the same sound or track (or to `slideTo` Hz for a single note), `'vibrato'` wobbles the pitch by half a semitone at 6 Hz, `'fadeout'` fades the note to silence.

**Music** is `{ bpm, stepsPerBeat?, length (1–4,096 steps), loop? (default true), tracks }` with one to four tracks `{ voice?, waveform, volume, attack, decay, sustain, release, notes }` (up to 512 notes each, on distinct voices). Steps run on the audio clock, to the sample, independently of frames. A sound played on a voice silences that voice's track until it ends; the track then resumes at its next note.

```js
const theme = engine.audio.createMusic({
  bpm: 140,
  length: 16,
  tracks: [
    {
      waveform: 'square',
      volume: 0.3,
      notes: [
        { step: 0, pitch: 'E5', length: 2 },
        { step: 4, pitch: 'G5' },
      ],
    },
    {
      waveform: 'triangle',
      notes: [
        { step: 0, pitch: 'C3', length: 8 },
        { step: 8, pitch: 'G2', length: 8 },
      ],
    },
  ],
});
engine.audio.playMusic(theme); // starts after the first unlock()
```

## Palette

The palette holds 1–256 opaque colors, chosen at `createEngine`; its size never changes, so indices stored in images stay valid. `engine.setPalette(colors)` replaces every color between frames (same count). `graphics.setPaletteColor(index, r, g, b)` changes one color together with the current frame: it applies only if the whole frame is accepted, and it affects every pixel with that index when shown. `graphics.remap` changes which index drawing writes, for the rest of one frame.

## Capture

- `capture({ scale? })` resolves to a PNG `Blob` of the last presented frame, at its logical size times `scale` (1–8, nearest neighbor), in the colors it was shown with, whatever the renderer. The frame is copied during the call, so later frames never change it. Before the first presented frame it rejects with `STATE`.
- `startRecording({ maxSeconds?, scale? })` keeps presented frames, at most 50 per second, for the last `maxSeconds` (1–60, default 10) and at most 64 MiB of frame copies; nothing is copied while not recording or while paused. `stopRecording()` encodes them into a looping GIF `Blob` (scaled 1–4 times) in slices that keep the page responsive. `recording` is true in between.

```js
const png = await engine.capture({ scale: 4 });
engine.startRecording({ maxSeconds: 5 });
// … later, for example from a key press:
const gif = await engine.stopRecording();
```

## Portal

`@pixeljs/core/portal` connects a game to the PixelJS portal at pixeljs.com: levels and runs, leaderboards, achievements, cloud saves, online play and the portal's pause, resume and mute controls. It is a separate entry point without dependencies, so games that do not import it do not load it, and it can be imported in Node. [Publish on PixelJS](portal.md) explains `pixeljs.json` and the whole workflow.

```js
import { attachEngine, connectPortal, createRandom } from '@pixeljs/core/portal';
```

| Export                                                  | Notes                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectPortal(options?): Promise<Portal>`              | Options: `timeoutMs` (default 3000), `capabilities` (those `pixeljs.json` declares; without them the portal grants every reviewed one) and `engine` (for example `'@pixeljs/core@0.0.4'`). In the portal's frame it resolves once the portal answers, or after `timeoutMs`; anywhere else at once. |
| `attachEngine(portal, engine, { volume? }): () => void` | The portal's `pause` and `resume` pause and resume the engine, and `mute` sets its volume to 0 or back to `volume` (0–1, default 1). Call it after `engine.start()`, which ends a pause. Returns a function that detaches the engine.                                                              |
| `createRandom(seed): Random`                            | A deterministic generator (mulberry32) for the seed of an online match and for replays: any safe integer seed (taken modulo 2³²) gives the same numbers in every browser. Not cryptographic.                                                                                                       |
| `BRIDGE_VERSION`                                        | `'2.0.0'`, the version of the portal protocol that `connectPortal` speaks.                                                                                                                                                                                                                         |

**The portal.** Outside the portal every method still answers: `inPortal` is false, `levelEnd` and `gameOver` answer `{ recorded: false, reason: 'not_in_portal' }`, `levels()` answers `{}`, `player()` answers `{ signedIn: false }`, saves stay in memory until the page closes and online requests answer `{ ok: false, reason: 'not_in_portal' }`. A request the portal does not answer within 15 seconds resolves as unavailable.

| `Portal` member                                                                     | Notes                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inPortal`, `capabilities`, `launch`                                                | Whether the game runs in the portal, the capabilities it granted, and the play mode the player chose: `{ mode: 'solo' \| 'local' \| 'online', players?, room? }` (`{ mode: 'solo' }` outside the portal).                                                                                                 |
| `on(event, handler): () => void`                                                    | `pause`, `resume`, `mute` (`{ muted }`), `visibility` (`{ visible, focused }`), `viewport` (`{ width, height, dpr, mode }`), `select` (`{ level }`, with `level-select`) and `player` (`{ signedIn, handle? }`). Returns a function that stops listening. A handler that throws does not stop the others. |
| `loading(loaded, total)`, `ready()`, `error(message)`, `state({ paused?, muted? })` | The portal's loading bar; the game accepts input; the game cannot run (at most 200 characters); a pause or mute the game decided itself.                                                                                                                                                                  |
| `levelStart(level?): Promise<string>`                                               | Starts a run of a declared level (`"main"` without one) and resolves with its id. A run still open is first ended as `"quit"`.                                                                                                                                                                            |
| `levelEnd(run, result): Promise<LevelEndResult>`                                    | `result` is a `LevelResult`: `{ outcome: 'complete' \| 'fail' \| 'quit', scores?, timeMs?, stars?, stats?, replay? }`. Answers `{ recorded, reason?, newBest?, best?, rank?, unlocked?, held? }`.                                                                                                         |
| `gameOver(result?): Promise<LevelEndResult>`                                        | Ends the current run as `"fail"` with `{ scores?, timeMs?, stats?, replay? }`, for endless games.                                                                                                                                                                                                         |
| `levels(): Promise<Record<string, LevelProgress>>`                                  | The player's progress by level id: `{ completed, stars?, best?, bestTimeMs?, attempts? }`.                                                                                                                                                                                                                |
| `unlock(id): Promise<UnlockResult>`                                                 | Unlocks an achievement without a rule: `{ unlocked, reason? }` (`reason` `'already'` the second time).                                                                                                                                                                                                    |
| `save(slot, data, { rev? }): Promise<SaveResult>`                                   | Saves a string: `{ ok: true, rev }`, or `{ ok: false, reason }` such as `'conflict'` (a newer save than `rev` exists), `'rate_limited'` or `'too_large'`.                                                                                                                                                 |
| `load(slot): Promise<LoadResult>`                                                   | `{ data, rev, schema, reason? }`; `data` is `null` for an empty slot.                                                                                                                                                                                                                                     |
| `player(): Promise<PlayerInfo>`                                                     | `{ signedIn, handle? }`: everything a game learns about the player.                                                                                                                                                                                                                                       |
| `multiplayer`                                                                       | Online play, below.                                                                                                                                                                                                                                                                                       |

**Online play.** `portal.multiplayer` needs the `multiplayer` capability. A `Room` is `{ code, mode, private, state: 'lobby' | 'playing' | 'ended', host, me, min, max, players }`, where `host` and `me` are slots and each player is `{ slot, handle, avatar, ready, connected }`.

| `portal.multiplayer` member                        | Notes                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `available`                                        | True in the portal with the `multiplayer` capability granted.                                                                                                                                                                            |
| `find({ mode? })`, `host({ mode? })`, `join(code)` | Quick match, a new private room, or a private room by its code. Answer `{ ok: true, room? }` or `{ ok: false, reason }` (such as `'guest'` for players who are not signed in, or `'room_not_found'`).                                    |
| `start()`, `result(placements)`                    | The host starts the match, and reports the final placements (slots, best first). Answer `{ ok: true }` or `{ ok: false, reason }`.                                                                                                       |
| `ready(ready?)`, `send(data, { to? })`, `leave()`  | Marks the player ready in the room; sends any JSON value to every other player or to slot `to`; leaves the room or the queue. No answer.                                                                                                 |
| `on(event, handler): () => void`                   | `room` (a `Room`, also when the host changes), `start` (a `MatchStart`: the room and its 32-bit `seed`, the same for every player), `message` (`{ from, data }`: check `data` before use), `left` (`{ slot }`) and `end` (`{ reason }`). |

| `Random` member                                 | Notes                                                                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `next()`                                        | The next unsigned 32-bit integer.                                                                                           |
| `int(maxExclusive)`, `range(min, maxInclusive)` | An integer from 0 to `maxExclusive - 1` (`maxExclusive` 1 to 2³²), or from `min` to `maxInclusive`.                         |
| `float()`                                       | A number from 0 (included) to 1 (excluded).                                                                                 |
| `pick(array)`, `shuffle(array)`                 | One item of a non-empty array; shuffles an array in place (Fisher–Yates) and returns it.                                    |
| `state()`, `fork()`                             | The 32-bit state (`createRandom(random.state())` continues the same sequence); a new generator seeded from the next number. |

`attachEngine`, `createRandom`, `int`, `range` and `pick` throw `RANGE` for values outside their range, and `shuffle` throws `ARGUMENT` for anything but an array. The other exported types are `Portal`, `PortalOptions`, `PortalEvents`, `PortalCapability`, `PortalState`, `Launch`, `PlayMode`, `LevelResult`, `LevelOutcome`, `LevelEndResult`, `GameOverResult`, `LevelProgress`, `UnlockResult`, `SaveResult`, `LoadResult`, `PlayerInfo`, `Multiplayer`, `MultiplayerEvents`, `MultiplayerResult`, `RoomResult`, `Room`, `RoomPlayer`, `RoomState`, `MatchStart`, `MatchMessage`, `PlayerLeft`, `MatchEnd`, `NoData`, `Random` and `AttachEngineOptions`.

## Errors

Every failure throws (or rejects with) `PixelJSError`, whose `code` is one of:

| Code                                                                               | Meaning                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ARGUMENT`                                                                         | Wrong type or unknown option value.                                                                     |
| `RANGE`                                                                            | A number outside its documented range.                                                                  |
| `STATE`                                                                            | Not allowed in the current phase or state (for example drawing outside `draw()`, or after `dispose()`). |
| `HANDLE`                                                                           | A resource from another engine, of the wrong kind, or released.                                         |
| `CAPACITY`                                                                         | A frame, queue, resource table or byte limit is full.                                                   |
| `RESOURCE_IN_USE`                                                                  | A tileset still used by a tilemap.                                                                      |
| `ASSET_LOAD`, `ASSET_DATA`                                                         | A file could not be fetched, or its content is invalid.                                                 |
| `ABORTED`                                                                          | Cancelled through an `AbortSignal`.                                                                     |
| `UNSUPPORTED`                                                                      | The browser lacks a required feature (for example WebGL2 when `renderer: 'webgl2'` is requested).       |
| `BLOCKED`, `AUDIO_ERROR`                                                           | Audio was blocked by the browser, or failed.                                                            |
| `WASM_LOAD`, `WASM_MIME`, `ABI_MISMATCH`, `RENDERER`, `CALLBACK`, `ASYNC_CALLBACK` | Startup, rendering and callback failures.                                                               |

## Limits

| Quantity               | Limit                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Framebuffer and images | 1–1024 per side, at most 1,048,576 pixels                                                                            |
| Commands per frame     | 4,096 records (triangles and rotated sprites take two)                                                               |
| Work per frame         | 16,000,000 units (pixels plus loop steps; a rotated or scaled sprite pixel counts 3); larger frames throw `CAPACITY` |
| Resources              | 256 per engine                                                                                                       |
| Palette                | 1–256 opaque colors, fixed per engine                                                                                |
| Tiles, glyphs          | Tiles ≤ 256 px; glyphs ≤ 64 px, ≤ 256 per font; character codes 0–65,535                                             |
| Ellipses               | Boxes up to 16,384 px per side                                                                                       |
| Sprite transforms      | Rotation resolution 1/4096 turn; scale 1/16–64                                                                       |
| Pointers               | 10 simultaneous contacts                                                                                             |
| Gamepads               | 4                                                                                                                    |
| Audio                  | 4 voices; 1,024 queued events; music 4 tracks × 512 notes, 1–4,096 steps, 20–400 BPM; sounds 64 notes                |
| Downloads              | PNG 16 MiB, JSON image 4 MiB, JSON and font files 1 MiB, sound 64 KiB, music 256 KiB                                 |
| Asset manifests        | 1 MiB, 1,024 entries, 4 requests at a time, 16 MiB of `data` entries                                                 |
| Capture and recording  | PNG scale 1–8; GIF 1–60 s, 50 frames/s, 64 MiB of frames, scale 1–4, output ≤ 256 MiB                                |
| Memory                 | 64 MiB of WebAssembly memory per engine; 64 KiB for the audio DSP                                                    |

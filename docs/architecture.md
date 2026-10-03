# Architecture

This guide explains how PixelJS is built: where each responsibility lives, how a frame travels from your `draw()` call to the screen, how audio runs, and which limits and checks keep the engine predictable. It is written for contributors and for anyone who wants to know what happens under the API. The [API reference](api.md) describes the public surface.

## Goals

- **Deterministic pixels.** Every browser draws exactly the same pixels, so rasterization uses integer arithmetic only and never depends on the GPU.
- **Bounded work.** No input, however hostile, can make the engine allocate without limit or run without end: every batch of drawing commands is validated and its work budgeted before anything is drawn.
- **Atomic frames.** A frame is drawn completely or not at all.
- **Plain web deployment.** One ES module package with its WebAssembly files; no threads, `SharedArrayBuffer`, cross-origin isolation, `eval` or install-time downloads.
- **One runtime for JavaScript and TypeScript.** The same code and runtime checks serve both; TypeScript users also get declarations.

## Layers

| Layer                   | Location                                                                                           | Responsibility                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| C core                  | [`core/`](../core)                                                                                 | Context and allocator, indexed framebuffer, resources, command validation and rasterization, the audio DSP    |
| WebAssembly bridges     | [`bridge/wasm/`](../bridge/wasm), [`bridge/audio/`](../bridge/audio)                               | Scalar-only exports around one core context (visual) or one DSP (audio) per instance                          |
| SDK internals           | [`packages/core/src/internal/`](../packages/core/src/internal)                                     | WASM loader, heap views, command encoder, resource uploads, audio controller, asset loaders, capture encoders |
| Public API and web host | [`packages/core/src/api/`](../packages/core/src/api), [`host/web/`](../packages/core/src/host/web) | Validation, lifecycle and timing, input, display scaling, WebGL2 and Canvas2D presentation                    |
| Portal bridge           | [`packages/core/src/portal/`](../packages/core/src/portal)                                         | `@pixeljs/core/portal`, a separate entry point: messages to the PixelJS portal, and the seeded generator      |
| Tools                   | [`packages/create/`](../packages/create), [`apps/editor/`](../apps/editor)                         | The project generator and PixelJS Studio; both use only the public API                                        |

The C core knows nothing about browsers, WebGL, Emscripten or npm, and never calls back into JavaScript. The same sources compile natively (for tests, sanitizers and fuzzing) and to WebAssembly.

## Instances and ownership

Every engine owns its own WebAssembly instance, linear memory (a fixed 64 MiB, without growth) and C context. Instances are never shared or reused: disposing an engine abandons its instance, and a new engine loads a fresh one.

Resources (images, tilemaps and fonts) live in C. The SDK hands out frozen objects that map, through a private per-engine `WeakMap`, to 32-bit handles: 12 bits of slot and 20 bits of generation. Releasing a resource bumps its generation, so a stale handle can never reach a newer resource; a slot whose generation is exhausted is retired rather than wrapped. Because two engines can issue equal numeric handles, the SDK also checks that every object belongs to the engine it is passed to.

Images are immutable once uploaded and never alias the framebuffer. A tilemap retains its tileset: releasing an image that a map still uses fails with `RESOURCE_IN_USE`. Fonts are self-contained. Uploads go through a bounded staging buffer (begin, copy chunks, commit) and publish nothing if any step fails.

## The frame

Each displayed frame goes through four steps:

1. **Update.** `update(dt)` runs at a fixed rate (60 Hz by default). The host clamps a long pause to 250 ms of catch-up and runs at most five updates per displayed frame, counting the rest as dropped. Input is a snapshot per update tick.
2. **Draw.** `draw()` calls on `engine.graphics` are encoded into 32-byte little-endian records in a buffer shared with the core (the mailbox).
3. **Submit.** When `draw()` returns, the core processes the batch in two passes. The first pass checks everything without writing any state: the header, every record, flags and reserved fields, color indices, resource handles and their kinds, clipping, and the total work. Only if the whole batch is valid does the second pass draw it and apply palette changes. A rejected batch leaves the framebuffer and palette untouched and reports the index and byte offset of the failing command.
4. **Present.** The renderer shows the indexed framebuffer.

Drawing is allowed only during `draw()`; creating or releasing resources only between callbacks. Asynchronous loaders fetch and decode outside frames, then publish their resource synchronously between callbacks. Neither pass allocates memory or calls back into JavaScript.

### The command protocol

A batch starts with a 32-byte header (`PXJS` magic, protocol version, command count, exact byte length, a frame sequence number and reserved zero fields). Each record holds a 16-bit opcode, 16 bits of flags, a resource handle and six 32-bit arguments:

| Opcodes                                                                           | Meaning                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CLEAR`, `PIXEL`, `LINE`, `RECT`, `RECTB`, `CIRCLE`, `CIRCLE_FILL`                | Basic primitives                                                               |
| `ELLIPSE`, `ELLIPSE_FILL`, `TRIANGLE`, `TRIANGLE_FILL`, `FILL`                    | Ellipses in a box, triangles, flood fill                                       |
| `BLIT`, `BLIT_TRANSFORM`, `TILEMAP`, `GLYPH`                                      | Sprites (flipped, or rotated and scaled), tilemaps, text                       |
| `SET_CLIP`, `RESET_CLIP`, `SET_CAMERA`, `SET_REMAP`, `RESET_REMAP`, `SET_PALETTE` | Drawing state for the rest of the batch, and in-frame palette changes          |
| `PARAMS`                                                                          | Extra arguments for the record just before it (triangles, transformed sprites) |

Numeric constants, the export list and the TypeScript mirror are generated from one [schema](../protocol/schema.json); the build fails if the generated files drift from it. Unknown opcodes are errors, never silent no-ops.

### Work budget

A batch may hold 4,096 records, but the number of records alone does not bound the time spent drawing. Each command's work is estimated before the batch runs: pixel visits and loop steps, including the steps spent outside the clip. Lines count their visible length, circles their radius, tilemaps their visited cells, flood fills a constant per clip pixel, and rotated or scaled sprites three units per destination pixel. A batch above 16,000,000 units is rejected with `CAPACITY`. Debug builds assert that every command's actual work stays within its estimate, and a benchmark checks that a batch at the budget still fits a 60 Hz frame for each family of commands.

### Deterministic rasterization

All drawing is integer-only:

- Lines use Bresenham's algorithm. Clipping never moves a pixel: a clipped line draws exactly the visible pixels of its unclipped walk, found with one 128-bit division.
- An ellipse is the set of pixels whose centers lie inside the ellipse inscribed in its box; its outline is that set's boundary, so outlines and fills always match.
- A filled triangle is every pixel whose center is inside or on the triangle, computed with 128-bit edge functions, plus its three edges.
- A rotated or scaled sprite maps each destination pixel center back to one source pixel with fixed-point arithmetic and a generated sine table.

The test suites compare tens of thousands of random shapes of each kind against independent reference implementations, natively and in WebAssembly.

## Rendering

The renderer is chosen once per canvas: WebGL2 when available, otherwise Canvas2D. With WebGL2, the framebuffer is uploaded as an 8-bit integer texture and a fragment shader looks up each index in a palette texture, with nearest filtering. With Canvas2D, the core expands indices to RGBA and the host copies the result into an `ImageData`. Both produce identical pixels. A lost WebGL context pauses the engine; when it is restored, the renderer rebuilds its resources and the game continues.

The palette holds 1–256 opaque colors, fixed in size for the life of an engine, so indices stored in images stay valid. `setPalette` replaces the colors between frames; `setPaletteColor` changes one color together with a frame and takes effect only if that frame is accepted.

Display scaling is CSS only; the framebuffer keeps its logical size. With `scaling: 'fit'` or `'integer'`, the host sizes the canvas to its parent with a `ResizeObserver` and a device-pixel-ratio query, in whole device pixels, and restores the canvas's original styles on dispose.

## Input

Browser events are collected between ticks and frozen into one snapshot per update, so reading a key twice in one tick gives the same answer, and a press and release between two ticks still report both edges. Keyboard events use `KeyboardEvent.code`. Up to 10 pointer contacts carry engine-assigned ids and are mapped through the part of the canvas that actually shows the game, honoring `object-fit`, borders and padding; a contact that starts in a letterbox margin is ignored. Gamepads with the standard mapping are polled once per tick, with a dead zone on each axis. Blur, a hidden page, pausing and restarting clear held input, so nothing stays stuck down. All input storage is bounded.

## Audio

Audio is optional and loads only after `audio.unlock()`. The synthesizer is a second, independent C module (`audio.wasm`, one 64 KiB memory page, no imports) running inside an AudioWorklet. The processor module is a same-origin file, so a strict Content-Security-Policy allows it, and the main thread transfers the DSP bytes to it, so the audio thread never fetches anything. Rendering allocates nothing and never waits.

- **Synthesis.** Four voices of square, triangle, sine or noise waves, each with an attack/decay/sustain/release envelope and optional slide, vibrato or fade-out.
- **Sequencing.** Multi-note sounds and music are sequenced inside the DSP with a 16.16 fixed-point step clock, so every note starts at an exact sample, independently of frame timing. A sound played on a voice silences that voice's music track until it ends, and the track then continues.
- **Transport.** The main thread sends events in batches of up to 64, with at most four batches in flight; each acknowledgement returns one credit, and at most 1,024 events wait on the main thread. `stop()` starts a new epoch: the processor acknowledges but skips batches from older epochs. Stops travel outside the credits, but only one is unconfirmed at a time, so even a processor that stops reading holds at most four batches and one stop.
- **Failure.** Notes played while audio is not running are dropped rather than queued, so they never play late in a burst. Audio failures are reported to `onError` and never pause the game.

## Assets and capture

Loaders read at most a fixed number of bytes (16 MiB for a PNG, 1 MiB for JSON), check cancellation and disposal after every `await`, and inspect a PNG's header before the browser decodes it. PNG colors are mapped to the nearest palette index deterministically.

An asset manifest is validated completely before its first request: keys, types, ids and paths, which must stay inside the manifest's directory. Entries load four at a time, dependencies first (a tilemap after its tileset). If any entry fails, the pending requests are cancelled and everything already created is released, so a failed load leaves nothing behind. Manifest and font files are parsed strictly: unknown or duplicate keys are errors, and no key can reach an object prototype.

`capture()` copies the last presented frame's indices and palette during the call and encodes the PNG in JavaScript, so the result does not depend on the renderer and later frames cannot change it. Recording copies frames only while active, bounded by time, frame rate and memory, and encodes the GIF with an LZW encoder that yields to the page between slices.

## Memory and limits

| Quantity                 | Limit                                                     |
| ------------------------ | --------------------------------------------------------- |
| Screen and image size    | 1–1,024 pixels per side, at most 1,048,576 pixels         |
| Commands per frame       | 4,096 records                                             |
| Work per frame           | 16,000,000 units                                          |
| Resources per engine     | 256                                                       |
| C allocations per engine | 32 MiB, inside a fixed 64 MiB of WebAssembly memory       |
| Flood-fill stack         | Preallocated with the framebuffer: 4 bytes per pixel      |
| Audio                    | 4 voices; 4 batches of 64 events in flight; 1,024 waiting |
| Asset manifests          | 1 MiB, 1,024 entries, 4 requests at a time                |

Steady frames never call the C allocator. `getStats().coreBytes` reports the core's allocations; it does not include the browser's own memory.

## Security model

Assets, parameters and file contents are untrusted input, even though the game's own JavaScript is trusted by the page that runs it. PixelJS is not a sandbox for untrusted game code, and it cannot interrupt a callback that never returns.

- The core checks sizes, offsets and arithmetic before every allocation or memory access, validates every command before applying any, and bounds the work of every batch.
- Resource handles carry generations and kinds; the SDK also checks engine ownership.
- An unexpected WebAssembly trap makes the engine unusable: the SDK never calls into a module that may be in an inconsistent state.
- Loaders, manifests, fonts and the audio transport are all bounded in bytes, entries or messages.
- The project generator never writes through symbolic links and runs no shell commands.
- The portal bridge accepts only messages from its parent window that carry its frame's nonce, and checks their shape before using them; it posts nothing outside a portal frame.

WebAssembly isolates the core's memory from the page, not C objects from each other, so the C code follows strict rules: checked arithmetic, no variable-length arrays or recursion, no unbounded string functions, and bounds checks that stay on in release builds.

## Build and verification

The WebAssembly build uses a pinned Emscripten with a fixed heap, explicit exports and no filesystem, dynamic execution, SIMD or threads. The loader fetches at most 8 MiB, requires `application/wasm`, checks the module's ABI version and hands the verified bytes to the module factory. Package tarballs are reproducible: two clean builds, even on different operating systems, produce identical contents.

Every change runs through:

- native C tests, also under AddressSanitizer and UndefinedBehaviorSanitizer, with fault injection on every allocation;
- libFuzzer targets for the command decoder, resource uploads and the audio DSP;
- Node tests against the real WebAssembly binaries;
- browser tests in Chromium, Firefox and WebKit, served with the production Content-Security-Policy;
- tests of the packed npm tarballs and of freshly generated starter projects;
- benchmarks for frame cost, the work budget, audio deadlines, startup size and lifecycle leaks.

See [CONTRIBUTING.md](../CONTRIBUTING.md) to run them.

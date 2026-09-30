# PixelJS 0.0.1 browser benchmarks

Recorded: 2026-09-30T20:17:02.212Z (finished 2026-09-30T20:36:27.767Z) with `tools/bench-browser.mjs`, mode `full`.

> **Not an acceptance measurement.** The machine was busy (1-minute load average 2.59 at start, 4.71 at end; threshold 2.5). PASS/FAIL below is computed from these samples but is indicative only.

## Environment

- Source: commit `ba93a99b6043abae1d9f3b09737d851d7a2828d6`
- Build: @pixeljs/core 0.0.1; manifest artifacts/build-manifest.json; measured files match the manifest
- engine.wasm SHA-256: `85add7fd0795ff4aaea92c9320a24707fa6d281bad9c76c929cd968da3c0d7f2`
- audio.wasm SHA-256: `893cd370e6f8d780487ace24e92906e3f80e8337c51a932ba060d344377b0a78`
- Build flags: CMAKE_BUILD_TYPE=Release (tools/build-wasm.mjs); production validation enabled; pinned Emscripten 6.0.10
- Node: v24.20.0
- OS: darwin 27.0.1 (kernel 27.0.0, arm64), model Mac16,10
- CPU: Apple M4, 10 logical CPUs; memory 16384.00 MiB
- Power: Now drawing from 'AC Power'
- Load average (1/5/15 min): start 2.59 / 2.93 / 3.34, end 4.71 / 4.83 / 4.48; flagged busy above 2.5: yes
- Browser: chromium 154.0.8037.58 (channel chrome, headless, --enable-precise-memory-info); Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36; WebGL "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)" (Google Inc. (Apple)); GPU timer query available; devicePixelRatio 1; performance.now() resolution 0.1 ms (not isolated)
- Server: tools/serve.mjs on http://127.0.0.1:4184 (loopback), production CSP from infra/nginx/pixeljs.conf, production caching headers (no-cache, ETag, 304), uncompressed bodies

## Settings

- Warm-up 5000 ms, 5 repetition(s) of 30000 ms sampling (plan: at least 5000 ms, 30000 ms, 5).
- Deviations: none.
- Percentiles use the nearest-rank method. Summary p50/p95/p99 and the mean are medians of the per-repetition values; the spread of the per-repetition p95 is listed per benchmark. A single value is shown in the p50 column.
- Targets are stated per row and evaluated on the measured value (never hard-coded). They are engineering hypotheses from the plan until qualified on named hardware.

## Summary

| ID | Scenario | Metric | p50 | p95 | p99 | Mean | Target | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B01 | WebGL2: engine CPU (draw recording + submit + present) | ms per frame | 0.1000 ms | 0.2000 ms | 0.2000 ms | 0.1172 ms | p95 ≤ 4 ms (engine CPU, desktop) | PASS |
| B01 | WebGL2: update() game logic | ms per call | 0 ms | 0 ms | 0.1000 ms | 0.00128 ms | — | INFO |
| B01 | WebGL2: draw() SDK recording | ms per frame | 0 ms | 0.1000 ms | 0.1000 ms | 0.0239 ms | — | INFO |
| B01 | WebGL2: submit + present after draw() | ms per frame | 0.1000 ms | 0.2000 ms | 0.2000 ms | 0.0931 ms | — | INFO |
| B01 | WebGL2: C submission (WebGL split) | ms per frame | 0.1000 ms | 0.1000 ms | 0.2000 ms | 0.0620 ms | — | INFO |
| B01 | WebGL2: WebGL upload + draw call (CPU) | ms per frame | 0 ms | 0.1000 ms | 0.1000 ms | 0.0301 ms | — | INFO |
| B01 | WebGL2: GPU time (timer query) | ms per frame | 0.0291 ms | 0.0308 ms | 0.0494 ms | 0.0298 ms | — | INFO |
| B01 | WebGL2: frame interval (rAF) | ms | 16.70 ms | 16.80 ms | 16.80 ms | 16.67 ms | — | INFO |
| B01 | Canvas2D: engine CPU (draw recording + submit + present) | ms per frame | 0.2000 ms | 0.3000 ms | 0.4000 ms | 0.1871 ms | p95 ≤ 4 ms (engine CPU, desktop) | PASS |
| B01 | Canvas2D: update() game logic | ms per call | 0 ms | 0 ms | 0 ms | 0.00083 ms | — | INFO |
| B01 | Canvas2D: draw() SDK recording | ms per frame | 0 ms | 0.1000 ms | 0.1000 ms | 0.0213 ms | — | INFO |
| B01 | Canvas2D: submit + present after draw() | ms per frame | 0.2000 ms | 0.3000 ms | 0.3000 ms | 0.1657 ms | — | INFO |
| B01 | Canvas2D: frame interval (rAF) | ms | 16.70 ms | 16.80 ms | 16.80 ms | 16.67 ms | — | INFO |
| B01 | Cold start: navigation to first frame | ms | 44.60 ms | 53.90 ms | 53.90 ms | 45.13 ms | — | INFO |
| B01 | Cold start: createEngine() | ms | 9.30 ms | 11.70 ms | 11.70 ms | 9.61 ms | — | INFO |
| B01 | Cold start: engine.wasm fetch | ms | 0.9000 ms | 1.80 ms | 1.80 ms | 0.9900 ms | — | INFO |
| B01 | Cold start: WebAssembly.instantiate (compile + instantiate) | ms | 0.4000 ms | 0.6000 ms | 0.6000 ms | 0.3800 ms | — | INFO |
| B06 | Full cycle: create, load PNG, start, 2 frames, release, dispose | ms per cycle | 29.70 ms | 34.40 ms | 36.00 ms | 29.92 ms | — | INFO |
| B06 | Full cycle with audio unlock | ms per cycle | 39.00 ms | 41.90 ms | 43.10 ms | 39.45 ms | — | INFO |
| B06 | createEngine() aborted | ms per cycle | 0.7000 ms | 8.80 ms | 9.30 ms | 2.76 ms | — | INFO |
| B06 | loadImage() aborted, then dispose | ms per cycle | 8.80 ms | 34.70 ms | 36.30 ms | 15.84 ms | — | INFO |
| B06 | dispose() during loadImage() | ms per cycle | 6.40 ms | 9.30 ms | 10.60 ms | 6.83 ms | — | INFO |
| B06 | JS heap trend after forced GC (worst repetition) | bytes per cycle | 178 B | — | — | — | ≤ 1 KiB per cycle (no leak trend) | PASS |
| B06 | Renderer RSS trend (worst repetition, OS view) | bytes per cycle | 137.0 KiB | — | — | — | — | INFO |
| B07 | With audio: engine CPU (draw recording + submit + present) | ms per frame | 0.1000 ms | 0.2000 ms | 0.3000 ms | 0.1186 ms | p95 ≤ 4 ms (engine CPU, desktop) | PASS |
| B07 | With audio: update() game logic | ms per call | 0 ms | 0 ms | 0.2000 ms | 0.00738 ms | — | INFO |
| B07 | With audio: draw() SDK recording | ms per frame | 0 ms | 0.1000 ms | 0.1000 ms | 0.0236 ms | — | INFO |
| B07 | With audio: submit + present after draw() | ms per frame | 0.1000 ms | 0.2000 ms | 0.2000 ms | 0.0955 ms | — | INFO |
| B07 | With audio: C submission (WebGL split) | ms per frame | 0.1000 ms | 0.2000 ms | 0.2000 ms | 0.0643 ms | — | INFO |
| B07 | With audio: WebGL upload + draw call (CPU) | ms per frame | 0 ms | 0.1000 ms | 0.1000 ms | 0.0304 ms | — | INFO |
| B07 | With audio: GPU time (timer query) | ms per frame | 0.0309 ms | 0.0456 ms | 0.0940 ms | 0.0328 ms | — | INFO |
| B07 | With audio: frame interval (rAF) | ms | 16.70 ms | 16.70 ms | 16.80 ms | 16.67 ms | — | INFO |
| B07 | Burst of 16 play() calls | ms per burst | 0.2000 ms | 0.3000 ms | 0.3000 ms | 0.1767 ms | — | INFO |
| B07 | Batch ACK latency (post → ACK) | ms | 0.4000 ms | 0.7000 ms | 0.8000 ms | 0.3986 ms | — | INFO |
| B07 | Batches in flight (max) | count | 4 | — | — | — | ≤ 4 credits | PASS |
| B07 | play() rejected with CAPACITY | count | 0 | — | — | — | 0 under this load | PASS |
| B09 | First frame: cold, root /, audio off | ms from navigation | 45.00 ms | 50.40 ms | 50.40 ms | 46.68 ms | — | INFO |
| B09 | First frame: cold, root /, audio unlocked | ms from navigation | 44.80 ms | 51.20 ms | 51.20 ms | 46.08 ms | — | INFO |
| B09 | First frame: warm, root /, audio off | ms from navigation | 45.30 ms | 51.70 ms | 51.70 ms | 45.69 ms | — | INFO |
| B09 | First frame: warm, root /, audio unlocked | ms from navigation | 45.40 ms | 55.00 ms | 55.00 ms | 46.58 ms | — | INFO |
| B09 | First frame: cold, nested /games/demo/, audio off | ms from navigation | 46.00 ms | 50.50 ms | 50.50 ms | 46.34 ms | — | INFO |
| B09 | First frame: cold, nested /games/demo/, audio unlocked | ms from navigation | 46.60 ms | 52.10 ms | 52.10 ms | 46.83 ms | — | INFO |
| B09 | First frame: warm, nested /games/demo/, audio off | ms from navigation | 46.10 ms | 50.50 ms | 50.50 ms | 46.14 ms | — | INFO |
| B09 | First frame: warm, nested /games/demo/, audio unlocked | ms from navigation | 45.80 ms | 53.30 ms | 53.30 ms | 45.80 ms | — | INFO |
| B09 | Audio unlock (click → running): cold, root | ms | 17.90 ms | 20.00 ms | 20.00 ms | 18.15 ms | — | INFO |
| B09 | Audio unlock (click → running): warm, root | ms | 17.50 ms | 18.80 ms | 18.80 ms | 17.70 ms | — | INFO |
| B09 | Cold, audio off: bytes before the first frame (served, uncompressed) | bytes | 250.9 KiB | — | — | — | — | INFO |
| B09 | Warm, audio off: body bytes (304 revalidation) | bytes | 0 B | — | — | — | — | INFO |
| B09 | Cold unlock: audio bytes (audio.wasm + processor.js) | bytes | 22.6 KiB | — | — | — | — | INFO |
| B09 | Runtime JS + WASM before the first frame, brotli 11 (computed) | bytes | 65.9 KiB | — | — | — | ≤ 1 MiB compressed (visual runtime target) | PASS |
| B11 | Frame interval, no loads (baseline) | ms | 16.70 ms | 16.70 ms | 16.80 ms | 16.67 ms | — | INFO |
| B11 | Frame interval during loads and uploads | ms | 16.70 ms | 16.70 ms | 16.80 ms | 16.69 ms | — | INFO |
| B11 | Frame interval p95 ratio, loads / baseline | ratio | 1 × | — | — | — | p95 ratio ≤ 1.25 | PASS |
| B11 | Engine CPU per frame during loads | ms per frame | 0 ms | 0.1000 ms | 0.2000 ms | 0.0521 ms | p95 ≤ 4 ms (engine CPU, desktop) | PASS |
| B11 | loadImage() 64 × 64 PNG (2304 bytes) | ms to published | 1.60 ms | 6.00 ms | 22.20 ms | 2.51 ms | — | INFO |
| B11 | loadImage() 256 × 256 PNG (26229 bytes) | ms to published | 3.10 ms | 23.00 ms | 23.90 ms | 8.91 ms | — | INFO |
| B11 | loadImage() 1024 × 1024 PNG (391920 bytes) | ms to published | 24.50 ms | 42.80 ms | 46.30 ms | 30.88 ms | — | INFO |
| B11 | Cancellation: abort() to rejection | ms | 0 ms | 0.2000 ms | 3.40 ms | 0.1127 ms | — | INFO |
| B11 | createImage() 1024 × 1024 between frames (synchronous) | ms per call | 4.70 ms | 4.90 ms | 5.00 ms | 4.75 ms | — | INFO |
| B11 | Peak performance.memory during loads (Chromium, precise flag) | bytes | 57.29 MiB | — | — | — | — | INFO |
| B11 | Peak accounted C bytes (coreBytes) | bytes | 4.53 MiB | — | — | — | — | INFO |
| B11 | Peak JS heap sampled via DevTools every 250 ms | bytes | 4.29 MiB | — | — | — | — | INFO |
| B11 | Peak renderer RSS (OS view) | bytes | 688.27 MiB | — | — | — | — | INFO |
| B12 | Burst: play() calls admitted | count | 1028 | — | — | — | = 1028 (1,024 queued + 4 in flight) | PASS |
| B12 | Burst: time to drain the queue (last ACK) | ms | 0.9000 ms | 1.60 ms | 1.70 ms | 0.9600 ms | — | INFO |
| B12 | Batch ACK latency (post → ACK) | ms | 0.2000 ms | 21.50 ms | 22.30 ms | 3.75 ms | — | INFO |
| B12 | Batches in flight (max) | count | 4 | — | — | — | ≤ 4 credits | PASS |
| B12 | stop() with a full queue | ms per call | 0 ms | 0.1000 ms | 0.1000 ms | 0.0150 ms | — | INFO |
| B12 | STOP round trip (stop() → ACK of the next note) | ms | 0.1000 ms | 0.2000 ms | 0.2000 ms | 0.0750 ms | — | INFO |
| B12 | pause() → AudioContext suspended | ms | 0.3000 ms | 0.4000 ms | 0.4000 ms | 0.2700 ms | — | INFO |
| B12 | resume() → AudioContext running | ms | 2.20 ms | 3.40 ms | 4.40 ms | 2.42 ms | — | INFO |
| B12 | Failing processor: unlock → failure reported | ms | 121.9 ms | — | — | — | — | INFO |
| B08 | At least 15 minutes on a named physical mobile device | — | — | — | — | — | — | NOT RUN: not executed: needs a named physical device |
| B10 | E0 versus optional E1/E2 worker execution | — | — | — | — | — | — | N/A: not applicable (no worker runtime) |

## Matrix coverage

| ID | Where it is measured |
| --- | --- |
| B01 | Core part (validation + raster): `npm run bench`. Full browser pipeline and cold start: `npm run bench:browser`. |
| B02–B05 | `npm run bench` (core in Node on the real engine.wasm). |
| B06 | `npm run bench:browser` (1,000 create/load/start/dispose cycles in Chromium). |
| B07 | DSP: `npm run bench`. Game rendering with music, bursts and the real AudioWorklet: `npm run bench:browser`. |
| B08 | Not executed: needs a named physical device. |
| B09 | `npm run bench:browser` (startup bytes and phases, audio off/lazy, cold/warm cache, root and nested path). |
| B10 | Not applicable (no worker runtime). |
| B11 | `npm run bench:browser` (image loads during play, cancellation, peak memory). |
| B12 | Transport with a scripted port: `npm run bench`. Real AudioWorklet in Chromium: `npm run bench:browser`. |

## Details

### B01 — 256 × 144 character/HUD scene: full pipeline and cold start (chromium 154.0.8037.58)

Status: **PASS**

Runs in: chromium 154.0.8037.58 via Playwright (headless, channel chrome), GPU "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)"; pages served by tools/serve.mjs with the production CSP and caching headers

Measures:

- The same scene as the core B01 (tools/bench/site/scene.mjs) through the public API in a running engine: update() game logic, draw() (SDK argument validation and command recording), then the engine’s own work after draw() returns (C validation and rasterization, then presentation), timed to the microtask that runs when the frame callback returns.
- With WebGL2, the frame’s first texSubImage2D splits C submission from presentation (texture upload and draw-call submission); GPU execution time comes from EXT_disjoint_timer_query_webgl2 where the browser exposes it (disjoint samples discarded). Canvas2D reports submit + present together (its present includes palette expansion and putImageData).
- Frame intervals from requestAnimationFrame timestamps, and cold start: a fresh browser context (empty HTTP cache) loads the game page at the site root; time from navigation start to the first submitted frame, with createEngine, the engine.wasm fetch and WebAssembly instantiation.

Does not measure:

- WebGL call time is CPU submission, not GPU completion; the GPU row is the timer-query measurement and is absent where the extension is not exposed. Compositor and display latency are not measured.
- Frame intervals are paced by the display/compositor (headless Chromium runs at about 60 Hz), so they show dropped frames rather than cost.
- Cold start here keeps the browser process, GPU process and their shader caches warm; it is not a first launch after boot. See B09 for bytes, warm cache and the nested path.
- performance.now() is clamped by the browser (Chromium: 100 µs unless the page is cross-origin isolated, 5 µs with --isolate); per-frame percentiles are multiples of the resolution listed under Environment, while means over many frames are far less affected by it.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| WebGL2 variant renders with WebGL2 | webgl2 | webgl2 | PASS |
| Canvas2D variant renders with Canvas2D | canvas2d | canvas2d | PASS |
| Steady frames make no C allocations | webgl2 7→7, canvas2d 7→7 | unchanged | PASS |
| No engine or page errors | none | none | PASS |
| Every cold load reached its first frame without errors or CSP violations | 50 of 50 | 50 of 50 | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- WebGL2: engine CPU (draw recording + submit + present), ms per frame: 0.2000 ms – 0.2000 ms (5 runs, 9001 samples)
- WebGL2: update() game logic, ms per call: 0 ms – 0 ms (5 runs, 9001 samples)
- WebGL2: draw() SDK recording, ms per frame: 0.1000 ms – 0.1000 ms (5 runs, 9001 samples)
- WebGL2: submit + present after draw(), ms per frame: 0.2000 ms – 0.2000 ms (5 runs, 9001 samples)
- WebGL2: C submission (WebGL split), ms per frame: 0.1000 ms – 0.2000 ms (5 runs, 9001 samples)
- WebGL2: WebGL upload + draw call (CPU), ms per frame: 0.1000 ms – 0.1000 ms (5 runs, 9001 samples)
- WebGL2: GPU time (timer query), ms per frame: 0.0306 ms – 0.0319 ms (5 runs, 9000 samples)
- WebGL2: frame interval (rAF), ms: 16.70 ms – 16.80 ms (5 runs, 9001 samples)
- Canvas2D: engine CPU (draw recording + submit + present), ms per frame: 0.3000 ms – 0.3000 ms (5 runs, 9000 samples)
- Canvas2D: update() game logic, ms per call: 0 ms – 0 ms (5 runs, 9000 samples)
- Canvas2D: draw() SDK recording, ms per frame: 0.1000 ms – 0.1000 ms (5 runs, 9000 samples)
- Canvas2D: submit + present after draw(), ms per frame: 0.3000 ms – 0.3000 ms (5 runs, 9000 samples)
- Canvas2D: frame interval (rAF), ms: 16.70 ms – 16.80 ms (5 runs, 9000 samples)
- Cold start: navigation to first frame, ms: 48.80 ms – 65.80 ms (5 runs, 50 samples)
- Cold start: createEngine(), ms: 10.70 ms – 15.90 ms (5 runs, 50 samples)
- Cold start: engine.wasm fetch, ms: 1.30 ms – 2.00 ms (5 runs, 50 samples)
- Cold start: WebAssembly.instantiate (compile + instantiate), ms: 0.5000 ms – 0.6000 ms (5 runs, 50 samples)

Observations:

- GPU timer query available: true
- WebGL2 intervals longer than 1.5 × the median interval: 0 of 9001 (median 16.70 ms)
- Frames rendered (WebGL2 / Canvas2D): 9302 / 9301
- Dropped update backlog (WebGL2 / Canvas2D): 0 / 0
- Cold loads measured: 50

Raw samples: `raw/B01.json`

### B06 — 1,000 create/load/start/dispose cycles with cancellations (chromium 154.0.8037.58)

Status: **PASS**

Runs in: chromium 154.0.8037.58 via Playwright (headless, channel chrome), GPU "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)"; pages served by tools/serve.mjs with the production CSP and caching headers

Measures:

- Per repetition, 1,000 cycles in one page through the public API, in a fixed rotation: 6/10 full cycles (createEngine, loadImage of a 16 × 16 PNG, start, two frames, release, dispose), 1/10 with audio unlocked and a note played, 1/10 createEngine aborted with an AbortController (immediately, after a task or after 5 ms), 1/10 loadImage of a 1024 × 1024 PNG aborted the same ways, 1/10 dispose() while that PNG loads. Renderers alternate between auto (WebGL2) and Canvas2D.
- Time per cycle by kind; the outcome of every cycle against its expected outcome.
- Native: the accounted C bytes after releasing the image equal those before loading it. Host: canvases left in the document, JS event listeners and DOM nodes (Chromium DevTools counters after a forced GC). GPU: WebGL2 contexts created and the browser’s “too many active WebGL contexts” warnings. Audio: AudioContexts left open after dispose. Memory: JS heap after a forced GC at each checkpoint, its trend per cycle, and renderer RSS from the OS.
- Attribution (Chromium): after the mixed cycles, a batch of full cycles and then a batch of audio cycles, each between forced-GC snapshots, give the JS listeners, DOM nodes and audio nodes still reachable per cycle of each kind.

Does not measure:

- dispose() does not promise to return WebAssembly memory to the OS; the RSS trend is reported, not gated. performance.memory and DevTools counters are Chromium-only and approximate.
- The engine does not call WEBGL_lose_context on dispose, so WebGL contexts of removed canvases live until garbage collection; the warning count shows how often the browser had to evict them.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Every cycle ended as expected | 5000 cycles | no unexpected outcome | PASS |
| Released images return the accounted C bytes (native ownership) | 0 mismatches | 0 | PASS |
| Every AudioContext is closed or collected after dispose | 0 open | 0 | PASS |
| No canvas is left in the document | 0 extra | 0 | PASS |
| No page errors or CSP violations | none | none | PASS |
| Disposed engines without audio stay unreachable (listeners, DOM nodes) | 0.00 listeners, 0.00 DOM nodes, 0.00 audio nodes per cycle | ≤ 0.05 per cycle | PASS |
| Disposed engines that unlocked audio stay unreachable (listeners, DOM nodes) | 0.00 listeners, 0.00 DOM nodes, 2.00 audio nodes per cycle | ≤ 0.05 per cycle | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- Full cycle: create, load PNG, start, 2 frames, release, dispose, ms per cycle: 34.30 ms – 34.40 ms (5 runs, 3000 samples)
- Full cycle with audio unlock, ms per cycle: 41.40 ms – 42.60 ms (5 runs, 500 samples)
- createEngine() aborted, ms per cycle: 8.50 ms – 9.00 ms (5 runs, 500 samples)
- loadImage() aborted, then dispose, ms per cycle: 34.60 ms – 35.90 ms (5 runs, 500 samples)
- dispose() during loadImage(), ms per cycle: 8.90 ms – 10.30 ms (5 runs, 500 samples)

Observations:

- Outcomes: {"full: DISPOSED":3000,"abortCreate: ABORTED":336,"abortLoad: ABORTED":338,"disposeDuringLoad: STATE":500,"audio: DISPOSED":500,"abortCreate: created before abort":164,"abortLoad: loaded before abort":162}
- JS event listeners / DOM nodes after GC, end minus start (worst repetition): +0 / +0
- Retention per cycle by kind (last repetition): {"full":{"count":50,"unexpected":0,"listeners":0,"nodes":0,"audioHandlers":0,"heapBytes":49.68},"audio":{"count":50,"unexpected":0,"listeners":0,"nodes":0,"audioHandlers":2,"heapBytes":554.56}}
- WebGL2 contexts created per repetition: 433, 432, 433, 433, 433
- “Too many active WebGL contexts” warnings per repetition: 0, 8, 8, 0, 0
- AudioContexts created / closed / collected (last repetition): 121 / 121 / 0
- JS heap after GC, start → end (last repetition): 2174460 → 2338160 bytes
- Renderer RSS, start → end (last repetition): 411271168 → 385466368 bytes
- JS heap trend per repetition (bytes/cycle): 178.3, 173.5, 176.7, 173.9, 176.6

Raw samples: `raw/B06.json`

### B07 — Four voices with event bursts and four-track music while the game renders (chromium 154.0.8037.58)

Status: **PASS**

Runs in: chromium 154.0.8037.58 via Playwright (headless, channel chrome), GPU "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)"; pages served by tools/serve.mjs with the production CSP and caching headers

Measures:

- The B01 scene rendering with WebGL2 while audio runs on the real AudioWorklet: a looping four-track piece (a note every step, vibrato/slide/fadeout) and, every 30 updates, a burst of four multi-note sounds (8 notes at 400 BPM) and twelve single notes, i.e. 16 play() calls, more than the four batch credits.
- Engine CPU per frame with audio active, the update() cost including bursts, the burst alone, CAPACITY rejections, and the transport as seen from the main thread: acknowledgement latency per batch (post to ACK), batches in flight and batch sizes (JSON length as a proxy).
- AudioContext state, sample rate and latencies as reported by the browser.

Does not measure:

- Audio-thread render time, deadline misses and audible glitches: Chromium exposes no playout statistics here (AudioContext.playoutStats is absent), so glitches are not observable; the DSP cost per quantum is measured in the Node B07.
- Headless Chromium mutes output (--mute-audio); the audio graph still runs.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Audio is running at the end | running | running | PASS |
| Music is still playing | true | true | PASS |
| Steady frames make no C allocations | 7→7 | unchanged | PASS |
| No engine or page errors | none | none | PASS |
| Every batch was acknowledged | 0 unacknowledged at the end | ≤ 4 (the last credits) | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- With audio: engine CPU (draw recording + submit + present), ms per frame: 0.2000 ms – 0.2000 ms (5 runs, 9001 samples)
- With audio: update() game logic, ms per call: 0 ms – 0.1000 ms (5 runs, 9001 samples)
- With audio: draw() SDK recording, ms per frame: 0.1000 ms – 0.1000 ms (5 runs, 9001 samples)
- With audio: submit + present after draw(), ms per frame: 0.2000 ms – 0.2000 ms (5 runs, 9001 samples)
- With audio: C submission (WebGL split), ms per frame: 0.2000 ms – 0.2000 ms (5 runs, 9001 samples)
- With audio: WebGL upload + draw call (CPU), ms per frame: 0.1000 ms – 0.1000 ms (5 runs, 9001 samples)
- With audio: GPU time (timer query), ms per frame: 0.0323 ms – 0.1030 ms (5 runs, 9000 samples)
- With audio: frame interval (rAF), ms: 16.70 ms – 16.80 ms (5 runs, 9001 samples)
- Burst of 16 play() calls, ms per burst: 0.3000 ms – 0.4000 ms (5 runs, 300 samples)
- Batch ACK latency (post → ACK), ms: 0.7000 ms – 0.7000 ms (1 runs, 1546 samples)

Observations:

- Bursts / plays: 309 / 4944
- Batches posted / max events per batch / max JSON bytes: 1546 / 12 / 5083
- AudioContext: running, 48000 Hz, baseLatency 0.005333333333333333, outputLatency 0.016, playoutStats not exposed
- Intervals longer than 1.5 × the median: 0 of 9001

Raw samples: `raw/B07.json`

### B09 — Startup: audio off vs lazy activation, cold/warm cache, root and nested path (chromium 154.0.8037.58)

Status: **PASS**

Runs in: chromium 154.0.8037.58 via Playwright (headless, channel chrome), GPU "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)"; pages served by tools/serve.mjs with the production CSP and caching headers

Measures:

- The game page (tools/bench/site/game.html, the B01 scene) deployed at / and at /games/demo/ with the packaged runtime beside it and relative imports. Each sample: a fresh browser context loads the page (cold: empty HTTP cache), then a second page in the same context loads it again (warm). With audio, Playwright clicks the page’s sound button (a real user gesture) after the first frame.
- Time from navigation start to the first submitted frame, the unlock time from click to a running AudioContext, and the bytes the server sent per resource kind (body bytes from the server log, headers excluded), with the HTTP statuses.
- The served runtime files needed before the first frame, compressed locally with brotli (quality 11) and gzip (level 9), against the 1 MiB compressed target.
- The server answers like the production Nginx site: `Cache-Control: no-cache, no-transform` with ETag/Last-Modified and 304 revalidation, and the production CSP.

Does not measure:

- Network latency and bandwidth (loopback), TLS and HTTP/2; tools/serve.mjs sends uncompressed bodies, so transfer sizes are uncompressed and the compressed sizes are computed, not transferred.
- Audio startup happens after the first frame by design; the unlock time includes the audio.wasm download, the worklet module and the processor handshake, but not audible output (headless Chromium mutes output).
- Cold here means an empty HTTP cache in a running browser; the browser and GPU processes are already warm.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Every load reached its first frame without errors or CSP violations | 400 of 400 | 400 of 400 | PASS |
| Audio off: no AudioContext and no audio bytes | 0 loads touched audio | 0 loads | PASS |
| Lazy activation: audio runs after the click | running | running | PASS |
| Nested deployment requests stay under /games/demo/ | none outside | none outside | PASS |
| Warm loads revalidate engine.wasm with 304 | 200 of 200 | 200 of 200 | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- First frame: cold, root /, audio off, ms from navigation: 50.30 ms – 57.90 ms (5 runs, 50 samples)
- First frame: cold, root /, audio unlocked, ms from navigation: 48.60 ms – 58.70 ms (5 runs, 50 samples)
- First frame: warm, root /, audio off, ms from navigation: 46.80 ms – 53.90 ms (5 runs, 50 samples)
- First frame: warm, root /, audio unlocked, ms from navigation: 47.10 ms – 60.40 ms (5 runs, 50 samples)
- First frame: cold, nested /games/demo/, audio off, ms from navigation: 48.70 ms – 56.50 ms (5 runs, 50 samples)
- First frame: cold, nested /games/demo/, audio unlocked, ms from navigation: 50.30 ms – 59.50 ms (5 runs, 50 samples)
- First frame: warm, nested /games/demo/, audio off, ms from navigation: 49.00 ms – 56.60 ms (5 runs, 50 samples)
- First frame: warm, nested /games/demo/, audio unlocked, ms from navigation: 48.30 ms – 58.50 ms (5 runs, 50 samples)
- Audio unlock (click → running): cold, root, ms: 18.70 ms – 27.40 ms (5 runs, 50 samples)
- Audio unlock (click → running): warm, root, ms: 18.30 ms – 20.00 ms (5 runs, 50 samples)

Observations:

- Loads measured: 400
- Runtime files before the first frame (root, cold): /pixeljs/index.js, /pixeljs/api/engine.js, /pixeljs/internal/protocol.js, /pixeljs/api/errors.js, /pixeljs/host/web/input.js, /pixeljs/host/web/renderer.js, /pixeljs/host/web/viewport.js, /pixeljs/internal/assets/bundle.js, /pixeljs/internal/assets/font-format.js, /pixeljs/internal/assets/json.js, /pixeljs/internal/assets/manifest.js, /pixeljs/internal/audio/controller.js, /pixeljs/internal/capture/service.js, /pixeljs/internal/commands.js, /pixeljs/internal/fetch.js, /pixeljs/internal/image-decoder.js, /pixeljs/internal/wasm/adapter.js, /pixeljs/host/web/gamepads.js, /pixeljs/host/web/pointers.js, /pixeljs/internal/audio/sequence.js, /pixeljs/host/web/styles.js, /pixeljs/internal/capture/gif.js, /pixeljs/internal/capture/png.js, /pixeljs/internal/capture/recorder.js, /pixeljs/internal/capture/slice.js, /pixeljs/internal/wasm/engine.wasm, /pixeljs/internal/wasm/engine.mjs
- Runtime size raw / gzip / brotli: 251253 / 77993 / 67499 bytes
- Audio files raw / gzip / brotli (after unlock): 23166 / 11246 / 10083 bytes
- Typical HTTP statuses, warm load: {"html 304":1,"js 304":28,"engine.wasm 304":1}
- createEngine() cold / warm (median of p50s): 9.50 / 8.90 ms

Raw samples: `raw/B09.json`

### B11 — Upload, decode and publication during play; cancellation and limits (chromium 154.0.8037.58)

Status: **PASS**

Runs in: chromium 154.0.8037.58 via Playwright (headless, channel chrome), GPU "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)"; pages served by tools/serve.mjs with the production CSP and caching headers

Measures:

- The B01 scene renders (WebGL2) while two loadImage() calls are always in flight, cycling 64 × 64, 256 × 256 and 1024 × 1024 PNGs (every fifth load is aborted at once or after 0–10 ms), and a synchronous 1024 × 1024 createImage() runs between frames every 500 ms; loaded images are drawn, and the oldest is released once eight are live. Baseline repetitions without loads come first.
- Frame intervals and engine CPU with and without loads, time from loadImage() to a published image per size, cancellation latency (abort() to rejection), the synchronous upload cost, and peak memory: performance.memory per frame, DevTools JS heap and renderer RSS every 250 ms, and the accounted C bytes.
- No partial state: cancelled loads alone leave the accounted C bytes unchanged. Limits: images are created until CAPACITY, which must arrive at the 256-slot resource limit while the engine keeps running.

Does not measure:

- Queue limits inside the engine: there is no loader queue and no decode-concurrency limit yet; concurrency here is bounded by the caller, and peak memory scales with it.
- PNG decoding runs in the browser (createImageBitmap) and palette mapping on the main thread; both are included in the load time, and a cancellation cannot interrupt a decode already running.
- DevTools heap samples are not forced-GC values; RSS is the OS view of all renderer processes.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Every load that was not cancelled was published | 17371 published | all published | PASS |
| Cancellations reject with ABORTED (or had already completed) | {"abort at once: ABORTED":869,"abort after 0 ms: ABORTED":869,"abort after 2 ms: ABORTED":328,"abort after 5 ms: completed first":687,"abort after 10 ms: completed first":782,"abort after 2 ms: completed first":540,"abort after 5 ms: ABORTED":181,"abort after 10 ms: ABORTED":84} | ABORTED or completed first | PASS |
| Cancelled loads leave the accounted C bytes unchanged | 345468 → 345468 | unchanged | PASS |
| Creating images stops with CAPACITY at the 256-slot limit | CAPACITY after 253 + 3 live | CAPACITY at 256 | PASS |
| The engine keeps running at the limit and recovers its bytes | RUNNING, restored true | RUNNING, restored | PASS |
| No engine or page errors | none | none | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- Frame interval, no loads (baseline), ms: 16.70 ms – 16.80 ms (5 runs, 9001 samples)
- Frame interval during loads and uploads, ms: 16.70 ms – 16.80 ms (5 runs, 8988 samples)
- Engine CPU per frame during loads, ms per frame: 0.1000 ms – 0.1000 ms (5 runs, 8988 samples)
- loadImage() 64 × 64 PNG (2304 bytes), ms to published: 4.10 ms – 19.90 ms (5 runs, 5791 samples)
- loadImage() 256 × 256 PNG (26229 bytes), ms to published: 22.40 ms – 23.40 ms (5 runs, 5790 samples)
- loadImage() 1024 × 1024 PNG (391920 bytes), ms to published: 42.20 ms – 43.30 ms (5 runs, 5790 samples)
- Cancellation: abort() to rejection, ms: 0.2000 ms – 0.2000 ms (1 runs, 4340 samples)
- createImage() 1024 × 1024 between frames (synchronous), ms per call: 4.90 ms – 4.90 ms (1 runs, 290 samples)

Observations:

- Loads published / cancelled: 17371 / 4340
- Cancellation outcomes: {"abort at once: ABORTED":869,"abort after 0 ms: ABORTED":869,"abort after 2 ms: ABORTED":328,"abort after 5 ms: completed first":687,"abort after 10 ms: completed first":782,"abort after 2 ms: completed first":540,"abort after 5 ms: ABORTED":181,"abort after 10 ms: ABORTED":84}
- Intervals longer than 2 × the baseline median (baseline / loads): 0 / 5
- Quiet cancellation outcomes: {"ABORTED":14,"completed first":36}

Raw samples: `raw/B11.json`

### B12 — Audio transport on the real AudioWorklet: saturation, STOP, suspend, missing ACK and failure (chromium 154.0.8037.58)

Status: **PASS**

Runs in: chromium 154.0.8037.58 via Playwright (headless, channel chrome), GPU "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)"; pages served by tools/serve.mjs with the production CSP and caching headers

Measures:

- Real processor: 5000 play() calls in one task (no ACK can arrive meanwhile), then the time until every posted batch is acknowledged; STOP with a full queue, and the round trip until a note posted in the new epoch is acknowledged; pause()/resume() and the device state changes; 20 iterations.
- Stalled processor (benchmark fixture that completes the handshake and then never reads its port): credits after 2,000 plays, and port traffic after 200 stop()/play() cycles.
- Failing processor (benchmark fixture that reports an error 32 quanta after starting): time from unlock to the reported failure, while the game keeps rendering.

Does not measure:

- Audible output and device underruns (headless Chromium mutes output; no playout statistics are exposed). Times come from main-thread timestamps of posts and received messages.
- Batch sizes use JSON length as a proxy for the structured clone; the Node B12 reports V8 serialization sizes.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Every burst admits exactly 1,024 + 4 notes | 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028, 1028 | 1028 | PASS |
| Every posted batch is acknowledged after a burst | 20 of 20 | 20 of 20 | PASS |
| No note is sent while paused | 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 | 0 | PASS |
| Stalled processor: plays leave ≤ 4 batches posted | 4 posts, 1028 admitted | ≤ 4 | PASS |
| Stalled processor: port traffic stays bounded across stop()/play() cycles | 5 posts (660 JSON bytes) after 200 cycles | ≤ 5 | PASS |
| Failing processor: reported once, audio failed, context closed | AUDIO_ERROR; failed; context closed | AUDIO_ERROR once; failed; closed | PASS |
| Failing processor: the game keeps running | RUNNING, 12 frames in 200 ms after the failure | RUNNING, frames advancing | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- Burst: time to drain the queue (last ACK), ms: 1.60 ms – 1.60 ms (1 runs, 20 samples)
- Batch ACK latency (post → ACK), ms: 21.50 ms – 21.50 ms (1 runs, 400 samples)
- stop() with a full queue, ms per call: 0.1000 ms – 0.1000 ms (1 runs, 20 samples)
- STOP round trip (stop() → ACK of the next note), ms: 0.2000 ms – 0.2000 ms (1 runs, 20 samples)
- pause() → AudioContext suspended, ms: 0.4000 ms – 0.4000 ms (1 runs, 20 samples)
- resume() → AudioContext running, ms: 3.40 ms – 3.40 ms (1 runs, 20 samples)

Observations:

- Unlock (real processor): 9.7 ms, state running
- Rejected per burst (CAPACITY): 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972, 3972
- Stalled processor posts after burst / after cycles: 4 / 5

Raw samples: `raw/B12.json`

### B08 — At least 15 minutes on a named physical mobile device

Status: **NOT RUN**

not executed: needs a named physical device

Does not measure:

- No physical Android or iPhone is attached to this machine. Desktop browsers, Playwright WebKit and simulators do not substitute for it.

### B10 — E0 versus optional E1/E2 worker execution

Status: **N/A**

not applicable (no worker runtime)

Does not measure:

- PixelJS 0.0.1 has no E1/E2 worker runtime (engine.capabilities.workers is false), so there is nothing to compare against E0.

Observations:

- engine.capabilities.workers observed in the browser: false

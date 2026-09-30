# PixelJS 0.0.1 Node benchmarks (core, DSP and audio transport)

Recorded: 2026-09-30T19:14:24.952Z (finished 2026-09-30T20:16:26.775Z) with `tools/bench.mjs`, mode `full`.

> **Not an acceptance measurement.** The machine was busy (1-minute load average 3.97 at start, 2.86 at end; threshold 2.5). PASS/FAIL below is computed from these samples but is indicative only.

## Environment

- Source: commit `36bf7b468e4c827f4c59ea06e0f85721f7d49394`
- Build: @pixeljs/core 0.0.1; manifest artifacts/build-manifest.json; measured files match the manifest
- engine.wasm SHA-256: `85add7fd0795ff4aaea92c9320a24707fa6d281bad9c76c929cd968da3c0d7f2`
- audio.wasm SHA-256: `893cd370e6f8d780487ace24e92906e3f80e8337c51a932ba060d344377b0a78`
- Build flags: CMAKE_BUILD_TYPE=Release (tools/build-wasm.mjs); production validation enabled; pinned Emscripten 6.0.10
- Node: v24.20.0
- OS: darwin 27.0.1 (kernel 27.0.0, arm64), model Mac16,10
- CPU: Apple M4, 10 logical CPUs; memory 16384.00 MiB
- Power: Now drawing from 'AC Power'
- Load average (1/5/15 min): start 3.97 / 5.26 / 6.44, end 2.86 / 3.01 / 3.39; flagged busy above 2.5: yes

## Settings

- Warm-up 5000 ms, 5 repetition(s) of 30000 ms sampling (plan: at least 5000 ms, 30000 ms, 5).
- Deviations: none.
- Percentiles use the nearest-rank method. Summary p50/p95/p99 and the mean are medians of the per-repetition values; the spread of the per-repetition p95 is listed per benchmark. A single value is shown in the p50 column.
- Targets are stated per row and evaluated on the measured value (never hard-coded). They are engineering hypotheses from the plan until qualified on named hardware.

## Summary

| ID | Scenario | Metric | p50 | p95 | p99 | Mean | Target | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B01 | HUD scene, validation + raster | ms per frame | 0.00601 ms | 0.00630 ms | 0.00738 ms | 0.00610 ms | p95 ≤ 4 ms (engine CPU, desktop) | PASS |
| B01 | HUD scene, validation only (rejected twin) | ms per frame | 0.00093 ms | 0.00096 ms | 0.00115 ms | 0.00094 ms | — | INFO |
| B01 | Baseline clear + 32 rects | ms per frame | 0.00303 ms | 0.00315 ms | 0.00351 ms | 0.00304 ms | p95 ≤ 4 ms (engine CPU, desktop) | PASS |
| B02 | 1,000 sprites | ms per frame | 0.1246 ms | 0.1281 ms | 0.1354 ms | 0.1255 ms | p95 ≤ 8 ms | PASS |
| B03 | A: 256 × 256 map | ms per frame | 0.0203 ms | 0.0209 ms | 0.0223 ms | 0.0203 ms | p95 ≤ 4 ms (engine CPU, desktop) | PASS |
| B03 | B: 16× world (4 × 4 chunks) | ms per frame | 0.0215 ms | 0.0224 ms | 0.0244 ms | 0.0216 ms | p95 ≤ 4 ms (engine CPU, desktop) | PASS |
| B03 | C: 8× single map (1024 × 512) | ms per frame | 0.0202 ms | 0.0208 ms | 0.0216 ms | 0.0202 ms | p95 ≤ 4 ms (engine CPU, desktop) | PASS |
| B03 | B/A cost ratio | median ratio | 1.06 × | — | — | — | median ratio ≤ 1.25 (cost tracks the visible area) | PASS |
| B03 | C/A cost ratio | median ratio | 0.9969 × | — | — | — | median ratio ≤ 1.25 (cost tracks the visible area) | PASS |
| B04 | Classic lines/rects/circles | ms per frame | 0.0872 ms | 0.0883 ms | 0.0899 ms | 0.0873 ms | p95 ≤ 8 ms | PASS |
| B04 | Ellipses, triangles, fills, rotated sprites | ms per frame | 0.3887 ms | 0.3994 ms | 0.4067 ms | 0.3901 ms | p95 ≤ 8 ms | PASS |
| B04 | Extreme coordinates crossing the view | ms per frame | 0.5988 ms | 0.6063 ms | 0.6206 ms | 0.5989 ms | p95 ≤ 8 ms | PASS |
| B04 | Entirely offscreen at int32 extremes | ms per frame | 0.0146 ms | 0.0149 ms | 0.0154 ms | 0.0147 ms | p95 ≤ 8 ms | PASS |
| B05 | 4,096 records | ms per frame | 0.1203 ms | 0.1230 ms | 0.1275 ms | 0.1201 ms | p95 ≤ 16 ms | PASS |
| B05 | At the cap: full-screen rectangles (433 × records) | ms per frame | 0.2672 ms | 0.2717 ms | 0.2814 ms | 0.2686 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | At the cap: full-screen 256 × 144 sprites with transparency (433 × records) | ms per frame | 13.80 ms | 13.89 ms | 14.64 ms | 13.81 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | At the cap: 16 × 16 sprites rotated and scaled 20× over the view (144 × record pairs) | ms per frame | 11.38 ms | 11.49 ms | 11.72 ms | 11.37 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | At the cap: unclipped flood fills repainting the view (43 × records) | ms per frame | 1.74 ms | 1.76 ms | 1.79 ms | 1.74 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | At the cap: one circle whose radius spends the budget (its arc crosses the view) (radius 1,995,391) | ms per frame | 4.10 ms | 4.22 ms | 4.30 ms | 4.13 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | Over the cap (rejected) | ms per rejection | 0.00359 ms | 0.00371 ms | 0.00381 ms | 0.00360 ms | p95 ≤ 1 ms | PASS |
| B05 | 4,096 records, last invalid (rejected) | ms per rejection | 0.0349 ms | 0.0358 ms | 0.0372 ms | 0.0351 ms | p95 ≤ 1 ms | PASS |
| B07 | A: 4 sustained voices | ms per 512 frames | 0.00972 ms | 0.0104 ms | 0.0113 ms | 0.00989 ms | p95 ≤ 0.2 ms | PASS |
| B07 | B: music + bursts | ms per 128-frame quantum | 0.00329 ms | 0.00429 ms | 0.00500 ms | 0.00350 ms | p99 ≤ 0.267 ms (10% of the quantum) | PASS |
| B07 | B: one burst of four multi-note sounds | ms per burst | 0.00033 ms | 0.00038 ms | 0.00046 ms | 0.00034 ms | p95 ≤ 0.267 ms | PASS |
| B07 | B: quanta slower than real time | count | 0 | — | — | — | 0 deadline misses | PASS |
| B12 | play() admitted | ms per call | 0.00021 ms | 0.00025 ms | 0.00029 ms | 0.00026 ms | p95 ≤ 0.05 ms | PASS |
| B12 | play() rejected (CAPACITY) | ms per call | 0.00229 ms | 0.00238 ms | 0.00246 ms | 0.00230 ms | p95 ≤ 0.05 ms | PASS |
| B12 | stop() with 1,024 queued events | ms per call | 0.00008 ms | 0.00017 ms | 0.00071 ms | 0.00011 ms | p95 ≤ 1 ms | PASS |
| B12 | Saturated quantum (deliver 4 batches + render) | ms per 128 frames | 0.00950 ms | 0.0120 ms | 0.0223 ms | 0.0104 ms | p99 ≤ 0.267 ms (10% of the quantum) | PASS |
| B12 | Frames until silence once STOP is delivered | frames | 63 | — | — | — | ≤ 64 frames | PASS |
| B12 | Largest serialized batch | bytes | 69.7 KiB | — | — | — | ≤ 128 KiB (one 4 × 512-note piece, the largest message the limits allow) | PASS |
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

### B01 — 256 × 144 character/HUD scene (core part)

Status: **PASS**

Runs in: Node v24.20.0, real engine.wasm/audio.wasm from packages/core/dist

Measures:

- C validation plus rasterization per frame (`_pxw_submit`) for the original character/HUD scene of tools/bench/site/scene.mjs (≈95 commands: sky, stars, ground tiles, coins, an animated 16 × 16 hero, HUD text and bars), 240 distinct prebuilt frames in rotation; each frame also copies its records into the mailbox.
- The same frames with one invalid final record: the validation pass alone, since a rejected batch draws nothing.
- The earlier baseline (clear + 32 clipped 16 × 16 rectangles) for continuity with previous results.

Does not measure:

- JavaScript game logic, SDK argument validation and encoding, palette expansion, texture upload, GPU work and cold start: see B01 in `npm run bench:browser` for the full browser pipeline.
- A sample is the mean over a batch of 20 (scene) or 100 (baseline) frames, which smooths single-frame outliers.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Steady frames make no C allocations | before 4/7, after 4/7 | unchanged | PASS |
| Every measured frame had the expected status | 0 unexpected | 0 | PASS |
| Rejected twins fail with RANGE at their last record | yes | yes | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- HUD scene, validation + raster, ms per frame: 0.00629 ms – 0.00633 ms (5 runs, 1229817 samples)
- HUD scene, validation only (rejected twin), ms per frame: 0.00095 ms – 0.00097 ms (5 runs, 1250000 samples)
- Baseline clear + 32 rects, ms per frame: 0.00314 ms – 0.00321 ms (5 runs, 492301 samples)

Observations:

- Commands per scene frame: 92–93
- Validation share of the scene frame (median): 15%

Raw samples: `raw/B01.json`

### B02 — 1,000 8 × 8 and 16 × 16 sprites with clipping and transparency

Status: **PASS**

Runs in: Node v24.20.0, real engine.wasm/audio.wasm from packages/core/dist

Measures:

- C validation plus rasterization of CLEAR and 1,000 BLIT records per frame: 500 16 × 16 and 500 8 × 8 sprites from one sheet with transparent index 0, all four flip combinations, positions spread from −16 to 272 × −16 to 160 so many are clipped.

Does not measure:

- SDK encoding, texture upload, GPU work and game logic.
- This workload was revised on 2026-09-30 to match its description (earlier results used 1,000 opaque 8 × 8 sources); older B02 numbers are not comparable.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Steady frames make no C allocations | before 5, after 5 | unchanged | PASS |
| Every measured frame was accepted | 0 rejected | 0 | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- 1,000 sprites, ms per frame: 0.1272 ms – 0.1293 ms (5 runs, 59747 samples)

Observations:

- Transparent share of the sprite sheet: 32.0%
- Sprites clipped at an edge: 171
- Sprites entirely offscreen: 184

Raw samples: `raw/B02.json`

### B03 — Scrolling viewport over a larger tilemap (visible-work culling)

Status: **PASS**

Runs in: Node v24.20.0, real engine.wasm/audio.wasm from packages/core/dist

Measures:

- C validation plus rasterization per frame while a 256 × 144 view scrolls along a fixed path over maps of 8 × 8 tiles (256-tile tileset with transparency, about 6% empty cells). Each frame is CLEAR plus TILEMAP records that name the whole map: the core itself selects the cells that intersect the clip.
- Map A: 256 × 256 cells (65,536). World B: 16× larger, 1024 × 1024 cells as 4 × 4 chunk maps of 256 × 256 (16 TILEMAP records per frame, the view crossing chunk seams). Map C: one 1024 × 512 map (8×, 524,288 cells), the largest single tilemap the 1,048,608-byte upload limit allows.
- The median-cost ratios B/A and C/A: if culling works, cost follows the visible cells, not the map size.

Does not measure:

- SDK encoding, texture upload, GPU work and game logic.
- A single 1024 × 1024-cell map cannot be uploaded (limit 524,288 cells per tilemap), so the 16× case uses chunks; per-record overhead of the 15 extra records is included in its cost.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Steady frames make no C allocations | before 23, after 23 | unchanged | PASS |
| Every measured frame was accepted | 0 rejected | 0 | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- A: 256 × 256 map, ms per frame: 0.0208 ms – 0.0211 ms (5 runs, 370135 samples)
- B: 16× world (4 × 4 chunks), ms per frame: 0.0221 ms – 0.0231 ms (5 runs, 346002 samples)
- C: 8× single map (1024 × 512), ms per frame: 0.0207 ms – 0.0220 ms (5 runs, 370080 samples)

Observations:

- Cells per map: A 65,536; B 1,048,576 (16 × 65,536); C 524,288
- Visible cells per frame (mean over the path, all variants): 620.5

Raw samples: `raw/B03.json`

### B04 — Primitives partially and extremely offscreen

Status: **PASS**

Runs in: Node v24.20.0, real engine.wasm/audio.wasm from packages/core/dist

Measures:

- Classic (1001 records, unchanged from earlier results): 250 each of LINE, RECTB, CIRCLE and CIRCLE_FILL spread from −20 to 280 × −20 to 160.
- New primitives (869 records): 100 each of ELLIPSE, ELLIPSE_FILL, TRIANGLE, TRIANGLE_FILL and rotated/scaled sprites (BLIT_TRANSFORM, 0.5×–3×) with a palette remap, 16 clipped flood fills inside outlines and 2 unclipped flood fills.
- Extreme (81 records): lines between ±2,000,000,000 endpoints crossing the view, huge outlines, circles of radius 200,000 and 50,000 whose arcs cross the view, 16,384-pixel ellipses, triangles with int32-scale vertices covering the view, a 64× rotated sprite and a camera near the int32 edge.
- Entirely offscreen (1001 records): every primitive kind placed beyond ±2,000,000,000, which the core must cull without drawing.

Does not measure:

- SDK encoding, texture upload, GPU work and game logic.
- Circles are charged by radius (their midpoint loop runs regardless of clipping), so the extreme batch is dominated by its two large circles by design.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Steady frames make no C allocations | before 5, after 5 | unchanged | PASS |
| Every measured frame was accepted | 0 rejected | 0 | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- Classic lines/rects/circles, ms per frame: 0.0877 ms – 0.0887 ms (5 runs, 85849 samples)
- Ellipses, triangles, fills, rotated sprites, ms per frame: 0.3970 ms – 0.4069 ms (5 runs, 19214 samples)
- Extreme coordinates crossing the view, ms per frame: 0.6045 ms – 0.6120 ms (5 runs, 12505 samples)
- Entirely offscreen at int32 extremes, ms per frame: 0.0149 ms – 0.0151 ms (5 runs, 510555 samples)

Raw samples: `raw/B04.json`

### B05 — 4,096 commands and raster work near the cap, with predictable rejection

Status: **PASS**

Runs in: Node v24.20.0, real engine.wasm/audio.wasm from packages/core/dist

Measures:

- A full 4,096-record batch (CLEAR and 4,095 4 × 4 rectangles), the command-count limit.
- The 16,000,000-unit work budget spent by one primitive family at a time: CLEAR plus the largest count (or, for the circle, radius) the core admits, found by bisection, so each batch is within one command of the cap. The families differ in cost per work unit; the slowest one is the worst batch validation admits.
- One rectangle over the cap (434 full-screen rectangles): rejection with CAPACITY before anything is drawn, and its cost; and a 4,096-record batch whose last record is invalid.

Does not measure:

- SDK encoding, texture upload and GPU work. Samples at the cap are single frames (batch 1); the others average 5 or 20 frames.
- The budget bounds work units, not time (docs/architecture.md): these rows are the per-operation calibration data the plan asks for.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Over-cap batch is rejected with CAPACITY | status 3 at command 434 | status 3 | PASS |
| Rejected batches leave frame and palette unchanged | unchanged | unchanged | PASS |
| Steady frames make no C allocations | before 6, after 6 | unchanged | PASS |
| Every measured frame had the expected status | 0 unexpected | 0 | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- 4,096 records, ms per frame: 0.1214 ms – 0.1312 ms (5 runs, 248790 samples)
- At the cap: full-screen rectangles (433 × records), ms per frame: 0.2701 ms – 0.2832 ms (5 runs, 553984 samples)
- At the cap: full-screen 256 × 144 sprites with transparency (433 × records), ms per frame: 13.85 ms – 15.24 ms (5 runs, 10778 samples)
- At the cap: 16 × 16 sprites rotated and scaled 20× over the view (144 × record pairs), ms per frame: 11.41 ms – 11.82 ms (5 runs, 13142 samples)
- At the cap: unclipped flood fills repainting the view (43 × records), ms per frame: 1.75 ms – 1.82 ms (5 runs, 85629 samples)
- At the cap: one circle whose radius spends the budget (its arc crosses the view) (radius 1,995,391), ms per frame: 4.22 ms – 4.63 ms (5 runs, 36028 samples)
- Over the cap (rejected), ms per rejection: 0.00368 ms – 0.00395 ms (5 runs, 1250000 samples)
- 4,096 records, last invalid (rejected), ms per rejection: 0.0354 ms – 0.0424 ms (5 runs, 211178 samples)

Observations:

- Slowest admitted family (median p95): full-screen 256 × 144 sprites with transparency: 13.893 ms
- Approximate ms per million work units (median p50 / 16): {"rects":0.0167,"sprites":0.8624,"rotated":0.7114,"fills":0.1089,"circle":0.2565}
- Command index reported for the over-cap rejection: 434

Raw samples: `raw/B05.json`

### B07 — Four voices, event bursts and four-track music (DSP)

Status: **PASS**

Runs in: Node v24.20.0, real engine.wasm/audio.wasm from packages/core/dist

Measures:

- A: the earlier workload for continuity, four sustained voices (one per waveform) rendered in 512-frame blocks at 48 kHz.
- B: a looping 64-step piece on four tracks (a note on every step, vibrato, slide and fadeout effects) while every 16th 128-frame quantum applies a burst of four multi-note sounds (8 notes each at 400 BPM) that take over the voices; the time per 128-frame quantum including any burst applied before it.
- Burst application alone (pxa_sound_begin/note/play for four voices), and the number of quanta slower than real time (2.667 ms), which would underrun on an audio thread.

Does not measure:

- The AudioWorklet thread, message transport and the browser audio device (see B12 and B07 in `npm run bench:browser`); audible quality.
- Rendering of the game: in a browser the DSP runs on the audio thread, so the game frame is measured separately (B07 browser).

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| A renders four sounding voices | sounding | sounding | PASS |
| B output is finite and within [−1, 1] | peak 1.000, 0 non-finite | finite, peak ≤ 1 | PASS |
| B is never silent for 20 quanta | 0 silent windows | 0 | PASS |
| B music advances through its steps | 12 distinct steps seen | > 8 | PASS |
| B bursts start on all four voices | 11171688 sounds started | a multiple of 4, > 0 | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- A: 4 sustained voices, ms per 512 frames: 0.0104 ms – 0.0107 ms (5 runs, 151711 samples)
- B: music + bursts, ms per 128-frame quantum: 0.00425 ms – 0.00442 ms (5 runs, 1250000 samples)
- B: one burst of four multi-note sounds, ms per burst: 0.00037 ms – 0.00038 ms (5 runs, 1250000 samples)

Observations:

- Real-time margin of A (block duration / median p95): 1025×
- Real-time margin of B (quantum / median p99): 533×
- Quanta measured in B (one timed quantum per sample, so timer overhead of ~0.1 µs is included): 1250000

Raw samples: `raw/B07.json`

### B12 — Audio transport: missing ACK/consumption, saturation, STOP, suspend and failure

Status: **PASS**

Runs in: Node v24.20.0, real engine.wasm/audio.wasm from packages/core/dist; real AudioController and processor.js with a scripted MessagePort and AudioContext

Measures:

- The real AudioController (packages/core/dist) and the real AudioWorklet processor module running the real audio.wasm, joined by a scripted, ordered port that the benchmark pumps. Startup goes through unlock(), the DSP download and the init/ready handshake.
- Queue, credit and port bounds when ACKs are lost, when the processor consumes nothing (including repeated stop()/play() cycles), and when the producer outruns a processor that acknowledges once per 128-frame quantum; batch sizes as V8 structured-clone bytes (what postMessage copies in Chromium).
- STOP with sounding voices, a full queue and batches in flight: epoch handling, stale ACKs and frames until the real DSP is silent.
- Suspension requested by the page and by the device, and a DSP that traps inside process().
- The synchronous cost of play() (admitted and rejected) and of stop() with 1,024 queued events.

Does not measure:

- Real MessagePort and audio-thread latency, device underruns and audible output: see B12 in `npm run bench:browser` (Chromium, real AudioWorklet).
- Batch size is bounded by the note limits, not by bytes: 64 events per batch, or one music piece of at most 4 × 512 notes.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Lost ACKs: queued events ≤ 1,024 notes + one stop per voice | max 1028 | ≤ 1028 | PASS |
| Lost ACKs: batches in flight ≤ 4 | max 4 | ≤ 4 | PASS |
| Lost ACKs: CAPACITY only once the queue is full | 0 early rejections | 0 | PASS |
| Stalled processor: plays alone leave ≤ 4 batches in the port | 4 messages, 924 bytes | ≤ 4 | PASS |
| Stalled processor: port traffic stays bounded across stop()/play() cycles | 5 messages, 957 bytes after 200 cycles | ≤ 5 messages | PASS |
| Saturated: queued events ≤ 1,024 | max 1024 | ≤ 1024 | PASS |
| Saturated: events per batch ≤ 64 | max 64 | ≤ 64 | PASS |
| Voices were sounding when STOP was sent | sounding | sounding | PASS |
| STOP empties the queue; sent batches keep their credits until acknowledged | pending 0, in flight 4 | pending 0, in flight > 0 | PASS |
| STOP is posted with the next epoch | {"type":"stop","epoch":1} | {"type":"stop","epoch":1} | PASS |
| ACKs of batches sent before STOP return their credits | returned | returned | PASS |
| A note after STOP is sent at once in the new epoch | sent | sent | PASS |
| Pause: notes played while paused are dropped | 100 of 100 dropped | 100 of 100 | PASS |
| Pause: no note is sent after the pause takes effect | 0 note events sent | 0 | PASS |
| Resume: nothing queued before the pause is replayed | 0 replayed | 0 | PASS |
| Device suspension is reported and drops new notes | suspended, 0 queued | suspended, 0 queued | PASS |
| Device resumption restores running | running | running | PASS |
| Failure: the processor reports once and outputs silence | 1 error message(s), silent true | 1, silent | PASS |
| Failure: the controller fails once and releases the device | failed, 1 report(s), device released true | failed, 1 report, released | PASS |
| Failure: later notes queue nothing and unlock() rejects | queue +0, unlock STATE | queue +0, unlock STATE | PASS |

Run-to-run spread of p95 (min–max over repetitions):

- play() admitted, ms per call: 0.00025 ms – 0.00025 ms (5 runs, 1250000 samples)
- play() rejected (CAPACITY), ms per call: 0.00237 ms – 0.00546 ms (5 runs, 1250000 samples)
- stop() with 1,024 queued events, ms per call: 0.00013 ms – 0.00029 ms (5 runs, 642732 samples)
- Saturated quantum (deliver 4 batches + render), ms per 128 frames: 0.0120 ms – 0.0120 ms (1 runs, 2000 samples)

Observations:

- Lost ACKs: 10000 plays: 1028 admitted, 8972 rejected with CAPACITY, 4 batches sent; the queue then held 1028 events (176249 serialized bytes). Lost ACKs are never retransmitted, so the transport stays saturated: stop() cannot return a credit, because an unacknowledged batch may still be waiting in the port.
- Saturated transport: 2000 quanta × 300 plays: 512772 admitted, 87228 rejected with CAPACITY, 511748 applied by the DSP (255.9 per quantum, i.e. 4 batches × 64 events per round trip); median queue 1024
- Largest note batch (64 events, V8 structured-clone bytes): 11074
- Largest batch with a 4 × 512-note music event: 71339
- Pause: 4 note events had been sent before the pause; queued notes became note_off events
- Stalled processor with stop()/play() cycles: batches keep their credits until acknowledged and a stop waits until the processor confirms the previous one, so 200 cycles left 5 messages (957 bytes) waiting in the port

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

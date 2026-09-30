# PixelJS 0.0.1 Node benchmarks (core, DSP and audio transport)

Recorded: 2026-09-30T19:07:00.146Z (finished 2026-09-30T19:07:02.368Z) with `tools/bench.mjs`, mode `smoke`.

> **Not an acceptance measurement.** Settings deviate from the plan: warm-up 50 ms (plan: at least 5000 ms); sampling 200 ms per repetition (plan: at least 30000 ms); 1 repetition(s) (plan: at least 5). The working tree had uncommitted changes. PASS/FAIL below is computed from these samples but is indicative only.

## Environment

- Source: commit `362f79cdfcbf326d885b53b7d9f622df506e8068` (uncommitted changes present)
- Build: @pixeljs/core 0.0.1; manifest artifacts/build-manifest.json; measured files match the manifest
- engine.wasm SHA-256: `85add7fd0795ff4aaea92c9320a24707fa6d281bad9c76c929cd968da3c0d7f2`
- audio.wasm SHA-256: `893cd370e6f8d780487ace24e92906e3f80e8337c51a932ba060d344377b0a78`
- Build flags: CMAKE_BUILD_TYPE=Release (tools/build-wasm.mjs); production validation enabled; pinned Emscripten 6.0.10
- Node: v24.20.0
- OS: darwin 27.0.1 (kernel 27.0.0, arm64), model Mac16,10
- CPU: Apple M4, 10 logical CPUs; memory 16384.00 MiB
- Power: Now drawing from 'AC Power'
- Load average (1/5/15 min): start 2.45 / 5.35 / 7.15, end 2.45 / 5.35 / 7.15; flagged busy above 2.5: no

## Settings

- Warm-up 50 ms, 1 repetition(s) of 200 ms sampling (plan: at least 5000 ms, 30000 ms, 5).
- Deviations: warm-up 50 ms (plan: at least 5000 ms); sampling 200 ms per repetition (plan: at least 30000 ms); 1 repetition(s) (plan: at least 5).
- Percentiles use the nearest-rank method. Summary p50/p95/p99 and the mean are medians of the per-repetition values; the spread of the per-repetition p95 is listed per benchmark. A single value is shown in the p50 column.
- Targets are stated per row and evaluated on the measured value (never hard-coded). They are engineering hypotheses from the plan until qualified on named hardware.

## Summary

| ID | Scenario | Metric | p50 | p95 | p99 | Mean | Target | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B05 | 4,096 records | ms per frame | 0.1163 ms | 0.1205 ms | 0.1230 ms | 0.1167 ms | p95 ≤ 16 ms | PASS |
| B05 | At the cap: full-screen rectangles (433 × records) | ms per frame | 0.2640 ms | 0.2717 ms | 0.2821 ms | 0.2631 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | At the cap: full-screen 256 × 144 sprites with transparency (433 × records) | ms per frame | 13.45 ms | 13.67 ms | 13.67 ms | 13.46 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | At the cap: 16 × 16 sprites rotated and scaled 20× over the view (144 × record pairs) | ms per frame | 11.09 ms | 11.23 ms | 11.23 ms | 11.08 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | At the cap: unclipped flood fills repainting the view (43 × records) | ms per frame | 1.66 ms | 1.68 ms | 1.69 ms | 1.65 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | At the cap: one circle whose radius spends the budget (its arc crosses the view) (radius 1,995,391) | ms per frame | 3.74 ms | 3.93 ms | 4.01 ms | 3.76 ms | p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame) | PASS |
| B05 | Over the cap (rejected) | ms per rejection | 0.00354 ms | 0.00368 ms | 0.00404 ms | 0.00352 ms | p95 ≤ 1 ms | PASS |
| B05 | 4,096 records, last invalid (rejected) | ms per rejection | 0.0343 ms | 0.0350 ms | 0.0354 ms | 0.0343 ms | p95 ≤ 1 ms | PASS |

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

- 4,096 records, ms per frame: 0.1205 ms – 0.1205 ms (1 runs, 343 samples)
- At the cap: full-screen rectangles (433 × records), ms per frame: 0.2717 ms – 0.2717 ms (1 runs, 760 samples)
- At the cap: full-screen 256 × 144 sprites with transparency (433 × records), ms per frame: 13.67 ms – 13.67 ms (1 runs, 15 samples)
- At the cap: 16 × 16 sprites rotated and scaled 20× over the view (144 × record pairs), ms per frame: 11.23 ms – 11.23 ms (1 runs, 19 samples)
- At the cap: unclipped flood fills repainting the view (43 × records), ms per frame: 1.68 ms – 1.68 ms (1 runs, 122 samples)
- At the cap: one circle whose radius spends the budget (its arc crosses the view) (radius 1,995,391), ms per frame: 3.93 ms – 3.93 ms (1 runs, 54 samples)
- Over the cap (rejected), ms per rejection: 0.00368 ms – 0.00368 ms (1 runs, 2838 samples)
- 4,096 records, last invalid (rejected), ms per rejection: 0.0350 ms – 0.0350 ms (1 runs, 292 samples)

Observations:

- Slowest admitted family (median p95): full-screen 256 × 144 sprites with transparency: 13.674 ms
- Approximate ms per million work units (median p50 / 16): {"rects":0.0165,"sprites":0.8409,"rotated":0.6932,"fills":0.1036,"circle":0.2338}
- Command index reported for the over-cap rejection: 434

Raw samples: `raw/B05.json`

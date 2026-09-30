# PixelJS 0.0.1 Benchmark Suite Results

Recorded: 2026-09-30T15:35:41.859Z
Platform: darwin (arm64), CPU: Apple M4 (10 cores)
Node: v24.20.0
Engine WASM SHA256: `043f9ac8b123de62ca1e237cd6feab63a001163ca327899bfb203a7c6e448e53`
Audio WASM SHA256: `52389fc703a7777e481a2f1438806812aa9c24adb23aeb04ae39e080b5334722`
Settings: 3000 ms warm-up, 3 runs of 8000 ms.

## Benchmark Summary

Times are core-only (validation and rasterization in WASM, no JavaScript game logic,
upload or GPU). Each sample is the average time per frame over one batch of
submissions; the table reports the median across runs of the p95 of those samples.

| ID | Scenario | Median p95 (ms) | Target (p95) | Status | Invariant |
|---|---|---|---|---|---|
| B01 | 256x144 scene (33 commands) | 0.00282 ms | < 4.000 ms | PASS | 0 steady C allocations (checked) |
| B02 | 1,000 sprites (BLIT + clip) | 0.06372 ms | < 8.000 ms | PASS | 0 steady C allocations (checked) |
| B04 | Extended primitives (lines/circles) | 0.08458 ms | < 8.000 ms | PASS | 0 steady C allocations (checked) |
| B05 | 4,096 command cap pressure | 0.10695 ms | < 16.000 ms | PASS | 0 steady C allocations (checked) |
| B07 | Audio DSP, 4 active voices, 512 frames | 0.00680 ms | < 0.200 ms | PASS | 1568x faster than real time |

## Details
- B01, B02, B04, B05 execute validation and rasterization in pure WASM/C with clipping and bounds verification.
- B07 renders 512 samples at 48 kHz (10.67 ms of audio) with four sounding voices; a silent block fails the run.
- These are microbenchmarks, not full-pipeline, browser, GPU, cold-start or mobile measurements.

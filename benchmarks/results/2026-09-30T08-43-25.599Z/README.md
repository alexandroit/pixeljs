# PixelJS 0.0.1 Benchmark Suite Results

Recorded: 2026-09-30T08:43:25.599Z
Platform: darwin (arm64), CPU: Apple M4 (10 cores)
Node: v24.20.0
Engine WASM SHA256: `251cf36109438256e7ad945af856eda3bace3d1be8cadf415650ca4cbabed960`
Audio WASM SHA256: `b5d6f260973c53461cf3ecc942b771bf3f690b1b4dbe924a29ba135b20166162`

## Benchmark Summary

| ID  | Scenario                            | Median p95 (ms) | Target (p95) | Status | Invariants             |
| --- | ----------------------------------- | --------------- | ------------ | ------ | ---------------------- |
| B01 | 256x144 scene (33 commands)         | 0.00279 ms      | < 4.000 ms   | PASS   | 0 steady C allocations |
| B02 | 1,000 sprites (BLIT + clip)         | 0.06392 ms      | < 8.000 ms   | PASS   | 0 steady C allocations |
| B04 | Extended primitives (lines/circles) | 0.09269 ms      | < 8.000 ms   | PASS   | 0 steady C allocations |
| B05 | 4,096 command cap pressure          | 0.10246 ms      | < 16.000 ms  | PASS   | 0 steady C allocations |
| B07 | Audio DSP 4 voices (512 frames)     | 0.00166 ms      | < 0.200 ms   | PASS   | Realtime margin > 50x  |

## Details

- B01, B02, B04, B05 execute validation and rasterization in pure WASM/C with clipping and bounds verification.
- B07 measures the standalone Audio DSP rendering 512 samples at 48kHz (10.67ms audio buffer duration).
- All visual benchmarks confirm zero steady frame heap allocations in C.

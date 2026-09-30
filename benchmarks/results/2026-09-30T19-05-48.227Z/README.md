# PixelJS 0.0.1 Node benchmarks (core, DSP and audio transport)

Recorded: 2026-09-30T19:05:48.227Z (finished 2026-09-30T19:05:49.132Z) with `tools/bench.mjs`, mode `smoke`.

> **Not an acceptance measurement.** Settings deviate from the plan: warm-up 50 ms (plan: at least 5000 ms); sampling 200 ms per repetition (plan: at least 30000 ms); 1 repetition(s) (plan: at least 5). The machine was busy (1-minute load average 3.15 at start, 3.15 at end; threshold 2.5). The working tree had uncommitted changes. PASS/FAIL below is computed from these samples but is indicative only.

## Environment

- Source: commit `362f79cdfcbf326d885b53b7d9f622df506e8068` (uncommitted changes present)
- Build: @pixeljs/core 0.0.1; manifest artifacts/build-manifest.json; measured files match the manifest
- engine.wasm SHA-256: `228b9e11be82fa024aa1759a8af9ec9ac558f9f1d60af422d29e6527edfb5d1a`
- audio.wasm SHA-256: `893cd370e6f8d780487ace24e92906e3f80e8337c51a932ba060d344377b0a78`
- Build flags: CMAKE_BUILD_TYPE=Release (tools/build-wasm.mjs); production validation enabled; pinned Emscripten 6.0.10
- Node: v24.20.0
- OS: darwin 27.0.1 (kernel 27.0.0, arm64), model Mac16,10
- CPU: Apple M4, 10 logical CPUs; memory 16384.00 MiB
- Power: Now drawing from 'AC Power'
- Load average (1/5/15 min): start 3.15 / 6.2 / 7.59, end 3.15 / 6.2 / 7.59; flagged busy above 2.5: yes

## Settings

- Warm-up 50 ms, 1 repetition(s) of 200 ms sampling (plan: at least 5000 ms, 30000 ms, 5).
- Deviations: warm-up 50 ms (plan: at least 5000 ms); sampling 200 ms per repetition (plan: at least 30000 ms); 1 repetition(s) (plan: at least 5).
- Percentiles use the nearest-rank method. Summary p50/p95/p99 and the mean are medians of the per-repetition values; the spread of the per-repetition p95 is listed per benchmark. A single value is shown in the p50 column.
- Targets are stated per row and evaluated on the measured value (never hard-coded). They are engineering hypotheses from the plan until qualified on named hardware.

## Summary

| ID | Scenario | Metric | p50 | p95 | p99 | Mean | Target | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B12 | play() admitted | ms per call | 0.00021 ms | 0.00025 ms | 0.00029 ms | 0.00021 ms | p95 ≤ 0.05 ms | PASS |
| B12 | play() rejected (CAPACITY) | ms per call | 0.00229 ms | 0.00238 ms | 0.00246 ms | 0.00229 ms | p95 ≤ 0.05 ms | PASS |
| B12 | stop() with 1,024 queued events | ms per call | 0.00013 ms | 0.00025 ms | 0.00142 ms | 0.00021 ms | p95 ≤ 1 ms | PASS |
| B12 | Saturated quantum (deliver 4 batches + render) | ms per 128 frames | 0.0121 ms | 0.0263 ms | 0.1243 ms | 0.0208 ms | p99 ≤ 0.267 ms (10% of the quantum) | PASS |
| B12 | Frames until silence once STOP is delivered | frames | 63 | — | — | — | ≤ 64 frames | PASS |
| B12 | Largest serialized batch | bytes | 69.7 KiB | — | — | — | ≤ 4 KiB (an earlier proposal, never a limit) | FAIL |

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

### B12 — Audio transport: missing ACK/consumption, saturation, STOP, suspend and failure

Status: **FAIL**

Runs in: Node v24.20.0, real engine.wasm/audio.wasm from packages/core/dist; real AudioController and processor.js with a scripted MessagePort and AudioContext

Measures:

- The real AudioController (packages/core/dist) and the real AudioWorklet processor module running the real audio.wasm, joined by a scripted, ordered port that the benchmark pumps. Startup goes through unlock(), the DSP download and the init/ready handshake.
- Queue, credit and port bounds when ACKs are lost, when the processor consumes nothing (including repeated stop()/play() cycles), and when the producer outruns a processor that acknowledges once per 128-frame quantum; batch sizes as V8 structured-clone bytes (what postMessage copies in Chromium).
- STOP with sounding voices, a full queue and batches in flight: epoch handling, stale ACKs and frames until the real DSP is silent.
- Suspension requested by the page and by the device, and a DSP that traps inside process().
- The synchronous cost of play() (admitted and rejected) and of stop() with 1,024 queued events.

Does not measure:

- Real MessagePort and audio-thread latency, device underruns and audible output: see B12 in `npm run bench:browser` (Chromium, real AudioWorklet).
- An earlier proposal of 4 KiB per batch was never an implemented limit; the largest batch is compared with it for information.

| Check | Observed | Expected | Status |
| --- | --- | --- | --- |
| Lost ACKs: queued events ≤ 1,024 notes + one stop per voice | max 1028 | ≤ 1028 | PASS |
| Lost ACKs: batches in flight ≤ 4 | max 4 | ≤ 4 | PASS |
| Lost ACKs: CAPACITY only once the queue is full | 0 early rejections | 0 | PASS |
| Stalled processor: plays alone leave ≤ 4 batches in the port | 4 messages, 924 bytes | ≤ 4 | PASS |
| Stalled processor: port traffic stays bounded across stop()/play() cycles | 5 messages, 957 bytes after 20 cycles | ≤ 5 messages | PASS |
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

- play() admitted, ms per call: 0.00025 ms – 0.00025 ms (1 runs, 250000 samples)
- play() rejected (CAPACITY), ms per call: 0.00238 ms – 0.00238 ms (1 runs, 85922 samples)
- stop() with 1,024 queued events, ms per call: 0.00025 ms – 0.00025 ms (1 runs, 914 samples)
- Saturated quantum (deliver 4 batches + render), ms per 128 frames: 0.0263 ms – 0.0263 ms (1 runs, 200 samples)

Observations:

- Lost ACKs: 2000 plays: 1028 admitted, 972 rejected with CAPACITY, 4 batches sent; the queue then held 1028 events (176249 serialized bytes). Lost ACKs are never retransmitted, so the transport stays saturated: stop() cannot return a credit, because an unacknowledged batch may still be waiting in the port.
- Saturated transport: 200 quanta × 300 plays: 51972 admitted, 8028 rejected with CAPACITY, 50948 applied by the DSP (254.7 per quantum, i.e. 4 batches × 64 events per round trip); median queue 1024
- Largest note batch (64 events, V8 structured-clone bytes): 11074
- Largest batch with a 4 × 512-note music event: 71339
- Pause: 4 note events had been sent before the pause; queued notes became note_off events
- Stalled processor with stop()/play() cycles: batches keep their credits until acknowledged and a stop waits until the processor confirms the previous one, so 20 cycles left 5 messages (957 bytes) waiting in the port

Raw samples: `raw/B12.json`

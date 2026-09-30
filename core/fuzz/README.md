# Native fuzz targets

These inputs and invariants are original PixelJS fixtures. Every fuzz context is a fresh 16 × 16 context holding one image (handle 4097), one tilemap using it (4098) and one font (4099), so handle paths are reachable and crashes reproduce from the input alone.

| Target      | Input                                                                                                                                                                       | Invariants                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands`  | A raw command batch.                                                                                                                                                        | Submission never allocates; a rejected batch leaves the frame, all 256 palette entries and the palette revision unchanged.                                |
| `resources` | Byte 0 selects image, tilemap or font; byte 1 selects the chunk size (0 = whole mailbox); the rest is the upload.                                                           | Chunks are uploaded with a draw between each; failures never publish a handle; the tileset stays retained; every path returns to the baseline allocation. |
| `audio`     | A u32 sample rate, then up to 4,096 audio DSP calls (notes, sounds, music, stop, volume, render), each a selector byte, a u32 and its arguments; floats come from raw bits. | Every rendered sample is finite and within [-1, 1]; at most 1,000,000 frames per input.                                                                   |

## Replay (every native and sanitizer test run)

`npm run test:c` builds `pixeljs_fuzz_replay_commands`, `pixeljs_fuzz_replay_resources` and `pixeljs_fuzz_replay_audio`, which run each harness over its corpus without libFuzzer, in both the `native` and the ASan/UBSan `safety` presets. This keeps the harnesses compiling and exercised on machines without a libFuzzer runtime, such as AppleClang.

## Campaigns (Clang with libFuzzer)

```sh
node core/fuzz/generate-seeds.mjs
cmake -S . -B build/fuzz -G Ninja -DBUILD_TESTING=OFF -DPX_BUILD_FUZZER=ON -DCMAKE_C_COMPILER=clang
cmake --build build/fuzz
mkdir -p build/fuzz-corpus/commands build/fuzz-corpus/resources build/fuzz-corpus/audio
cp core/fuzz/corpus/commands/*.bin build/fuzz-corpus/commands/
cp core/fuzz/corpus/resources/*.bin build/fuzz-corpus/resources/
cp core/fuzz/corpus/audio/*.bin build/fuzz-corpus/audio/
build/fuzz/pixeljs_fuzz_commands build/fuzz-corpus/commands -max_total_time=60 -max_len=131104 -rss_limit_mb=512
build/fuzz/pixeljs_fuzz_resources build/fuzz-corpus/resources -max_total_time=60 -max_len=1048610 -rss_limit_mb=512
build/fuzz/pixeljs_fuzz_audio build/fuzz-corpus/audio -max_total_time=60 -max_len=65536 -rss_limit_mb=512
```

All targets use ASan and UBSan. Like the replay runs, they are debug builds, so every accepted batch also asserts that each command's actual raster work stays within the estimate that admitted it. CI runs them on every push (see [CONTRIBUTING](../../CONTRIBUTING.md#continuous-integration)). Copying seeds into the build directory preserves the original corpus; `generate-seeds.mjs` must reproduce the committed seeds exactly. Duration and zero observed crashes do not prove complete coverage.

The deterministic WASM gate in `tests/fuzz-negative.test.mjs` complements these native campaigns by mutating batches and uploads against the shipped `engine.wasm` on every `npm test`. Scale it for longer runs with `PIXELJS_FUZZ_SCALE=1000 PIXELJS_FUZZ_SEED=7 node --test tests/fuzz-negative.test.mjs` (6,000 × scale batches and 3,000 × scale uploads).

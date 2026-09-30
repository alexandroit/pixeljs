# PixelJS C core

The portable C17 heart of PixelJS: an allocator with a fixed budget, the indexed framebuffer, immutable resources, the command validator and rasterizer, and the audio synthesizer. It has no dependency on browsers, GPUs, Emscripten or npm, never calls back into the game, and compiles unchanged for native tests and for WebAssembly.

| Path                          | Contents                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `include/pixeljs/pixeljs.h`   | The native API: contexts, resources, submission, diagnostics and ownership rules |
| `include/pixeljs/audio.h`     | The synthesizer and sequencer                                                    |
| `include/pixeljs/protocol.h`  | Protocol constants, generated from `protocol/schema.json`                        |
| `src/context/`, `src/memory/` | Context lifetime and the budgeted allocator                                      |
| `src/assets/`                 | Uploads of images, tilemaps and fonts                                            |
| `src/graphics/`               | Command validation (`commands.c`) and rasterization (`raster.c`)                 |
| `src/audio/`                  | The DSP: voices, envelopes, effects and the step sequencer                       |
| `tests/`                      | Native contract tests                                                            |
| `fuzz/`                       | libFuzzer targets and the seed corpus                                            |

The WebAssembly entry points live in [`../bridge`](../bridge), and every numeric constant of the protocol is generated from [`../protocol/schema.json`](../protocol/schema.json).

## Submission

A frame arrives as one batch in the mailbox: a 32-byte `PXJS` header followed by 32-byte records. Submission runs in two passes. The first validates everything (layout, reserved fields, arguments, colors, resource handles and kinds, clipping and the total work) and writes nothing. Only a fully valid batch reaches the second pass, which draws it. A rejected batch leaves the framebuffer and palette unchanged and reports the failing command's index and byte offset. Neither pass allocates.

## Resources

Handles pack a 12-bit slot and a 20-bit generation; releasing a resource advances the generation, and a slot whose generation is exhausted is retired. Uploads use a staging buffer (begin, copy chunks, commit): images use a `PXIM` header followed by one byte per pixel, tilemaps a `PXTM` header followed by 16-bit tile IDs, and fonts a `PXFN` header followed by 1-bit rows. Nothing is published unless the whole upload is valid. A tilemap keeps its tileset alive.

## Limits

Up to 1,024 pixels per side and 1,048,576 pixels per image or framebuffer, 256 resources, 4,096 records and 16,000,000 work units per batch, and 32 MiB of owned allocations. The WebAssembly build uses a fixed 64 MiB memory that also holds the mailbox, the stack and the runtime.

## Tests

```sh
cmake --preset native && cmake --build --preset native && ctest --preset native
cmake --preset safety && cmake --build --preset safety && ctest --preset safety   # ASan and UBSan
```

The contract tests cover the native API, inject a failure into each allocation of context creation and uploads, compare rasterization against independent reference implementations and replay the fuzz corpus. See [`fuzz/README.md`](fuzz/README.md) for the libFuzzer targets.

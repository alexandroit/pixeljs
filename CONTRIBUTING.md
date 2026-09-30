# Contributing to PixelJS

Thanks for your interest in PixelJS. Bug reports, fixes, tests, documentation and examples are all welcome. For a larger change, please open an issue first so we can agree on the approach before you spend time on it. Security problems follow the [security policy](SECURITY.md) instead of public issues.

## Repository layout

| Path                   | Contents                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `core/`                | The C17 core: context, allocator, resources, command validation, rasterization and audio DSP |
| `bridge/`              | The WebAssembly entry points of the visual core and of the audio DSP                         |
| `protocol/schema.json` | The single source of the command protocol's constants; C and TypeScript files are generated  |
| `packages/core/`       | `@pixeljs/core`, the TypeScript SDK that games import                                        |
| `packages/create/`     | `@pixeljs/create`, the `npm create @pixeljs` project generator and its starters              |
| `apps/editor/`         | PixelJS Studio, the browser editor                                                           |
| `apps/site/`           | The pixeljs.com website                                                                      |
| `apps/mobile-smoke/`   | A Capacitor app that runs PixelJS inside an Android WebView                                  |
| `examples/`            | The Pac-Man example in JavaScript and its TypeScript consumer                                |
| `tests/`, `tools/`     | Node and browser tests, benchmarks and build scripts                                         |

The [architecture guide](docs/architecture.md) explains how these pieces fit together.

## Setting up

You need Node.js 24 with npm, a C17 compiler (Clang or GCC), CMake 3.24 or later, Ninja and Emscripten 6.0.10. The exact versions used by CI are pinned in [`toolchain.json`](toolchain.json).

Install Emscripten into a directory next to the repository, at the pinned emsdk revision:

```sh
git clone https://github.com/emscripten-core/emsdk.git ../pixeljs-emsdk
git -C ../pixeljs-emsdk checkout e566f7bdcc7735f44037911c24b87a58a3c93145
../pixeljs-emsdk/emsdk install 6.0.10
../pixeljs-emsdk/emsdk activate 6.0.10
source ../pixeljs-emsdk/emsdk_env.sh
```

Then install the dependencies and the test browsers, and run everything:

```sh
npm ci
npx playwright install chromium firefox webkit
npm run verify
```

The scripts find `cmake`, `ctest`, `emcmake` and the C compiler on `PATH`; set `CMAKE`, `CTEST`, `EMCMAKE` or `CC` to use other executables. On macOS, the Command Line Tools are enough (`DEVELOPER_DIR=/Library/Developer/CommandLineTools`). Local browser tests use an installed Google Chrome; set `PIXELJS_USE_BUNDLED_CHROMIUM=1` to use Playwright's Chromium instead, as CI does.

## Commands

| Command                    | What it does                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`           | Everything below, in order. Run it before opening a pull request                                                            |
| `npm run build`            | Compile the SDK, copy the audio worklet and build both WebAssembly binaries                                                 |
| `npm run build:site`       | Build the website, the examples, the editor and the mobile app, and pack both npm tarballs                                  |
| `npm run test:c`           | Native C tests, with warnings as errors, in a normal build and under AddressSanitizer and UndefinedBehaviorSanitizer        |
| `npm test`                 | Node tests against the real WebAssembly: the ABI, rasterization, audio, the SDK, the generator, the editor and the examples |
| `npm run test:browser`     | Playwright tests in Chromium, Firefox and WebKit, served with the production Content-Security-Policy                        |
| `npm run test:package`     | Install the packed tarballs in fresh projects, build JavaScript and TypeScript consumers and generated starters, run them   |
| `npm run test:docs`        | Check that the site's source panels match the examples, typecheck the examples and check every Markdown link                |
| `npm run test:game`        | Play the built site's Pac-Man in three browsers                                                                             |
| `npm run lint`             | Strict TypeScript checks and source policy checks (C warnings are enforced by CMake)                                        |
| `npm run format`           | Format with Prettier; C sources follow [`.clang-format`](.clang-format)                                                     |
| `npm run verify:generated` | Check that the generated protocol files and example assets match their sources                                              |
| `npm run bench`            | Core benchmarks; see below                                                                                                  |

For C work alone: `cmake --preset native && cmake --build --preset native && ctest --preset native`, or the `safety` preset for sanitizers. [`core/fuzz/`](core/fuzz) describes the libFuzzer targets and the seed corpus.

`node tools/serve.mjs` serves the repository for manual testing; set `PIXELJS_SERVE_CSP=production` to send the same Content-Security-Policy as pixeljs.com.

## Continuous integration

[`ci.yml`](.github/workflows/ci.yml) runs on every push and pull request with the pinned toolchain on Ubuntu:

- `verify`: Clang static analysis of every C source, then `npm run verify`;
- `fuzz`: each libFuzzer target (commands, resources, audio) for 60 seconds under the sanitizers. A manual run can ask for 15 minutes per target.

Workflows run with read-only permissions, check out without keeping credentials, and pin every action to a commit.

## Benchmarks

`npm run bench` measures the core in Node (frame cost, sprites, tilemaps, primitives, batches at the work budget, the audio DSP and the audio transport); `npm run bench:browser` measures the full pipeline in real browsers (frame cost with WebGL2 and Canvas2D, startup size, create and dispose cycles, loads during play, audio bursts). The default plan warms up for 5 seconds and takes five 30-second samples per case; `--quick` and `--smoke` are shorter. Each run writes a report with the machine, versions, build hashes and raw samples to `benchmarks/results/`. Numbers from a busy machine are marked as indicative.

## Coding guidelines

- **C.** C17, no dynamic allocation during a frame, checked arithmetic before any allocation or memory access, no recursion or variable-length arrays, and validation that stays enabled in release builds. Public functions use the `px_` prefix, bridge exports `pxw_` and `pxa_`.
- **TypeScript.** Strict mode. Validate every public argument at runtime, since JavaScript callers get no type checks. Never expose heap offsets, pointers or raw handles.
- **Protocol changes.** Edit [`protocol/schema.json`](protocol/schema.json) and run `node tools/generate-protocol.mjs`; never edit the generated files by hand.
- **Tests.** A fix comes with a test that fails without it. New drawing operations need reference tests; new input paths need browser tests in all three engines.
- **Documentation.** Update the [API reference](docs/api.md) with any public change, and the [changelog](CHANGELOG.md) under the next version.

## Pull requests

Keep a pull request focused on one change, describe what it changes and why, and make sure `npm run verify` passes. By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

## Releases

Maintainers publish releases from GitHub Actions; see [releasing](docs/release.md).

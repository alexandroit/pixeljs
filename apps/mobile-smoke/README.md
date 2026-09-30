# PixelJS Mobile Smoke

A small PixelJS game packaged as a Capacitor 8 app, used to prove that the same `@pixeljs/core` build (JavaScript, visual WASM, AudioWorklet and DSP WASM) runs inside a native mobile WebView. It is a test app, not a starter template.

## What the app contains

- A Vite + TypeScript page using `@pixeljs/core` with `scaling: 'integer'`: the canvas takes the largest whole number of device pixels per logical pixel that fits the `.screen` box, in portrait and in landscape.
- The example game's original asset files (`examples/javascript/assets`: PNG sprite sheet and tiles, tile map, font, sound and music JSON), bundled as separate files so they load from the app's own origin. `assetsInlineLimit: 0` keeps Vite from turning small files into `data:` URLs.
- A fixed calibration pattern at the top of the screen (16 palette swatches, the sprite sheet, part of the maze tile map and text in the example font), drawn over a starfield and a ship that follows the finger.
- An on-screen D-pad, a sound toggle, pause/resume and "Recreate Engine" (dispose and create again).
- `window.pixeljsSmoke`: read-only diagnostics (the current engine, the pattern layout, recent pointer samples, per-frame update counters and page/shell lifecycle events) used by the automated emulator checks.

The Capacitor configuration only names the app, its web directory and the `https` scheme, which gives the page the secure origin `https://localhost` that WebAssembly and AudioWorklet need. No plugin is added and the generated Android manifest requests only `INTERNET`.

## Build and run on Android

The native projects are not committed: `tools/test-mobile-android.mjs` generates them in `build/mobile-android` every time. Requirements: JDK 21 (`JAVA_HOME`), the Android SDK (`ANDROID_HOME`) with platform 36 and an emulator image or a device with USB debugging.

```sh
npm ci
npm run build                  # the SDK the app bundles
npm run test:mobile:android    # web build, cap add/sync, Gradle debug APK, emulator or device checks
npm run test:mobile:android -- --skip-build   # reuse the last APK
```

When no device is attached, the script boots the first Android Virtual Device (or `PIXELJS_AVD`) headless and read-only with 2 GB of memory and 2 cores, and shuts it down at the end (`PIXELJS_KEEP_EMULATOR=1` keeps it). `ANDROID_SERIAL` selects a device. Results are written to `artifacts/mobile-android/results.json` with screenshots taken with `adb exec-out screencap`.

To work on the native project by hand, run the script once and open `build/mobile-android/project/android` in Android Studio. Do not commit an `android/` or `ios/` directory here; both are ignored.

## What the emulator run verifies

The script installs the APK, launches it and drives the real WebView through its DevTools socket (`webview_devtools_remote_<pid>`, forwarded with adb and opened with Playwright's `connectOverCDP`). Touch input goes through the Android input system (`adb shell input tap/swipe`; two-finger touch through the kernel touch device with root on emulator images).

| Check                   | How                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions             | Source manifest and the built APK (`aapt2 dump permissions`)                                                                                 |
| Origin, WASM and assets | `https://localhost`, secure context, engine WASM served as `application/wasm`, all six assets loaded from the shell origin, C core running   |
| Frames                  | Frame and update counters advance                                                                                                            |
| Pixels                  | Every presented pixel equals its palette color; sprite, tile map and font pixels equal references decoded from the source files in Node      |
| Palette                 | `setPalette` changes the presented color between frames                                                                                      |
| Touch                   | Taps and a swipe arrive in `input.pointers` at the exact logical pixel under whole-device-pixel scaling; two simultaneous touches            |
| Audio                   | Unlock from a real tap, a note, a non-looping piece that ends (`musicPlaying` true, then false)                                              |
| Background              | HOME pauses the engine and its audio; the first frame after relaunch does not catch up; a manual pause stays paused across HOME and relaunch |
| Orientation             | Landscape re-fits the canvas with whole device pixels and taps still map exactly                                                             |
| Create/dispose          | Five recreate cycles leave canvas, window and document listener counts unchanged                                                             |
| Errors                  | No page or console errors                                                                                                                    |

The script writes each run's results and screenshots to `artifacts/mobile-android/`.

## Still open

- **Physical Android devices:** not yet tested. Real GPU drivers, audio routing, touch hardware and sustained thermal behavior are unverified.
- **iPhone and iOS:** `cap add ios` generates the Swift Package Manager project, but no iOS build has been run yet, so WKWebView is untested.
- **Release builds and stores:** only debug APKs are built; signing, store packaging and submission are out of scope.

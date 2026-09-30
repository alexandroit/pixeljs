// Opt-in validation of apps/mobile-smoke inside a real Capacitor shell on
// Android. Builds the web app, generates the Android project in
// build/mobile-android (never committed), builds a debug APK with Gradle, runs
// it on an attached device or on an emulator it boots headless, and drives the
// real Android WebView through its DevTools socket. Not part of `npm run verify`.
//
//   npm run build && npm run test:mobile:android [-- --skip-build]
//
// Environment: ANDROID_HOME (default ~/Library/Android/sdk or ~/Android/Sdk),
// JAVA_HOME (JDK 21; found with /usr/libexec/java_home on macOS), ANDROID_SERIAL
// (device to use), PIXELJS_AVD (emulator to boot; default the first AVD),
// PIXELJS_KEEP_EMULATOR=1 (leave running an emulator this run booted).
// Results and screenshots go to artifacts/mobile-android/.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { build } from 'vite';

const APP_ID = 'com.pixeljs.mobilesmoke';
const ACTIVITY = `${APP_ID}/.MainActivity`;
const WIDTH = 224;
const HEIGHT = 256;
const root = resolve('.');
const appDir = join(root, 'apps/mobile-smoke');
const work = join(root, 'build/mobile-android');
const project = join(work, 'project');
const android = join(project, 'android');
const apkPath = join(android, 'app/build/outputs/apk/debug/app-debug.apk');
const out = join(root, 'artifacts/mobile-android');
const skipBuild = process.argv.includes('--skip-build');
const sdk =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), platform() === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
const adbPath = join(sdk, 'platform-tools/adb');
const emulatorPath = join(sdk, 'emulator/emulator');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function exec(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}: ${String(result.stderr ?? '').slice(-2000)}`,
    );
  return result.stdout;
}
let serial = process.env.ANDROID_SERIAL ?? null;
const adb = (...args) => exec(adbPath, serial ? ['-s', serial, ...args] : args);
const shell = (...args) =>
  adb('shell', ...args)
    .replace(/\r/g, '')
    .trim();
async function waitFor(probe, timeout, what) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await probe();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(250);
  }
}

// --- Checks are recorded as passed, failed or not possible, never skipped silently.
const checks = [];
class NotPossible extends Error {}
function expectThat(condition, message) {
  if (!condition) throw new Error(message);
}
async function check(name, action) {
  process.stdout.write(`- ${name}: `);
  try {
    const detail = (await action()) ?? {};
    checks.push({ name, status: 'passed', ...detail });
    console.log('passed');
  } catch (error) {
    const status = error instanceof NotPossible ? 'not possible' : 'failed';
    checks.push({ name, status, reason: error.message });
    console.log(`${status}: ${error.message}`);
  }
}

// --- Build: web app, Capacitor project in a scratch directory, debug APK.
function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  if (platform() === 'darwin') {
    const found = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
    if (found.status === 0) return found.stdout.trim();
  }
  throw new Error('Set JAVA_HOME to a JDK 21 installation.');
}
function uses(manifest) {
  return [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
}
async function buildApk() {
  if (!existsSync(join(root, 'packages/core/dist/index.js')))
    throw new Error('Run `npm run build` first: the app bundles the built @pixeljs/core.');
  await build({ root: appDir, configFile: join(appDir, 'vite.config.ts'), logLevel: 'error' });
  await rm(project, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  for (const file of ['package.json', 'capacitor.config.json'])
    await cp(join(appDir, file), join(project, file));
  await cp(join(appDir, 'dist'), join(project, 'dist'), { recursive: true });
  const env = { ...process.env, JAVA_HOME: javaHome(), ANDROID_HOME: sdk };
  const cap = join(root, 'node_modules/@capacitor/cli/bin/capacitor');
  exec(process.execPath, [cap, 'add', 'android'], { cwd: project, env, stdio: 'inherit' });
  exec(process.execPath, [cap, 'sync', 'android'], { cwd: project, env, stdio: 'inherit' });
  // `cap add` syncs Gradle through a daemon; stop it and build without one.
  exec('./gradlew', ['--stop'], { cwd: android, env });
  exec('./gradlew', ['assembleDebug', '--no-daemon', '--console=plain', '--quiet'], {
    cwd: android,
    env,
    stdio: 'inherit',
  });
}
/** Versions actually used by the generated project. */
async function toolchain() {
  const text = (path) => readFile(join(android, path), 'utf8');
  const variables = await text('variables.gradle');
  const variable = (name) => Number(new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(variables)?.[1]);
  const java = spawnSync(join(javaHome(), 'bin/java'), ['-version'], { encoding: 'utf8' });
  return {
    capacitor: JSON.parse(
      await readFile(join(root, 'node_modules/@capacitor/android/package.json'), 'utf8'),
    ).version,
    gradle: /gradle-([\d.]+)-/.exec(await text('gradle/wrapper/gradle-wrapper.properties'))?.[1],
    androidGradlePlugin: /com\.android\.tools\.build:gradle:([\d.]+)/.exec(
      await text('build.gradle'),
    )?.[1],
    minSdk: variable('minSdkVersion'),
    compileSdk: variable('compileSdkVersion'),
    targetSdk: variable('targetSdkVersion'),
    java: java.stderr.split('\n')[0],
  };
}
function aapt2() {
  const tools = join(sdk, 'build-tools');
  const versions = spawnSync('ls', [tools], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const found = versions.map((version) => join(tools, version, 'aapt2')).find(existsSync);
  if (!found) throw new Error('aapt2 was not found in the Android SDK build-tools.');
  return found;
}

// --- Device: an attached device or an emulator booted headless for this run.
let bootedEmulator = null;
function attached() {
  return exec(adbPath, ['devices'])
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([id, state]) => id && state === 'device')
    .map(([id]) => id);
}
async function ensureDevice() {
  const devices = attached();
  if (serial) {
    expectThat(devices.includes(serial), `ANDROID_SERIAL ${serial} is not attached.`);
    return;
  }
  if (devices.length > 0) {
    serial = devices[0];
    return;
  }
  const avds = exec(emulatorPath, ['-list-avds']).split('\n').filter(Boolean);
  const avd = process.env.PIXELJS_AVD ?? avds[0];
  if (!avd) throw new Error('No device is attached and no Android Virtual Device exists.');
  let port = 5554;
  while (devices.includes(`emulator-${port}`)) port += 2;
  await mkdir(work, { recursive: true });
  const log = openSync(join(work, 'emulator.log'), 'w');
  // Headless, modest resources, and read-only: the AVD's data is not modified.
  const child = spawn(
    emulatorPath,
    [
      ...['-avd', avd, '-port', String(port), '-no-window', '-no-boot-anim', '-read-only'],
      ...['-no-snapshot-save', '-memory', '2048', '-cores', '2', '-gpu', 'swiftshader_indirect'],
      '-no-metrics',
    ],
    { detached: true, stdio: ['ignore', log, log] },
  );
  child.unref();
  serial = `emulator-${port}`;
  bootedEmulator = { avd, pid: child.pid, serial };
  await waitFor(() => attached().includes(serial), 120_000, `${serial} to attach`);
  await waitFor(() => shell('getprop', 'sys.boot_completed') === '1', 300_000, 'Android boot');
}
async function stopEmulator() {
  if (!bootedEmulator || process.env.PIXELJS_KEEP_EMULATOR === '1') return;
  try {
    adb('emu', 'kill');
  } catch {
    process.kill(bootedEmulator.pid, 'SIGTERM');
  }
  await waitFor(
    () => {
      try {
        process.kill(bootedEmulator.pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    60_000,
    'the emulator to exit',
  ).catch(() => process.kill(bootedEmulator.pid, 'SIGKILL'));
}
function deviceInfo() {
  const prop = (name) => shell('getprop', name);
  const webview = /Current WebView package \(name, version\): \(([^,]+), ([^)]+)\)/.exec(
    shell('dumpsys', 'webviewupdate'),
  );
  return {
    serial,
    kind: prop('ro.kernel.qemu') === '1' ? 'emulator' : 'physical device',
    avd:
      bootedEmulator?.avd ??
      (prop('ro.kernel.qemu') === '1' ? prop('ro.boot.qemu.avd_name') : null),
    model: prop('ro.product.model'),
    android: prop('ro.build.version.release'),
    apiLevel: prop('ro.build.version.sdk_full') || prop('ro.build.version.sdk'),
    abi: prop('ro.product.cpu.abi'),
    fingerprint: prop('ro.build.fingerprint'),
    screen: shell('wm', 'size').replace('Physical size: ', ''),
    density: shell('wm', 'density').replace('Physical density: ', ''),
    webViewPackage: webview?.[1] ?? null,
    webViewVersion: webview?.[2] ?? null,
  };
}
async function screenshot(name) {
  await mkdir(out, { recursive: true });
  const result = spawnSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) await writeFile(join(out, `${name}.png`), result.stdout);
}

// --- WebView: DevTools socket of the app process, driven with Playwright over CDP.
async function connect() {
  const pid = await waitFor(() => shell('pidof', APP_ID), 30_000, `${APP_ID} to start`);
  const socket = `webview_devtools_remote_${pid}`;
  await waitFor(() => shell('cat', '/proc/net/unix').includes(socket), 30_000, socket);
  const port = adb('forward', 'tcp:0', `localabstract:${socket}`).trim();
  const endpoint = `http://127.0.0.1:${port}`;
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await waitFor(
    () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith('https://localhost')),
    30_000,
    'the app page',
  );
  return { browser, page, port, endpoint };
}
/** Where the WebView is on screen, from the DevTools target list. */
async function webViewRect(endpoint) {
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const target = targets.find((entry) => entry.url.startsWith('https://localhost'));
  return JSON.parse(target.description);
}
/** Screen pixel at the center of logical pixel (x, y), through the page's real layout. */
async function screenPoint(page, endpoint, x, y) {
  const view = await webViewRect(endpoint);
  const box = await page.evaluate(() => {
    const canvas = document.querySelector('#screen');
    const rect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    const px = (value) => Number.parseFloat(value) || 0;
    const left = px(style.borderLeftWidth) + px(style.paddingLeft);
    const top = px(style.borderTopWidth) + px(style.paddingTop);
    return {
      left: rect.left + left,
      top: rect.top + top,
      width: rect.width - left - px(style.borderRightWidth) - px(style.paddingRight),
      height: rect.height - top - px(style.borderBottomWidth) - px(style.paddingBottom),
      ratio: devicePixelRatio,
    };
  });
  return {
    x: Math.round(view.screenX + (box.left + ((x + 0.5) * box.width) / WIDTH) * box.ratio),
    y: Math.round(view.screenY + (box.top + ((y + 0.5) * box.height) / HEIGHT) * box.ratio),
    box,
  };
}
async function elementPoint(page, endpoint, selector) {
  const view = await webViewRect(endpoint);
  const center = await page.evaluate((query) => {
    const rect = document.querySelector(query).getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      ratio: devicePixelRatio,
    };
  }, selector);
  const point = {
    x: Math.round(view.screenX + center.x * center.ratio),
    y: Math.round(view.screenY + center.y * center.ratio),
  };
  expectThat(
    point.x >= view.screenX &&
      point.y >= view.screenY &&
      point.x < view.screenX + view.width &&
      point.y < view.screenY + view.height,
    `${selector} at (${point.x}, ${point.y}) is outside the WebView ${JSON.stringify(view)}`,
  );
  return point;
}
const inputMark = (page) => page.evaluate(() => window.pixeljsSmoke.inputSamples.length);
async function inputSince(page, mark) {
  await sleep(400);
  return page.evaluate((from) => window.pixeljsSmoke.inputSamples.slice(from), mark);
}
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`${what} did not answer within ${ms} ms.`);
    }),
  ]);
}
const smokeState = (page) =>
  withTimeout(
    page.evaluate(() => {
      const engine = window.pixeljsSmoke.engine;
      return {
        state: engine?.state ?? null,
        label: document.getElementById('status-label')?.textContent ?? '',
        visibility: document.visibilityState,
        stats: engine ? engine.getStats() : null,
        audio: engine ? engine.audio.capabilities.state : null,
        created: window.pixeljsSmoke.enginesCreated,
        ready: Boolean(window.pixeljsSmoke.resources),
        canvasStyle: document.querySelector('#screen').getAttribute('style'),
        viewport: [innerWidth, innerHeight],
        lifecycle: [...window.pixeljsSmoke.lifecycle],
      };
    }),
    5000,
    'The page',
  );

// --- Pixel references decoded from the same asset files the app bundles.
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let type = 0;
  const data = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    const kind = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      type = body[9];
      if (body[8] !== 8 || (type !== 2 && type !== 6) || body[12] !== 0)
        throw new Error('Only 8-bit RGB/RGBA non-interlaced PNG references are supported.');
    } else if (kind === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const channels = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0;
      const paeth = () => {
        const p = left + up - corner;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        return a <= b && a <= c ? left : b <= c ? up : corner;
      };
      const predictor = [0, left, up, (left + up) >> 1, paeth()][filter];
      rows[y * stride + x] = (value + predictor) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < 3; channel++)
      rgba[pixel * 4 + channel] = rows[pixel * channels + channel];
    rgba[pixel * 4 + 3] = channels === 4 ? rows[pixel * 4 + 3] : 255;
  }
  return { width, height, rgba };
}
/** The SDK's documented mapping: squared RGB distance, lowest index on ties. */
function nearest(palette, red, green, blue, skip) {
  let best = -1;
  let bestDistance = Infinity;
  palette.forEach(([r, g, b], index) => {
    if (index === skip) return;
    const distance = (red - r) ** 2 + (green - g) ** 2 + (blue - b) ** 2;
    if (distance < bestDistance) [best, bestDistance] = [index, distance];
  });
  return best;
}
/** One presented frame: RGBA read back from the canvas and indices from readPixel. */
function captureFrame(page) {
  return page.evaluate(
    ({ width, height }) =>
      new Promise((done) => {
        // Runs after the engine's frame callback, before the frame is composited.
        requestAnimationFrame(() => {
          const engine = window.pixeljsSmoke.engine;
          const canvas = document.querySelector('#screen');
          let rgba;
          if (engine.capabilities.renderer === 'webgl2') {
            const gl = canvas.getContext('webgl2');
            const flipped = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
            rgba = new Uint8Array(flipped.length);
            for (let y = 0; y < height; y++)
              rgba.set(
                flipped.subarray((height - 1 - y) * width * 4, (height - y) * width * 4),
                y * width * 4,
              );
          } else rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
          const indices = new Uint8Array(width * height);
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) indices[y * width + x] = engine.readPixel(x, y);
          const encode = (bytes) => {
            let text = '';
            for (let at = 0; at < bytes.length; at += 8192)
              text += String.fromCharCode(...bytes.subarray(at, at + 8192));
            return btoa(text);
          };
          done({ rgba: encode(rgba), indices: encode(indices) });
        });
      }),
    { width: WIDTH, height: HEIGHT },
  );
}
const decode64 = (text) => Buffer.from(text, 'base64');

async function pixelChecks(page) {
  const pattern = await page.evaluate(() => window.pixeljsSmoke.pattern);
  const frame = await captureFrame(page);
  const rgba = decode64(frame.rgba);
  const indices = decode64(frame.indices);
  const at = (x, y) => y * WIDTH + x;
  const { swatches, sprite, map, text } = pattern;
  // The palette as presented: one swatch per index.
  const palette = Array.from({ length: 16 }, (_, index) => {
    const pixel = at(swatches.x + index * swatches.step + 1, swatches.y + 1);
    expectThat(indices[pixel] === index, `swatch ${index} holds index ${indices[pixel]}`);
    return [...rgba.subarray(pixel * 4, pixel * 4 + 4)];
  });
  // Every presented pixel is the palette color of its index.
  let mismatched = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    const color = palette[indices[pixel]];
    if (!color || color.some((value, channel) => rgba[pixel * 4 + channel] !== value)) mismatched++;
  }
  expectThat(mismatched === 0, `${mismatched} presented pixels differ from their palette color`);
  // The same files the app bundles, decoded independently of the browser.
  const file = (name) => readFile(join(root, 'examples/javascript/assets', name));
  const compare = (label, expected) => {
    let wrong = 0;
    let first = null;
    for (const [x, y, index] of expected)
      if (indices[at(x, y)] !== index) {
        wrong++;
        first ??= `(${x}, ${y}) is ${indices[at(x, y)]}, expected ${index}`;
      }
    expectThat(wrong === 0, `${label}: ${wrong} pixels differ, first ${first}`);
    return expected.length;
  };
  const player = decodePng(await file('player.png'));
  const spriteExpected = [];
  for (let y = 0; y < player.height; y++)
    for (let x = 0; x < player.width; x++) {
      const [r, g, b, a] = player.rgba.subarray((y * player.width + x) * 4);
      const index = a < 128 ? sprite.background : nearest(palette, r, g, b, 0);
      spriteExpected.push([sprite.x + x, sprite.y + y, index]);
    }
  const tiles = decodePng(await file('tiles.png'));
  const maze = JSON.parse(await file('maze.json'));
  const perRow = Math.floor(tiles.width / maze.tileWidth);
  const mapExpected = [];
  for (let row = 0; row < map.rows; row++)
    for (let col = 0; col < map.cols; col++) {
      const id = maze.tiles[row * maze.cols + col];
      for (let y = 0; y < maze.tileHeight; y++)
        for (let x = 0; x < maze.tileWidth; x++) {
          let index = 0;
          if (id !== 65535) {
            const sx = (id % perRow) * maze.tileWidth + x;
            const sy = Math.floor(id / perRow) * maze.tileHeight + y;
            const [r, g, b] = tiles.rgba.subarray((sy * tiles.width + sx) * 4);
            index = nearest(palette, r, g, b, -1);
          }
          mapExpected.push([
            map.x + col * maze.tileWidth + x,
            map.y + row * maze.tileHeight + y,
            index,
          ]);
        }
    }
  const font = JSON.parse(await file('arcade-font.json'));
  const textExpected = [];
  [...text.value].forEach((character, position) => {
    const code = character.charCodeAt(0) - font.firstChar;
    const glyph = font.glyphs[code >= 0 && code < font.glyphs.length ? code : 0];
    glyph.forEach((line, y) =>
      [...line].forEach((cell, x) =>
        textExpected.push([
          text.x + position * font.glyphWidth + x,
          text.y + y,
          cell === '#' ? text.color : text.background,
        ]),
      ),
    );
  });
  return {
    palette,
    sprite: compare('sprite (player.png)', spriteExpected),
    tilemap: compare('tile map (tiles.png, maze.json)', mapExpected),
    text: compare('font text (arcade-font.json)', textExpected),
  };
}

// --- Multi-touch through the kernel input device (`input` has one pointer only).
function touchDevice() {
  const listing = shell('getevent', '-lp');
  const devices = listing.split('add device').slice(1);
  const pick =
    devices.find((entry) => /name:\s+"virtio_input_multi_touch_1"/.test(entry)) ??
    devices.find((entry) => entry.includes('ABS_MT_POSITION_X'));
  if (!pick) return null;
  const path = /:\s+(\/dev\/input\/event\d+)/.exec(pick)?.[1];
  const max = (axis) => Number(new RegExp(`${axis}\\s*:.*max (\\d+)`).exec(pick)?.[1]);
  return { path, maxX: max('ABS_MT_POSITION_X'), maxY: max('ABS_MT_POSITION_Y') };
}
function twoFingers(device, screen, points, phase, prefix) {
  const [width, height] = screen;
  const commands = [];
  const event = (type, code, value) =>
    commands.push(`${prefix}sendevent ${device.path} ${type} ${code} ${value}`);
  points.forEach((point, slot) => {
    event(3, 47, slot); // ABS_MT_SLOT
    if (phase === 'up')
      event(3, 57, -1); // ABS_MT_TRACKING_ID
    else {
      if (phase === 'down') event(3, 57, 100 + slot);
      event(3, 53, Math.round((point.x * (device.maxX + 1)) / width)); // ABS_MT_POSITION_X
      event(3, 54, Math.round((point.y * (device.maxY + 1)) / height)); // ABS_MT_POSITION_Y
      event(3, 58, 512); // ABS_MT_PRESSURE
    }
  });
  event(1, 330, phase === 'up' ? 0 : 1); // BTN_TOUCH
  event(0, 0, 0); // SYN_REPORT
  shell(commands.join(' && '));
}

async function listenerCounts(cdp) {
  const counts = {};
  for (const [name, expression] of [
    ['canvas', 'document.querySelector("#screen")'],
    ['window', 'window'],
    ['document', 'document'],
  ]) {
    const { result } = await cdp.send('Runtime.evaluate', { expression });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId,
    });
    counts[name] = listeners.length;
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
  }
  return counts;
}

async function runChecks({ page, endpoint }) {
  const problems = [];
  const network = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Network.responseReceived', ({ response }) =>
    network.push({ url: response.url, status: response.status, mimeType: response.mimeType }),
  );
  await cdp.send('Network.enable');
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  await waitFor(async () => (await smokeState(page)).ready, 30_000, 'the app to load its assets');
  await screenshot('01-launched-portrait');

  await check('engine runs from the shell origin with the packaged WASM', async () => {
    const found = await page.evaluate(async () => {
      const engine = window.pixeljsSmoke.engine;
      const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
      const wasm = resources.filter((name) => name.endsWith('.wasm'));
      const mime = wasm[0] ? (await fetch(wasm[0])).headers.get('content-type') : null;
      return {
        origin: location.origin,
        secure: isSecureContext,
        state: engine.state,
        renderer: engine.capabilities.renderer,
        coreBytes: engine.getStats().coreBytes,
        wasm,
        mime,
        assets: resources.filter((name) => /\.(png|json)$/.test(name)),
      };
    });
    expectThat(found.origin === 'https://localhost', `origin is ${found.origin}`);
    expectThat(found.secure, 'the page is not a secure context');
    expectThat(found.state === 'RUNNING', `engine state is ${found.state}`);
    expectThat(found.coreBytes > 0, 'the C core reports no allocations');
    expectThat(
      found.wasm.some((url) => /^https:\/\/localhost\/assets\/engine-[\w-]+\.wasm$/.test(url)),
      `visual WASM not loaded from the shell: ${found.wasm.join(', ')}`,
    );
    expectThat(found.mime === 'application/wasm', `WASM served as ${found.mime}`);
    expectThat(
      found.assets.length === 6 &&
        found.assets.every((url) => url.startsWith('https://localhost/')),
      `assets: ${found.assets.join(', ')}`,
    );
    return found;
  });

  await check('frames advance', async () => {
    const before = (await smokeState(page)).stats;
    await sleep(2000);
    const after = (await smokeState(page)).stats;
    expectThat(after.frames > before.frames + 10, `frames ${before.frames} -> ${after.frames}`);
    return {
      framesPerSecond: (after.frames - before.frames) / 2,
      updatesPerSecond: (after.updates - before.updates) / 2,
    };
  });

  await check('sprite, tile map, font text and palette pixels are exact', () => pixelChecks(page));

  await check('setPalette changes presented colors between frames', async () => {
    const frame = await captureFrame(page);
    const rgba = decode64(frame.rgba);
    const { swatches } = await page.evaluate(() => window.pixeljsSmoke.pattern);
    const colorAt = (index) => {
      const pixel = (swatches.y + 1) * WIDTH + swatches.x + index * swatches.step + 1;
      return [...rgba.subarray(pixel * 4, pixel * 4 + 4)];
    };
    const original = Array.from({ length: 16 }, (_, index) => colorAt(index)).flat();
    const changed = [...original];
    changed.splice(5 * 4, 4, 10, 20, 30, 255);
    await page.evaluate((colors) => window.pixeljsSmoke.engine.setPalette(colors), changed);
    const next = decode64((await captureFrame(page)).rgba);
    const pixel = (swatches.y + 1) * WIDTH + swatches.x + 5 * swatches.step + 1;
    const shown = [...next.subarray(pixel * 4, pixel * 4 + 4)];
    await page.evaluate((colors) => window.pixeljsSmoke.engine.setPalette(colors), original);
    expectThat(shown.join() === '10,20,30,255', `index 5 is presented as ${shown}`);
    return { changedIndex: 5, presented: shown };
  });

  const view = await webViewRect(endpoint);
  await check(
    'taps reach input.pointers at the right logical pixels (integer scaling)',
    async () => {
      const taps = [];
      for (const [x, y] of [
        [20, 120],
        [200, 230],
        [112, 128],
        [3, 250],
      ]) {
        const point = await screenPoint(page, endpoint, x, y);
        const mark = await inputMark(page);
        shell('input', 'tap', String(point.x), String(point.y));
        const samples = await waitFor(
          async () => {
            const list = await inputSince(page, mark);
            return list.some((sample) => sample.pointers.some((p) => p.released)) && list;
          },
          10_000,
          `tap (${x}, ${y})`,
        );
        const pressed = samples.flatMap((s) => s.pointers).find((p) => p.pressed);
        const released = samples.flatMap((s) => s.pointers).find((p) => p.released);
        expectThat(pressed?.type === 'touch', `pointer type ${pressed?.type}`);
        expectThat(
          pressed.x === x && pressed.y === y && released.x === x && released.y === y,
          `tap at (${x}, ${y}) arrived at (${pressed.x}, ${pressed.y}) / (${released.x}, ${released.y})`,
        );
        taps.push({ logical: [x, y], screen: [point.x, point.y], id: pressed.id });
        const scale = (point.box.width * point.box.ratio) / WIDTH;
        expectThat(
          Math.abs(scale - Math.round(scale)) < 0.01,
          `${scale} device pixels per logical pixel is not a whole number`,
        );
      }
      const { box } = await screenPoint(page, endpoint, 0, 0);
      return { taps, deviceScale: (box.width * box.ratio) / WIDTH, webView: view };
    },
  );

  await check('a swipe is one contact that moves and ends at its last point', async () => {
    const from = await screenPoint(page, endpoint, 40, 200);
    const to = await screenPoint(page, endpoint, 180, 110);
    const mark = await inputMark(page);
    shell('input', 'swipe', String(from.x), String(from.y), String(to.x), String(to.y), '600');
    const samples = await waitFor(
      async () => {
        const list = await inputSince(page, mark);
        return list.some((sample) => sample.pointers.some((p) => p.released)) && list;
      },
      10_000,
      'the swipe',
    );
    const contacts = samples.flatMap((sample) => sample.pointers);
    const ids = new Set(contacts.map((pointer) => pointer.id));
    const start = contacts.find((pointer) => pointer.pressed);
    const end = contacts.find((pointer) => pointer.released);
    const between = contacts.filter((p) => p.down && !p.pressed && (p.x !== 40 || p.y !== 200));
    expectThat(ids.size === 1, `${ids.size} contacts for one swipe`);
    expectThat(start.x === 40 && start.y === 200, `swipe started at (${start.x}, ${start.y})`);
    expectThat(end.x === 180 && end.y === 110, `swipe ended at (${end.x}, ${end.y})`);
    expectThat(between.length > 0, 'no intermediate positions were reported');
    return { ticks: samples.length, intermediatePositions: between.length };
  });

  await check('two simultaneous touches (kernel multi-touch events)', async () => {
    const device = touchDevice();
    if (!device?.path) throw new NotPossible('no multi-touch input device was found');
    const size = /(\d+)x(\d+)/.exec(shell('wm', 'size')).slice(1).map(Number);
    const rotation = shell('settings', 'get', 'system', 'user_rotation');
    if (view.screenX !== 0 || view.screenY !== 0 || !['0', 'null'].includes(rotation))
      throw new NotPossible(
        'raw touch coordinates are only mapped for an unrotated full-screen WebView',
      );
    // SELinux denies the shell user raw input writes; userdebug images allow `su`.
    let prefix = '';
    try {
      if (shell('su', '0', 'id', '-u') === '0') prefix = 'su 0 ';
    } catch {
      /* A user build: no root. */
    }
    const first = await screenPoint(page, endpoint, 50, 150);
    const second = await screenPoint(page, endpoint, 170, 200);
    const mark = await inputMark(page);
    try {
      twoFingers(device, size, [first, second], 'down', prefix);
      await sleep(500);
      twoFingers(device, size, [first, second], 'up', prefix);
    } catch (error) {
      if (/Permission denied/.test(error.message))
        throw new NotPossible('this device does not allow raw input events without root');
      throw error;
    }
    const samples = await inputSince(page, mark);
    const both = samples.find((sample) => sample.pointers.filter((p) => p.down).length === 2);
    expectThat(both, `no tick saw two contacts down (${samples.length} samples)`);
    const [a, b] = both.pointers;
    expectThat(
      a.type === 'touch' && b.type === 'touch' && a.id !== b.id,
      'the contacts are not two distinct touches',
    );
    expectThat(
      a.x === 50 && a.y === 150 && b.x === 170 && b.y === 200,
      `contacts at (${a.x}, ${a.y}) and (${b.x}, ${b.y})`,
    );
    const ended = samples.flatMap((sample) => sample.pointers).filter((p) => p.released);
    expectThat(ended.length === 2, `${ended.length} releases`);
    return {
      device: device.path,
      injectedAsRoot: prefix !== '',
      contacts: [
        [a.x, a.y],
        [b.x, b.y],
      ],
    };
  });
  await screenshot('02-after-touch');

  await check('audio unlocks from a real tap, plays a note and a non-looping piece', async () => {
    const state = await waitFor(
      async () => {
        const audio = (await smokeState(page)).audio;
        return ['running', 'failed', 'blocked'].includes(audio) && audio;
      },
      15_000,
      'audio to start after the first tap',
    );
    expectThat(state === 'running', `audio state is ${state}`);
    const played = await page.evaluate(async () => {
      const { engine, resources } = window.pixeljsSmoke;
      engine.audio.setVolume(0.3);
      const note = engine.audio.play(resources.sound);
      engine.audio.playMusic(resources.music, { loop: false });
      const started = engine.audio.musicPlaying;
      const began = performance.now();
      while (engine.audio.musicPlaying && performance.now() - began < 10_000)
        await new Promise((done) => setTimeout(done, 50));
      return {
        voice: note.voice,
        started,
        ended: !engine.audio.musicPlaying,
        seconds: (performance.now() - began) / 1000,
        state: engine.audio.capabilities.state,
      };
    });
    const files = network.filter(({ url }) =>
      /^https:\/\/localhost\/assets\/(processor-[\w-]+\.js|audio-[\w-]+\.wasm)$/.test(url),
    );
    expectThat(played.voice >= 0 && played.voice <= 3, `note voice ${played.voice}`);
    expectThat(played.started, 'musicPlaying was false right after playMusic');
    expectThat(played.ended, 'the non-looping piece did not end within 10 s');
    expectThat(
      files.some(({ url, status }) => url.endsWith('.wasm') && status === 200),
      `DSP binary responses: ${JSON.stringify(files)}`,
    );
    return { ...played, audioFiles: files };
  });

  await check(
    'HOME pauses the engine and its audio; a relaunch resumes without replaying the background',
    async () => {
      const before = await smokeState(page);
      expectThat(before.state === 'RUNNING', `state before HOME is ${before.state}`);
      const events = before.lifecycle.length;
      const saw = (state, type) => state.lifecycle.slice(events).find((e) => e.type === type);
      shell('input', 'keyevent', 'KEYCODE_HOME');
      const hidden = await waitFor(
        async () => {
          const state = await smokeState(page);
          return saw(state, 'pause') && state;
        },
        10_000,
        'the shell to report the background',
      );
      // Suspending the AudioContext is asynchronous.
      const background = await waitFor(
        async () => {
          const state = await smokeState(page);
          return state.audio !== 'running' && state;
        },
        3000,
        'audio to stop in the background',
      ).catch(() => hidden);
      await sleep(3000);
      const later = await smokeState(page);
      await screenshot('03-home');
      shell('am', 'start', '-n', ACTIVITY);
      const back = await waitFor(
        async () => {
          const state = await smokeState(page);
          return saw(state, 'resume') && state.state === 'RUNNING' && state;
        },
        10_000,
        'the app to come back',
      );
      await sleep(1000);
      const recorded = await page.evaluate(() => [...window.pixeljsSmoke.frames]);
      const after = await smokeState(page);
      const pausedAt = saw(back, 'pause').time;
      const resumedAt = saw(back, 'resume').time;
      const last = recorded.filter((frame) => frame.time < pausedAt).at(-1);
      const first = recorded.find((frame) => frame.time > resumedAt);
      expectThat(last && first, 'the frame record does not cover the pause');
      const detail = {
        events: back.lifecycle.slice(events).map((e) => e.type),
        visibilityInBackground: hidden.visibility,
        stateInBackground: hidden.state,
        labelInBackground: hidden.label,
        audioInBackground: background.audio,
        framesDrawnInBackground: later.stats.frames - hidden.stats.frames,
        secondsInBackground: (resumedAt - pausedAt) / 1000,
        resumedState: back.state,
        audioAfterResume: after.audio,
        // The first drawn frame after resume against the last one before HOME.
        firstFrameCatchUpUpdates: first.updates - last.updates,
        firstFrameDroppedUpdates: first.droppedUpdates - last.droppedUpdates,
        // Later slow frames (software rendering) are reported, not failed.
        droppedUpdatesInFollowingSecond: after.stats.droppedUpdates - first.droppedUpdates,
      };
      const summary = JSON.stringify(detail);
      expectThat(hidden.state === 'PAUSED', `the engine did not pause: ${summary}`);
      expectThat(
        detail.framesDrawnInBackground === 0,
        `frames were drawn in the background: ${summary}`,
      );
      expectThat(
        before.audio !== 'running' || background.audio === 'suspended',
        `audio kept running in the background: ${summary}`,
      );
      // A replay of the background time would run 5 updates and drop 10 at 60 Hz
      // in that first frame (the 250 ms frame clamp); a rebased clock runs none.
      expectThat(
        detail.firstFrameCatchUpUpdates <= 1 && detail.firstFrameDroppedUpdates === 0,
        `the first frame after resume caught up: ${summary}`,
      );
      expectThat(back.state === 'RUNNING', `state after relaunch: ${summary}`);
      return detail;
    },
  );

  await check('a manual pause survives background and foreground', async () => {
    const pauseButton = await elementPoint(page, endpoint, '#btn-pause');
    shell('input', 'tap', String(pauseButton.x), String(pauseButton.y));
    const paused = await waitFor(
      async () => {
        const state = await smokeState(page);
        return state.state === 'PAUSED' && state;
      },
      5000,
      'manual pause',
    );
    const events = paused.lifecycle.length;
    const saw = (name) => async () =>
      (await smokeState(page)).lifecycle.slice(events).some((event) => event.type === name);
    shell('input', 'keyevent', 'KEYCODE_HOME');
    await waitFor(saw('pause'), 10_000, 'the background');
    shell('am', 'start', '-n', ACTIVITY);
    await waitFor(saw('resume'), 10_000, 'the foreground');
    await sleep(1000);
    const back = await smokeState(page);
    await screenshot('04-manual-pause-kept');
    const resume = await elementPoint(page, endpoint, '#btn-pause');
    shell('input', 'tap', String(resume.x), String(resume.y));
    const resumed = await waitFor(
      async () => (await smokeState(page)).state === 'RUNNING',
      5000,
      'resume',
    );
    expectThat(back.state === 'PAUSED', `state after foreground is ${back.state}`);
    expectThat(back.label === 'PAUSED', `label after foreground is ${back.label}`);
    return { afterForeground: back.state, label: back.label, resumed };
  });

  await check('rotation re-fits the canvas with whole device pixels', async () => {
    const portrait = await screenPoint(page, endpoint, 0, 0);
    const accelerometer = shell('settings', 'get', 'system', 'accelerometer_rotation');
    shell('settings', 'put', 'system', 'accelerometer_rotation', '0');
    shell('settings', 'put', 'system', 'user_rotation', '1');
    try {
      await waitFor(
        async () => {
          const [width, height] = (await smokeState(page)).viewport;
          return width > height;
        },
        15_000,
        'landscape',
      );
      await sleep(1000);
      const landscape = await screenPoint(page, endpoint, 0, 0);
      await screenshot('05-landscape');
      const state = await smokeState(page);
      const scale = (landscape.box.width * landscape.box.ratio) / WIDTH;
      const scaleY = (landscape.box.height * landscape.box.ratio) / HEIGHT;
      expectThat(state.state === 'RUNNING', `state after rotation is ${state.state}`);
      expectThat(landscape.box.width !== portrait.box.width, 'the canvas was not re-fitted');
      expectThat(
        Math.abs(scale - Math.round(scale)) < 0.01 && Math.abs(scale - scaleY) < 0.01,
        `landscape scale ${scale} x ${scaleY}`,
      );
      const point = await screenPoint(page, endpoint, 100, 60);
      const mark = await inputMark(page);
      shell('input', 'tap', String(point.x), String(point.y));
      const samples = await waitFor(
        async () => {
          const list = await inputSince(page, mark);
          return list.some((sample) => sample.pointers.some((p) => p.released)) && list;
        },
        10_000,
        'landscape tap',
      );
      const pressed = samples.flatMap((s) => s.pointers).find((p) => p.pressed);
      expectThat(
        pressed.x === 100 && pressed.y === 60,
        `landscape tap at (${pressed.x}, ${pressed.y})`,
      );
      return {
        portraitCss: [portrait.box.width, portrait.box.height],
        landscapeCss: [landscape.box.width, landscape.box.height],
        landscapeDevicePixelsPerPixel: scale,
        canvasStyle: state.canvasStyle,
      };
    } finally {
      shell('settings', 'put', 'system', 'user_rotation', '0');
      shell(
        'settings',
        'put',
        'system',
        'accelerometer_rotation',
        accelerometer === '1' ? '1' : '0',
      );
      // Later taps need the page layout and the WebView's screen rectangle
      // both back in portrait, not only the viewport.
      await waitFor(
        async () => {
          const [width, height] = (await smokeState(page)).viewport;
          const view = await webViewRect(endpoint);
          const { box } = await screenPoint(page, endpoint, 0, 0);
          return (
            width < height &&
            view.width < view.height &&
            Math.abs(box.width - portrait.box.width) < 0.01 &&
            Math.abs(box.height - portrait.box.height) < 0.01
          );
        },
        15_000,
        'the portrait layout to return',
      );
      await sleep(500);
    }
  });

  await check('five recreate cycles leave the listener counts unchanged', async () => {
    const baseline = await listenerCounts(cdp);
    const first = await smokeState(page);
    for (let cycle = 1; cycle <= 5; cycle++) {
      const button = await elementPoint(page, endpoint, '#btn-recreate');
      shell('input', 'tap', String(button.x), String(button.y));
      await waitFor(
        async () => {
          const state = await smokeState(page);
          return (
            state.created === first.created + cycle && state.ready && state.state === 'RUNNING'
          );
        },
        20_000,
        `recreate ${cycle}`,
      );
    }
    const after = await listenerCounts(cdp);
    const last = await smokeState(page);
    await screenshot('06-recreated');
    expectThat(
      JSON.stringify(after) === JSON.stringify(baseline),
      `listeners ${JSON.stringify(baseline)} -> ${JSON.stringify(after)}`,
    );
    expectThat(
      last.canvasStyle === first.canvasStyle,
      'the canvas style changed across recreations',
    );
    return { listeners: after, enginesCreated: last.created, coreBytes: last.stats.coreBytes };
  });

  await check('no page or console errors', async () => {
    expectThat(problems.length === 0, problems.join(' | '));
  });
}

async function main() {
  const report = { date: new Date().toISOString(), checks };
  let connection = null;
  try {
    if (!skipBuild) await buildApk();
    expectThat(existsSync(apkPath), 'The debug APK was not built.');
    const apk = await readFile(apkPath);
    const permissions = exec(aapt2(), ['dump', 'permissions', apkPath]);
    report.apk = {
      bytes: apk.length,
      sha256: createHash('sha256').update(apk).digest('hex'),
      sourceManifestPermissions: uses(
        await readFile(join(android, 'app/src/main/AndroidManifest.xml'), 'utf8'),
      ),
      apkPermissions: [...permissions.matchAll(/uses-permission: name='([^']+)'/g)].map(
        (m) => m[1],
      ),
    };
    report.toolchain = await toolchain();
    await check('manifest requests only INTERNET', async () => {
      const { sourceManifestPermissions: source, apkPermissions: merged } = report.apk;
      expectThat(source.join() === 'android.permission.INTERNET', `source manifest: ${source}`);
      // AndroidX Core adds an app-private signature permission for its own receivers.
      const extra = merged.filter(
        (name) =>
          name !== 'android.permission.INTERNET' &&
          name !== `${APP_ID}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
      );
      expectThat(extra.length === 0, `APK requests ${extra.join(', ')}`);
      return { source, merged };
    });
    await ensureDevice();
    report.device = deviceInfo();
    console.log(`Device: ${JSON.stringify(report.device)}`);
    try {
      // Quiet but audible: the emulator plays through the host's speakers.
      shell('cmd', 'media_session', 'volume', '--stream', '3', '--set', '2');
    } catch {
      /* Not every device offers this command. */
    }
    adb('install', '-r', '-t', apkPath);
    shell('am', 'force-stop', APP_ID);
    shell('am', 'start', '-W', '-n', ACTIVITY);
    connection = await connect();
    report.webView = await (await fetch(`${connection.endpoint}/json/version`)).json();
    await runChecks(connection);
  } catch (error) {
    checks.push({ name: 'run', status: 'failed', reason: error.stack ?? String(error) });
    console.error(error);
  } finally {
    await connection?.browser.close().catch(() => {});
    if (connection)
      spawnSync(adbPath, ['-s', serial, 'forward', '--remove', `tcp:${connection.port}`]);
    if (serial && !bootedEmulator) spawnSync(adbPath, ['-s', serial, 'uninstall', APP_ID]);
    await stopEmulator();
  }
  report.emulatorStopped = Boolean(bootedEmulator) && process.env.PIXELJS_KEEP_EMULATOR !== '1';
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  const count = (status) => checks.filter((entry) => entry.status === status).length;
  console.log(
    `\n${count('passed')} passed, ${count('failed')} failed, ${count('not possible')} not possible. Results: ${join(out, 'results.json')}`,
  );
  process.exit(count('failed') > 0 ? 1 : 0);
}

await main();

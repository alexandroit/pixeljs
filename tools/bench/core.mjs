// Benchmarks that run in Node on the real build artifacts: the core parts of
// B01–B05 (validation and rasterization in engine.wasm), B07 (the audio DSP
// in audio.wasm) and B12 (the real AudioController, AudioWorklet processor
// and DSP joined by a scripted port). Each function returns a result object
// for tools/bench/common.mjs; none of them writes files.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { serialize } from 'node:v8';
import factory from '../../packages/core/dist/internal/wasm/engine.mjs';
import { FLAGS, OPCODE, PROTOCOL, STATUS } from '../../packages/core/dist/internal/protocol.js';
import { WasmAdapter } from '../../packages/core/dist/internal/wasm/adapter.js';
import {
  AUDIO_LIMITS,
  AudioController,
} from '../../packages/core/dist/internal/audio/controller.js';
import { aggregate, check, compact, finishResult, median, row, summarize } from './common.mjs';
import { drawScene, sceneImages } from './site/scene.mjs';

const DIST = new URL('../../packages/core/dist/', import.meta.url);
const MAX_SAMPLES = 250_000;
const NODE_RUNTIME = `Node ${process.version}, real engine.wasm/audio.wasm from packages/core/dist`;

let cached = null;
export async function binaries() {
  cached ??= {
    engine: new Uint8Array(await readFile(new URL('internal/wasm/engine.wasm', DIST))),
    audio: new Uint8Array(await readFile(new URL('internal/wasm/audio.wasm', DIST))),
  };
  return cached;
}

// -----------------------------------------------------------------------------
// Timing
// -----------------------------------------------------------------------------

/**
 * Warm-up, then `runs` repetitions. Within a repetition the variants run in
 * rotating order so slow drift does not favour one of them. A sample is the
 * mean time per call over one batch of `batch` consecutive calls. The
 * optional `begin({ warmup, run })` hook runs before each phase.
 */
export function timeVariants(variants, { warmupMs, sampleMs, runs }) {
  const measure = (variant, duration, keep, run) => {
    variant.begin?.({ warmup: !keep, run });
    const samples = [];
    const start = performance.now();
    let calls = 0;
    do {
      const at = performance.now();
      for (let index = 0; index < variant.batch; index++) variant.frame();
      const elapsed = performance.now() - at;
      calls += variant.batch;
      if (keep && samples.length < MAX_SAMPLES) samples.push(elapsed / variant.batch);
    } while (performance.now() - start < duration);
    return { samples, calls, elapsedMs: performance.now() - start };
  };
  for (const variant of variants) measure(variant, warmupMs, false, -1);
  const measured = new Map(variants.map((variant) => [variant.name, []]));
  for (let run = 0; run < runs; run++)
    for (let offset = 0; offset < variants.length; offset++) {
      const variant = variants[(run + offset) % variants.length];
      measured.get(variant.name).push(measure(variant, sampleMs, true, run));
    }
  return Object.fromEntries(
    variants.map((variant) => {
      const list = measured.get(variant.name);
      const perRun = list.map((entry) => summarize(entry.samples));
      return [
        variant.name,
        {
          batch: variant.batch,
          stats: aggregate(perRun),
          runs: list.map((entry, index) => ({
            calls: entry.calls,
            elapsedMs: entry.elapsedMs,
            stats: perRun[index],
          })),
          samples: list.map((entry) => entry.samples),
        },
      ];
    }),
  );
}

/** Raw file content: per variant, the batch size and each repetition's samples. */
const rawTimings = (timings, extra = {}) => ({
  sampleUnit: 'ms per call (mean over one batch)',
  ...extra,
  variants: Object.fromEntries(
    Object.entries(timings).map(([name, timing]) => [
      name,
      { batch: timing.batch, runs: timing.runs, samples: timing.samples.map(compact) },
    ]),
  ),
});

// -----------------------------------------------------------------------------
// Engine helpers (the same WASM adapter the SDK uses)
// -----------------------------------------------------------------------------

async function createCore(width = 256, height = 144) {
  const module = await factory({ wasmBinary: (await binaries()).engine });
  return { module, adapter: new WasmAdapter(module, width, height) };
}

/** Little-endian command records in the documented 32-byte layout. */
class Records {
  constructor(capacity = PROTOCOL.maxCommands) {
    this.bytes = new Uint8Array(PROTOCOL.headerBytes + capacity * PROTOCOL.recordBytes);
    this.view = new DataView(this.bytes.buffer);
    this.count = 0;
  }
  add(opcode, handle = 0, args = [], flags = 0) {
    const at = PROTOCOL.headerBytes + this.count * PROTOCOL.recordBytes;
    if (at + PROTOCOL.recordBytes > this.bytes.length) throw new Error('Record capacity exceeded.');
    this.view.setUint16(at, opcode, true);
    this.view.setUint16(at + 2, flags, true);
    this.view.setUint32(at + 4, handle, true);
    for (let index = 0; index < 6; index++)
      this.view.setInt32(at + 8 + index * 4, args[index] ?? 0, true);
    this.count++;
    return this;
  }
  finish(sequence = 0) {
    const length = PROTOCOL.headerBytes + this.count * PROTOCOL.recordBytes;
    this.view.setUint32(0, 0x534a5850, true);
    this.view.setUint32(4, PROTOCOL.protocolVersion, true);
    this.view.setUint32(8, this.count, true);
    this.view.setUint32(12, length, true);
    this.view.setUint32(16, sequence >>> 0, true);
    return this.bytes.slice(0, length);
  }
}

function imageBytes({ width, height, pixels, transparentIndex }) {
  const bytes = new Uint8Array(PROTOCOL.headerBytes + width * height);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x4d495850, true);
  view.setUint32(4, PROTOCOL.imageVersion, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, transparentIndex ?? PROTOCOL.noTransparency, true);
  view.setUint32(20, bytes.length, true);
  bytes.set(pixels, PROTOCOL.headerBytes);
  return bytes;
}

function tilemapBytes({ cols, rows, tileWidth, tileHeight, tileset, tiles }) {
  const bytes = new Uint8Array(PROTOCOL.headerBytes + cols * rows * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x4d545850, true);
  view.setUint32(4, PROTOCOL.tilemapVersion, true);
  view.setUint32(8, cols, true);
  view.setUint32(12, rows, true);
  view.setUint32(16, tileWidth, true);
  view.setUint32(20, tileHeight, true);
  view.setUint32(24, tileset, true);
  view.setUint32(28, bytes.length, true);
  for (let index = 0; index < tiles.length; index++)
    view.setUint16(PROTOCOL.headerBytes + index * 2, tiles[index], true);
  return bytes;
}

/** Copies a batch into the mailbox and returns its length. */
function load(core, batch) {
  core.adapter.mailboxBytes.set(batch);
  return batch.length;
}

function submitOrThrow(core, length, label) {
  const status = core.module._pxw_submit(length);
  if (status !== STATUS.OK)
    throw new Error(
      `${label}: submit returned ${status} at command ${core.module._pxw_last_error_command_index()}.`,
    );
}

/** Deterministic pseudo-random integers (xorshift32). */
function random(seed) {
  let state = seed >>> 0 || 1;
  return (low, high) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return low + (state % (high - low + 1));
  };
}

const allocations = (core) => core.module._pxw_allocation_count() >>> 0;
const frameHash = (core) => {
  let hash = 2166136261;
  for (const value of core.adapter.indexed) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return hash;
};

// -----------------------------------------------------------------------------
// B01 (core part): the baseline rectangles and the character/HUD scene
// -----------------------------------------------------------------------------

/** Encodes the scene's graphics calls exactly as the SDK writes them. */
class SceneEncoder {
  constructor(records) {
    this.records = records;
  }
  clear(color) {
    this.records.add(OPCODE.CLEAR, 0, [color]);
  }
  pixel(x, y, color) {
    this.records.add(OPCODE.PIXEL, 0, [x, y, color]);
  }
  rect(x, y, width, height, color) {
    this.records.add(OPCODE.RECT, 0, [x, y, width, height, color]);
  }
  rectb(x, y, width, height, color) {
    this.records.add(OPCODE.RECTB, 0, [x, y, width, height, color]);
  }
  sprite(image, x, y, options = {}) {
    const flags = (options.flipX ? FLAGS.FLIP_X : 0) | (options.flipY ? FLAGS.FLIP_Y : 0);
    this.records.add(
      OPCODE.BLIT,
      image.handle,
      [
        x,
        y,
        options.sourceX ?? 0,
        options.sourceY ?? 0,
        options.width ?? image.width,
        options.height ?? image.height,
      ],
      flags,
    );
  }
  text(x, y, content, color) {
    let penX = x;
    let penY = y;
    for (let index = 0; index < content.length; index++) {
      const code = content.charCodeAt(index);
      if (code === 10) {
        penY += 8;
        penX = x;
      } else if (code !== 13) {
        this.records.add(OPCODE.GLYPH, 0, [penX, penY, code, color, -1]);
        penX += 8;
      }
    }
  }
}

/** Uploads the scene images and prebuilds `count` frames (plus rejected twins). */
function buildSceneFrames(core, count) {
  const images = {};
  for (const [name, image] of Object.entries(sceneImages()))
    images[name] = {
      handle: core.adapter.upload(PROTOCOL.imageKind, imageBytes(image)),
      width: image.width,
      height: image.height,
    };
  const frames = [];
  const rejected = [];
  for (let frame = 0; frame < count; frame++) {
    const records = new Records(256);
    drawScene(new SceneEncoder(records), images, frame);
    frames.push(records.finish(frame));
    // The same frame with an invalid final record: validation runs over every
    // record and rejects the batch before anything is drawn.
    records.add(OPCODE.RECT, 0, [0, 0, -1, 1, 0]);
    rejected.push(records.finish(frame));
  }
  return { frames, rejected };
}

export async function runB01Core(settings) {
  const baseline = await createCore();
  const records = new Records(33);
  records.add(OPCODE.CLEAR, 0, [0]);
  for (let index = 1; index < 33; index++)
    records.add(OPCODE.RECT, 0, [
      ((index * 31) % 260) - 4,
      ((index * 17) % 150) - 4,
      16,
      16,
      index % 16,
    ]);
  const baselineLength = load(baseline, records.finish());
  submitOrThrow(baseline, baselineLength, 'B01 baseline');

  const scene = await createCore();
  const { frames, rejected } = buildSceneFrames(scene, 240);
  let rejectedIndexOk = true;
  for (const batch of rejected) {
    const status = scene.module._pxw_submit(load(scene, batch));
    const commands = (batch.length - PROTOCOL.headerBytes) / PROTOCOL.recordBytes;
    if (status !== STATUS.RANGE || scene.module._pxw_last_error_command_index() !== commands - 1)
      rejectedIndexOk = false;
  }
  for (const batch of frames) submitOrThrow(scene, load(scene, batch), 'B01 scene');
  const before = [allocations(baseline), allocations(scene)];

  let sceneFrame = 0;
  let twinFrame = 0;
  let unexpected = 0;
  const timings = timeVariants(
    [
      {
        name: 'baseline',
        batch: 100,
        frame: () => {
          if (baseline.module._pxw_submit(baselineLength) !== STATUS.OK) unexpected++;
        },
      },
      {
        name: 'scene',
        batch: 20,
        frame: () => {
          const batch = frames[sceneFrame++ % frames.length];
          scene.adapter.mailboxBytes.set(batch);
          if (scene.module._pxw_submit(batch.length) !== STATUS.OK) unexpected++;
        },
      },
      {
        name: 'validation',
        batch: 20,
        frame: () => {
          const batch = rejected[twinFrame++ % rejected.length];
          scene.adapter.mailboxBytes.set(batch);
          if (scene.module._pxw_submit(batch.length) !== STATUS.RANGE) unexpected++;
        },
      },
    ],
    settings,
  );
  const after = [allocations(baseline), allocations(scene)];
  const commandCounts = frames.map(
    (batch) => (batch.length - PROTOCOL.headerBytes) / PROTOCOL.recordBytes,
  );
  baseline.adapter.destroy();
  scene.adapter.destroy();
  const target = { op: '<=', limit: 4, text: 'p95 ≤ 4 ms (engine CPU, desktop)' };
  return finishResult({
    id: 'B01',
    title: '256 × 144 character/HUD scene (core part)',
    runtime: NODE_RUNTIME,
    measures: [
      'C validation plus rasterization per frame (`_pxw_submit`) for the original character/HUD scene of tools/bench/site/scene.mjs (≈95 commands: sky, stars, ground tiles, coins, an animated 16 × 16 hero, HUD text and bars), 240 distinct prebuilt frames in rotation; each frame also copies its records into the mailbox.',
      'The same frames with one invalid final record: the validation pass alone, since a rejected batch draws nothing.',
      'The earlier baseline (clear + 32 clipped 16 × 16 rectangles) for continuity with previous results.',
    ],
    excludes: [
      'JavaScript game logic, SDK argument validation and encoding, palette expansion, texture upload, GPU work and cold start: see B01 in `npm run bench:browser` for the full browser pipeline.',
      'A sample is the mean over a batch of 20 (scene) or 100 (baseline) frames, which smooths single-frame outliers.',
    ],
    rows: [
      row({
        scenario: 'HUD scene, validation + raster',
        metric: 'ms per frame',
        stats: timings.scene.stats,
        target,
      }),
      row({
        scenario: 'HUD scene, validation only (rejected twin)',
        metric: 'ms per frame',
        stats: timings.validation.stats,
      }),
      row({
        scenario: 'Baseline clear + 32 rects',
        metric: 'ms per frame',
        stats: timings.baseline.stats,
        target,
      }),
    ],
    checks: [
      check(
        'Steady frames make no C allocations',
        before.every((value, index) => value === after[index]),
        `before ${before.join('/')}, after ${after.join('/')}`,
        'unchanged',
      ),
      check(
        'Every measured frame had the expected status',
        unexpected === 0,
        `${unexpected} unexpected`,
        '0',
      ),
      check(
        'Rejected twins fail with RANGE at their last record',
        rejectedIndexOk,
        rejectedIndexOk ? 'yes' : 'no',
        'yes',
      ),
    ],
    observations: {
      'Commands per scene frame': `${Math.min(...commandCounts)}–${Math.max(...commandCounts)}`,
      'Validation share of the scene frame (median)': `${((timings.validation.stats.p50 / timings.scene.stats.p50) * 100).toFixed(0)}%`,
    },
    raw: rawTimings(timings),
  });
}

// -----------------------------------------------------------------------------
// B02: 1,000 8 × 8 and 16 × 16 sprites with clipping and transparency
// -----------------------------------------------------------------------------

function spriteSheet() {
  // 32 × 16: a 16 × 16 character on the left, four 8 × 8 tiles on the right.
  const pixels = new Uint8Array(32 * 16);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 32; x++) {
      let color;
      if (x < 16) {
        const dx = x - 7.5;
        const dy = y - 7.5;
        color = dx * dx + dy * dy <= 49 ? 1 + ((x + 2 * y) % 15) : 0;
      } else {
        const tx = x % 8;
        const ty = y % 8;
        color = (tx + ty) % 4 === 0 || (tx === 0 && ty === 0) ? 0 : 1 + ((x * 3 + y) % 15);
      }
      pixels[y * 32 + x] = color;
    }
  return { width: 32, height: 16, pixels, transparentIndex: 0 };
}

/** A width × height pattern with about 1/9 transparent pixels (index 0). */
function patternImage(width, height) {
  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index++)
    pixels[index] = (index * 7) % 9 === 0 ? 0 : 1 + (index % 15);
  return { width, height, pixels, transparentIndex: 0 };
}

export async function runB02(settings) {
  const core = await createCore();
  const sheet = spriteSheet();
  const handle = core.adapter.upload(PROTOCOL.imageKind, imageBytes(sheet));
  const records = new Records(1001);
  records.add(OPCODE.CLEAR, 0, [0]);
  let clipped = 0;
  let offscreen = 0;
  for (let index = 0; index < 1000; index++) {
    const big = index % 2 === 0;
    const size = big ? 16 : 8;
    const x = ((index * 17) % 288) - 16;
    const y = ((index * 23) % 176) - 16;
    const sourceX = big ? 0 : 16 + ((index >> 1) & 1) * 8;
    const sourceY = big ? 0 : ((index >> 2) & 1) * 8;
    const flags = [0, FLAGS.FLIP_X, FLAGS.FLIP_Y, FLAGS.FLIP_X | FLAGS.FLIP_Y][index % 4];
    records.add(OPCODE.BLIT, handle, [x, y, sourceX, sourceY, size, size], flags);
    const outside = x + size <= 0 || y + size <= 0 || x >= 256 || y >= 144;
    if (outside) offscreen++;
    else if (x < 0 || y < 0 || x + size > 256 || y + size > 144) clipped++;
  }
  const length = load(core, records.finish());
  submitOrThrow(core, length, 'B02');
  const before = allocations(core);
  let unexpected = 0;
  const timings = timeVariants(
    [
      {
        name: 'sprites',
        batch: 20,
        frame: () => {
          if (core.module._pxw_submit(length) !== STATUS.OK) unexpected++;
        },
      },
    ],
    settings,
  );
  const after = allocations(core);
  core.adapter.destroy();
  const transparent = sheet.pixels.filter((value) => value === 0).length / sheet.pixels.length;
  return finishResult({
    id: 'B02',
    title: '1,000 8 × 8 and 16 × 16 sprites with clipping and transparency',
    runtime: NODE_RUNTIME,
    measures: [
      'C validation plus rasterization of CLEAR and 1,000 BLIT records per frame: 500 16 × 16 and 500 8 × 8 sprites from one sheet with transparent index 0, all four flip combinations, positions spread from −16 to 272 × −16 to 160 so many are clipped.',
    ],
    excludes: [
      'SDK encoding, texture upload, GPU work and game logic.',
      'This workload was revised on 2026-09-30 to match its description (earlier results used 1,000 opaque 8 × 8 sources); older B02 numbers are not comparable.',
    ],
    rows: [
      row({
        scenario: '1,000 sprites',
        metric: 'ms per frame',
        stats: timings.sprites.stats,
        target: { op: '<=', limit: 8, text: 'p95 ≤ 8 ms' },
      }),
    ],
    checks: [
      check(
        'Steady frames make no C allocations',
        before === after,
        `before ${before}, after ${after}`,
        'unchanged',
      ),
      check('Every measured frame was accepted', unexpected === 0, `${unexpected} rejected`, '0'),
    ],
    observations: {
      'Transparent share of the sprite sheet': `${(transparent * 100).toFixed(1)}%`,
      'Sprites clipped at an edge': clipped,
      'Sprites entirely offscreen': offscreen,
    },
    raw: rawTimings(timings),
  });
}

// -----------------------------------------------------------------------------
// B03: scrolling viewport over a larger tilemap; visible-work culling
// -----------------------------------------------------------------------------

function tileset() {
  // 128 × 128 pixels: 256 tiles of 8 × 8, about 1/8 transparent.
  const pixels = new Uint8Array(128 * 128);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) {
      const tile = (y >> 3) * 16 + (x >> 3);
      const local = (y & 7) * 8 + (x & 7);
      pixels[y * 128 + x] = (local * 7 + tile) % 8 === 0 ? 0 : 1 + ((tile + local) % 15);
    }
  return { width: 128, height: 128, pixels, transparentIndex: 0 };
}

function mapTiles(cols, rows, seed) {
  const next = random(seed);
  const tiles = new Uint16Array(cols * rows);
  for (let index = 0; index < tiles.length; index++)
    tiles[index] = next(0, 99) < 6 ? PROTOCOL.emptyTile : next(0, 255);
  return tiles;
}

export async function runB03(settings) {
  const core = await createCore();
  const tilesetHandle = core.adapter.upload(PROTOCOL.imageKind, imageBytes(tileset()));
  const upload = (cols, rows, seed) =>
    core.adapter.upload(
      PROTOCOL.tilemapKind,
      tilemapBytes({
        cols,
        rows,
        tileWidth: 8,
        tileHeight: 8,
        tileset: tilesetHandle,
        tiles: mapTiles(cols, rows, seed),
      }),
    );
  // A: 256 × 256 cells (2048 × 2048 px). B: a 16× larger world of 1024 × 1024
  // cells as 4 × 4 chunks of 256 × 256, because one upload is limited to
  // 1,048,608 bytes (524,288 cells). C: the largest single map, 1024 × 512.
  const mapA = upload(256, 256, 1);
  const chunks = [];
  for (let chunk = 0; chunk < 16; chunk++) chunks.push(upload(256, 256, 100 + chunk));
  const mapC = upload(1024, 512, 7);
  const maxCells = (PROTOCOL.maxUploadBytes - PROTOCOL.headerBytes) / 2;

  // One camera path for every variant, offset so B's view crosses chunk seams.
  const path = [];
  for (let step = 0; step < 4096; step++)
    path.push([
      Math.round(896 + 896 * Math.sin(step * 0.013)),
      Math.round(952 + 950 * Math.sin(step * 0.017 + 1)),
    ]);
  const view = core.adapter.mailbox;
  const writeRecord = (index, opcode, handle, args) => {
    const at = PROTOCOL.headerBytes + index * PROTOCOL.recordBytes;
    view.setUint16(at, opcode, true);
    view.setUint16(at + 2, 0, true);
    view.setUint32(at + 4, handle, true);
    for (let arg = 0; arg < 6; arg++) view.setInt32(at + 8 + arg * 4, args[arg] ?? 0, true);
  };
  const header = (count) => {
    view.setUint32(0, 0x534a5850, true);
    view.setUint32(4, PROTOCOL.protocolVersion, true);
    view.setUint32(8, count, true);
    view.setUint32(12, PROTOCOL.headerBytes + count * PROTOCOL.recordBytes, true);
    for (let offset = 16; offset < 32; offset += 4) view.setUint32(offset, 0, true);
    return PROTOCOL.headerBytes + count * PROTOCOL.recordBytes;
  };
  let step = 0;
  let unexpected = 0;
  let visibleCells = 0;
  let frames = 0;
  const submit = (length) => {
    if (core.module._pxw_submit(length) !== STATUS.OK) unexpected++;
  };
  const frameA = () => {
    const [x, y] = path[step++ & 4095];
    writeRecord(0, OPCODE.CLEAR, 0, [0]);
    writeRecord(1, OPCODE.TILEMAP, mapA, [-x, -y, 0, 0, 256, 256]);
    submit(header(2));
  };
  const frameB = () => {
    const [px, py] = path[step++ & 4095];
    const x = px + 3072;
    const y = py + 3072;
    writeRecord(0, OPCODE.CLEAR, 0, [0]);
    for (let chunk = 0; chunk < 16; chunk++)
      writeRecord(1 + chunk, OPCODE.TILEMAP, chunks[chunk], [
        (chunk % 4) * 2048 - x,
        (chunk >> 2) * 2048 - y,
        0,
        0,
        256,
        256,
      ]);
    submit(header(17));
  };
  const frameC = () => {
    const [px, py] = path[step++ & 4095];
    writeRecord(0, OPCODE.CLEAR, 0, [0]);
    writeRecord(1, OPCODE.TILEMAP, mapC, [-(px + 3072), -(py + 1024), 0, 0, 1024, 512]);
    submit(header(2));
  };
  for (const [x, y] of path) {
    visibleCells += Math.ceil(((x % 8) + 256) / 8) * Math.ceil(((y % 8) + 144) / 8);
    frames++;
  }
  for (let warm = 0; warm < 16; warm++) {
    frameA();
    frameB();
    frameC();
  }
  const before = allocations(core);
  unexpected = 0;
  const timings = timeVariants(
    [
      { name: 'map', batch: 20, frame: frameA },
      { name: 'world16x', batch: 20, frame: frameB },
      { name: 'single8x', batch: 20, frame: frameC },
    ],
    settings,
  );
  const after = allocations(core);
  core.adapter.destroy();
  const target = { op: '<=', limit: 4, text: 'p95 ≤ 4 ms (engine CPU, desktop)' };
  const ratio = (name) => timings[name].stats.p50 / timings.map.stats.p50;
  const ratioTarget = {
    op: '<=',
    limit: 1.25,
    text: 'median ratio ≤ 1.25 (cost tracks the visible area)',
  };
  return finishResult({
    id: 'B03',
    title: 'Scrolling viewport over a larger tilemap (visible-work culling)',
    runtime: NODE_RUNTIME,
    measures: [
      'C validation plus rasterization per frame while a 256 × 144 view scrolls along a fixed path over maps of 8 × 8 tiles (256-tile tileset with transparency, about 6% empty cells). Each frame is CLEAR plus TILEMAP records that name the whole map: the core itself selects the cells that intersect the clip.',
      'Map A: 256 × 256 cells (65,536). World B: 16× larger, 1024 × 1024 cells as 4 × 4 chunk maps of 256 × 256 (16 TILEMAP records per frame, the view crossing chunk seams). Map C: one 1024 × 512 map (8×, 524,288 cells), the largest single tilemap the 1,048,608-byte upload limit allows.',
      'The median-cost ratios B/A and C/A: if culling works, cost follows the visible cells, not the map size.',
    ],
    excludes: [
      'SDK encoding, texture upload, GPU work and game logic.',
      `A single 1024 × 1024-cell map cannot be uploaded (limit ${maxCells.toLocaleString('en-US')} cells per tilemap), so the 16× case uses chunks; per-record overhead of the 15 extra records is included in its cost.`,
    ],
    rows: [
      row({
        scenario: 'A: 256 × 256 map',
        metric: 'ms per frame',
        stats: timings.map.stats,
        target,
      }),
      row({
        scenario: 'B: 16× world (4 × 4 chunks)',
        metric: 'ms per frame',
        stats: timings.world16x.stats,
        target,
      }),
      row({
        scenario: 'C: 8× single map (1024 × 512)',
        metric: 'ms per frame',
        stats: timings.single8x.stats,
        target,
      }),
      row({
        scenario: 'B/A cost ratio',
        metric: 'median ratio',
        unit: '×',
        stats: { value: ratio('world16x') },
        target: ratioTarget,
      }),
      row({
        scenario: 'C/A cost ratio',
        metric: 'median ratio',
        unit: '×',
        stats: { value: ratio('single8x') },
        target: ratioTarget,
      }),
    ],
    checks: [
      check(
        'Steady frames make no C allocations',
        before === after,
        `before ${before}, after ${after}`,
        'unchanged',
      ),
      check('Every measured frame was accepted', unexpected === 0, `${unexpected} rejected`, '0'),
    ],
    observations: {
      'Cells per map': 'A 65,536; B 1,048,576 (16 × 65,536); C 524,288',
      'Visible cells per frame (mean over the path, all variants)': (visibleCells / frames).toFixed(
        1,
      ),
    },
    raw: rawTimings(timings, {
      path: 'x = 896 + 896 sin(0.013 t), y = 952 + 950 sin(0.017 t + 1), rounded',
    }),
  });
}

// -----------------------------------------------------------------------------
// B04: lines, circles, rectangles and the newer primitives, partially and
// extremely offscreen
// -----------------------------------------------------------------------------

function classicPrimitives() {
  const records = new Records(1001);
  records.add(OPCODE.CLEAR, 0, [0]);
  for (let index = 0; index < 250; index++)
    records.add(OPCODE.LINE, 0, [
      ((index * 13) % 300) - 20,
      ((index * 19) % 180) - 20,
      ((index * 29) % 300) - 20,
      ((index * 37) % 180) - 20,
      (index % 15) + 1,
    ]);
  for (let index = 0; index < 250; index++)
    records.add(OPCODE.RECTB, 0, [
      ((index * 23) % 280) - 10,
      ((index * 17) % 160) - 10,
      (index % 30) + 4,
      (index % 30) + 4,
      (index % 15) + 1,
    ]);
  for (let index = 0; index < 250; index++)
    records.add(OPCODE.CIRCLE, 0, [
      ((index * 31) % 280) - 10,
      ((index * 27) % 160) - 10,
      (index % 20) + 2,
      (index % 15) + 1,
    ]);
  for (let index = 0; index < 250; index++)
    records.add(OPCODE.CIRCLE_FILL, 0, [
      ((index * 17) % 280) - 10,
      ((index * 23) % 160) - 10,
      (index % 12) + 2,
      (index % 15) + 1,
    ]);
  return records.finish();
}

function newPrimitives(sprite) {
  const next = random(404);
  const records = new Records(1200);
  const color = () => next(1, 15);
  records.add(OPCODE.CLEAR, 0, [0]);
  records.add(OPCODE.SET_REMAP, 0, [5, 12]);
  for (let index = 0; index < 100; index++)
    records.add(OPCODE.ELLIPSE, 0, [
      next(-40, 280),
      next(-40, 170),
      next(2, 80),
      next(2, 80),
      color(),
    ]);
  for (let index = 0; index < 100; index++)
    records.add(OPCODE.ELLIPSE_FILL, 0, [
      next(-40, 280),
      next(-40, 170),
      next(2, 60),
      next(2, 60),
      color(),
    ]);
  for (const opcode of [OPCODE.TRIANGLE, OPCODE.TRIANGLE_FILL])
    for (let index = 0; index < 100; index++) {
      const x = next(-60, 300);
      const y = next(-60, 190);
      records.add(opcode, 0, [
        x,
        y,
        x + next(-50, 50),
        y + next(-50, 50),
        x + next(-50, 50),
        y + next(-50, 50),
      ]);
      records.add(OPCODE.PARAMS, 0, [color()]);
    }
  for (let index = 0; index < 100; index++) {
    records.add(
      OPCODE.BLIT_TRANSFORM,
      sprite,
      [next(-30, 270), next(-30, 160), 0, 0, 16, 16],
      index % 4,
    );
    records.add(OPCODE.PARAMS, 0, [
      (index * 97) % PROTOCOL.angleUnits,
      32768 + ((index * 4099) % 163840),
    ]);
  }
  records.add(OPCODE.RESET_REMAP);
  // Bounded flood fills: an outline, then a fill inside it with a matching clip.
  for (let index = 0; index < 16; index++) {
    const x = next(-20, 236);
    const y = next(-20, 124);
    records.add(OPCODE.SET_CLIP, 0, [x, y, 40, 30]);
    records.add(OPCODE.RECTB, 0, [x, y, 40, 30, color()]);
    records.add(OPCODE.FILL, 0, [x + 20, y + 15, color()]);
    records.add(OPCODE.RESET_CLIP);
  }
  // Two unclipped fills, the most expensive fill case.
  records.add(OPCODE.FILL, 0, [3, 140, 13]);
  records.add(OPCODE.FILL, 0, [250, 5, 14]);
  return records.finish();
}

const FAR = 2_000_000_000;

/** Every primitive at int32-scale coordinates; most cross or cover the view. */
function extremePrimitives(sprite) {
  const records = new Records(512);
  records.add(OPCODE.CLEAR, 0, [0]);
  for (let index = 0; index < 32; index++) {
    const k = (index + 1) * 1_000_000;
    records.add(OPCODE.LINE, 0, [-FAR, 72 - k, FAR, 72 + k, (index % 15) + 1]);
    records.add(OPCODE.LINE, 0, [128 - k, -FAR, 128 + k, FAR, (index % 15) + 1]);
  }
  records.add(OPCODE.RECTB, 0, [-1_000_000_000, -1_000_000_000, 2_000_000_000, 2_000_000_000, 7]);
  records.add(OPCODE.RECTB, 0, [-FAR, 20, 2_147_483_647, 100, 8]);
  // A circle is charged by its radius (the midpoint loop runs regardless of
  // clipping): these arcs cross the view and cost ~1.6M and ~0.4M work units.
  records.add(OPCODE.CIRCLE, 0, [128, 72 + 200_000, 200_000, 9]);
  records.add(OPCODE.CIRCLE_FILL, 0, [128, 120 + 50_000, 50_000, 10]);
  const size = PROTOCOL.maxEllipseDimension;
  records.add(OPCODE.ELLIPSE, 0, [128 - size / 2, 100 - size, size, size, 11]);
  records.add(OPCODE.ELLIPSE_FILL, 0, [-size + 60, 72 - size / 2, size, size, 12]);
  records.add(OPCODE.TRIANGLE_FILL, 0, [-FAR, -FAR, FAR, -FAR, 0, FAR]);
  records.add(OPCODE.PARAMS, 0, [2]);
  records.add(OPCODE.TRIANGLE, 0, [-FAR, 100, FAR, 30, 128, -FAR]);
  records.add(OPCODE.PARAMS, 0, [13]);
  records.add(OPCODE.BLIT_TRANSFORM, sprite, [120, 64, 0, 0, 16, 16], 0);
  records.add(OPCODE.PARAMS, 0, [512, PROTOCOL.maxScale]);
  // A camera near the int32 edge with geometry expressed in world coordinates.
  records.add(OPCODE.SET_CAMERA, 0, [1_000_000_000, -1_000_000_000]);
  records.add(OPCODE.RECT, 0, [1_000_000_010, -999_999_990, 50, 50, 4]);
  records.add(OPCODE.LINE, 0, [0, -1_000_000_000 + 72, 2_000_000_000, -1_000_000_000 + 80, 5]);
  records.add(OPCODE.SET_CAMERA, 0, [0, 0]);
  return records.finish();
}

/** Primitives entirely outside the view at int32 extremes: validation and culling only. */
function offscreenPrimitives(sprite) {
  const records = new Records(1100);
  records.add(OPCODE.CLEAR, 0, [0]);
  for (let index = 0; index < 100; index++) {
    const x = index % 2 ? FAR + index : -FAR - index;
    const y = index % 3 ? FAR - index : -FAR + index;
    records.add(OPCODE.LINE, 0, [x, y, x + 1_000_000, y - 1_000_000, 1]);
    records.add(OPCODE.RECT, 0, [x, y, 100_000, 100_000, 2]);
    records.add(OPCODE.RECTB, 0, [x, y, 100_000, 100_000, 3]);
    records.add(OPCODE.CIRCLE, 0, [x, y, 1_000_000, 4]);
    records.add(OPCODE.CIRCLE_FILL, 0, [x, y, 1_000_000, 5]);
    records.add(OPCODE.ELLIPSE_FILL, 0, [
      x,
      y,
      PROTOCOL.maxEllipseDimension,
      PROTOCOL.maxEllipseDimension,
      6,
    ]);
    records.add(OPCODE.TRIANGLE_FILL, 0, [x, y, x + 5000, y, x, y + 5000]);
    records.add(OPCODE.PARAMS, 0, [7]);
    records.add(OPCODE.BLIT_TRANSFORM, sprite, [x, y, 0, 0, 16, 16], 0);
    records.add(OPCODE.PARAMS, 0, [1024, PROTOCOL.maxScale]);
  }
  return records.finish();
}

export async function runB04(settings) {
  const core = await createCore();
  const sheet = spriteSheet();
  const sprite = core.adapter.upload(PROTOCOL.imageKind, imageBytes(sheet));
  const batches = {
    classic: classicPrimitives(),
    shapes: newPrimitives(sprite),
    extreme: extremePrimitives(sprite),
    offscreen: offscreenPrimitives(sprite),
  };
  const lengths = {};
  for (const [name, batch] of Object.entries(batches)) {
    lengths[name] = batch.length;
    submitOrThrow(core, load(core, batch), `B04 ${name}`);
  }
  const before = allocations(core);
  let unexpected = 0;
  const variant = (name) => ({
    name,
    batch: 20,
    frame: () => {
      const batch = batches[name];
      core.adapter.mailboxBytes.set(batch);
      if (core.module._pxw_submit(batch.length) !== STATUS.OK) unexpected++;
    },
  });
  const timings = timeVariants(
    ['classic', 'shapes', 'extreme', 'offscreen'].map(variant),
    settings,
  );
  const after = allocations(core);
  core.adapter.destroy();
  const records = (name) => (lengths[name] - PROTOCOL.headerBytes) / PROTOCOL.recordBytes;
  const target = { op: '<=', limit: 8, text: 'p95 ≤ 8 ms' };
  return finishResult({
    id: 'B04',
    title: 'Primitives partially and extremely offscreen',
    runtime: NODE_RUNTIME,
    measures: [
      `Classic (${records('classic')} records, unchanged from earlier results): 250 each of LINE, RECTB, CIRCLE and CIRCLE_FILL spread from −20 to 280 × −20 to 160.`,
      `New primitives (${records('shapes')} records): 100 each of ELLIPSE, ELLIPSE_FILL, TRIANGLE, TRIANGLE_FILL and rotated/scaled sprites (BLIT_TRANSFORM, 0.5×–3×) with a palette remap, 16 clipped flood fills inside outlines and 2 unclipped flood fills.`,
      `Extreme (${records('extreme')} records): lines between ±2,000,000,000 endpoints crossing the view, huge outlines, circles of radius 200,000 and 50,000 whose arcs cross the view, 16,384-pixel ellipses, triangles with int32-scale vertices covering the view, a 64× rotated sprite and a camera near the int32 edge.`,
      `Entirely offscreen (${records('offscreen')} records): every primitive kind placed beyond ±2,000,000,000, which the core must cull without drawing.`,
    ],
    excludes: [
      'SDK encoding, texture upload, GPU work and game logic.',
      'Circles are charged by radius (their midpoint loop runs regardless of clipping), so the extreme batch is dominated by its two large circles by design.',
    ],
    rows: [
      row({
        scenario: 'Classic lines/rects/circles',
        metric: 'ms per frame',
        stats: timings.classic.stats,
        target,
      }),
      row({
        scenario: 'Ellipses, triangles, fills, rotated sprites',
        metric: 'ms per frame',
        stats: timings.shapes.stats,
        target,
      }),
      row({
        scenario: 'Extreme coordinates crossing the view',
        metric: 'ms per frame',
        stats: timings.extreme.stats,
        target,
      }),
      row({
        scenario: 'Entirely offscreen at int32 extremes',
        metric: 'ms per frame',
        stats: timings.offscreen.stats,
        target,
      }),
    ],
    checks: [
      check(
        'Steady frames make no C allocations',
        before === after,
        `before ${before}, after ${after}`,
        'unchanged',
      ),
      check('Every measured frame was accepted', unexpected === 0, `${unexpected} rejected`, '0'),
    ],
    raw: rawTimings(timings),
  });
}

// -----------------------------------------------------------------------------
// B05: 4,096 commands and raster work near the cap; predictable rejection
// -----------------------------------------------------------------------------

/** Batches that spend the 16,000,000-unit work budget with one primitive family. */
function capFamilies(handles) {
  const clear = (records) => records.add(OPCODE.CLEAR, 0, [0]);
  const repeat = (count, perRecord, body) => {
    const records = new Records(1 + count * perRecord);
    clear(records);
    for (let index = 0; index < count; index++) body(records, index);
    return records.finish();
  };
  return {
    rects: {
      label: 'full-screen rectangles',
      max: PROTOCOL.maxCommands - 1,
      build: (count) =>
        repeat(count, 1, (records, index) =>
          records.add(OPCODE.RECT, 0, [0, 0, 256, 144, (index % 15) + 1]),
        ),
    },
    sprites: {
      label: 'full-screen 256 × 144 sprites with transparency',
      max: PROTOCOL.maxCommands - 1,
      build: (count) =>
        repeat(count, 1, (records, index) =>
          records.add(OPCODE.BLIT, handles.screen, [0, 0, 0, 0, 256, 144], index % 4),
        ),
    },
    rotated: {
      label: '16 × 16 sprites rotated and scaled 20× over the view',
      max: (PROTOCOL.maxCommands - 1) >> 1,
      build: (count) =>
        repeat(count, 2, (records, index) => {
          records.add(OPCODE.BLIT_TRANSFORM, handles.sprite, [120, 64, 0, 0, 16, 16], index % 4);
          records.add(OPCODE.PARAMS, 0, [(index * 37) % PROTOCOL.angleUnits, 20 * 65536]);
        }),
    },
    fills: {
      label: 'unclipped flood fills repainting the view',
      max: PROTOCOL.maxCommands - 1,
      build: (count) =>
        repeat(count, 1, (records, index) =>
          records.add(OPCODE.FILL, 0, [10, 10, 1 + (index % 2)]),
        ),
    },
    circle: {
      label: 'one circle whose radius spends the budget (its arc crosses the view)',
      max: PROTOCOL.maxWorkPixels,
      build: (radius) => {
        const records = new Records(2);
        clear(records);
        records.add(OPCODE.CIRCLE, 0, [128, 72 + radius, radius, 9]);
        return records.finish();
      },
    },
  };
}

export async function runB05(settings) {
  const core = await createCore();
  const screen = patternImage(256, 144);
  const handles = {
    screen: core.adapter.upload(PROTOCOL.imageKind, imageBytes(screen)),
    sprite: core.adapter.upload(PROTOCOL.imageKind, imageBytes(spriteSheet())),
  };
  const maxRecords = new Records(PROTOCOL.maxCommands);
  maxRecords.add(OPCODE.CLEAR, 0, [0]);
  for (let index = 1; index < PROTOCOL.maxCommands; index++)
    maxRecords.add(OPCODE.RECT, 0, [(index * 7) % 256, (index * 11) % 144, 4, 4, (index % 15) + 1]);
  const maxBatch = maxRecords.finish();
  const invalidRecords = new Records(PROTOCOL.maxCommands);
  invalidRecords.bytes.set(maxBatch);
  invalidRecords.count = PROTOCOL.maxCommands - 1;
  invalidRecords.add(OPCODE.RECT, 0, [0, 0, -1, 1, 0]);
  const invalidBatch = invalidRecords.finish();

  // For each family, the largest count (or radius) the work budget admits.
  const families = capFamilies(handles);
  const admitted = {};
  for (const [name, family] of Object.entries(families)) {
    let low = 1;
    let high = family.max;
    while (low < high) {
      const middle = Math.floor((low + high + 1) / 2);
      if (core.module._pxw_submit(load(core, family.build(middle))) === STATUS.OK) low = middle;
      else high = middle - 1;
    }
    admitted[name] = { count: low, batch: family.build(low) };
  }
  const overCap = families.rects.build(admitted.rects.count + 1);
  const overStatus = core.module._pxw_submit(load(core, overCap));
  const overIndex = core.module._pxw_last_error_command_index();

  // A rejected batch must leave frame and palette untouched.
  submitOrThrow(core, load(core, maxBatch), 'B05 4,096');
  const hashBefore = frameHash(core);
  const revisionBefore = core.module._pxw_palette_revision();
  core.module._pxw_submit(load(core, overCap));
  core.module._pxw_submit(load(core, invalidBatch));
  const unchanged =
    frameHash(core) === hashBefore && core.module._pxw_palette_revision() === revisionBefore;

  const before = allocations(core);
  let unexpected = 0;
  const variant = (name, batch, status, size) => ({
    name,
    batch: size,
    frame: () => {
      core.adapter.mailboxBytes.set(batch);
      if (core.module._pxw_submit(batch.length) !== status) unexpected++;
    },
  });
  const timings = timeVariants(
    [
      variant('commands4096', maxBatch, STATUS.OK, 5),
      ...Object.entries(admitted).map(([name, { batch }]) => variant(name, batch, STATUS.OK, 1)),
      variant('workOverCap', overCap, STATUS.CAPACITY, 20),
      variant('invalidLast', invalidBatch, STATUS.RANGE, 20),
    ],
    settings,
  );
  const after = allocations(core);
  core.adapter.destroy();
  const frameTarget = {
    op: '<=',
    limit: 16.67,
    text: 'p95 ≤ 16.67 ms (calibration target: an admitted batch fits a 60 Hz frame)',
  };
  const records = (batch) => (batch.length - PROTOCOL.headerBytes) / PROTOCOL.recordBytes;
  const worst = Object.keys(admitted).reduce((a, b) =>
    timings[a].stats.p95 >= timings[b].stats.p95 ? a : b,
  );
  return finishResult({
    id: 'B05',
    title: '4,096 commands and raster work near the cap, with predictable rejection',
    runtime: NODE_RUNTIME,
    measures: [
      'A full 4,096-record batch (CLEAR and 4,095 4 × 4 rectangles), the command-count limit.',
      'The 16,000,000-unit work budget spent by one primitive family at a time: CLEAR plus the largest count (or, for the circle, radius) the core admits, found by bisection, so each batch is within one command of the cap. The families differ in cost per work unit; the slowest one is the worst batch validation admits.',
      `One rectangle over the cap (${admitted.rects.count + 1} full-screen rectangles): rejection with CAPACITY before anything is drawn, and its cost; and a 4,096-record batch whose last record is invalid.`,
    ],
    excludes: [
      'SDK encoding, texture upload and GPU work. Samples at the cap are single frames (batch 1); the others average 5 or 20 frames.',
      'The budget bounds work units, not time (docs/architecture.md): these rows are the per-operation calibration data the plan asks for.',
    ],
    rows: [
      row({
        scenario: '4,096 records',
        metric: 'ms per frame',
        stats: timings.commands4096.stats,
        target: { op: '<=', limit: 16, text: 'p95 ≤ 16 ms' },
      }),
      ...Object.entries(admitted).map(([name, { count, batch }]) =>
        row({
          scenario: `At the cap: ${families[name].label} (${name === 'circle' ? `radius ${count.toLocaleString('en-US')}` : `${count} × ${records(batch) > count + 1 ? 'record pairs' : 'records'}`})`,
          metric: 'ms per frame',
          stats: timings[name].stats,
          target: frameTarget,
        }),
      ),
      row({
        scenario: 'Over the cap (rejected)',
        metric: 'ms per rejection',
        stats: timings.workOverCap.stats,
        target: { op: '<=', limit: 1, text: 'p95 ≤ 1 ms' },
      }),
      row({
        scenario: '4,096 records, last invalid (rejected)',
        metric: 'ms per rejection',
        stats: timings.invalidLast.stats,
        target: { op: '<=', limit: 1, text: 'p95 ≤ 1 ms' },
      }),
    ],
    checks: [
      check(
        'Over-cap batch is rejected with CAPACITY',
        overStatus === STATUS.CAPACITY,
        `status ${overStatus} at command ${overIndex}`,
        `status ${STATUS.CAPACITY}`,
      ),
      check(
        'Rejected batches leave frame and palette unchanged',
        unchanged,
        unchanged ? 'unchanged' : 'changed',
        'unchanged',
      ),
      check(
        'Steady frames make no C allocations',
        before === after,
        `before ${before}, after ${after}`,
        'unchanged',
      ),
      check(
        'Every measured frame had the expected status',
        unexpected === 0,
        `${unexpected} unexpected`,
        '0',
      ),
    ],
    observations: {
      'Slowest admitted family (median p95)': `${families[worst].label}: ${timings[worst].stats.p95.toFixed(3)} ms`,
      'Approximate ms per million work units (median p50 / 16)': Object.fromEntries(
        Object.keys(admitted).map((name) => [
          name,
          Number((timings[name].stats.p50 / 16).toFixed(4)),
        ]),
      ),
      'Command index reported for the over-cap rejection': overIndex,
    },
    raw: rawTimings(timings),
  });
}

// -----------------------------------------------------------------------------
// B07: four voices, multi-note bursts and four-track music in the DSP
// -----------------------------------------------------------------------------

async function audioDsp() {
  const { instance } = await WebAssembly.instantiate((await binaries()).audio, {});
  instance.exports.__wasm_call_ctors?.();
  return instance.exports;
}

const INSTRUMENTS = [
  [0.5, 0.005, 0.02, 0.7, 0.05],
  [0.6, 0.01, 0.05, 0.8, 0.08],
  [0.5, 0.002, 0.03, 0.6, 0.04],
  [0.3, 0.001, 0.02, 0.4, 0.03],
];

/** A looping 64-step piece: every track has a note on every step. */
function startMusic(dsp) {
  const ok = (value, what) => {
    if (value !== 1) throw new Error(`B07: ${what} was rejected by the DSP.`);
  };
  ok(dsp.pxa_music_begin(64, 15000, 4, 4), 'music_begin');
  const effects = [2, 1, 3, 0]; // vibrato, slide, fadeout, none
  for (let track = 0; track < 4; track++) {
    ok(dsp.pxa_music_track(track, track, ...INSTRUMENTS[track]), 'music_track');
    for (let step = 0; step < 64; step++)
      ok(
        dsp.pxa_music_note(
          track,
          step,
          1 + (step % 2),
          48 + track * 7 + (step % 12),
          200,
          track,
          effects[track],
        ),
        'music_note',
      );
  }
  ok(dsp.pxa_music_play(1), 'music_play');
}

/** One burst: a multi-note sound (8 notes at 400 BPM) on each of the four voices. */
function burst(dsp, seed) {
  let started = 0;
  for (let voice = 0; voice < 4; voice++) {
    if (dsp.pxa_sound_begin(voice, 40000, 16, 0.8, 0.001, 0.01, 0.6, 0.02) !== 1) continue;
    let valid = true;
    for (let note = 0; note < 8; note++)
      valid &&=
        dsp.pxa_sound_note(
          voice,
          note,
          1,
          60 + ((seed + note * 3) % 24),
          255,
          (voice + note) % 4,
          note % 4,
        ) === 1;
    if (valid && dsp.pxa_sound_play(voice) === 1) started++;
  }
  return started;
}

export async function runB07(settings) {
  // A: the earlier four sustained voices, 512-frame blocks (continuity).
  const sustained = await audioDsp();
  sustained.pxa_initialize(48000);
  const trigger = () => {
    const started = [
      sustained.pxa_note_on(0, 0, 440.0, 0.8, 0.005, 0.01, 0.7, 0.05, 60.0),
      sustained.pxa_note_on(1, 1, 220.0, 0.6, 0.01, 0.02, 0.8, 0.05, 60.0),
      sustained.pxa_note_on(2, 2, 880.0, 0.5, 0.01, 0.02, 0.8, 0.05, 60.0),
      sustained.pxa_note_on(3, 3, 1000.0, 0.4, 0.001, 0.01, 0.5, 0.05, 60.0),
    ];
    if (started.some((value) => value !== 1)) throw new Error('B07: a voice was rejected');
  };
  trigger();
  let blockA = 0;
  const outputA = new Float32Array(sustained.memory.buffer, sustained.pxa_buffer_offset(), 512);
  let silentA = 0;

  // B: four-track music with multi-note bursts, rendered in 128-frame quanta
  // like an AudioWorklet. Bursts are applied between quanta, as the
  // processor applies a batch before its next process() call.
  const music = await audioDsp();
  music.pxa_initialize(48000);
  startMusic(music);
  const outputB = new Float32Array(music.memory.buffer, music.pxa_buffer_offset(), 512);
  let quantum = 0;
  let burstsStarted = 0;
  let peak = 0;
  let nonFinite = 0;
  let silentWindows = 0;
  let windowEnergy = 0;
  const steps = new Set();
  const burstRuns = [];
  let burstSamples = null;
  const timings = timeVariants(
    [
      {
        name: 'sustained512',
        batch: 100,
        frame: () => {
          if (blockA++ % 1000 === 0) trigger();
          sustained.pxa_render(512);
        },
      },
      {
        name: 'musicBursts128',
        batch: 1,
        begin: ({ warmup }) => {
          burstSamples = warmup ? null : [];
          if (burstSamples) burstRuns.push(burstSamples);
        },
        frame: () => {
          if (quantum % 16 === 0) {
            const at = performance.now();
            burstsStarted += burst(music, quantum >> 4);
            if (burstSamples && burstSamples.length < MAX_SAMPLES)
              burstSamples.push(performance.now() - at);
          }
          music.pxa_render(128);
          quantum++;
        },
      },
    ],
    settings,
  );
  // Output checks on fresh blocks (outside the timed loop).
  for (let block = 0; block < 400; block++) {
    if (block % 16 === 0) burstsStarted += burst(music, block);
    music.pxa_render(128);
    steps.add(music.pxa_music_step());
    for (let index = 0; index < 128; index++) {
      const value = outputB[index];
      if (!Number.isFinite(value)) nonFinite++;
      else {
        peak = Math.max(peak, Math.abs(value));
        windowEnergy += Math.abs(value);
      }
    }
    if (block % 20 === 19) {
      if (windowEnergy === 0) silentWindows++;
      windowEnergy = 0;
    }
  }
  sustained.pxa_render(512);
  if (!outputA.some((value) => value !== 0) || sustained.pxa_is_active() !== 1) silentA++;

  const quantumMs = (128 / 48000) * 1000;
  const blockMs = (512 / 48000) * 1000;
  const allQuanta = timings.musicBursts128.samples.flat();
  const misses = allQuanta.filter((value) => value > quantumMs).length;
  const burstStats = aggregate(burstRuns.map((samples) => summarize(samples)));
  return finishResult({
    id: 'B07',
    title: 'Four voices, event bursts and four-track music (DSP)',
    runtime: NODE_RUNTIME,
    measures: [
      'A: the earlier workload for continuity, four sustained voices (one per waveform) rendered in 512-frame blocks at 48 kHz.',
      'B: a looping 64-step piece on four tracks (a note on every step, vibrato, slide and fadeout effects) while every 16th 128-frame quantum applies a burst of four multi-note sounds (8 notes each at 400 BPM) that take over the voices; the time per 128-frame quantum including any burst applied before it.',
      'Burst application alone (pxa_sound_begin/note/play for four voices), and the number of quanta slower than real time (2.667 ms), which would underrun on an audio thread.',
    ],
    excludes: [
      'The AudioWorklet thread, message transport and the browser audio device (see B12 and B07 in `npm run bench:browser`); audible quality.',
      'Rendering of the game: in a browser the DSP runs on the audio thread, so the game frame is measured separately (B07 browser).',
    ],
    rows: [
      row({
        scenario: 'A: 4 sustained voices',
        metric: 'ms per 512 frames',
        stats: timings.sustained512.stats,
        target: { op: '<=', limit: 0.2, text: 'p95 ≤ 0.2 ms' },
      }),
      row({
        scenario: 'B: music + bursts',
        metric: 'ms per 128-frame quantum',
        stats: timings.musicBursts128.stats,
        target: {
          op: '<=',
          limit: quantumMs / 10,
          statistic: 'p99',
          text: 'p99 ≤ 0.267 ms (10% of the quantum)',
        },
      }),
      row({
        scenario: 'B: one burst of four multi-note sounds',
        metric: 'ms per burst',
        stats: burstStats,
        target: { op: '<=', limit: quantumMs / 10, text: 'p95 ≤ 0.267 ms' },
      }),
      row({
        scenario: 'B: quanta slower than real time',
        metric: 'count',
        unit: 'count',
        stats: { value: misses },
        target: { op: '==', limit: 0, text: '0 deadline misses' },
      }),
    ],
    checks: [
      check(
        'A renders four sounding voices',
        silentA === 0,
        silentA === 0 ? 'sounding' : 'silent',
        'sounding',
      ),
      check(
        'B output is finite and within [−1, 1]',
        nonFinite === 0 && peak <= 1,
        `peak ${peak.toFixed(3)}, ${nonFinite} non-finite`,
        'finite, peak ≤ 1',
      ),
      check(
        'B is never silent for 20 quanta',
        silentWindows === 0,
        `${silentWindows} silent windows`,
        '0',
      ),
      check(
        'B music advances through its steps',
        steps.size > 8,
        `${steps.size} distinct steps seen`,
        '> 8',
      ),
      check(
        'B bursts start on all four voices',
        burstsStarted > 0 && burstsStarted % 4 === 0,
        `${burstsStarted} sounds started`,
        'a multiple of 4, > 0',
      ),
    ],
    observations: {
      'Real-time margin of A (block duration / median p95)': `${(blockMs / timings.sustained512.stats.p95).toFixed(0)}×`,
      'Real-time margin of B (quantum / median p99)': `${(quantumMs / timings.musicBursts128.stats.p99).toFixed(0)}×`,
      'Quanta measured in B (one timed quantum per sample, so timer overhead of ~0.1 µs is included)':
        allQuanta.length,
    },
    raw: { ...rawTimings(timings), burstRuns: burstRuns.map(compact) },
  });
}

// -----------------------------------------------------------------------------
// B12: audio transport under missing ACKs or consumption, saturation, STOP,
// suspension and processor failure. Real AudioController, real processor.js
// and real DSP; only the MessagePort, the AudioContext and the clock are
// scripted, so every delivery is under the benchmark's control.
// -----------------------------------------------------------------------------

const QUANTUM = 128;
let Processor = null;
let pendingProcessorPort = null;

async function processorClass() {
  if (Processor) return Processor;
  const saved = {
    AudioWorkletProcessor: globalThis.AudioWorkletProcessor,
    registerProcessor: globalThis.registerProcessor,
  };
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = pendingProcessorPort;
      pendingProcessorPort = null;
    }
  };
  globalThis.registerProcessor = (name, constructor) => {
    if (name === 'pixeljs-audio-processor') Processor = constructor;
  };
  try {
    await import(new URL('internal/audio/processor.js', DIST).href);
  } finally {
    restoreGlobals(saved);
  }
  if (!Processor) throw new Error('processor.js did not register pixeljs-audio-processor.');
  return Processor;
}

function restoreGlobals(saved) {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
}

const messageBytes = (message) => serialize(message).byteLength;
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** An ordered two-way channel that delivers only when the benchmark pumps it. */
class ScriptedLink {
  constructor() {
    this.toProcessor = [];
    this.toController = [];
    this.closed = false;
    /** Byte accounting serializes every message; timing loops turn it off. */
    this.countBytes = true;
    this.stats = { batches: 0, maxEvents: 0, maxBatchBytes: 0 };
    const link = this;
    this.controllerPort = {
      onmessage: null,
      postMessage(message) {
        const bytes = link.countBytes && message?.type !== 'init' ? messageBytes(message) : 0;
        link.toProcessor.push({ message, bytes });
        if (message?.type === 'batch') {
          link.stats.batches++;
          link.stats.maxEvents = Math.max(link.stats.maxEvents, message.events.length);
          link.stats.maxBatchBytes = Math.max(link.stats.maxBatchBytes, bytes);
        }
      },
      close() {
        link.closed = true;
      },
    };
    this.processorPort = {
      onmessage: null,
      postMessage(message) {
        link.toController.push(message);
      },
    };
  }
  transitBytes() {
    return this.toProcessor.reduce((total, entry) => total + entry.bytes, 0);
  }
  /** Delivers every queued message to the processor and returns them. */
  deliverToProcessor() {
    const entries = this.toProcessor.splice(0);
    for (const { message } of entries) this.processorPort.onmessage?.({ data: message });
    return entries.map((entry) => entry.message);
  }
  /** Delivers (or, with `drop`, loses) every message bound for the controller. */
  deliverToController(drop = false) {
    const messages = this.toController.splice(0);
    if (!drop) for (const message of messages) this.controllerPort.onmessage?.({ data: message });
    return messages;
  }
}

/** Starts the real controller through unlock() against a scripted device. */
async function audioHarness() {
  const Worklet = await processorClass();
  const audio = (await binaries()).audio;
  const harness = { link: null, processor: null, context: null, reports: [] };
  class Context {
    state = 'suspended';
    currentTime = 0;
    sampleRate = 48000;
    destination = {};
    onstatechange = null;
    audioWorklet = { addModule: async () => undefined };
    constructor() {
      harness.context = this;
    }
    /** Like a browser, state changes are announced asynchronously. */
    change(state) {
      if (this.state === state) return;
      this.state = state;
      queueMicrotask(() => this.onstatechange?.());
    }
    async resume() {
      this.change('running');
    }
    async suspend() {
      this.change('suspended');
    }
    async close() {
      this.change('closed');
    }
    createGain() {
      return { gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} };
    }
  }
  class Node {
    onprocessorerror = null;
    constructor() {
      const link = new ScriptedLink();
      harness.link = link;
      this.port = link.controllerPort;
      pendingProcessorPort = link.processorPort;
      harness.processor = new Worklet();
    }
    connect() {}
    disconnect() {}
  }
  const saved = {
    window: globalThis.window,
    fetch: globalThis.fetch,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    sampleRate: globalThis.sampleRate,
  };
  globalThis.window = { AudioContext: Context, AudioWorkletNode: Node };
  globalThis.AudioWorkletNode = Node;
  globalThis.sampleRate = 48000;
  globalThis.fetch = async () =>
    new Response(audio.slice(), { headers: { 'content-type': 'application/wasm' } });
  harness.restore = () => restoreGlobals(saved);
  harness.controller = new AudioController({ canvas: {} }, (error) => harness.reports.push(error));
  let done = false;
  let failure = null;
  harness.controller.unlock().then(
    () => (done = true),
    (error) => {
      done = true;
      failure = error;
    },
  );
  for (let turn = 0; turn < 2000 && !done; turn++) {
    await settle();
    harness.link?.deliverToProcessor();
    harness.link?.deliverToController();
  }
  if (!done || failure) {
    harness.restore();
    throw failure ?? new Error('B12: the scripted audio startup did not settle.');
  }
  /** One 128-frame render quantum of the real processor; returns the left channel. */
  harness.render = () => {
    const output = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    harness.processor.process([], [output]);
    return output[0];
  };
  return harness;
}

async function withHarness(body) {
  const harness = await audioHarness();
  try {
    return await body(harness);
  } finally {
    harness.restore();
  }
}

const tryPlay = (controller, sound, voice) => {
  try {
    return { instance: controller.play(sound, voice), code: 'OK' };
  } catch (error) {
    if (error?.code !== 'CAPACITY') throw error;
    return { instance: null, code: 'CAPACITY' };
  }
};

const noteEvents = (messages) =>
  messages
    .filter((message) => message?.type === 'batch')
    .flatMap((message) => message.events)
    .filter((event) => event.kind === 'note_on' || event.kind === 'sound').length;

/**
 * Times `call` after an untimed `prepare`, with the usual warm-up and
 * repetitions; returns aggregate statistics and the per-run samples.
 */
function sampleCalls(settings, prepare, call) {
  const phase = (duration, samples) => {
    const start = performance.now();
    do {
      prepare();
      const at = performance.now();
      call();
      const elapsed = performance.now() - at;
      if (samples && samples.length < MAX_SAMPLES) samples.push(elapsed);
    } while (performance.now() - start < duration);
  };
  phase(settings.warmupMs, null);
  const runs = [];
  for (let run = 0; run < settings.runs; run++) {
    const samples = [];
    phase(settings.sampleMs, samples);
    runs.push(samples);
  }
  return { stats: aggregate(runs.map((samples) => summarize(samples))), runs };
}

export async function runB12(settings) {
  const checks = [];
  const observations = {};
  const limit = AUDIO_LIMITS.pendingEvents;
  const credits = AUDIO_LIMITS.batchesInFlight;
  const smoke = settings.mode === 'smoke';

  // 1. ACKs never arrive: the processor consumes and acknowledges, every ACK is lost.
  await withHarness(async ({ controller, link, render }) => {
    const sound = controller.createSound({ frequency: 440, duration: 0.05 });
    const attempts = smoke ? 2000 : 10000;
    let admitted = 0;
    let rejected = 0;
    let early = 0;
    let maxPending = 0;
    let maxInFlight = 0;
    const newest = [null, null, null, null];
    for (let index = 0; index < attempts; index++) {
      const before = controller.pending.length;
      const result = tryPlay(controller, sound, index % 4);
      if (result.code === 'OK') {
        admitted++;
        newest[index % 4] = result.instance;
      } else {
        rejected++;
        if (before < limit) early++;
      }
      maxPending = Math.max(maxPending, controller.pending.length);
      maxInFlight = Math.max(maxInFlight, controller.inFlight.size);
      link.deliverToProcessor();
      link.deliverToController(true);
      if (index % 64 === 0) render();
    }
    // A stop per voice is always admitted, once, even into a full queue.
    for (const instance of newest) instance?.stop();
    for (const instance of newest) instance?.stop();
    maxPending = Math.max(maxPending, controller.pending.length);
    checks.push(
      check(
        'Lost ACKs: queued events ≤ 1,024 notes + one stop per voice',
        maxPending <= limit + 4,
        `max ${maxPending}`,
        `≤ ${limit + 4}`,
      ),
      check(
        'Lost ACKs: batches in flight ≤ 4',
        maxInFlight <= credits,
        `max ${maxInFlight}`,
        `≤ ${credits}`,
      ),
      check(
        'Lost ACKs: CAPACITY only once the queue is full',
        early === 0,
        `${early} early rejections`,
        '0',
      ),
    );
    observations['Lost ACKs'] =
      `${attempts} plays: ${admitted} admitted, ${rejected} rejected with CAPACITY, ${link.stats.batches} batches sent; the queue then held ${controller.pending.length} events (${messageBytes(controller.pending)} serialized bytes). Lost ACKs are never retransmitted, so the transport stays saturated: stop() cannot return a credit, because an unacknowledged batch may still be waiting in the port.`;
  });

  // 2. Missing consumption: the processor never reads its port.
  let stalled;
  await withHarness(async ({ controller, link }) => {
    for (let index = 0; index < 2000; index++) tryPlay(controller, { frequency: 330 }, index % 4);
    const afterPlays = { messages: link.toProcessor.length, bytes: link.transitBytes() };
    const cycles = smoke ? 20 : 200;
    for (let cycle = 0; cycle < cycles; cycle++) {
      controller.stop();
      for (let index = 0; index < 300; index++) tryPlay(controller, { frequency: 330 }, index % 4);
    }
    stalled = {
      afterPlays,
      cycles,
      afterCycles: { messages: link.toProcessor.length, bytes: link.transitBytes() },
      queued: controller.pending.length,
    };
    checks.push(
      check(
        'Stalled processor: plays alone leave ≤ 4 batches in the port',
        afterPlays.messages <= credits,
        `${afterPlays.messages} messages, ${afterPlays.bytes} bytes`,
        `≤ ${credits}`,
      ),
      check(
        'Stalled processor: port traffic stays bounded across stop()/play() cycles',
        stalled.afterCycles.messages <= credits + 1,
        `${stalled.afterCycles.messages} messages, ${stalled.afterCycles.bytes} bytes after ${cycles} cycles`,
        `≤ ${credits + 1} messages`,
      ),
    );
  });

  // 3. Saturation: the producer outruns a processor that consumes and
  // acknowledges once per render quantum.
  const quantumSamples = [];
  let saturation;
  await withHarness(async ({ controller, link, render }) => {
    const perQuantum = 300;
    const quanta = smoke ? 200 : 2000;
    let admitted = 0;
    let rejected = 0;
    let applied = 0;
    let maxPending = 0;
    const queue = [];
    for (let q = 0; q < quanta; q++) {
      for (let index = 0; index < perQuantum; index++)
        if (
          tryPlay(controller, { frequency: 200 + (index % 400), duration: 0.02 }, index % 4)
            .code === 'OK'
        )
          admitted++;
        else rejected++;
      maxPending = Math.max(maxPending, controller.pending.length);
      queue.push(controller.pending.length);
      const at = performance.now();
      link.deliverToProcessor();
      render();
      quantumSamples.push(performance.now() - at);
      for (const message of link.deliverToController())
        if (message.type === 'ack') applied += message.accepted;
    }
    const noteBatchBytes = link.stats.maxBatchBytes;
    // Music travels as one event of up to 4 tracks × 512 notes. Clear the
    // saturated queue first so the piece is posted at once.
    controller.stop();
    link.deliverToProcessor();
    link.deliverToController();
    const steps = Array.from({ length: 512 }, (_, index) => ({
      step: index * 8,
      pitch: 60 + (index % 12),
    }));
    const piece = controller.createMusic({
      bpm: 120,
      length: 4096,
      tracks: [0, 1, 2, 3].map((voice) => ({ voice, notes: steps })),
    });
    controller.playMusic(piece);
    const musicPosted = link.toProcessor.some((entry) =>
      entry.message?.events?.some((event) => event.kind === 'music'),
    );
    link.deliverToProcessor();
    link.deliverToController();
    if (!musicPosted) throw new Error('B12: the music event was not posted.');
    saturation = {
      quanta,
      perQuantum,
      admitted,
      rejected,
      applied,
      maxPending,
      noteBatchBytes,
      maxBatchBytes: link.stats.maxBatchBytes,
    };
    checks.push(
      check(
        'Saturated: queued events ≤ 1,024',
        maxPending <= limit,
        `max ${maxPending}`,
        `≤ ${limit}`,
      ),
      check(
        'Saturated: events per batch ≤ 64',
        link.stats.maxEvents <= AUDIO_LIMITS.eventsPerBatch,
        `max ${link.stats.maxEvents}`,
        `≤ ${AUDIO_LIMITS.eventsPerBatch}`,
      ),
    );
    observations['Saturated transport'] =
      `${quanta} quanta × ${perQuantum} plays: ${admitted} admitted, ${rejected} rejected with CAPACITY, ${applied} applied by the DSP (${(applied / quanta).toFixed(1)} per quantum, i.e. 4 batches × 64 events per round trip); median queue ${median(queue)}`;
    observations['Largest note batch (64 events, V8 structured-clone bytes)'] = noteBatchBytes;
    observations['Largest batch with a 4 × 512-note music event'] = link.stats.maxBatchBytes;
  });

  // 4. STOP with sounding voices, a full queue and batches in flight.
  let silence;
  await withHarness(async ({ controller, link, render }) => {
    const fill = () => {
      while (controller.pending.length < limit)
        controller.play({ frequency: 500, duration: 5 }, controller.pending.length % 4);
    };
    fill();
    link.deliverToProcessor();
    let sounding = false;
    for (let q = 0; q < 4; q++) sounding = render().some((value) => value !== 0);
    const staleAcks = link.deliverToController(true).filter((message) => message.type === 'ack');
    fill();
    const epoch = controller.epoch;
    controller.stop();
    const stopMessage = link.toProcessor.at(-1)?.message;
    const inFlight = controller.inFlight.size;
    const cleared = controller.pending.length === 0;
    link.deliverToProcessor();
    let lastSound = -1;
    for (let q = 0; q < 8; q++) {
      const output = render();
      for (let index = 0; index < QUANTUM; index++)
        if (output[index] !== 0) lastSound = q * QUANTUM + index;
    }
    for (const ack of staleAcks) controller.receive(ack);
    for (const ack of link.deliverToController(true)) controller.receive(ack);
    const credited = controller.inFlight.size === 0;
    tryPlay(controller, { frequency: 440 }, 0);
    const resumed = link.toProcessor.at(-1)?.message?.epoch === epoch + 1;
    silence = lastSound + 1;
    checks.push(
      check(
        'Voices were sounding when STOP was sent',
        sounding,
        sounding ? 'sounding' : 'silent',
        'sounding',
      ),
      check(
        'STOP empties the queue; sent batches keep their credits until acknowledged',
        cleared && inFlight > 0,
        `pending ${controller.pending.length}, in flight ${inFlight}`,
        'pending 0, in flight > 0',
      ),
      check(
        'STOP is posted with the next epoch',
        stopMessage?.type === 'stop' && stopMessage.epoch === epoch + 1,
        JSON.stringify(stopMessage),
        JSON.stringify({ type: 'stop', epoch: epoch + 1 }),
      ),
      check(
        'ACKs of batches sent before STOP return their credits',
        credited,
        credited ? 'returned' : 'still in flight',
        'returned',
      ),
      check(
        'A note after STOP is sent at once in the new epoch',
        resumed,
        resumed ? 'sent' : 'not sent',
        'sent',
      ),
    );
  });

  // 5. Suspension requested by the page (pause) and by the device.
  await withHarness(async ({ controller, link, context }) => {
    for (let index = 0; index < 40; index++) tryPlay(controller, { frequency: 300 }, index % 4);
    const sentBefore = link.deliverToProcessor();
    controller.onPause('hidden');
    await settle();
    let dropped = 0;
    for (let index = 0; index < 100; index++) {
      const before = controller.pending.length;
      controller.play({ frequency: 300 }, index % 4);
      if (controller.pending.length === before) dropped++;
    }
    link.deliverToController();
    const sentWhilePaused = link.deliverToProcessor();
    link.deliverToController();
    controller.onResume('hidden');
    await settle();
    const replayed =
      noteEvents(link.deliverToProcessor()) +
      controller.pending.filter((event) => event.kind === 'note_on' || event.kind === 'sound')
        .length;
    context.change('suspended');
    await settle();
    const deviceState = controller.capabilities.state;
    const before = controller.pending.length;
    for (let index = 0; index < 100; index++) controller.play({ frequency: 300 }, index % 4);
    const queuedWhileSuspended = controller.pending.length - before;
    context.change('running');
    await settle();
    checks.push(
      check(
        'Pause: notes played while paused are dropped',
        dropped === 100,
        `${dropped} of 100 dropped`,
        '100 of 100',
      ),
      check(
        'Pause: no note is sent after the pause takes effect',
        noteEvents(sentWhilePaused) === 0,
        `${noteEvents(sentWhilePaused)} note events sent`,
        '0',
      ),
      check(
        'Resume: nothing queued before the pause is replayed',
        replayed === 0,
        `${replayed} replayed`,
        '0',
      ),
      check(
        'Device suspension is reported and drops new notes',
        deviceState === 'suspended' && queuedWhileSuspended === 0,
        `${deviceState}, ${queuedWhileSuspended} queued`,
        'suspended, 0 queued',
      ),
      check(
        'Device resumption restores running',
        controller.capabilities.state === 'running',
        controller.capabilities.state,
        'running',
      ),
    );
    observations['Pause'] =
      `${noteEvents(sentBefore)} note events had been sent before the pause; queued notes became note_off events`;
  });

  // 6. Processor failure: the DSP traps inside process().
  await withHarness(async (harness) => {
    const { controller, link, processor, context, render } = harness;
    tryPlay(controller, { frequency: 440 }, 0);
    link.deliverToProcessor();
    processor.dsp = {
      ...processor.dsp,
      pxa_render() {
        throw new WebAssembly.RuntimeError('unreachable');
      },
    };
    const output = render();
    render();
    const errors = link.toController.filter((message) => message.type === 'error').length;
    link.deliverToController();
    const state = controller.capabilities.state;
    const released = context.state === 'closed' && link.closed;
    const before = controller.pending.length;
    for (let index = 0; index < 100; index++) controller.play({ frequency: 440 }, index % 4);
    let unlock = 'resolved';
    try {
      await controller.unlock();
    } catch (error) {
      unlock = error.code;
    }
    const silent = output.every((value) => value === 0);
    checks.push(
      check(
        'Failure: the processor reports once and outputs silence',
        errors === 1 && silent,
        `${errors} error message(s), silent ${silent}`,
        '1, silent',
      ),
      check(
        'Failure: the controller fails once and releases the device',
        state === 'failed' && harness.reports.length === 1 && released,
        `${state}, ${harness.reports.length} report(s), device released ${released}`,
        'failed, 1 report, released',
      ),
      check(
        'Failure: later notes queue nothing and unlock() rejects',
        controller.pending.length === before && unlock === 'STATE',
        `queue +${controller.pending.length - before}, unlock ${unlock}`,
        'queue +0, unlock STATE',
      ),
    );
  });

  // Timing of the public calls, without byte accounting.
  const timing = await withHarness(async ({ controller, link }) => {
    link.countBytes = false;
    const sound = controller.createSound({ frequency: 440, duration: 0.05 });
    let voice = 0;
    const admitted = sampleCalls(
      settings,
      () => {
        link.deliverToProcessor();
        link.deliverToController();
      },
      () => controller.play(sound, voice++ & 3),
    );
    const fill = () => {
      while (controller.pending.length < limit) controller.play(sound, voice++ & 3);
    };
    fill();
    const rejected = sampleCalls(
      settings,
      () => {},
      () => tryPlay(controller, sound, voice++ & 3),
    );
    const stop = sampleCalls(
      settings,
      () => {
        link.deliverToProcessor();
        link.deliverToController();
        fill();
      },
      () => controller.stop(),
    );
    return { admitted, rejected, stop };
  });
  const quantumMs = (QUANTUM / 48000) * 1000;
  return finishResult({
    id: 'B12',
    title: 'Audio transport: missing ACK/consumption, saturation, STOP, suspend and failure',
    runtime: `${NODE_RUNTIME}; real AudioController and processor.js with a scripted MessagePort and AudioContext`,
    measures: [
      'The real AudioController (packages/core/dist) and the real AudioWorklet processor module running the real audio.wasm, joined by a scripted, ordered port that the benchmark pumps. Startup goes through unlock(), the DSP download and the init/ready handshake.',
      'Queue, credit and port bounds when ACKs are lost, when the processor consumes nothing (including repeated stop()/play() cycles), and when the producer outruns a processor that acknowledges once per 128-frame quantum; batch sizes as V8 structured-clone bytes (what postMessage copies in Chromium).',
      'STOP with sounding voices, a full queue and batches in flight: epoch handling, stale ACKs and frames until the real DSP is silent.',
      'Suspension requested by the page and by the device, and a DSP that traps inside process().',
      'The synchronous cost of play() (admitted and rejected) and of stop() with 1,024 queued events.',
    ],
    excludes: [
      'Real MessagePort and audio-thread latency, device underruns and audible output: see B12 in `npm run bench:browser` (Chromium, real AudioWorklet).',
      'Batch size is bounded by the note limits, not by bytes: 64 events per batch, or one music piece of at most 4 × 512 notes.',
    ],
    rows: [
      row({
        scenario: 'play() admitted',
        metric: 'ms per call',
        stats: timing.admitted.stats,
        target: { op: '<=', limit: 0.05, text: 'p95 ≤ 0.05 ms' },
      }),
      row({
        scenario: 'play() rejected (CAPACITY)',
        metric: 'ms per call',
        stats: timing.rejected.stats,
        target: { op: '<=', limit: 0.05, text: 'p95 ≤ 0.05 ms' },
      }),
      row({
        scenario: 'stop() with 1,024 queued events',
        metric: 'ms per call',
        stats: timing.stop.stats,
        target: { op: '<=', limit: 1, text: 'p95 ≤ 1 ms' },
      }),
      row({
        scenario: 'Saturated quantum (deliver 4 batches + render)',
        metric: 'ms per 128 frames',
        stats: aggregate([summarize(quantumSamples)]),
        target: {
          op: '<=',
          limit: quantumMs / 10,
          statistic: 'p99',
          text: 'p99 ≤ 0.267 ms (10% of the quantum)',
        },
      }),
      row({
        scenario: 'Frames until silence once STOP is delivered',
        metric: 'frames',
        unit: 'count',
        stats: { value: silence },
        target: { op: '<=', limit: 64, text: '≤ 64 frames' },
      }),
      row({
        scenario: 'Largest serialized batch',
        metric: 'bytes',
        unit: 'bytes',
        stats: { value: saturation.maxBatchBytes },
        target: {
          op: '<=',
          limit: 128 * 1024,
          text: '≤ 128 KiB (one 4 × 512-note piece, the largest message the limits allow)',
        },
      }),
    ],
    checks,
    observations: {
      ...observations,
      'Stalled processor with stop()/play() cycles': `batches keep their credits until acknowledged and a stop waits until the processor confirms the previous one, so ${stalled.cycles} cycles left ${stalled.afterCycles.messages} messages (${stalled.afterCycles.bytes} bytes) waiting in the port`,
    },
    raw: {
      sampleUnit: 'ms per call',
      admitted: timing.admitted.runs.map(compact),
      rejected: timing.rejected.runs.map(compact),
      stop: timing.stop.runs.map(compact),
      quantumSamples: compact(quantumSamples),
      saturation,
      stalled,
    },
  });
}

export const NODE_BENCHMARKS = Object.freeze({
  B01: runB01Core,
  B02: runB02,
  B03: runB03,
  B04: runB04,
  B05: runB05,
  B07: runB07,
  B12: runB12,
});

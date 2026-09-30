import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32, inflateSync } from 'node:zlib';
import { PixelJSError } from '../packages/core/dist/api/errors.js';
import { crc32, encodePng } from '../packages/core/dist/internal/capture/png.js';
import { encodeGif } from '../packages/core/dist/internal/capture/gif.js';
import {
  FrameRecorder,
  RECORDING_LIMITS,
} from '../packages/core/dist/internal/capture/recorder.js';
import { FrameCapture } from '../packages/core/dist/internal/capture/service.js';
import { decodeGif } from './support/gif-decoder.mjs';

/** Deterministic xorshift generator, so failures reproduce. */
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/** 256 RGBA entries; entry i is distinct for every i. */
function palette(shift = 0) {
  const bytes = new Uint8Array(1024);
  for (let index = 0; index < 256; index++)
    bytes.set(
      [(index * 37 + shift) & 255, (index * 91 + 7) & 255, (index * 13 + 101) & 255, 255],
      index * 4,
    );
  return bytes;
}

function concat(parts) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** Independent PNG reader for the subset the encoder writes: 8-bit indexed, no interlace. */
function decodePng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    assert.equal(
      view.getUint32(at + 8 + length),
      zlibCrc32(bytes.subarray(at + 4, at + 8 + length)),
      `${type} CRC`,
    );
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['IHDR', 'PLTE', 'IDAT', 'IEND'],
  );
  const header = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  assert.deepEqual([...chunks[0].data.subarray(8)], [8, 3, 0, 0, 0], 'bit depth 8, indexed color');
  const raw = inflateSync(chunks[2].data);
  assert.equal(raw.length, height * (width + 1));
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width + 1)], 0, 'filter type 0');
    pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, palette: chunks[1].data, pixels };
}

function scaled(pixels, width, height, scale) {
  const out = new Uint8Array(width * scale * height * scale);
  for (let y = 0; y < height * scale; y++)
    for (let x = 0; x < width * scale; x++)
      out[y * width * scale + x] = pixels[Math.floor(y / scale) * width + Math.floor(x / scale)];
  return out;
}

function rgbOf(indices, colors) {
  const out = new Uint8Array(indices.length * 3);
  indices.forEach((index, at) => out.set(colors.subarray(index * 4, index * 4 + 3), at * 3));
  return out;
}

test('crc32 matches zlib and continues across parts', () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, index) => (index * 7) & 255);
  assert.equal(crc32(bytes), zlibCrc32(bytes));
  assert.equal(crc32(bytes.subarray(600), crc32(bytes.subarray(0, 600))), zlibCrc32(bytes));
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('PNG capture writes the exact indices, palette and integer scale', async () => {
  const next = random(7);
  const colors = palette();
  for (const [width, height, count] of [
    [5, 3, 16],
    [17, 9, 256],
    [1, 1, 1],
    [300, 2, 3],
  ]) {
    const pixels = Uint8Array.from({ length: width * height }, () => Math.floor(next() * count));
    for (const stored of [false, true])
      for (const scale of [1, 2, 3]) {
        const parts = await encodePng(
          { width, height, pixels, palette: colors, colors: count },
          scale,
          { stored },
        );
        const png = decodePng(concat(parts));
        assert.equal(png.width, width * scale);
        assert.equal(png.height, height * scale);
        assert.deepEqual(
          png.palette,
          rgbOf(
            Uint8Array.from({ length: count }, (_, index) => index),
            colors,
          ),
        );
        assert.deepEqual(
          png.pixels,
          scaled(pixels, width, height, scale),
          `${width}x${height} x${scale} stored=${stored}`,
        );
      }
  }
});

test('PNG stored blocks split exactly at the 65,535-byte deflate limit', async () => {
  // 256 + 1 filter byte per row, 255 rows = 65,535 bytes: one full block and an empty final block.
  for (const height of [255, 256]) {
    const pixels = Uint8Array.from({ length: 256 * height }, (_, index) => index % 251);
    const parts = await encodePng(
      { width: 256, height, pixels, palette: palette(), colors: 256 },
      1,
      { stored: true },
    );
    assert.deepEqual(decodePng(concat(parts)).pixels, pixels);
  }
});

test('PNG encoding yields to the event loop and stops with STATE when aborted', async () => {
  const pixels = new Uint8Array(64 * 64).fill(3);
  let yields = 0;
  const image = { width: 64, height: 64, pixels, palette: palette(), colors: 16 };
  await encodePng(image, 2, { sliceMs: 0, yieldTask: async () => void yields++ });
  assert.ok(yields >= 64, `yielded ${yields} times`);
  const controller = new AbortController();
  await assert.rejects(
    encodePng(image, 2, {
      sliceMs: 0,
      signal: controller.signal,
      yieldTask: async () => controller.abort(),
    }),
    (error) => error instanceof PixelJSError && error.code === 'STATE',
  );
});

function frame(width, height, fill, changes = []) {
  const pixels = new Uint8Array(width * height).fill(fill);
  for (const [x, y, value] of changes) pixels[y * width + x] = value;
  return pixels;
}

test('GIF frames round-trip through an independent decoder with deltas, merges and palettes', async () => {
  const width = 8;
  const height = 6;
  const base = palette();
  const other = palette(90);
  const f0 = frame(width, height, 1, [[0, 0, 2]]);
  const f1 = frame(width, height, 1, [
    [0, 0, 2],
    [5, 3, 7],
    [6, 4, 9],
  ]);
  const f3 = frame(width, height, 4);
  const f4 = frame(width, height, 4, [[7, 5, 15]]);
  const input = [
    { pixels: f0, palette: base, delay: 3 },
    { pixels: f1, palette: base, delay: 4 },
    { pixels: f1.slice(), palette: base.slice(), delay: 5 }, // identical: merged into the previous
    { pixels: f3, palette: other, delay: 6 }, // palette change: full frame, local table
    { pixels: f4, palette: other, delay: 7 }, // delta with the local table
    { pixels: f4, palette: base, delay: 8 }, // back to the global colors
  ];
  for (const scale of [1, 2]) {
    const parts = await encodeGif(input, { width, height, colors: 16, scale, maxBytes: 1 << 20 });
    const gif = decodeGif(concat(parts));
    assert.equal(gif.width, width * scale);
    assert.equal(gif.height, height * scale);
    assert.equal(gif.loop, 0, 'NETSCAPE2.0 loops forever');
    assert.equal(gif.globalColors, 16);
    assert.deepEqual(
      gif.frames.map((item) => item.delay),
      [3, 9, 6, 7, 8],
    );
    assert.deepEqual(
      gif.frames.map((item) => item.localColors),
      [0, 0, 16, 16, 0],
    );
    assert.deepEqual(
      gif.frames.map((item) => [item.x, item.y, item.width, item.height]),
      [
        [0, 0, 8 * scale, 6 * scale],
        [5 * scale, 3 * scale, 2 * scale, 2 * scale],
        [0, 0, 8 * scale, 6 * scale],
        [7 * scale, 5 * scale, scale, scale],
        [0, 0, 8 * scale, 6 * scale],
      ],
    );
    assert.ok(gif.frames.every((item) => item.disposal === 1));
    const expected = [
      [f0, base],
      [f1, base],
      [f3, other],
      [f4, other],
      [f4, base],
    ];
    gif.frames.forEach((item, index) => {
      const [pixels, colors] = expected[index];
      assert.deepEqual(
        item.rgb,
        rgbOf(scaled(pixels, width, height, scale), colors),
        `frame ${index}`,
      );
    });
  }
});

test('LZW output stays exact past 4,096 codes, with clear codes and 12-bit codes', async () => {
  const next = random(99);
  const width = 160;
  const height = 120;
  const noise = Uint8Array.from({ length: width * height }, () => Math.floor(next() * 256));
  const gif = decodeGif(
    concat(
      await encodeGif([{ pixels: noise, palette: palette(), delay: 2 }], {
        width,
        height,
        colors: 256,
        scale: 1,
        maxBytes: 1 << 22,
      }),
    ),
  );
  assert.equal(gif.frames[0].minCodeSize, 8);
  assert.equal(gif.frames[0].largestCodeSize, 12);
  assert.ok(gif.frames[0].clears >= 3, `${gif.frames[0].clears} clear codes`);
  assert.deepEqual(gif.frames[0].rgb, rgbOf(noise, palette()));
  // Small palettes use the minimum code size of 2; long runs build long strings.
  for (const colors of [1, 2, 3, 5, 17, 129]) {
    const pixels = Uint8Array.from({ length: 97 * 61 }, (_, index) =>
      Math.floor(index / 300) % 2 ? Math.floor(next() * colors) : index % colors,
    );
    const decoded = decodeGif(
      concat(
        await encodeGif([{ pixels, palette: palette(), delay: 2 }], {
          width: 97,
          height: 61,
          colors,
          scale: 3,
          maxBytes: 1 << 22,
        }),
      ),
    );
    let tableBits = 1;
    while (1 << tableBits < colors) tableBits++;
    assert.equal(decoded.globalColors, 1 << tableBits);
    assert.equal(decoded.frames[0].minCodeSize, Math.max(2, tableBits));
    assert.deepEqual(
      decoded.frames[0].rgb,
      rgbOf(scaled(pixels, 97, 61, 3), palette()),
      `${colors} colors`,
    );
  }
});

test('GIF encoding enforces its byte limit and stops with STATE when aborted', async () => {
  const next = random(5);
  const pixels = Uint8Array.from({ length: 64 * 64 }, () => Math.floor(next() * 256));
  const frames = [{ pixels, palette: palette(), delay: 2 }];
  await assert.rejects(
    encodeGif(frames, { width: 64, height: 64, colors: 256, scale: 2, maxBytes: 4096 }),
    (error) => error instanceof PixelJSError && error.code === 'CAPACITY',
  );
  let yields = 0;
  await encodeGif(frames, {
    width: 64,
    height: 64,
    colors: 256,
    scale: 2,
    maxBytes: 1 << 22,
    sliceMs: 0,
    yieldTask: async () => void yields++,
  });
  assert.ok(yields >= 128, `yielded ${yields} times`);
  const controller = new AbortController();
  await assert.rejects(
    encodeGif(frames, {
      width: 64,
      height: 64,
      colors: 256,
      scale: 2,
      maxBytes: 1 << 22,
      sliceMs: 0,
      signal: controller.signal,
      yieldTask: async () => controller.abort(),
    }),
    (error) => error instanceof PixelJSError && error.code === 'STATE',
  );
});

/** A stand-in for the engine's frame: tests change pixels, size and palette directly. */
function fakeSource(width, height) {
  const source = {
    paletteCount: 16,
    frameWidth: width,
    frameHeight: height,
    pixels: new Uint8Array(width * height),
    colors: palette(),
    revision: 1,
    copies: 0,
    paletteCopies: 0,
    width: () => source.frameWidth,
    height: () => source.frameHeight,
    paletteRevision: () => source.revision,
    copyFrame(target) {
      source.copies++;
      const copy =
        target && target.length === source.pixels.length
          ? target
          : new Uint8Array(source.pixels.length);
      copy.set(source.pixels);
      return copy;
    },
    copyPalette() {
      source.paletteCopies++;
      return source.colors.slice();
    },
  };
  return source;
}

test('the recorder skips frames closer than 20 ms and keeps only the last maxSeconds', () => {
  const source = fakeSource(4, 4);
  const recorder = new FrameRecorder(1000, 1);
  recorder.add(0, source);
  recorder.add(RECORDING_LIMITS.minFrameMs - 1, source);
  assert.equal(recorder.size.frames, 1);
  recorder.add(RECORDING_LIMITS.minFrameMs, source);
  assert.equal(recorder.size.frames, 2);
  for (let time = 40; time <= 3000; time += 25) recorder.add(time, source);
  const { frames } = recorder.take(3010);
  // Frames from 1990 to 2990 ms remain: at most 1000 ms before the newest one.
  assert.equal(frames.length, 41);
  assert.ok(frames.every((item) => item.delay >= 2));
  assert.equal(
    frames.slice(0, -1).reduce((sum, item) => sum + item.delay, 0),
    100,
  );
  assert.equal(frames.at(-1).delay, 2);
  assert.equal(
    source.paletteCopies,
    1,
    'the palette is copied once while its revision is unchanged',
  );
});

test('a pause or stall counts at most 250 ms of recording time', () => {
  const source = fakeSource(2, 2);
  const recorder = new FrameRecorder(1000, 1);
  for (const time of [0, 30, 60, 5060, 5090, 5120]) recorder.add(time, source);
  // Without the cap, the 5 s pause would have evicted the first three frames.
  const { frames } = recorder.take(9000);
  assert.deepEqual(
    frames.map((item) => item.delay),
    [3, 3, 25, 3, 3, 25],
  );
  assert.equal(RECORDING_LIMITS.maxGapMs, 250);
});

test('the recorder never holds more than 64 MiB and reuses evicted buffers', () => {
  const source = fakeSource(1024, 1024);
  const recorder = new FrameRecorder(60_000, 1);
  let allocations = 0;
  const copy = source.copyFrame;
  source.copyFrame = (target) => {
    if (!target) allocations++;
    return copy(target);
  };
  for (let index = 0; index < 100; index++) {
    source.pixels[0] = index;
    recorder.add(index * 25, source);
    assert.ok(recorder.size.bytes <= RECORDING_LIMITS.bytes);
  }
  assert.equal(recorder.size.frames, 63);
  assert.equal(allocations, 63, 'evicted frames are reused instead of allocating');
  const { frames } = recorder.take(2500);
  assert.equal(frames[0].pixels[0], 37);
  assert.equal(frames.at(-1).pixels[0], 99);
});

test('the recorder copies the palette when its revision changes and restarts after a resize', () => {
  const source = fakeSource(4, 4);
  const recorder = new FrameRecorder(10_000, 1);
  recorder.add(0, source);
  source.revision++;
  source.colors = palette(50);
  recorder.add(30, source);
  recorder.add(60, source);
  assert.equal(source.paletteCopies, 2);
  const taken = recorder.take(90);
  assert.equal(taken.frames[0].palette[0], palette()[0]);
  assert.equal(taken.frames[2].palette, taken.frames[1].palette);
  source.frameWidth = 8;
  source.pixels = new Uint8Array(32);
  recorder.add(0, fakeSource(4, 4));
  recorder.add(30, source);
  const resized = recorder.take(60);
  assert.equal(resized.frames.length, 1);
  assert.equal(resized.width, 8);
});

const code = (expected) => (error) => error instanceof PixelJSError && error.code === expected;

test('capture copies the presented frame at call time and enforces its states', async () => {
  const source = fakeSource(6, 4);
  const capture = new FrameCapture(source);
  await assert.rejects(capture.capture(), code('STATE'));
  // Presenting frames without recording copies nothing.
  for (let time = 0; time < 1000; time += 16) capture.framePresented(time);
  assert.deepEqual([source.copies, source.paletteCopies], [0, 0]);
  source.pixels.set([1, 2, 3, 4, 5, 6]);
  capture.framePresented(0);
  await assert.rejects(capture.capture({ scale: 9 }), code('RANGE'));
  await assert.rejects(capture.capture({ scale: 1.5 }), code('RANGE'));
  await assert.rejects(capture.capture(null), code('ARGUMENT'));
  const pending = capture.capture({ scale: 2 });
  await assert.rejects(capture.capture(), code('STATE'));
  // Later frames and palettes never reach a pending capture.
  source.pixels.fill(9);
  source.colors = palette(1);
  const png = decodePng(new Uint8Array(await (await pending).arrayBuffer()));
  const expected = new Uint8Array(24);
  expected.set([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(png.pixels, scaled(expected, 6, 4, 2));
  assert.deepEqual(png.palette.subarray(0, 3), palette().subarray(0, 3));
  // setPalette between frames: the capture keeps the presented colors.
  capture.framePresented(20);
  const presented = source.colors;
  capture.paletteChanging();
  source.colors = palette(2);
  assert.deepEqual(
    decodePng(new Uint8Array(await (await capture.capture()).arrayBuffer())).palette.subarray(0, 3),
    presented.subarray(0, 3),
  );
  capture.frameReplaced();
  await assert.rejects(capture.capture(), code('STATE'));
  capture.framePresented(40);
  const disposed = capture.capture();
  capture.dispose();
  await assert.rejects(disposed, code('STATE'));
});

test('recording states, options and disposal', async () => {
  const source = fakeSource(8, 8);
  const capture = new FrameCapture(source);
  await assert.rejects(capture.stopRecording(), code('STATE'));
  assert.throws(() => capture.startRecording({ maxSeconds: 0.5 }), code('RANGE'));
  assert.throws(() => capture.startRecording({ maxSeconds: 61 }), code('RANGE'));
  assert.throws(() => capture.startRecording({ scale: 5 }), code('RANGE'));
  assert.throws(() => capture.startRecording('fast'), code('ARGUMENT'));
  assert.equal(capture.recording, false);
  capture.startRecording();
  assert.equal(capture.recording, true);
  assert.throws(() => capture.startRecording(), code('STATE'));
  await assert.rejects(capture.stopRecording(), code('STATE'), 'no frame was presented');
  assert.equal(capture.recording, false);
  capture.startRecording({ maxSeconds: 2, scale: 2 });
  for (let index = 0; index < 5; index++) {
    source.pixels.fill(index);
    capture.framePresented(1000 + index * 40);
  }
  const encoding = capture.stopRecording();
  assert.equal(capture.recording, false);
  assert.throws(
    () => capture.startRecording(),
    code('STATE'),
    'the previous recording is encoding',
  );
  const blob = await encoding;
  assert.equal(blob.type, 'image/gif');
  const gif = decodeGif(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(gif.width, 16);
  assert.equal(gif.frames.length, 5);
  assert.deepEqual(
    gif.frames.slice(0, 4).map((item) => item.delay),
    [4, 4, 4, 4],
  );
  gif.frames.forEach((item, index) =>
    assert.deepEqual(item.rgb, rgbOf(new Uint8Array(256).fill(index), palette())),
  );
  capture.startRecording();
  capture.framePresented(5000);
  const disposed = capture.stopRecording();
  capture.dispose();
  await assert.rejects(disposed, code('STATE'));
  assert.equal(capture.recording, false);
});

test('a frame copy failure is reported by stopRecording with its own code', async () => {
  for (const [thrown, expected] of [
    [new PixelJSError('STATE', 'destroyed'), 'STATE'],
    [new RangeError('Array buffer allocation failed'), 'CAPACITY'],
  ]) {
    const source = fakeSource(4, 4);
    const capture = new FrameCapture(source);
    capture.startRecording();
    capture.framePresented(0);
    source.copyFrame = () => {
      throw thrown;
    };
    // The game keeps running: the failure surfaces only when recording stops.
    capture.framePresented(40);
    capture.framePresented(80);
    await assert.rejects(capture.stopRecording(), code(expected));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import factory from '../packages/core/dist/internal/wasm/engine.mjs';
import { PROTOCOL, OPCODE, STATUS } from '../packages/core/dist/internal/protocol.js';

// The shipped engine.wasm against references written from the documented
// rules, independently of the C implementation.
const wasmBinary = await readFile('packages/core/dist/internal/wasm/engine.wasm');
const WIDTH = 32;
const HEIGHT = 24;

async function instance(t, width = WIDTH, height = HEIGHT) {
  const mod = await factory({ wasmBinary, printErr() {} });
  assert.equal(mod._pxw_initialize(width, height, 16), STATUS.OK);
  t.after(() => mod._pxw_destroy());
  return mod;
}

function submit(mod, records) {
  const bytes = new Uint8Array(32 + 32 * records.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x534a5850, true);
  view.setUint32(4, PROTOCOL.protocolVersion, true);
  view.setUint32(8, records.length, true);
  view.setUint32(12, bytes.length, true);
  records.forEach(([op, flags, handle, ...args], index) => {
    const at = 32 + index * 32;
    view.setUint16(at, op, true);
    view.setUint16(at + 2, flags, true);
    view.setUint32(at + 4, handle, true);
    args.forEach((value, arg) => view.setInt32(at + 8 + arg * 4, value, true));
  });
  mod.HEAPU8.set(bytes, mod._pxw_mailbox_offset());
  return mod._pxw_submit(bytes.length);
}

const frame = (mod) =>
  mod.HEAPU8.slice(mod._pxw_frame_offset(), mod._pxw_frame_offset() + WIDTH * HEIGHT);

function random(seed) {
  let state = seed >>> 0;
  return (low, high) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return low + (state % (high - low + 1));
  };
}

/** Half of the cases draw with the whole screen as clip. */
function randomClip(next) {
  if (next(0, 1) === 0) return [0, 0, WIDTH, HEIGHT];
  return [next(-3, WIDTH - 1), next(-3, HEIGHT - 1), next(0, WIDTH + 3), next(0, HEIGHT + 3)];
}

function clipBox(x, y, width, height) {
  return [Math.max(0, x), Math.max(0, y), Math.min(WIDTH, x + width), Math.min(HEIGHT, y + height)];
}

const plot = (pixels, [left, top, right, bottom], x, y, color) => {
  if (x >= left && x < right && y >= top && y < bottom) pixels[y * WIDTH + x] = color;
};

function walk(pixels, clip, x0, y0, x1, y1, color) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  let error = dx + dy;
  for (;;) {
    plot(pixels, clip, x0, y0, color);
    if (x0 === x1 && y0 === y1) return;
    const doubled = 2 * error;
    if (doubled >= dy) [error, x0] = [error + dy, x0 + (x0 < x1 ? 1 : -1)];
    if (doubled <= dx) [error, y0] = [error + dx, y0 + (y0 < y1 ? 1 : -1)];
  }
}

const drawn = (pixels) => pixels.reduce((count, value) => count + (value !== 0 ? 1 : 0), 0);

test('ellipses in WASM match the pixel-center rule and its boundary', async (t) => {
  const mod = await instance(t);
  let total = 0;
  const next = random(0x1234abcd);
  const inside = (i, j, w, h) => {
    if (i < 0 || j < 0 || i >= w || j >= h) return false;
    const dx = 2 * i + 1 - w;
    const dy = 2 * j + 1 - h;
    return dx * dx * h * h + dy * dy * w * w <= w * w * h * h;
  };
  for (let iteration = 0; iteration < 3000; iteration++) {
    const filled = iteration % 2 === 1;
    const [x, y, w, h] = [next(-20, 28), next(-16, 20), next(0, 40), next(0, 40)];
    const clip = randomClip(next);
    assert.equal(
      submit(mod, [
        [OPCODE.CLEAR, 0, 0, 0],
        [OPCODE.SET_CLIP, 0, 0, ...clip],
        [filled ? OPCODE.ELLIPSE_FILL : OPCODE.ELLIPSE, 0, 0, x, y, w, h, 5],
      ]),
      STATUS.OK,
    );
    const expected = new Uint8Array(WIDTH * HEIGHT);
    const box = clipBox(...clip);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        if (!inside(i, j, w, h)) continue;
        const edge =
          !inside(i - 1, j, w, h) ||
          !inside(i + 1, j, w, h) ||
          !inside(i, j - 1, w, h) ||
          !inside(i, j + 1, w, h);
        if (filled || edge) plot(expected, box, x + i, y + j, 5);
      }
    assert.deepEqual(frame(mod), expected, JSON.stringify({ x, y, w, h, clip, filled }));
    total += drawn(expected);
  }
  assert.ok(total > 50_000, `only ${total} ellipse pixels were compared`);
});

test('triangles in WASM cover pixel centers exactly, even with full-range vertices', async (t) => {
  const mod = await instance(t);
  let total = 0;
  let covered = 0;
  const next = random(0x9abcdef1);
  // BigInt edge functions: no reference arithmetic can overflow.
  const covers = (xs, ys, px, py) => {
    const X = xs.map(BigInt);
    const Y = ys.map(BigInt);
    const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (Y[1] - Y[0]) * (X[2] - X[0]);
    if (area === 0n) return false;
    for (let edge = 0; edge < 3; edge++) {
      const n = (edge + 1) % 3;
      const value =
        (X[n] - X[edge]) * (2n * BigInt(py) + 1n - 2n * Y[edge]) -
        (Y[n] - Y[edge]) * (2n * BigInt(px) + 1n - 2n * X[edge]);
      if ((area > 0n && value < 0n) || (area < 0n && value > 0n)) return false;
    }
    return true;
  };
  for (let iteration = 0; iteration < 3000; iteration++) {
    const filled = iteration % 2 === 1;
    const vertices = Array.from({ length: 6 }, (_, index) =>
      index % 2 === 0 ? next(-20, WIDTH + 20) : next(-16, HEIGHT + 16),
    );
    const clip = randomClip(next);
    assert.equal(
      submit(mod, [
        [OPCODE.CLEAR, 0, 0, 0],
        [OPCODE.SET_CLIP, 0, 0, ...clip],
        [filled ? OPCODE.TRIANGLE_FILL : OPCODE.TRIANGLE, 0, 0, ...vertices],
        [OPCODE.PARAMS, 0, 0, 9],
      ]),
      STATUS.OK,
    );
    const expected = new Uint8Array(WIDTH * HEIGHT);
    const box = clipBox(...clip);
    const xs = [vertices[0], vertices[2], vertices[4]];
    const ys = [vertices[1], vertices[3], vertices[5]];
    if (filled)
      for (let py = box[1]; py < box[3]; py++)
        for (let px = box[0]; px < box[2]; px++)
          if (covers(xs, ys, px, py)) expected[py * WIDTH + px] = 9;
    for (let edge = 0; edge < 3; edge++)
      walk(expected, box, xs[edge], ys[edge], xs[(edge + 1) % 3], ys[(edge + 1) % 3], 9);
    assert.deepEqual(frame(mod), expected, JSON.stringify({ vertices, clip, filled }));
    total += drawn(expected);
  }
  assert.ok(total > 50_000, `only ${total} triangle pixels were compared`);
  const full = () => next(0, 0xffffffff) | 0;
  for (let iteration = 0; iteration < 1000; iteration++) {
    const vertices = Array.from({ length: 6 }, full);
    const camera = [full(), full()];
    const result = submit(mod, [
      [OPCODE.CLEAR, 0, 0, 0],
      [OPCODE.SET_CAMERA, 0, 0, ...camera],
      [OPCODE.TRIANGLE_FILL, 0, 0, ...vertices],
      [OPCODE.PARAMS, 0, 0, 4],
    ]);
    assert.equal(result, STATUS.OK);
    const pixels = frame(mod);
    const xs = [0, 2, 4].map((index) => vertices[index] - camera[0]);
    const ys = [1, 3, 5].map((index) => vertices[index] - camera[1]);
    for (let py = 0; py < HEIGHT; py++)
      for (let px = 0; px < WIDTH; px++)
        if (covers(xs, ys, px, py)) {
          assert.equal(pixels[py * WIDTH + px], 4);
          covered += 1;
        }
  }
  assert.ok(covered > 1_000, `only ${covered} full-range interior pixels were compared`);
});

test('flood fill in WASM matches a breadth-first reference inside the clip', async (t) => {
  const mod = await instance(t);
  let changed = 0;
  const next = random(0x51ed270b);
  for (let iteration = 0; iteration < 1500; iteration++) {
    const expected = new Uint8Array(WIDTH * HEIGHT);
    const records = [];
    const density = next(0, 3) === 0 ? next(40, 70) : next(0, 35);
    for (let index = 0; index < WIDTH * HEIGHT; index++) {
      const roll = next(0, 99);
      expected[index] = roll < density ? 1 + (roll % 2) : 0;
      records.push([OPCODE.PIXEL, 0, 0, index % WIDTH, Math.floor(index / WIDTH), expected[index]]);
    }
    const clip = randomClip(next);
    const [x, y, color] = [next(0, WIDTH - 1), next(0, HEIGHT - 1), next(0, 3)];
    records.push([OPCODE.SET_CLIP, 0, 0, ...clip], [OPCODE.FILL, 0, 0, x, y, color]);
    assert.equal(submit(mod, records), STATUS.OK);
    const [left, top, right, bottom] = clipBox(...clip);
    if (x >= left && x < right && y >= top && y < bottom && expected[y * WIDTH + x] !== color) {
      const target = expected[y * WIDTH + x];
      const queue = [[x, y]];
      expected[y * WIDTH + x] = color;
      changed += 1;
      while (queue.length > 0) {
        const [cx, cy] = queue.shift();
        for (const [nx, ny] of [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ])
          if (
            nx >= left &&
            nx < right &&
            ny >= top &&
            ny < bottom &&
            expected[ny * WIDTH + nx] === target
          ) {
            expected[ny * WIDTH + nx] = color;
            queue.push([nx, ny]);
            changed += 1;
          }
      }
    }
    assert.deepEqual(frame(mod), expected);
  }
  assert.ok(changed > 20_000, `only ${changed} filled pixels were compared`);
});

test('rotated and scaled sprites in WASM follow the documented integer mapping', async (t) => {
  const mod = await instance(t);
  let total = 0;
  const next = random(0x0badf00d);
  const [imageWidth, imageHeight] = [12, 10];
  const source = Uint8Array.from(
    { length: imageWidth * imageHeight },
    (_, index) => 1 + (index % 15),
  );
  source[4] = 0;
  const header = new Uint8Array(32 + source.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x4d495850, true);
  view.setUint32(4, PROTOCOL.imageVersion, true);
  view.setUint32(8, imageWidth, true);
  view.setUint32(12, imageHeight, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, header.length, true);
  header.set(source, 32);
  assert.equal(mod._pxw_upload_begin(PROTOCOL.imageKind, header.length), STATUS.OK);
  mod.HEAPU8.set(header, mod._pxw_mailbox_offset());
  assert.equal(mod._pxw_upload_chunk(header.length), STATUS.OK);
  assert.equal(mod._pxw_upload_commit(), STATUS.OK);
  const handle = mod._pxw_last_resource_handle() >>> 0;
  // The generator's table, recomputed: round(sin(k * pi / 2048) * 65536).
  const quarter = Array.from({ length: 1025 }, (_, k) =>
    Math.round(Math.sin((k * Math.PI) / 2048) * 65536),
  );
  const sine = (angle) => {
    const step = angle & 1023;
    const quadrant = (angle >> 10) & 3;
    const value = quarter[quadrant & 1 ? 1024 - step : step];
    return BigInt(quadrant >= 2 ? -value : value);
  };
  const floorDiv = (value, divisor) => {
    const quotient = value / divisor;
    return value % divisor !== 0n && value < 0n ? quotient - 1n : quotient;
  };
  for (let iteration = 0; iteration < 3000; iteration++) {
    const sx = next(0, 4);
    const sy = next(0, 3);
    const w = next(0, imageWidth - sx);
    const h = next(0, imageHeight - sy);
    const [x, y, flags] = [next(-10, WIDTH - 2), next(-8, HEIGHT - 2), next(0, 3)];
    const angle = next(0, 4095);
    const scale = next(0, 3) === 0 ? next(PROTOCOL.minScale, 65536) : next(65536, 4 * 65536);
    const clip = randomClip(next);
    assert.equal(
      submit(mod, [
        [OPCODE.CLEAR, 0, 0, 0],
        [OPCODE.SET_CLIP, 0, 0, ...clip],
        [OPCODE.BLIT_TRANSFORM, flags, handle, x, y, sx, sy, w, h],
        [OPCODE.PARAMS, 0, 0, angle, scale],
      ]),
      STATUS.OK,
    );
    const expected = new Uint8Array(WIDTH * HEIGHT);
    const [left, top, right, bottom] = clipBox(...clip);
    const sin = sine(angle);
    const cos = sine((angle + 1024) & 4095);
    const inverse = (2n ** 32n + BigInt(scale) / 2n) / BigInt(scale);
    for (let py = top; py < bottom; py++)
      for (let px = left; px < right; px++) {
        const dx = BigInt(2 * px + 1 - (2 * x + w));
        const dy = BigInt(2 * py + 1 - (2 * y + h));
        const u = floorDiv((cos * dx + sin * dy) * inverse, 65536n);
        const v = floorDiv((cos * dy - sin * dx) * inverse, 65536n);
        const column = Number(floorDiv(u + BigInt(w) * 65536n, 131072n));
        const line = Number(floorDiv(v + BigInt(h) * 65536n, 131072n));
        if (column < 0 || column >= w || line < 0 || line >= h) continue;
        const cx = sx + (flags & 1 ? w - 1 - column : column);
        const cy = sy + (flags & 2 ? h - 1 - line : line);
        const color = source[cy * imageWidth + cx];
        if (color !== 0) expected[py * WIDTH + px] = color;
      }
    assert.deepEqual(frame(mod), expected, JSON.stringify({ x, y, sx, sy, w, h, angle, scale }));
    total += drawn(expected);
  }
  assert.ok(total > 20_000, `only ${total} sprite pixels were compared`);
});

test('remapping in WASM applies to every write until reset or the next frame', async (t) => {
  const mod = await instance(t);
  assert.equal(
    submit(mod, [
      [OPCODE.CLEAR, 0, 0, 2],
      [OPCODE.SET_REMAP, 0, 0, 2, 11],
      [OPCODE.ELLIPSE_FILL, 0, 0, 0, 0, 8, 8, 2],
      [OPCODE.TRIANGLE, 0, 0, 20, 2, 30, 2, 25, 10],
      [OPCODE.PARAMS, 0, 0, 2],
      [OPCODE.FILL, 0, 0, 31, 23, 2],
      [OPCODE.RESET_REMAP, 0, 0],
      [OPCODE.PIXEL, 0, 0, 12, 12, 2],
    ]),
    STATUS.OK,
  );
  const pixels = frame(mod);
  assert.equal(pixels[4 * WIDTH + 4], 11, 'remapped ellipse');
  assert.equal(pixels[2 * WIDTH + 25], 11, 'remapped triangle edge');
  assert.equal(pixels[23 * WIDTH + 31], 11, 'the fill writes the remapped index');
  assert.equal(pixels[12 * WIDTH + 12], 2, 'identity after the reset');
  assert.equal(submit(mod, [[OPCODE.PIXEL, 0, 0, 0, 0, 2]]), STATUS.OK);
  assert.equal(frame(mod)[0], 2, 'every frame starts with the identity table');
});

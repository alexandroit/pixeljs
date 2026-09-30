import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import factory from '../packages/core/dist/internal/wasm/engine.mjs';
import { PROTOCOL, OPCODE, STATUS } from '../packages/core/dist/internal/protocol.js';
const wasmBinary = new Uint8Array(
  await readFile(new URL('../packages/core/dist/internal/wasm/engine.wasm', import.meta.url)),
);
async function instance(t, width = 8, height = 8) {
  const mod = await factory({ wasmBinary });
  assert.equal(mod._pxw_abi_version(), PROTOCOL.abiVersion);
  assert.equal(mod._pxw_initialize(width, height, 16), 0);
  t.after(() => mod._pxw_destroy());
  return mod;
}
function pixels(mod, count = 64) {
  return mod.HEAPU8.slice(mod._pxw_frame_offset(), mod._pxw_frame_offset() + count);
}
function batch(mod, commands) {
  const bytes = new Uint8Array(32 + 32 * commands.length);
  const d = new DataView(bytes.buffer);
  d.setUint32(0, 0x534a5850, true);
  d.setUint32(4, PROTOCOL.protocolVersion, true);
  d.setUint32(8, commands.length, true);
  d.setUint32(12, bytes.length, true);
  for (const [index, command] of commands.entries()) {
    const at = 32 + index * 32;
    d.setUint16(at, command.op, true);
    d.setUint16(at + 2, command.flags ?? 0, true);
    d.setUint32(at + 4, command.handle ?? 0, true);
    for (let arg = 0; arg < 6; arg++) d.setInt32(at + 8 + arg * 4, command.args?.[arg] ?? 0, true);
  }
  mod.HEAPU8.set(bytes, mod._pxw_mailbox_offset());
  return bytes;
}
function imageBytes() {
  const bytes = new Uint8Array(36);
  const d = new DataView(bytes.buffer);
  d.setUint32(0, 0x4d495850, true);
  d.setUint32(4, PROTOCOL.imageVersion, true);
  d.setUint32(8, 2, true);
  d.setUint32(12, 2, true);
  d.setUint32(16, 0, true);
  d.setUint32(20, 36, true);
  bytes.set([1, 0, 2, 3], 32);
  return bytes;
}
function upload(mod) {
  const bytes = imageBytes();
  assert.equal(mod._pxw_upload_begin(1, bytes.length), 0);
  mod.HEAPU8.set(bytes, mod._pxw_mailbox_offset());
  assert.equal(mod._pxw_upload_chunk(bytes.length), 0);
  assert.equal(mod._pxw_upload_commit(), 0);
  return mod._pxw_last_resource_handle() >>> 0;
}

test('real wasm32 artifact exposes only the private ABI and bounded memory', async () => {
  const module = await WebAssembly.compile(wasmBinary);
  const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
  assert(exports.includes('pxw_submit'));
  assert(!exports.includes('malloc'));
  assert(!exports.includes('free'));
  assert(!WebAssembly.Module.imports(module).some((entry) => /pthread|asyncify/i.test(entry.name)));
  const mod = await factory({ wasmBinary });
  assert.equal(mod.HEAPU8.byteLength, 67108864);
  assert.equal(mod._pxw_initialize(0, 8, 16), STATUS.RANGE);
  mod._pxw_destroy();
});
test('C raster clips rectangles and expands original palette to RGBA', async (t) => {
  const mod = await instance(t);
  const bytes = batch(mod, [
    { op: 1, args: [0] },
    { op: 2, args: [-1, -1, 3, 3, 7] },
  ]);
  assert.equal(mod._pxw_submit(bytes.length), 0);
  const expected = new Uint8Array(64);
  expected[0] = 7;
  expected[1] = 7;
  expected[8] = 7;
  expected[9] = 7;
  assert.deepEqual(pixels(mod), expected);
  assert.equal(mod._pxw_expand_rgba(), 0);
  const p = mod._pxw_palette_offset() + 7 * 4;
  assert.deepEqual(
    mod.HEAPU8.slice(mod._pxw_rgba_offset(), mod._pxw_rgba_offset() + 4),
    mod.HEAPU8.slice(p, p + 4),
  );
});
test('malformed second command cannot partially apply an otherwise valid clear', async (t) => {
  const mod = await instance(t);
  const before = pixels(mod);
  const bytes = batch(mod, [{ op: 1, args: [4] }, { op: 999 }]);
  assert.equal(mod._pxw_submit(bytes.length), STATUS.UNSUPPORTED);
  assert.equal(mod._pxw_last_error_command_index(), 1);
  assert.deepEqual(pixels(mod), before);
  assert.equal(mod._pxw_last_error_code(), STATUS.UNSUPPORTED);
});
test('every truncated header and record, bad magic, flags and reserved field reject atomically', async (t) => {
  const mod = await instance(t);
  const valid = batch(mod, [{ op: 1, args: [7] }]);
  for (let n = 0; n < valid.length; n++) {
    mod.HEAPU8.set(valid, mod._pxw_mailbox_offset());
    assert.notEqual(mod._pxw_submit(n), 0);
    assert(pixels(mod).every((pixel) => pixel === 0));
  }
  for (const offset of [0, 4, 20, 24, 28, 34, 36, 44]) {
    const bytes = valid.slice();
    bytes[offset] = 255;
    mod.HEAPU8.set(bytes, mod._pxw_mailbox_offset());
    assert.notEqual(mod._pxw_submit(bytes.length), 0, `offset ${offset}`);
    assert(pixels(mod).every((pixel) => pixel === 0));
  }
});
test('draw can occur between image chunks without corrupting owned staging', async (t) => {
  const mod = await instance(t);
  const bytes = imageBytes();
  assert.equal(mod._pxw_upload_begin(1, bytes.length), 0);
  mod.HEAPU8.set(bytes.subarray(0, 16), mod._pxw_mailbox_offset());
  assert.equal(mod._pxw_upload_chunk(16), 0);
  const commands = batch(mod, [{ op: 1, args: [5] }]);
  assert.equal(mod._pxw_submit(commands.length), 0);
  mod.HEAPU8.set(bytes.subarray(16), mod._pxw_mailbox_offset());
  assert.equal(mod._pxw_upload_chunk(bytes.length - 16), 0);
  assert.equal(mod._pxw_upload_commit(), 0);
  const handle = mod._pxw_last_resource_handle();
  assert.notEqual(handle, 0);
  const draw = batch(mod, [{ op: 4, handle, args: [0, 0, 0, 0, 2, 2] }]);
  assert.equal(mod._pxw_submit(draw.length), 0);
  assert.deepEqual(Array.from(pixels(mod).slice(0, 2)), [1, 5]);
  assert.equal(pixels(mod)[8], 2);
  assert.equal(pixels(mod)[9], 3);
});
test('stale handles fail and aborted uploads clear previous results', async (t) => {
  const mod = await instance(t);
  const handle = upload(mod);
  assert.equal(mod._pxw_resource_release(handle), 0);
  const next = upload(mod);
  assert.notEqual(next, handle);
  const bytes = batch(mod, [{ op: 4, handle, args: [0, 0, 0, 0, 2, 2] }]);
  assert.equal(mod._pxw_submit(bytes.length), STATUS.HANDLE);
  assert.equal(mod._pxw_upload_begin(1, 36), 0);
  assert.equal(mod._pxw_last_resource_handle(), 0);
  assert.equal(mod._pxw_upload_abort(), 0);
  assert.equal(mod._pxw_last_resource_handle(), 0);
});
test('instances are independent and no frame allocations occur', async (t) => {
  const first = await instance(t);
  const second = await instance(t);
  const allocations = first._pxw_allocation_count();
  for (let i = 0; i < 1000; i++) {
    const bytes = batch(first, [
      { op: OPCODE.CLEAR, args: [3] },
      { op: OPCODE.RECT, args: [-2, 5, 20, 20, 8] },
    ]);
    assert.equal(first._pxw_submit(bytes.length), 0);
    assert.equal(first._pxw_expand_rgba(), 0);
  }
  assert.equal(first._pxw_allocation_count(), allocations);
  assert(pixels(second).every((pixel) => pixel === 0));
  assert.notDeepEqual(pixels(first), pixels(second));
});
test('double init and any operation after terminal destroy fail', async (t) => {
  const mod = await instance(t);
  assert.equal(mod._pxw_initialize(8, 8, 16), STATUS.STATE);
  mod._pxw_destroy();
  assert.equal(mod._pxw_live_bytes(), 0);
  assert.equal(mod._pxw_initialize(8, 8, 16), STATUS.STATE);
  assert.equal(mod._pxw_submit(PROTOCOL.headerBytes), STATUS.STATE);
});

test('private adapter abandons a trapped upload without calling abort or destroy again', async () => {
  const { WasmAdapter } = await import('../packages/core/dist/internal/wasm/adapter.js');
  const mod = await factory({ wasmBinary });
  const adapter = new WasmAdapter(mod, 8, 8);
  let abortCalls = 0;
  let destroyCalls = 0;
  // Inject a trap at the adapter boundary, not a memory-corrupting C fixture.
  mod._pxw_upload_chunk = () => {
    throw new WebAssembly.RuntimeError('injected trap');
  };
  mod._pxw_upload_abort = () => {
    abortCalls++;
    return 0;
  };
  mod._pxw_destroy = () => {
    destroyCalls++;
    return 0;
  };
  assert.throws(() => adapter.upload(PROTOCOL.imageKind, imageBytes()), WebAssembly.RuntimeError);
  adapter.destroy();
  assert.equal(abortCalls, 0);
  assert.equal(destroyCalls, 0);
  assert.equal(adapter.indexed.length, 0);
  assert.equal(adapter.mailbox.byteLength, 0);
});

test('WASM resize and setPalette dynamically modify frame and palette layout', async (t) => {
  const mod = await instance(t, 4, 4);
  assert.equal(mod._pxw_frame_stride(), 4);
  assert.equal(mod._pxw_resize(8, 6), STATUS.OK);
  assert.equal(mod._pxw_frame_stride(), 8);
  assert.equal(mod._pxw_resize(0, 6), STATUS.RANGE);

  const newPalette = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    newPalette[i * 4 + 0] = i * 10;
    newPalette[i * 4 + 1] = i * 15;
    newPalette[i * 4 + 2] = i * 20;
    newPalette[i * 4 + 3] = 255;
  }
  mod.HEAPU8.set(newPalette, mod._pxw_mailbox_offset());
  assert.equal(mod._pxw_set_palette(16), STATUS.OK);
  const paletteReadback = mod.HEAPU8.slice(
    mod._pxw_palette_offset(),
    mod._pxw_palette_offset() + 64,
  );
  assert.deepEqual(Array.from(paletteReadback), Array.from(newPalette));
});

test('extended primitives line, rectb, circle, circleFill, glyph render correctly in WASM', async (t) => {
  const mod = await instance(t, 16, 16);
  const bytes = batch(mod, [
    { op: OPCODE.CLEAR, args: [0] },
    { op: OPCODE.LINE, args: [0, 0, 3, 3, 2] },
    { op: OPCODE.RECTB, args: [4, 0, 4, 4, 3] },
    { op: OPCODE.CIRCLE, args: [2, 6, 1, 4] },
    { op: OPCODE.CIRCLE_FILL, args: [6, 6, 1, 5] },
    { op: OPCODE.GLYPH, args: [8, 0, 33, 7, -1] },
  ]);
  assert.equal(mod._pxw_submit(bytes.length), STATUS.OK);
  assert.equal(mod._pxw_expand_rgba(), STATUS.OK);
  const frame = pixels(mod, 256);
  assert.equal(frame[1 * 16 + 1], 2);
  assert.equal(frame[0 * 16 + 4], 3);
  assert.equal(frame[1 * 16 + 5], 0);
  assert.equal(frame[6 * 16 + 2], 0);
  assert.equal(frame[5 * 16 + 2], 4);
  assert.equal(frame[6 * 16 + 6], 5);
  assert.equal(frame[0 * 16 + 11], 7);
});

/**
 * Exact reference for lines: the pixels of the unclipped all-octant
 * Bresenham walk that fall inside the clip. Pixel k of the walk lies k steps
 * along the major axis and floor((2 * minor * k + major) / (2 * major)) along
 * the minor one; BigInt evaluates that for every visible major coordinate.
 */
function referenceLine(frame, width, height, clip, camera, line, color) {
  const left = Math.max(0, clip[0]);
  const top = Math.max(0, clip[1]);
  const right = Math.min(width, clip[0] + clip[2]);
  const bottom = Math.min(height, clip[1] + clip[3]);
  const [x0, y0, x1, y1] = [
    BigInt(line[0]) - BigInt(camera[0]),
    BigInt(line[1]) - BigInt(camera[1]),
    BigInt(line[2]) - BigInt(camera[0]),
    BigInt(line[3]) - BigInt(camera[1]),
  ];
  const abs = (value) => (value < 0n ? -value : value);
  const xMajor = abs(x1 - x0) >= abs(y1 - y0);
  const [major, minor] = xMajor ? [abs(x1 - x0), abs(y1 - y0)] : [abs(y1 - y0), abs(x1 - x0)];
  const [origin, other] = xMajor ? [x0, y0] : [y0, x0];
  const majorStep = (xMajor ? x1 >= x0 : y1 >= y0) ? 1n : -1n;
  const minorStep = (xMajor ? y1 >= y0 : x1 >= x0) ? 1n : -1n;
  const [low, high] = xMajor ? [left, right] : [top, bottom];
  for (let coordinate = low; coordinate < high; coordinate++) {
    const k = (BigInt(coordinate) - origin) * majorStep;
    if (k < 0n || k > major) continue;
    const offset = major === 0n ? 0n : (2n * minor * k + major) / (2n * major);
    const across = Number(other + minorStep * offset);
    const [x, y] = xMajor ? [coordinate, across] : [across, coordinate];
    if (x >= left && x < right && y >= top && y < bottom) frame[y * width + x] = color;
  }
}

/** The literal walk, for lines short enough to step through. */
function walkLine(frame, width, clip, [x0, y0, x1, y1], color) {
  const [left, top, right, bottom] = clip;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  let error = dx + dy;
  for (;;) {
    if (x0 >= left && x0 < right && y0 >= top && y0 < bottom) frame[y0 * width + x0] = color;
    if (x0 === x1 && y0 === y1) return;
    const doubled = 2 * error;
    if (doubled >= dy) [error, x0] = [error + dy, x0 + (x0 < x1 ? 1 : -1)];
    if (doubled <= dx) [error, y0] = [error + dx, y0 + (y0 < y1 ? 1 : -1)];
  }
}

test('clipped lines keep exactly the pixels of the unclipped walk, even at full range', async (t) => {
  const width = 40;
  const height = 30;
  const mod = await instance(t, width, height);
  let seed = 0x1234567;
  const next = () => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed;
  };
  const extremes = [-2147483648, 2147483647, -1073741824, 1073741823];
  let slowVisible = 0;
  let fastVisible = 0;
  for (let iteration = 0; iteration < 4000; iteration++) {
    const slow = iteration % 2 === 0;
    // The camera leaves room for a visible point to stay within int32.
    const camera = [(next() % 2 ** 31) - 2 ** 30, (next() % 2 ** 31) - 2 ** 30];
    const clip = [next() % 30, next() % 22, 1 + (next() % 40), 1 + (next() % 30)];
    // One endpoint inside the clip, so every line crosses the visible area.
    const inside = [
      camera[0] + clip[0] + (next() % Math.min(clip[2], width - clip[0])),
      camera[1] + clip[1] + (next() % Math.min(clip[3], height - clip[1])),
    ];
    // Far endpoints make camera-relative magnitudes reach 2^31 or more.
    const far = slow
      ? [extremes[next() % 4], extremes[next() % 4]]
      : [inside[0] + (next() % 201) - 100, inside[1] + (next() % 201) - 100];
    const line = next() % 2 === 0 ? [...inside, ...far] : [...far, ...inside];
    const bytes = batch(mod, [
      { op: OPCODE.CLEAR, args: [0] },
      { op: OPCODE.SET_CAMERA, args: camera },
      { op: OPCODE.SET_CLIP, args: clip },
      { op: OPCODE.LINE, args: [...line, 9] },
    ]);
    assert.equal(mod._pxw_submit(bytes.length), STATUS.OK);
    const expected = new Uint8Array(width * height);
    referenceLine(expected, width, height, clip, camera, line, 9);
    assert.deepEqual(pixels(mod, width * height), expected, JSON.stringify({ camera, clip, line }));
    if (!slow) {
      // Short lines also run the literal walk, which validates the closed form.
      const walked = new Uint8Array(width * height);
      const bounds = [
        Math.max(0, clip[0]),
        Math.max(0, clip[1]),
        Math.min(width, clip[0] + clip[2]),
        Math.min(height, clip[1] + clip[3]),
      ];
      const relative = line.map((value, index) => value - camera[index % 2]);
      walkLine(walked, width, bounds, relative, 9);
      assert.deepEqual(walked, expected);
    }
    const visible = expected.some((pixel) => pixel !== 0);
    if (slow && visible) slowVisible += 1;
    if (!slow && visible) fastVisible += 1;
  }
  // Every generated line crosses its clip, so every case must draw pixels.
  assert.equal(slowVisible, 2000);
  assert.equal(fastVisible, 2000);
});

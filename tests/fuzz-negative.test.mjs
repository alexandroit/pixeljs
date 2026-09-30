// Deterministic negative fuzzing of the real WASM artifact. This is a bounded
// regression gate that runs with every test pass; it complements, and does not
// replace, the coverage-guided libFuzzer campaigns in core/fuzz.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import factory from '../packages/core/dist/internal/wasm/engine.mjs';
import { PROTOCOL, OPCODE, STATUS } from '../packages/core/dist/internal/protocol.js';

const wasmBinary = new Uint8Array(
  await readFile(new URL('../packages/core/dist/internal/wasm/engine.wasm', import.meta.url)),
);
const WIDTH = 32;
const HEIGHT = 24;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const EXTREMES = [INT32_MIN, INT32_MIN + 1, -65536, -1, 0, 1, 7, 255, 65535, 2 ** 30, INT32_MAX];
const STATUSES = new Set(Object.values(STATUS));
// A generous ceiling that the pre-validation defects (seconds per record) exceeded.
const MAX_SUBMIT_MS = 250;
// Longer local or CI campaigns: PIXELJS_FUZZ_SCALE=50 PIXELJS_FUZZ_SEED=7 npm test
const SCALE = Number(process.env.PIXELJS_FUZZ_SCALE ?? 1);
const SEED = Number(process.env.PIXELJS_FUZZ_SEED ?? 0);
if (!Number.isInteger(SCALE) || SCALE < 1 || !Number.isInteger(SEED) || SEED < 0)
  throw new Error('PIXELJS_FUZZ_SCALE must be a positive integer and PIXELJS_FUZZ_SEED >= 0.');

function random(seed) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  return {
    next,
    below: (limit) => next() % limit,
    pick: (values) => values[next() % values.length],
  };
}

function header(magic, fields) {
  const bytes = new Uint8Array(PROTOCOL.headerBytes);
  const view = new DataView(bytes.buffer);
  bytes.set([...magic].map((character) => character.charCodeAt(0)));
  fields.forEach((value, index) => view.setUint32(4 + index * 4, value >>> 0, true));
  return bytes;
}

function concat(...parts) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function batch(records) {
  const bytes = new Uint8Array(PROTOCOL.headerBytes + records.length * PROTOCOL.recordBytes);
  const view = new DataView(bytes.buffer);
  bytes.set([0x50, 0x58, 0x4a, 0x53]);
  view.setUint32(4, PROTOCOL.protocolVersion, true);
  view.setUint32(8, records.length, true);
  view.setUint32(12, bytes.length, true);
  records.forEach(({ op, flags = 0, handle = 0, args = [] }, index) => {
    const at = PROTOCOL.headerBytes + index * PROTOCOL.recordBytes;
    view.setUint16(at, op, true);
    view.setUint16(at + 2, flags, true);
    view.setUint32(at + 4, handle >>> 0, true);
    for (let arg = 0; arg < 6; arg++) view.setInt32(at + 8 + arg * 4, args[arg] ?? 0, true);
  });
  return bytes;
}

function imagePayload(width, height, transparency, pixel) {
  const pixels = Uint8Array.from({ length: width * height }, (_, index) => pixel(index));
  return concat(
    header('PXIM', [1, width, height, transparency, PROTOCOL.headerBytes + pixels.length, 0, 0]),
    pixels,
  );
}

function tilemapPayload(tileset) {
  const cells = new Uint8Array([0, 0, 1, 0, 255, 255, 3, 0]);
  return concat(
    header('PXTM', [1, 2, 2, 2, 2, tileset, PROTOCOL.headerBytes + cells.length]),
    cells,
  );
}

function fontPayload() {
  const glyphs = Uint8Array.from({ length: 16 }, (_, index) => (0x81 << (index % 3)) & 0xff);
  return concat(header('PXFN', [1, 8, 8, 65, 2, 66, PROTOCOL.headerBytes + glyphs.length]), glyphs);
}

async function engine() {
  const mod = await factory({ wasmBinary });
  assert.equal(mod._pxw_abi_version(), PROTOCOL.abiVersion);
  assert.equal(mod._pxw_initialize(WIDTH, HEIGHT, 16), STATUS.OK);
  const upload = (kind, bytes, rng) => {
    let status = mod._pxw_upload_begin(kind, bytes.length);
    if (status !== STATUS.OK) return { status, handle: 0 };
    for (let offset = 0; offset < bytes.length && status === STATUS.OK;) {
      const size = rng ? 1 + rng.below(Math.min(64, bytes.length - offset)) : bytes.length;
      mod.HEAPU8.set(bytes.subarray(offset, offset + size), mod._pxw_mailbox_offset());
      status = mod._pxw_upload_chunk(size);
      offset += size;
      // Drawing between chunks must not disturb the private staging copy.
      if (rng && rng.below(4) === 0) submit(batch([{ op: OPCODE.CLEAR, args: [rng.below(16)] }]));
    }
    if (status === STATUS.OK) status = mod._pxw_upload_commit();
    const handle = mod._pxw_last_resource_handle() >>> 0;
    if (status !== STATUS.OK) {
      assert.equal(handle, 0, 'a failed commit never publishes a handle');
      assert.equal(mod._pxw_upload_abort(), STATUS.OK);
    }
    return { status, handle };
  };
  const snapshot = () => ({
    frame: mod.HEAPU8.slice(mod._pxw_frame_offset(), mod._pxw_frame_offset() + WIDTH * HEIGHT),
    palette: mod.HEAPU8.slice(mod._pxw_palette_offset(), mod._pxw_palette_offset() + 1024),
    revision: mod._pxw_palette_revision(),
    bytes: mod._pxw_live_bytes(),
    allocations: mod._pxw_allocation_count(),
  });
  const submit = (bytes, length = bytes.length) => {
    mod.HEAPU8.set(
      bytes.subarray(0, Math.min(bytes.length, PROTOCOL.mailboxBytes)),
      mod._pxw_mailbox_offset(),
    );
    const before = snapshot();
    const started = performance.now();
    const status = mod._pxw_submit(length);
    const elapsed = performance.now() - started;
    const after = snapshot();
    assert.ok(STATUSES.has(status), `unknown status ${status}`);
    assert.ok(elapsed < MAX_SUBMIT_MS, `submit took ${elapsed.toFixed(1)} ms`);
    assert.equal(after.bytes, before.bytes, 'submission never allocates');
    assert.equal(after.allocations, before.allocations, 'submission never allocates');
    if (status !== STATUS.OK) {
      assert.deepEqual(after.frame, before.frame, 'a rejected batch preserves the frame');
      assert.deepEqual(after.palette, before.palette, 'a rejected batch preserves the palette');
      assert.equal(after.revision, before.revision);
    }
    return status;
  };
  return { mod, upload, submit, snapshot };
}

function corpus(handles) {
  const { image, tilemap, font } = handles;
  return [
    [{ op: OPCODE.CLEAR, args: [3] }],
    [
      { op: OPCODE.SET_CAMERA, args: [-4, 3] },
      { op: OPCODE.SET_CLIP, args: [2, 2, 20, 12] },
      { op: OPCODE.RECT, args: [1, 1, 9, 7, 5] },
      { op: OPCODE.PIXEL, args: [4, 4, 6] },
      { op: OPCODE.RESET_CLIP },
      { op: OPCODE.BLIT, flags: 3, handle: image, args: [5, 6, 1, 0, 3, 4] },
    ],
    [
      { op: OPCODE.LINE, args: [-50, -20, 90, 40, 7] },
      { op: OPCODE.RECTB, args: [3, 2, 12, 9, 8] },
      { op: OPCODE.CIRCLE, args: [16, 12, 9, 9] },
      { op: OPCODE.CIRCLE_FILL, args: [8, 8, 5, 10] },
    ],
    [
      { op: OPCODE.GLYPH, args: [0, 0, 33, 11, -1] },
      { op: OPCODE.GLYPH, handle: font, args: [9, 9, 65, 12, 1] },
      { op: OPCODE.TILEMAP, handle: tilemap, args: [2, 3, 0, 0, 2, 2] },
      { op: OPCODE.SET_PALETTE, args: [4, 12, 34, 56] },
    ],
  ];
}

function mutate(bytes, rng, handles) {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  const records = Math.max(0, (out.length - PROTOCOL.headerBytes) / PROTOCOL.recordBytes);
  const recordAt = () =>
    PROTOCOL.headerBytes + rng.below(Math.max(1, records)) * PROTOCOL.recordBytes;
  switch (rng.below(8)) {
    case 0:
      out[rng.below(out.length)] ^= 1 << rng.below(8);
      break;
    case 1:
      out[rng.below(out.length)] = rng.pick([0, 0x7f, 0x80, 0xff]);
      break;
    case 2:
      if (records) view.setInt32(recordAt() + 8 + 4 * rng.below(6), rng.pick(EXTREMES), true);
      break;
    case 3:
      if (records)
        view.setUint16(recordAt(), rng.pick([0, 15, 99, 0xffff, ...Object.values(OPCODE)]), true);
      break;
    case 4:
      if (records)
        view.setUint32(
          recordAt() + 4,
          rng.pick([0, 1, 0xffffffff, handles.image, handles.tilemap, handles.font, handles.stale]),
          true,
        );
      break;
    case 5:
      view.setUint32(
        rng.pick([8, 12, 16, 20, 24, 28]),
        rng.pick([0, 1, 4096, 4097, 0xffffffff]),
        true,
      );
      break;
    case 6:
      if (records) view.setUint16(recordAt() + 2, rng.pick([0, 1, 2, 3, 4, 0x8000]), true);
      break;
    default:
      if (records)
        for (let arg = 0; arg < 6; arg++)
          view.setInt32(recordAt() + 8 + arg * 4, rng.pick(EXTREMES), true);
  }
  return out;
}

test('hostile command batches are rejected atomically without traps or allocation', async () => {
  const { mod, upload, submit } = await engine();
  const tileset = upload(
    1,
    imagePayload(4, 4, 0, (index) => index % 16),
  );
  const handles = {
    image: tileset.handle,
    tilemap: upload(2, tilemapPayload(tileset.handle)).handle,
    font: upload(3, fontPayload()).handle,
  };
  const staleImage = upload(
    1,
    imagePayload(1, 1, 0xffffffff, () => 1),
  ).handle;
  assert.equal(mod._pxw_resource_release(staleImage), STATUS.OK);
  handles.stale = staleImage;
  assert.ok(handles.image && handles.tilemap && handles.font);
  const seeds = corpus(handles).map(batch);
  for (const seed of seeds) assert.equal(submit(seed), STATUS.OK, 'every corpus seed is valid');

  // Every truncation of a mixed batch is rejected before any write.
  const mixed = concat(seeds[1], seeds[2].subarray(PROTOCOL.headerBytes));
  new DataView(mixed.buffer).setUint32(8, 10, true);
  new DataView(mixed.buffer).setUint32(12, mixed.length, true);
  assert.equal(submit(mixed), STATUS.OK);
  for (let length = 0; length < mixed.length; length++)
    assert.notEqual(submit(mixed, length), STATUS.OK);

  const rng = random(0x5eed1234 + SEED);
  const outcomes = new Map();
  for (let iteration = 0; iteration < 6000 * SCALE; iteration++) {
    let bytes = rng.pick(seeds);
    for (let rounds = 1 + rng.below(3); rounds > 0; rounds--) bytes = mutate(bytes, rng, handles);
    const status = submit(bytes);
    outcomes.set(status, (outcomes.get(status) ?? 0) + 1);
  }
  // The campaign must exercise both acceptance and several rejection paths.
  assert.ok((outcomes.get(STATUS.OK) ?? 0) > 100, JSON.stringify([...outcomes]));
  for (const status of [STATUS.PROTOCOL, STATUS.RANGE, STATUS.HANDLE, STATUS.UNSUPPORTED])
    assert.ok((outcomes.get(status) ?? 0) > 0, `status ${status} never produced`);

  // Full batches of extreme geometry cost only their visible work: outlines
  // taller than the screen, full-range lines and invisible huge circles.
  const extreme = batch(
    Array.from(
      { length: PROTOCOL.maxCommands },
      (_, index) =>
        [
          { op: OPCODE.RECTB, args: [0, -(2 ** 30), WIDTH, INT32_MAX, 1] },
          { op: OPCODE.LINE, args: [INT32_MIN, INT32_MIN, INT32_MAX, INT32_MAX, 2] },
          { op: OPCODE.CIRCLE, args: [INT32_MIN, INT32_MIN, 2 ** 30, 3] },
          { op: OPCODE.CIRCLE_FILL, args: [INT32_MAX, INT32_MIN, 2 ** 30, 4] },
        ][index % 4],
    ),
  );
  assert.equal(submit(extreme), STATUS.OK);
  // A visible circle whose loop would exceed the budget is refused up front.
  assert.equal(submit(batch([{ op: OPCODE.CIRCLE, args: [16, 12, 2 ** 30, 5] }])), STATUS.CAPACITY);
  mod._pxw_destroy();
});

test('hostile resource uploads never publish, leak or corrupt interleaved drawing', async () => {
  const { mod, upload, submit, snapshot } = await engine();
  const tileset = upload(
    1,
    imagePayload(4, 4, 0, (index) => index % 16),
  ).handle;
  const baseline = snapshot().bytes;
  const valid = [
    [1, imagePayload(3, 2, 0, (index) => (index * 5) % 16)],
    [2, tilemapPayload(tileset)],
    [3, fontPayload()],
  ];
  const rng = random(0xc0ffee + SEED);
  let published = 0;
  for (let iteration = 0; iteration < 3000 * SCALE; iteration++) {
    const [kind, source] = rng.pick(valid);
    const bytes = source.slice();
    const view = new DataView(bytes.buffer);
    const mutations = rng.below(4);
    for (let round = 0; round < mutations; round++) {
      if (rng.below(2) === 0) bytes[rng.below(bytes.length)] ^= 1 << rng.below(8);
      else
        view.setUint32(4 * rng.below(8), rng.pick([0, 1, 2, 3, 65, 257, 65535, 0xffffffff]), true);
    }
    const uploadKind = rng.below(10) === 0 ? rng.pick([0, 1, 2, 3, 4, 0xffffffff]) : kind;
    const { status, handle } = upload(uploadKind, bytes, rng);
    assert.ok(STATUSES.has(status));
    if (status === STATUS.OK) {
      published += 1;
      if (uploadKind === 2)
        assert.equal(mod._pxw_resource_release(tileset), STATUS.RESOURCE_IN_USE);
      submit(batch([{ op: OPCODE.CLEAR, args: [1] }]));
      assert.equal(mod._pxw_resource_release(handle), STATUS.OK);
    }
    assert.equal(snapshot().bytes, baseline, 'every upload path returns to the baseline');
  }
  assert.ok(published > 0 && published < 3000 * SCALE, `published ${published} uploads`);
  mod._pxw_destroy();
  assert.equal(mod._pxw_live_bytes(), 0);
});

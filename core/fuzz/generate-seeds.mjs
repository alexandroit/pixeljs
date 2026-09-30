// Writes the original PixelJS fuzz seeds. Resource handles 4097 (image),
// 4098 (tilemap) and 4099 (font) exist in every fuzz context.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const directory = new URL('./corpus/', import.meta.url);
const schema = JSON.parse(
  await readFile(new URL('../../protocol/schema.json', import.meta.url), 'utf8'),
);
await mkdir(new URL('commands/', directory), { recursive: true });
await mkdir(new URL('resources/', directory), { recursive: true });

function batch(records) {
  const bytes = Buffer.alloc(32 + records.length * 32);
  bytes.write('PXJS');
  bytes.writeUInt32LE(schema.protocolVersion, 4);
  bytes.writeUInt32LE(records.length, 8);
  bytes.writeUInt32LE(bytes.length, 12);
  records.forEach(([op, flags, handle, ...args], index) => {
    const at = 32 + index * 32;
    bytes.writeUInt16LE(op, at);
    bytes.writeUInt16LE(flags, at + 2);
    bytes.writeUInt32LE(handle, at + 4);
    args.forEach((value, arg) => bytes.writeInt32LE(value, at + 8 + arg * 4));
  });
  return bytes;
}

function resource(kind, magic, fields, payload) {
  const bytes = Buffer.alloc(2 + 32 + payload.length);
  bytes[0] = kind;
  bytes[1] = 7; // Upload in 7-byte chunks with drawing in between.
  bytes.write(magic, 2);
  fields.forEach((value, index) => bytes.writeUInt32LE(value >>> 0, 6 + index * 4));
  bytes.writeUInt32LE(32 + payload.length, magic === 'PXIM' ? 22 : 30);
  bytes.set(payload, 34);
  return bytes;
}

const seeds = {
  'commands/empty.bin': batch([]),
  'commands/clear.bin': batch([[1, 0, 0, 5]]),
  'commands/clipped-rectangle.bin': batch([[2, 0, 0, -2, -3, 8, 8, 3]]),
  'commands/primitives.bin': batch([
    [7, 0, 0, -2, 1],
    [5, 0, 0, 1, 1, 12, 12],
    [8, 0, 0, -40, -9, 70, 30, 7],
    [9, 0, 0, 2, 2, 9, 7, 8],
    [10, 0, 0, 8, 8, 6, 9],
    [11, 0, 0, 4, 11, 3, 10],
    [6, 0, 0],
    [12, 0, 0, 0, 0, 65, 11, -1],
    [14, 0, 0, 4, 12, 34, 56],
  ]),
  // Shapes, remapping and a rotated sprite; PARAMS (23) follows opcodes 17, 18 and 22.
  'commands/shapes.bin': batch([
    [20, 0, 0, 3, 9],
    [15, 0, 0, 1, 2, 11, 7, 3],
    [16, 0, 0, 5, 5, 6, 9, 4],
    [17, 0, 0, 0, 0, 15, 3, 7, 14],
    [23, 0, 0, 5],
    [18, 0, 0, -9, 20, 8, -4, 30, 12],
    [23, 0, 0, 6],
    [19, 0, 0, 2, 13, 8],
    [21, 0, 0],
    [22, 1, 4097, 3, 4, 0, 0, 4, 4],
    [23, 0, 0, 512, 98304],
  ]),
  'commands/resources.bin': batch([
    [4, 3, 4097, 1, 2, 1, 0, 3, 4],
    [13, 0, 4098, 3, 3, 0, 0, 2, 2],
    [12, 0, 4099, 8, 8, 66, 12, 2],
  ]),
  // Selector byte 0: image. Fields: version, width, height, transparency, length, 0, 0.
  'resources/image.bin': resource(0, 'PXIM', [1, 3, 2, 0], Buffer.from([1, 2, 0, 3, 4, 5])),
  // Selector byte 1: tilemap of 2x2 tiles over the 4x4 fixture image (handle 4097).
  'resources/tilemap.bin': resource(
    1,
    'PXTM',
    [1, 2, 1, 2, 2, 4097],
    Buffer.from([3, 0, 0xff, 0xff]),
  ),
  // Selector byte 2: two 8x8 glyphs starting at 'A'.
  'resources/font.bin': resource(
    2,
    'PXFN',
    [1, 8, 8, 65, 2, 65],
    Buffer.from([
      0x18, 0x24, 0x42, 0x7e, 0x42, 0x42, 0x42, 0, 0x7c, 0x42, 0x7c, 0x42, 0x42, 0x42, 0x7c, 0,
    ]),
  ),
};
// Audio: a u32 sample rate, then operations (see audio.c): selector byte,
// u32 voice/track/count, arguments. Floats are little-endian IEEE 754.
function audio(sampleRate, operations) {
  const parts = [u32(sampleRate)];
  for (const [selector, voice, ...args] of operations) {
    parts.push(Buffer.from([selector]), u32(voice));
    for (const [type, value] of args)
      parts.push(type === 'f' ? f32(value) : type === 'b' ? Buffer.from([value]) : u32(value));
  }
  return Buffer.concat(parts);
}
function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}
function f32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(value);
  return bytes;
}
const instrument = [
  ['f', 0.8],
  ['f', 0.001],
  ['f', 0.01],
  ['f', 0.7],
  ['f', 0.02],
];
const stepNote = (step, length, pitch, effect) => [
  ['u', step],
  ['u', length],
  ['b', pitch],
  ['b', 255],
  ['b', 0],
  ['b', effect],
];
await mkdir(new URL('audio/', directory), { recursive: true });
// 48,000 = 8,000 + 40,000 (the harness maps the rate into 8,000-192,000).
seeds['audio/note.bin'] = audio(40000, [
  [
    0,
    0,
    ['b', 2],
    ['b', 1],
    ['f', 440],
    ['f', 880],
    ['f', 1],
    ['f', 0],
    ['f', 0.01],
    ['f', 1],
    ['f', 0.05],
    ['f', 0.2],
  ],
  [13, 511],
  [1, 0],
  [13, 300],
]);
seeds['audio/sound.bin'] = audio(40000, [
  [3, 1, ...instrument, ['u', 24000], ['u', 4]],
  [4, 1, ...stepNote(0, 1, 60, 1)],
  [4, 1, ...stepNote(2, 2, 64, 2)],
  [5, 1],
  [13, 511],
  [13, 511],
]);
seeds['audio/music.bin'] = audio(40000, [
  [6, 2, ['u', 8], ['u', 40000], ['u', 16]],
  [7, 0, ...instrument, ['u', 0]],
  [7, 1, ...instrument, ['u', 3]],
  [8, 0, ...stepNote(0, 2, 69, 0)],
  [8, 0, ...stepNote(4, 1, 72, 3)],
  [8, 1, ...stepNote(1, 7, 45, 2)],
  [9, 1],
  [13, 511],
  [
    0,
    3,
    ['b', 3],
    ['b', 0],
    ['f', 1000],
    ['f', 0],
    ['f', 0.5],
    ['f', 0],
    ['f', 0],
    ['f', 1],
    ['f', 0],
    ['f', 0.01],
  ],
  [13, 511],
  [2, 0],
  [13, 128],
]);

for (const [name, bytes] of Object.entries(seeds)) await writeFile(new URL(name, directory), bytes);
console.log(`Original PixelJS fuzz seeds generated (${Object.keys(seeds).length}).`);

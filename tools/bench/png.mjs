// Deterministic PNG fixtures for the browser benchmarks (B06, B11): original
// pixel-art-like RGBA images encoded with Node's zlib. No image libraries.
import { crc32, deflateSync } from 'node:zlib';

const COLORS = [
  [0, 0, 0],
  [29, 43, 83],
  [126, 37, 83],
  [0, 135, 81],
  [171, 82, 54],
  [95, 87, 79],
  [194, 195, 199],
  [255, 241, 232],
  [255, 0, 77],
  [255, 163, 0],
  [255, 236, 39],
  [0, 228, 54],
];

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([header, data, crc]);
}

/**
 * An RGBA PNG of `width` × `height`: blocky shapes in the top half, per-pixel
 * detail (a hash of the position) in the bottom half, and some transparency,
 * so large fixtures do not compress to a trivial size.
 */
export function fixturePng(width, height, seed = 1) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const block = ((x >> 3) * 7 + (y >> 3) * 13 + seed) % COLORS.length;
      const edge = (x & 7) === 0 || (y & 7) === 0;
      const detail =
        (Math.imul((x * 73856093) ^ (y * 19349663), 2654435761) >>> 28) % COLORS.length;
      const index = y >= height / 2 ? detail : edge ? (block + 5) % COLORS.length : block;
      const [r, g, b] = COLORS[index];
      const at = y * stride + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = (x * 31 + y * 17 + seed) % 23 === 0 ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

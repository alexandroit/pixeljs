import { MAX_PNG_BYTES, MAX_PNG_SIDE, formatBytes } from './limits.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export class ImageFileError extends Error {
  override readonly name = 'ImageFileError';
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/**
 * Reads the PNG header before any decoding: signature, IHDR size limits and
 * animation. Browser decoders allocate only after this check passed.
 */
export function inspectPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 33 || SIGNATURE.some((value, index) => bytes[index] !== value))
    throw new ImageFileError('The file is not a PNG image.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || chunkType(bytes, 12) !== 'IHDR')
    throw new ImageFileError('The PNG header is malformed.');
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE)
    throw new ImageFileError(
      `PNG images are limited to ${MAX_PNG_SIDE} × ${MAX_PNG_SIDE} pixels (this one is ${width} × ${height}).`,
    );
  for (let offset = 8, chunks = 0; offset + 8 <= bytes.length && chunks < 4096; chunks++) {
    const type = chunkType(bytes, offset + 4);
    if (type === 'acTL') throw new ImageFileError('Animated PNG images are not supported.');
    if (type === 'IDAT') break;
    offset += 12 + view.getUint32(offset);
  }
  return { width, height };
}

export interface DecodedImage {
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA, as the engine's PNG loader reads it. */
  rgba: Uint8ClampedArray;
}

/** Decodes a bounded static PNG with the same browser path as `engine.loadImage`. */
export async function decodePng(file: Blob): Promise<DecodedImage> {
  if (file.size > MAX_PNG_BYTES)
    throw new ImageFileError(
      `PNG files are limited to ${formatBytes(MAX_PNG_BYTES)} (this one is ${formatBytes(file.size)}).`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { width, height } = inspectPng(bytes);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
  } catch {
    throw new ImageFileError('The browser could not decode this PNG image.');
  }
  try {
    if (bitmap.width !== width || bitmap.height !== height)
      throw new ImageFileError('The decoded size differs from the PNG header.');
    const context =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
        : canvasContext(width, height);
    if (!context) throw new ImageFileError('Canvas 2D is required to read images.');
    context.drawImage(bitmap, 0, 0);
    return { width, height, rgba: context.getImageData(0, 0, width, height).data };
  } finally {
    bitmap.close();
  }
}

function canvasContext(width: number, height: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d', { willReadFrequently: true });
}

// ---------------------------------------------------------------------------
// Encoding: 8-bit indexed PNG (color type 3) with the palette in PLTE and the
// transparent index, if any, as the only non-opaque tRNS entry.

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib stream of stored (uncompressed) deflate blocks, when CompressionStream is absent. */
function storedZlib(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let block = 0; block < blocks; block++) {
    const part = data.subarray(block * 65535, (block + 1) * 65535);
    out[at] = block === blocks - 1 ? 1 : 0;
    view.setUint16(at + 1, part.length, true);
    view.setUint16(at + 3, ~part.length & 0xffff, true);
    out.set(part, at + 5);
    at += 5 + part.length;
  }
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  view.setUint32(at, ((b << 16) | a) >>> 0);
  return out;
}

async function zlib(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream !== 'function') return storedZlib(data);
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeIndexedPng(
  width: number,
  height: number,
  pixels: Uint8Array,
  palette: readonly number[],
  transparentIndex: number | null,
): Promise<Blob> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 3, 0, 0, 0], 8);
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((color, index) =>
    plte.set([(color >> 16) & 255, (color >> 8) & 255, color & 255], index * 3),
  );
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++)
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const parts: Uint8Array<ArrayBuffer>[] = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('PLTE', plte),
  ];
  if (transparentIndex !== null) {
    const alpha = new Uint8Array(transparentIndex + 1).fill(255);
    alpha[transparentIndex] = 0;
    parts.push(chunk('tRNS', alpha));
  }
  parts.push(chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

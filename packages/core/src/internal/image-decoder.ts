import { PixelJSError } from '../api/errors.js';
import { PROTOCOL } from './protocol.js';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_CACHED_COLORS = 65536;

export interface DecodeOptions {
  /** Engine palette: 256 RGBA entries, of which the first paletteCount are usable. */
  palette: Uint8Array;
  paletteCount: number;
  /** Index for pixels with alpha below 128; without it alpha is ignored. */
  transparentIndex: number | undefined;
  document: Document;
  /** Throws when the load was cancelled while the browser decoded. */
  check: () => void;
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/**
 * Reads PNG chunk headers up to the first image data chunk. Dimensions and
 * animation are checked before the browser decoder allocates pixel memory.
 */
export function inspectPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value))
    throw new PixelJSError('ASSET_DATA', 'Only PNG images and PixelJS JSON images are supported.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || chunkType(bytes, 12) !== 'IHDR')
    throw new PixelJSError('ASSET_DATA', 'The PNG header is malformed.');
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (
    width === 0 ||
    height === 0 ||
    width > PROTOCOL.maxDimension ||
    height > PROTOCOL.maxDimension ||
    width * height > PROTOCOL.maxImagePixels
  )
    throw new PixelJSError(
      'RANGE',
      `PNG images are limited to ${PROTOCOL.maxDimension} × ${PROTOCOL.maxDimension} pixels (got ${width} × ${height}).`,
    );
  // Ancillary chunks precede the image data; the scan is bounded either way.
  for (let offset = 8, chunks = 0; offset + 8 <= bytes.length && chunks < 4096; chunks++) {
    const type = chunkType(bytes, offset + 4);
    if (type === 'acTL')
      throw new PixelJSError('ASSET_DATA', 'Animated PNG images are not supported.');
    if (type === 'IDAT') break;
    offset += 12 + view.getUint32(offset);
  }
  return { width, height };
}

function readPixels(bitmap: ImageBitmap, document: Document): Uint8ClampedArray {
  const { width, height } = bitmap;
  if (typeof OffscreenCanvas === 'function') {
    const context = new OffscreenCanvas(width, height).getContext('2d', {
      willReadFrequently: true,
    });
    if (!context) throw new PixelJSError('UNSUPPORTED', 'Canvas 2D is required to read images.');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new PixelJSError('UNSUPPORTED', 'Canvas 2D is required to read images.');
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, width, height).data;
}

/**
 * Deterministic nearest-color mapping: squared RGB distance, lowest index on
 * ties. The transparent index is reserved for transparent pixels.
 */
function quantize(rgba: Uint8ClampedArray, options: DecodeOptions): Uint8Array {
  const { palette, paletteCount, transparentIndex } = options;
  const pixels = new Uint8Array(rgba.length / 4);
  const cache = new Map<number, number>();
  for (let pixel = 0; pixel < pixels.length; pixel++) {
    const at = pixel * 4;
    if (transparentIndex !== undefined && (rgba[at + 3] ?? 255) < 128) {
      pixels[pixel] = transparentIndex;
      continue;
    }
    const red = rgba[at] ?? 0;
    const green = rgba[at + 1] ?? 0;
    const blue = rgba[at + 2] ?? 0;
    const key = (red << 16) | (green << 8) | blue;
    let best = cache.get(key);
    if (best === undefined) {
      best = -1;
      let bestDistance = Infinity;
      for (let index = 0; index < paletteCount; index++) {
        if (index === transparentIndex && paletteCount > 1) continue;
        const dr = red - (palette[index * 4] ?? 0);
        const dg = green - (palette[index * 4 + 1] ?? 0);
        const db = blue - (palette[index * 4 + 2] ?? 0);
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      if (cache.size < MAX_CACHED_COLORS) cache.set(key, best);
    }
    pixels[pixel] = best;
  }
  return pixels;
}

/** Decodes a bounded, static PNG and maps it to palette indices. */
export async function decodeImage(
  bytes: Uint8Array,
  options: DecodeOptions,
): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const { width, height } = inspectPng(bytes);
  if (typeof createImageBitmap !== 'function')
    throw new PixelJSError('UNSUPPORTED', 'createImageBitmap is not available in this browser.');
  let bitmap: ImageBitmap;
  try {
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' });
    bitmap = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
  } catch (error) {
    throw new PixelJSError('ASSET_DATA', 'The browser could not decode the PNG image.', {
      cause: error,
    });
  }
  try {
    options.check();
    if (bitmap.width !== width || bitmap.height !== height)
      throw new PixelJSError('ASSET_DATA', 'The decoded size differs from the PNG header.');
    return { width, height, pixels: quantize(readPixels(bitmap, options.document), options) };
  } finally {
    bitmap.close();
  }
}

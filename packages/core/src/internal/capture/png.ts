import { scaleRow, TimeSlicer, type SliceOptions } from './slice.js';

/** An indexed frame copied out of the engine. */
export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  /** width × height palette indices, row by row. */
  readonly pixels: Uint8Array;
  /** RGBA entries; the first `colors` are written. */
  readonly palette: Uint8Array;
  /** Palette entries in use, 1–256. */
  readonly colors: number;
}

export interface PngOptions extends SliceOptions {
  /** Uses uncompressed deflate blocks even when CompressionStream exists. */
  readonly stored?: boolean | undefined;
}

type Bytes = Uint8Array<ArrayBuffer>;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Scanlines are handed to the compressor in batches of about this size. */
const BATCH_BYTES = 64 * 1024;
let crcTable: Uint32Array | undefined;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** CRC-32 (ISO 3309) as PNG uses it; pass the previous result to continue. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  const values = table();
  let crc = ~previous;
  for (let index = 0; index < bytes.length; index++)
    crc = (values[(crc ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return ~crc >>> 0;
}

interface ZlibWriter {
  write(chunk: Bytes): Promise<void>;
  close(): Promise<Bytes[]>;
  abort(): void;
}

/** zlib stream of uncompressed deflate blocks, for browsers without CompressionStream. */
function storedZlib(): ZlibWriter {
  const parts: Bytes[] = [Uint8Array.of(0x78, 0x01)];
  const block = new Uint8Array(65535);
  let used = 0;
  let a = 1;
  let b = 0;
  const emit = (final: boolean): void => {
    const header = new Uint8Array(5);
    header[0] = final ? 1 : 0;
    header[1] = used & 0xff;
    header[2] = used >>> 8;
    header[3] = ~used & 0xff;
    header[4] = (~used >>> 8) & 0xff;
    parts.push(header, block.slice(0, used));
    used = 0;
  };
  return {
    write(chunk) {
      for (let offset = 0; offset < chunk.length;) {
        const count = Math.min(chunk.length - offset, block.length - used);
        const piece = chunk.subarray(offset, offset + count);
        block.set(piece, used);
        // Adler-32, reduced often enough that the sums stay exact.
        for (let start = 0; start < piece.length; start += 5552) {
          const end = Math.min(piece.length, start + 5552);
          for (let index = start; index < end; index++) {
            a += piece[index] ?? 0;
            b += a;
          }
          a %= 65521;
          b %= 65521;
        }
        used += count;
        offset += count;
        if (used === block.length) emit(false);
      }
      return Promise.resolve();
    },
    close() {
      emit(true);
      const adler = new Uint8Array(4);
      new DataView(adler.buffer).setUint32(0, ((b << 16) | a) >>> 0);
      parts.push(adler);
      return Promise.resolve(parts);
    },
    abort() {
      parts.length = 0;
    },
  };
}

/** zlib stream compressed by the browser. */
function streamZlib(): ZlibWriter {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const parts: Bytes[] = [];
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return parts;
      parts.push(value as Bytes);
    }
  })();
  // Failures surface through write() or close(); never leave this unobserved.
  reading.catch(() => undefined);
  return {
    write: (chunk) => writer.write(chunk),
    close: async () => {
      await writer.close();
      return reading;
    },
    abort() {
      writer.abort().catch(() => undefined);
      reader.cancel().catch(() => undefined);
    },
  };
}

function chunk(type: string, data: Uint8Array): Bytes {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) bytes[4 + index] = type.charCodeAt(index);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
  return bytes;
}

/**
 * Encodes an 8-bit indexed PNG (color type 3, filter 0) of the frame scaled
 * by an integer factor. Scanlines are generated and compressed in batches,
 * so the scaled image is never held uncompressed, and the work yields to
 * the event loop between slices. Returns the file as parts for a Blob.
 */
export async function encodePng(
  image: IndexedImage,
  scale: number,
  options: PngOptions = {},
): Promise<Bytes[]> {
  const slicer = new TimeSlicer(options);
  const width = image.width * scale;
  const height = image.height * scale;
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 3, 0, 0, 0], 8);
  const colors = new Uint8Array(image.colors * 3);
  for (let index = 0; index < image.colors; index++)
    colors.set(image.palette.subarray(index * 4, index * 4 + 3), index * 3);
  const zlib =
    options.stored === true || typeof CompressionStream !== 'function'
      ? storedZlib()
      : streamZlib();
  try {
    const rowBytes = 1 + width;
    const batchRows = Math.max(1, Math.floor(BATCH_BYTES / rowBytes));
    // Filter byte 0 (none) starts every scanline.
    const row = new Uint8Array(rowBytes);
    let batch = new Uint8Array(batchRows * rowBytes);
    let used = 0;
    for (let y = 0; y < image.height; y++) {
      scaleRow(image.pixels, y * image.width, image.width, scale, row, 1);
      for (let copy = 0; copy < scale; copy++) {
        batch.set(row, used);
        used += rowBytes;
        if (used === batch.length) {
          // A written batch is never modified again: the stream may read it later.
          await zlib.write(batch);
          slicer.check();
          batch = new Uint8Array(batch.length);
          used = 0;
        }
      }
      if (slicer.due) await slicer.pause();
    }
    if (used > 0) await zlib.write(batch.subarray(0, used));
    const compressed = await zlib.close();
    slicer.check();
    let length = 0;
    let crc = crc32(Uint8Array.of(0x49, 0x44, 0x41, 0x54));
    for (const part of compressed) {
      length += part.length;
      crc = crc32(part, crc);
    }
    const idat = new Uint8Array(8);
    new DataView(idat.buffer).setUint32(0, length);
    idat.set([0x49, 0x44, 0x41, 0x54], 4);
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, crc);
    return [
      Uint8Array.from(SIGNATURE),
      chunk('IHDR', header),
      chunk('PLTE', colors),
      idat,
      ...compressed,
      tail,
      chunk('IEND', new Uint8Array(0)),
    ];
  } catch (error) {
    zlib.abort();
    slicer.check();
    throw error;
  }
}

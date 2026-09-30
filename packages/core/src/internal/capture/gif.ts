import { PixelJSError } from '../../api/errors.js';
import { scaleRow, TimeSlicer, type SliceOptions } from './slice.js';

type Bytes = Uint8Array<ArrayBuffer>;

export interface GifFrame {
  /** width × height palette indices, row by row. */
  readonly pixels: Uint8Array;
  /** RGBA entries; the first `colors` are used. */
  readonly palette: Uint8Array;
  /** Display time in hundredths of a second. */
  readonly delay: number;
}

export interface GifOptions extends SliceOptions {
  readonly width: number;
  readonly height: number;
  /** Palette entries in use, 1–256. */
  readonly colors: number;
  /** Integer nearest-neighbor upscaling. */
  readonly scale: number;
  /** Largest file produced; beyond it encoding fails with CAPACITY. */
  readonly maxBytes: number;
}

const CHUNK_BYTES = 64 * 1024;
const MAX_CODES = 4096;
const HASH_SIZE = 8192;
const HASH_MASK = HASH_SIZE - 1;

/** Collects output in fixed-size parts and enforces the size limit. */
class ByteSink {
  private readonly parts: Bytes[] = [];
  private part: Bytes = new Uint8Array(CHUNK_BYTES);
  private used = 0;
  private flushed = 0;

  constructor(private readonly maxBytes: number) {}

  byte(value: number): void {
    if (this.used === CHUNK_BYTES) this.flush();
    this.part[this.used++] = value;
  }

  bytes(values: Uint8Array): void {
    for (let offset = 0; offset < values.length;) {
      if (this.used === CHUNK_BYTES) this.flush();
      const count = Math.min(values.length - offset, CHUNK_BYTES - this.used);
      this.part.set(values.subarray(offset, offset + count), this.used);
      this.used += count;
      offset += count;
    }
  }

  u16(value: number): void {
    this.byte(value & 0xff);
    this.byte(value >>> 8);
  }

  private flush(): void {
    this.flushed += this.used;
    if (this.flushed > this.maxBytes)
      throw new PixelJSError(
        'CAPACITY',
        `The GIF would exceed ${this.maxBytes / (1024 * 1024)} MiB; record fewer seconds or a smaller scale.`,
      );
    this.parts.push(this.used === CHUNK_BYTES ? this.part : this.part.slice(0, this.used));
    this.part = new Uint8Array(CHUNK_BYTES);
    this.used = 0;
  }

  finish(): Bytes[] {
    if (this.used > 0) this.flush();
    return this.parts;
  }
}

/**
 * Variable-length LZW as GIF uses it: codes start at minCodeSize + 1 bits,
 * grow when the decoder's table reaches the next power of two, stop growing
 * at 12 bits, and a clear code restarts the table when all 4096 codes are
 * used. Codes are packed least significant bit first into sub-blocks of at
 * most 255 bytes. One writer encodes every frame of a GIF in turn: begin(),
 * write() and finish() per frame.
 */
export class LzwWriter {
  private readonly clearCode: number;
  private readonly endCode: number;
  private readonly keys = new Int32Array(HASH_SIZE);
  private readonly codes = new Uint16Array(HASH_SIZE);
  private codeSize = 0;
  private next = 0;
  private prefix = -1;
  private bits = 0;
  private bitCount = 0;
  private readonly block = new Uint8Array(256);
  private blockLength = 0;

  constructor(
    private readonly minCodeSize: number,
    private readonly sink: ByteSink,
  ) {
    this.clearCode = 1 << minCodeSize;
    this.endCode = this.clearCode + 1;
  }

  /** Starts the image data of one frame. */
  begin(): void {
    this.prefix = -1;
    this.bits = 0;
    this.bitCount = 0;
    this.blockLength = 0;
    this.sink.byte(this.minCodeSize);
    this.reset();
    this.emit(this.clearCode);
  }

  private reset(): void {
    this.keys.fill(-1);
    this.codeSize = this.minCodeSize + 1;
    this.next = this.endCode + 1;
  }

  private emit(code: number): void {
    this.bits |= code << this.bitCount;
    this.bitCount += this.codeSize;
    while (this.bitCount >= 8) {
      this.block[++this.blockLength] = this.bits & 0xff;
      if (this.blockLength === 255) this.flushBlock();
      this.bits >>>= 8;
      this.bitCount -= 8;
    }
  }

  /** Emits a string code; the decoder adds a table entry when it reads it. */
  private emitString(code: number): void {
    this.emit(code);
    if (this.next >= 1 << this.codeSize && this.codeSize < 12) this.codeSize++;
  }

  private flushBlock(): void {
    if (this.blockLength === 0) return;
    this.block[0] = this.blockLength;
    this.sink.bytes(this.block.subarray(0, this.blockLength + 1));
    this.blockLength = 0;
  }

  write(pixels: Uint8Array): void {
    const { keys, codes } = this;
    let prefix = this.prefix;
    let index = 0;
    if (prefix < 0) {
      if (pixels.length === 0) return;
      prefix = pixels[0] ?? 0;
      index = 1;
    }
    for (; index < pixels.length; index++) {
      const pixel = pixels[index] ?? 0;
      const key = (prefix << 8) | pixel;
      let slot = Math.imul(key, 0x9e3779b1) >>> 19;
      let found = -1;
      for (let probe = keys[slot] ?? -1; probe !== -1; probe = keys[slot] ?? -1) {
        if (probe === key) {
          found = codes[slot] ?? 0;
          break;
        }
        slot = (slot + 1) & HASH_MASK;
      }
      if (found >= 0) {
        prefix = found;
        continue;
      }
      this.emitString(prefix);
      if (this.next < MAX_CODES) {
        keys[slot] = key;
        codes[slot] = this.next++;
      } else {
        this.emit(this.clearCode);
        this.reset();
      }
      prefix = pixel;
    }
    this.prefix = prefix;
  }

  finish(): void {
    if (this.prefix >= 0) this.emitString(this.prefix);
    this.emit(this.endCode);
    if (this.bitCount > 0) {
      this.block[++this.blockLength] = this.bits & 0xff;
      if (this.blockLength === 255) this.flushBlock();
    }
    this.flushBlock();
    this.sink.byte(0);
  }
}

interface Planned {
  readonly frame: GifFrame;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly local: boolean;
  delay: number;
}

function sameColors(a: Uint8Array, b: Uint8Array, colors: number): boolean {
  if (a === b) return true;
  for (let index = 0; index < colors * 4; index++) if (a[index] !== b[index]) return false;
  return true;
}

function rowDiffers(a: Uint8Array, b: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index++) if (a[index] !== b[index]) return true;
  return false;
}

/** Smallest rectangle containing every changed pixel, or null when nothing changed. */
function changedRect(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  let top = 0;
  while (top < height && !rowDiffers(a, b, top * width, (top + 1) * width)) top++;
  if (top === height) return null;
  let bottom = height - 1;
  while (bottom > top && !rowDiffers(a, b, bottom * width, (bottom + 1) * width)) bottom--;
  let left = width;
  let right = -1;
  for (let y = top; y <= bottom; y++) {
    const row = y * width;
    for (let x = 0; x < left; x++)
      if (a[row + x] !== b[row + x]) {
        left = x;
        break;
      }
    for (let x = width - 1; x > right; x--)
      if (a[row + x] !== b[row + x]) {
        right = x;
        break;
      }
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Chooses what to write for each frame: the full first frame and every frame
 * whose palette changed, otherwise only the rectangle that changed; frames
 * identical to the previous one extend its delay instead.
 */
async function plan(
  frames: readonly GifFrame[],
  options: GifOptions,
  slicer: TimeSlicer,
): Promise<Planned[]> {
  const { width, height, colors } = options;
  const global = frames[0]?.palette ?? new Uint8Array(0);
  const planned: Planned[] = [];
  let previous: GifFrame | undefined;
  for (const frame of frames) {
    let rect: { x: number; y: number; width: number; height: number } | null = {
      x: 0,
      y: 0,
      width,
      height,
    };
    if (previous !== undefined && sameColors(previous.palette, frame.palette, colors)) {
      rect = changedRect(previous.pixels, frame.pixels, width, height);
      const last = planned[planned.length - 1];
      if (rect === null && last !== undefined) {
        last.delay = Math.min(0xffff, last.delay + frame.delay);
        previous = frame;
        continue;
      }
    }
    if (rect === null) rect = { x: 0, y: 0, width, height };
    planned.push({
      frame,
      ...rect,
      local: !sameColors(global, frame.palette, colors),
      delay: frame.delay,
    });
    previous = frame;
    if (slicer.due) await slicer.pause();
  }
  return planned;
}

/** RGB triples of the first `colors` entries, padded with black to `size` entries. */
function colorTable(palette: Uint8Array, colors: number, size: number): Uint8Array {
  const table = new Uint8Array(size * 3);
  for (let index = 0; index < colors; index++)
    table.set(palette.subarray(index * 4, index * 4 + 3), index * 3);
  return table;
}

/**
 * Encodes frames of one size as a looping GIF89a. The global color table is
 * the first frame's palette padded to a power of two; frames with another
 * palette carry a local table. Frames are drawn over the previous one
 * (disposal "do not dispose"), so a frame stores only what changed. The
 * work yields between slices and stops with STATE when `signal` aborts.
 */
export async function encodeGif(
  frames: readonly GifFrame[],
  options: GifOptions,
): Promise<Bytes[]> {
  const { width, height, colors, scale } = options;
  const slicer = new TimeSlicer(options);
  let bits = 1;
  while (1 << bits < colors) bits++;
  const tableSize = 1 << bits;
  const minCodeSize = Math.max(2, bits);
  const sink = new ByteSink(options.maxBytes);
  const lzw = new LzwWriter(minCodeSize, sink);
  sink.bytes(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61));
  sink.u16(width * scale);
  sink.u16(height * scale);
  // Global table, 8-bit color resolution, table size 2^bits.
  sink.bytes(Uint8Array.of(0x80 | 0x70 | (bits - 1), 0, 0));
  sink.bytes(colorTable(frames[0]?.palette ?? new Uint8Array(0), colors, tableSize));
  // NETSCAPE2.0 application extension: loop forever.
  sink.bytes(Uint8Array.of(0x21, 0xff, 0x0b));
  sink.bytes(Uint8Array.of(0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30));
  sink.bytes(Uint8Array.of(0x03, 0x01, 0x00, 0x00, 0x00));
  for (const item of await plan(frames, options, slicer)) {
    // Graphic control: disposal 1 (keep), no transparency.
    sink.bytes(Uint8Array.of(0x21, 0xf9, 0x04, 0x04));
    sink.u16(Math.max(0, Math.min(0xffff, Math.round(item.delay))));
    sink.bytes(Uint8Array.of(0, 0));
    sink.byte(0x2c);
    sink.u16(item.x * scale);
    sink.u16(item.y * scale);
    sink.u16(item.width * scale);
    sink.u16(item.height * scale);
    sink.byte(item.local ? 0x80 | (bits - 1) : 0);
    if (item.local) sink.bytes(colorTable(item.frame.palette, colors, tableSize));
    lzw.begin();
    const row = new Uint8Array(item.width * scale);
    for (let y = item.y; y < item.y + item.height; y++) {
      scaleRow(item.frame.pixels, y * width + item.x, item.width, scale, row, 0);
      for (let copy = 0; copy < scale; copy++) {
        lzw.write(row);
        if (slicer.due) await slicer.pause();
      }
    }
    lzw.finish();
  }
  sink.byte(0x3b);
  slicer.check();
  return sink.finish();
}

import type { GifFrame } from './gif.js';

/** Private read access to the engine's presented frame; everything returned is a copy. */
export interface FrameSource {
  readonly paletteCount: number;
  width(): number;
  height(): number;
  /** Changes whenever any palette entry changes. */
  paletteRevision(): number;
  /** Copies the indexed framebuffer, into `target` when its length matches. */
  copyFrame(target?: Uint8Array): Uint8Array;
  /** Copies all 256 RGBA palette entries. */
  copyPalette(): Uint8Array;
}

export const RECORDING_LIMITS = Object.freeze({
  /** Frames closer together than this are skipped: at most 50 per second. */
  minFrameMs: 20,
  /** Frame and palette copies kept at once. */
  bytes: 64 * 1024 * 1024,
  /**
   * The longest gap between presented frames that counts in full, as in the
   * update clock: a pause, hidden tab or stall adds at most this much.
   */
  maxGapMs: 250,
});
const PALETTE_BYTES = 256 * 4;

interface RecordedFrame {
  readonly pixels: Uint8Array;
  readonly palette: Uint8Array;
  readonly time: number;
  /** The oldest frame of a palette run accounts for the palette copy. */
  ownsPalette: boolean;
}

/**
 * Copies presented frames into a bounded ring: frames more than `maxMs` of
 * recording time older than the newest one are dropped, and so are the
 * oldest frames whenever the copies would exceed the byte limit. Recording
 * time follows the game clock rather than the wall clock (see maxGapMs).
 */
export class FrameRecorder {
  private readonly frames: RecordedFrame[] = [];
  private bytes = 0;
  private width = 0;
  private height = 0;
  private palette: Uint8Array | null = null;
  private revision = -1;
  private spare: Uint8Array | null = null;
  private lastPresented: number | null = null;
  /** Wall-clock time of gaps beyond maxGapMs, left out of recording time. */
  private skipped = 0;

  constructor(
    readonly maxMs: number,
    readonly scale: number,
    private readonly maxBytes: number = RECORDING_LIMITS.bytes,
  ) {}

  /** Frames and bytes currently held. */
  get size(): { frames: number; bytes: number } {
    return { frames: this.frames.length, bytes: this.bytes };
  }

  add(presented: number, source: FrameSource): void {
    const gap = this.lastPresented === null ? 0 : presented - this.lastPresented;
    if (gap > RECORDING_LIMITS.maxGapMs) this.skipped += gap - RECORDING_LIMITS.maxGapMs;
    this.lastPresented = presented;
    const time = presented - this.skipped;
    const newest = this.frames[this.frames.length - 1];
    if (newest !== undefined && time - newest.time < RECORDING_LIMITS.minFrameMs) return;
    const width = source.width();
    const height = source.height();
    if (width !== this.width || height !== this.height) {
      // A resize starts over: one GIF has one size.
      this.frames.length = 0;
      this.bytes = 0;
      this.palette = null;
      this.spare = null;
      this.width = width;
      this.height = height;
    }
    const pixelBytes = width * height;
    while (this.frames.length > 0 && this.bytes + pixelBytes + PALETTE_BYTES > this.maxBytes)
      this.evict();
    const revision = source.paletteRevision();
    const newPalette = this.palette === null || revision !== this.revision;
    if (newPalette) {
      this.palette = source.copyPalette();
      this.revision = revision;
    }
    const ownsPalette = newPalette || this.frames.length === 0;
    const pixels = source.copyFrame(this.spare ?? undefined);
    this.spare = null;
    this.frames.push({ pixels, palette: this.palette!, time, ownsPalette });
    this.bytes += pixelBytes + (ownsPalette ? PALETTE_BYTES : 0);
    while (this.frames.length > 1 && (this.frames[0]?.time ?? time) < time - this.maxMs)
      this.evict();
  }

  private evict(): void {
    const oldest = this.frames.shift();
    if (!oldest) return;
    this.bytes -= oldest.pixels.length;
    const next = this.frames[0];
    if (oldest.ownsPalette) {
      if (next !== undefined && next.palette === oldest.palette) next.ownsPalette = true;
      else this.bytes -= PALETTE_BYTES;
    }
    // Reused by the next copy of the same size instead of a new allocation.
    this.spare = oldest.pixels;
  }

  /**
   * Hands over the recorded frames with delays in hundredths of a second.
   * Rounding cumulative timestamps keeps the total exact and, with frames
   * at least 20 ms apart, every delay at least 2 (browsers slow shorter
   * ones down); the last frame lasts until `now` in recording time.
   */
  take(now: number): { frames: GifFrame[]; width: number; height: number } {
    const last = this.lastPresented ?? now;
    const end = Math.min(now, last + RECORDING_LIMITS.maxGapMs) - this.skipped;
    const frames = this.frames.map((frame, index): GifFrame => {
      const next = this.frames[index + 1];
      const delay =
        next === undefined
          ? Math.max(2, Math.round(end / 10) - Math.round(frame.time / 10))
          : Math.round(next.time / 10) - Math.round(frame.time / 10);
      return { pixels: frame.pixels, palette: frame.palette, delay };
    });
    this.frames.length = 0;
    this.bytes = 0;
    this.spare = null;
    return { frames, width: this.width, height: this.height };
  }
}

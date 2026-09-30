import { integer, PixelJSError, record } from '../../api/errors.js';
import { encodeGif } from './gif.js';
import { encodePng } from './png.js';
import { FrameRecorder, type FrameSource } from './recorder.js';

export const CAPTURE_LIMITS = Object.freeze({
  pngScale: 8,
  gifScale: 4,
  maxSeconds: 60,
  defaultSeconds: 10,
  gifBytes: 256 * 1024 * 1024,
});

function options(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  record(value, name);
  return value;
}

/**
 * PNG snapshots and GIF recording of presented frames. The engine reports
 * each presented frame, resize and between-frame palette change; everything
 * read from the engine is copied synchronously, and encoding stops with
 * STATE once dispose() has been called.
 */
export class FrameCapture {
  private presented = false;
  /** The presented palette, kept only after setPalette() replaced it before the next frame. */
  private presentedPalette: Uint8Array | null = null;
  private recorder: FrameRecorder | null = null;
  private recordingError: unknown = null;
  private capturing = false;
  private encoding = false;
  private readonly jobs = new Set<AbortController>();

  constructor(private readonly source: FrameSource) {}

  get recording(): boolean {
    return this.recorder !== null;
  }

  /** After each presented frame; `time` is the frame timestamp in milliseconds. */
  framePresented(time: number): void {
    this.presented = true;
    this.presentedPalette = null;
    const recorder = this.recorder;
    if (recorder === null || this.recordingError !== null) return;
    try {
      recorder.add(time, this.source);
    } catch (error) {
      // Recording is optional: the game keeps running; stopRecording() reports it.
      this.recordingError = error;
    }
  }

  /** The framebuffer was replaced (resize): nothing presented is left to capture. */
  frameReplaced(): void {
    this.presented = false;
    this.presentedPalette = null;
  }

  /** Before setPalette() changes colors between frames. */
  paletteChanging(): void {
    if (this.presented && this.presentedPalette === null)
      this.presentedPalette = this.source.copyPalette();
  }

  private job<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const job = new AbortController();
    this.jobs.add(job);
    return work(job.signal).finally(() => this.jobs.delete(job));
  }

  async capture(value: unknown): Promise<Blob> {
    const scale = integer(
      options(value, 'capture options')['scale'] ?? 1,
      'scale',
      1,
      CAPTURE_LIMITS.pngScale,
    );
    if (this.capturing) throw new PixelJSError('STATE', 'A capture is already in progress.');
    if (!this.presented)
      throw new PixelJSError('STATE', 'No frame has been presented since start or resize.');
    // Copied now: frames presented while encoding cannot change the result.
    const image = {
      width: this.source.width(),
      height: this.source.height(),
      pixels: this.source.copyFrame(),
      palette: this.presentedPalette ?? this.source.copyPalette(),
      colors: this.source.paletteCount,
    };
    this.capturing = true;
    try {
      return await this.job(async (signal) => {
        const parts = await encodePng(image, scale, { signal });
        if (signal.aborted)
          throw new PixelJSError('STATE', 'The engine was disposed before encoding finished.');
        return new Blob(parts, { type: 'image/png' });
      });
    } finally {
      this.capturing = false;
    }
  }

  startRecording(value: unknown): void {
    const settings = options(value, 'recording options');
    const seconds = settings['maxSeconds'] ?? CAPTURE_LIMITS.defaultSeconds;
    if (
      typeof seconds !== 'number' ||
      !Number.isFinite(seconds) ||
      seconds < 1 ||
      seconds > CAPTURE_LIMITS.maxSeconds
    )
      throw new PixelJSError(
        'RANGE',
        `maxSeconds must be a number between 1 and ${CAPTURE_LIMITS.maxSeconds}.`,
      );
    const scale = integer(settings['scale'] ?? 1, 'scale', 1, CAPTURE_LIMITS.gifScale);
    if (this.recorder !== null) throw new PixelJSError('STATE', 'Recording is already running.');
    if (this.encoding)
      throw new PixelJSError('STATE', 'The previous recording is still being encoded.');
    this.recordingError = null;
    this.recorder = new FrameRecorder(seconds * 1000, scale);
  }

  async stopRecording(): Promise<Blob> {
    const recorder = this.recorder;
    if (recorder === null) throw new PixelJSError('STATE', 'Recording has not been started.');
    this.recorder = null;
    const failure = this.recordingError;
    if (failure !== null)
      throw failure instanceof PixelJSError
        ? failure
        : new PixelJSError('CAPACITY', 'Recording ran out of memory while copying a frame.', {
            cause: failure,
          });
    const { frames, width, height } = recorder.take(performance.now());
    if (frames.length === 0)
      throw new PixelJSError('STATE', 'No frame was presented while recording.');
    this.encoding = true;
    try {
      return await this.job(async (signal) => {
        const parts = await encodeGif(frames, {
          width,
          height,
          colors: this.source.paletteCount,
          scale: recorder.scale,
          maxBytes: CAPTURE_LIMITS.gifBytes,
          signal,
        });
        if (signal.aborted)
          throw new PixelJSError('STATE', 'The engine was disposed before encoding finished.');
        return new Blob(parts, { type: 'image/gif' });
      });
    } finally {
      this.encoding = false;
    }
  }

  /** Drops the recording and makes pending encodes reject with STATE. */
  dispose(): void {
    this.recorder = null;
    this.presented = false;
    this.presentedPalette = null;
    for (const job of this.jobs) job.abort();
  }
}

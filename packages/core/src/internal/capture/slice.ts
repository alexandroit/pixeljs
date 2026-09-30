import { PixelJSError } from '../../api/errors.js';

/**
 * Resolves in a later task, so input and rendering run in between. A message
 * port is used because timers can be throttled heavily in background tabs.
 */
export function nextTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof MessageChannel !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export interface SliceOptions {
  /** Aborted when the engine is disposed. */
  readonly signal?: AbortSignal | undefined;
  /** Work between yields, in milliseconds. Default 8. */
  readonly sliceMs?: number | undefined;
  /** How to yield; tests may substitute their own. */
  readonly yieldTask?: (() => Promise<void>) | undefined;
}

/** Splits long synchronous work into slices and checks for disposal between them. */
export class TimeSlicer {
  private started = performance.now();
  private readonly budget: number;

  constructor(private readonly options: SliceOptions) {
    this.budget = options.sliceMs ?? 8;
    this.check();
  }

  /** Throws STATE once the owning engine has been disposed. */
  check(): void {
    if (this.options.signal?.aborted)
      throw new PixelJSError('STATE', 'The engine was disposed before encoding finished.');
  }

  get due(): boolean {
    return performance.now() - this.started >= this.budget;
  }

  async pause(): Promise<void> {
    await (this.options.yieldTask ?? nextTask)();
    this.check();
    this.started = performance.now();
  }
}

/** Writes `count` indices from `source[offset]` into `target[at]`, each repeated `scale` times. */
export function scaleRow(
  source: Uint8Array,
  offset: number,
  count: number,
  scale: number,
  target: Uint8Array,
  at: number,
): void {
  if (scale === 1) {
    target.set(source.subarray(offset, offset + count), at);
    return;
  }
  for (let x = 0; x < count; x++) {
    const start = at + x * scale;
    target.fill(source[offset + x] ?? 0, start, start + scale);
  }
}

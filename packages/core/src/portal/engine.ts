import { PixelJSError } from '../api/errors.js';
import type { Engine } from '../api/types.js';
import type { Portal } from './types.js';

export interface AttachEngineOptions {
  /** The volume set when the portal unmutes the game, from 0 to 1 (default 1). */
  volume?: number;
}

/**
 * Lets the portal control an engine: its `pause` and `resume` events pause and
 * resume the engine's loop and sound, and `mute` sets the engine's volume to 0 or
 * back to `volume`. Held keys, pointers and gamepad buttons need nothing more: the
 * engine releases them whenever its window loses focus, its page is hidden, and on
 * every pause and resume. Call it after `engine.start()`, which ends a pause.
 * Returns a function that detaches the engine again.
 */
export function attachEngine(
  portal: Portal,
  engine: Engine,
  options: AttachEngineOptions = {},
): () => void {
  const volume = options.volume ?? 1;
  if (typeof volume !== 'number' || !(volume >= 0 && volume <= 1))
    throw new PixelJSError('RANGE', 'volume must be a number between 0 and 1.');
  // A disposed or failed engine ignores the portal instead of throwing STATE.
  const usable = (): boolean =>
    engine.state !== 'DISPOSING' && engine.state !== 'DISPOSED' && engine.state !== 'FAILED';
  const stops = [
    portal.on('pause', () => {
      if (usable()) engine.pause();
    }),
    portal.on('resume', () => {
      if (usable()) engine.resume();
    }),
    portal.on('mute', ({ muted }) => {
      if (usable()) engine.audio.setVolume(muted ? 0 : volume);
    }),
  ];
  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}

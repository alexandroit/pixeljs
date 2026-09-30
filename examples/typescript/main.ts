import { createEngine } from '@pixeljs/core';
import {
  runGame,
  GAME_WIDTH,
  GAME_HEIGHT,
  type DemoEngine,
  type GameController,
  type GameSnapshot,
} from '../javascript/game.js';
import { bindGameControls, unlockAudioOnGesture } from '../javascript/controls.js';

// The typed consumer uses the same Pac-Man game as the JavaScript example.
// Its controller declarations preserve the actual @pixeljs/core engine type.
const canvas = document.querySelector<HTMLCanvasElement>('canvas');
const status = document.querySelector<HTMLElement>('[data-status]');
const pause = document.querySelector<HTMLButtonElement>('[data-pause]');
const restart = document.querySelector<HTMLButtonElement>('[data-restart]');
const mute = document.querySelector<HTMLButtonElement>('[data-mute]');
const screenshot = document.querySelector<HTMLButtonElement>('[data-screenshot]');
if (!canvas || !status || !pause || !restart || !mute || !screenshot)
  throw new Error('The example markup is incomplete.');

let game: GameController | undefined;
let engine: DemoEngine | undefined;
let paused = false;
const unbindControls = bindGameControls(canvas, document, () => game);
const unbindAudio = unlockAudioOnGesture(document, () => game);
try {
  engine = await createEngine({
    canvas,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    onError: (error: unknown): void => {
      status.textContent = `Runtime error: ${String(error)}`;
    },
  });
  // The assets live with the JavaScript example; paths resolve against this page.
  const assets = await engine.loadAssets('../javascript/assets/assets.json');
  const running = runGame(engine, {
    assets,
    onProgress: (snapshot: GameSnapshot): void => {
      status.textContent = `Score ${snapshot.score} · Lives ${snapshot.lives} · Level ${snapshot.level} · ${snapshot.status}`;
    },
  });
  game = running;
  for (const button of [pause, restart, mute, screenshot]) button.disabled = false;
  canvas.focus({ preventScroll: true });

  restart.addEventListener('click', (): void => {
    running.restart();
    if (paused) running.resume();
    paused = false;
    pause.textContent = 'Pause';
    canvas.focus({ preventScroll: true });
  });
  pause.addEventListener('click', (): void => {
    paused = !paused;
    if (paused) running.pause();
    else running.resume();
    pause.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) canvas.focus({ preventScroll: true });
  });
  mute.addEventListener('click', (): void => {
    const muted = mute.getAttribute('aria-pressed') !== 'true';
    running.engine.audio.setVolume(muted ? 0 : 1);
    mute.setAttribute('aria-pressed', String(muted));
    canvas.focus({ preventScroll: true });
  });
  // A PNG of the last presented frame, three times its size.
  screenshot.addEventListener('click', (): void => {
    void (async (): Promise<void> => {
      try {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(await running.engine.capture({ scale: 3 }));
        link.download = 'pacman.png';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      } catch (error: unknown) {
        status.textContent = `Screenshot failed: ${String(error)}`;
      }
      canvas.focus({ preventScroll: true });
    })();
  });
  window.addEventListener(
    'pagehide',
    (): void => {
      unbindControls();
      unbindAudio();
      void running.dispose();
    },
    { once: true },
  );
} catch (error: unknown) {
  await engine?.dispose();
  status.textContent = `Unable to start PixelJS: ${String(error)}`;
}

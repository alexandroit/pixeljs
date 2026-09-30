import { createEngine } from '@pixeljs/core';
import { runGame, GAME_MANIFEST, GAME_WIDTH, GAME_HEIGHT } from './game.js';
import { bindGameControls, unlockAudioOnGesture } from './controls.js';

const canvas = document.querySelector('canvas');
const status = document.querySelector('[data-status]');
const pause = document.querySelector('[data-pause]');
const restart = document.querySelector('[data-restart]');
const mute = document.querySelector('[data-mute]');
const screenshot = document.querySelector('[data-screenshot]');
let game;
let engine;
let paused = false;
const unbindControls = bindGameControls(canvas, document, () => game);
const unbindAudio = unlockAudioOnGesture(document, () => game);

try {
  engine = await createEngine({
    canvas,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    onError: (error) => {
      status.textContent = `Runtime error: ${String(error)}`;
    },
  });
  // Images, the maze tilemap, the HUD font, sounds and music: all or nothing.
  const assets = await engine.loadAssets(GAME_MANIFEST);
  game = runGame(engine, {
    assets,
    onProgress: (snapshot) => {
      status.textContent = `Score ${snapshot.score} · Lives ${snapshot.lives} · Level ${snapshot.level} · ${snapshot.status}`;
    },
  });
  for (const button of [pause, restart, mute, screenshot]) button.disabled = false;
  canvas.focus({ preventScroll: true });

  restart.addEventListener('click', () => {
    game.restart();
    if (paused) game.resume();
    paused = false;
    pause.textContent = 'Pause';
    canvas.focus({ preventScroll: true });
  });
  pause.addEventListener('click', () => {
    paused = !paused;
    if (paused) game.pause();
    else game.resume();
    pause.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) canvas.focus({ preventScroll: true });
  });
  mute.addEventListener('click', () => {
    const muted = mute.getAttribute('aria-pressed') !== 'true';
    engine.audio.setVolume(muted ? 0 : 1);
    mute.setAttribute('aria-pressed', String(muted));
    canvas.focus({ preventScroll: true });
  });
  // A PNG of the last presented frame, three times its size.
  screenshot.addEventListener('click', async () => {
    try {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await engine.capture({ scale: 3 }));
      link.download = 'pacman.png';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (error) {
      status.textContent = `Screenshot failed: ${String(error)}`;
    }
    canvas.focus({ preventScroll: true });
  });
  window.addEventListener(
    'pagehide',
    () => {
      unbindControls();
      unbindAudio();
      void game.dispose();
    },
    { once: true },
  );
} catch (error) {
  await engine?.dispose();
  status.textContent = `Unable to start PixelJS: ${String(error)}`;
}

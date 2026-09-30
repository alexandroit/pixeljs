import {
  mountGame,
  type GameController,
  type GameSnapshot,
} from '../../../examples/javascript/game.js';
import { bindGameControls, unlockAudioOnGesture } from '../../../examples/javascript/controls.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Required page element is missing: ${id}`);
  return found as T;
}

const canvas = element<HTMLCanvasElement>('game');
const loading = element<HTMLDivElement>('game-loading');
const stateLabel = element<HTMLElement>('game-state');
const message = element<HTMLElement>('runtime-message');
const mission = element<HTMLElement>('mission-status');
const score = element<HTMLElement>('score-count');
const lives = element<HTMLElement>('lives-count');
const level = element<HTMLElement>('level-count');
const pellets = element<HTMLElement>('pellets-count');
const gameStatus = element<HTMLElement>('game-status');
const directionButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('[data-direction]'),
);
const pauseButton = element<HTMLButtonElement>('pause-game');
const restartButton = element<HTMLButtonElement>('restart-game');
const disposeButton = element<HTMLButtonElement>('dispose-game');
const muteButton = element<HTMLButtonElement>('mute-game');
const captureButton = element<HTMLButtonElement>('capture-game');
let game: GameController | undefined;
let paused = false;
let muted = false;
let generation = 0;
let closing = false;
let lastGameStatus = 'READY · Choose a direction to play';

function controls(disabled: boolean): void {
  pauseButton.disabled = disabled;
  restartButton.disabled = disabled;
  disposeButton.disabled = disabled;
  muteButton.disabled = disabled;
  captureButton.disabled = disabled;
  for (const button of directionButtons) button.disabled = disabled;
}

function displayError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  loading.hidden = false;
  loading.textContent = `Pac-Man could not run: ${detail}`;
  message.textContent = `Runtime error: ${detail}. Use Restart to try a new instance.`;
  stateLabel.textContent = 'ERROR';
}

async function restart(): Promise<void> {
  const thisGeneration = ++generation;
  controls(true);
  loading.hidden = false;
  loading.textContent = 'Loading the arcade…';
  stateLabel.textContent = 'LOADING';
  try {
    const previous = game;
    game = undefined;
    if (previous) await previous.dispose();
    const next = await mountGame(canvas, {
      manifest: './examples/javascript/assets/assets.json',
      onProgress(snapshot: GameSnapshot): void {
        score.textContent = snapshot.score.toLocaleString('en');
        lives.textContent = String(snapshot.lives);
        level.textContent = String(snapshot.level);
        pellets.textContent = String(snapshot.remaining);
        lastGameStatus =
          snapshot.status === 'ready'
            ? 'READY · Choose a direction to play'
            : snapshot.status.replaceAll('-', ' ').toUpperCase();
        if (!paused) {
          gameStatus.textContent = lastGameStatus;
        }
        const messages: Record<GameSnapshot['status'], string> = {
          ready: 'Use the arrows, WASD, a swipe, or the direction buttons to begin.',
          playing: 'Clear the maze. Power pellets let you chase the ghosts.',
          dying: 'Caught! Get ready for another try.',
          'level-clear': 'Maze cleared! The next level is on its way.',
          'game-over': 'Game over. Press Restart or Enter to play again.',
        };
        if (mission.textContent !== messages[snapshot.status])
          mission.textContent = messages[snapshot.status];
      },
      onError: displayError,
    });
    if (closing || thisGeneration !== generation) {
      await next.dispose();
      return;
    }
    game = next;
    next.engine.audio.setVolume(muted ? 0 : 1);
    paused = false;
    pauseButton.textContent = 'Pause';
    lastGameStatus = 'READY · Choose a direction to play';
    gameStatus.textContent = lastGameStatus;
    loading.hidden = true;
    controls(false);
    updateStats();
    canvas.focus({ preventScroll: true });
    message.textContent =
      'Pac-Man is ready. Play with your keyboard, swipe, or use the direction buttons.';
  } catch (error: unknown) {
    displayError(error);
    restartButton.disabled = false;
  }
}

function updateStats(): void {
  if (!game) return;
  const stats = game.engine.getStats();
  stateLabel.textContent = String(game.engine.state).toUpperCase();
  element<HTMLElement>('renderer-stat').textContent = stats.renderer;
  element<HTMLElement>('memory-stat').textContent = `${(stats.coreBytes / 1024).toFixed(1)} KiB`;
  element<HTMLElement>('frame-stat').textContent = stats.frames.toLocaleString('en');
}

pauseButton.addEventListener('click', (): void => {
  if (!game) return;
  try {
    paused = !paused;
    if (paused) {
      game.pause();
      pauseButton.textContent = 'Resume';
      gameStatus.textContent = `${lastGameStatus} (ENGINE PAUSED)`;
      message.textContent = 'Paused. Resume keeps the same engine and game state.';
    } else {
      game.resume();
      pauseButton.textContent = 'Pause';
      gameStatus.textContent = lastGameStatus;
      message.textContent = 'Resumed. Back to the maze.';
    }
    updateStats();
    if (!paused) canvas.focus({ preventScroll: true });
  } catch (error: unknown) {
    displayError(error);
  }
});

restartButton.addEventListener('click', (): void => {
  void restart();
});
disposeButton.addEventListener('click', (): void => {
  void (async (): Promise<void> => {
    ++generation;
    controls(true);
    const previous = game;
    game = undefined;
    paused = false;
    pauseButton.textContent = 'Pause';
    try {
      if (previous) await previous.dispose();
      stateLabel.textContent = 'DISPOSED';
      gameStatus.textContent = 'DISPOSED · Arcade closed';
      loading.hidden = false;
      loading.textContent = 'Arcade closed. Press Restart to play again.';
      message.textContent =
        'Disposed. Scheduling, listeners, and the engine instance have been released.';
      element<HTMLElement>('memory-stat').textContent = 'Released';
    } catch (error: unknown) {
      displayError(error);
    }
    restartButton.disabled = false;
  })();
});
muteButton.addEventListener('click', (): void => {
  muted = !muted;
  muteButton.setAttribute('aria-pressed', String(muted));
  game?.engine.audio.setVolume(muted ? 0 : 1);
  message.textContent = muted ? 'Sound muted.' : 'Sound on.';
  canvas.focus({ preventScroll: true });
});
// engine.capture() encodes the last presented frame as a PNG.
captureButton.addEventListener('click', (): void => {
  void (async (): Promise<void> => {
    if (!game) return;
    try {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await game.engine.capture({ scale: 3 }));
      link.download = 'pixeljs-pacman.png';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      message.textContent = 'Screenshot saved as a PNG, three times the game size.';
    } catch (error: unknown) {
      message.textContent = `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    canvas.focus({ preventScroll: true });
  })();
});
const unbindControls = bindGameControls(canvas, document, () => game);
const unbindAudio = unlockAudioOnGesture(document, () => game);
const statsTimer = window.setInterval(updateStats, 750);
window.addEventListener(
  'pagehide',
  (): void => {
    closing = true;
    ++generation;
    window.clearInterval(statsTimer);
    unbindControls();
    unbindAudio();
    const previous = game;
    game = undefined;
    void previous?.dispose();
  },
  { once: true },
);

// These are source files, not duplicated snippet strings. The JS game module is
// also imported above, so the displayed drawing/input logic is the running game.
const sourceText = element<HTMLElement>('source-text');
const sourcePanel = element<HTMLElement>('source-code');
const sourceName = element<HTMLElement>('source-filename');
const copyButton = element<HTMLButtonElement>('copy-source');
const copyStatus = element<HTMLElement>('copy-status');
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-language]'));
let currentSource = '';
let sourceRequest = 0;

async function selectSource(language: string): Promise<void> {
  const request = ++sourceRequest;
  const typescript = language === 'typescript';
  const path = typescript ? 'examples/typescript/main.ts' : 'examples/javascript/game.js';
  const label = typescript ? 'typescript' : 'javascript';
  for (const tab of tabs) {
    const selected = tab.dataset.language === label;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  sourcePanel.setAttribute('aria-labelledby', `tab-${label}`);
  sourceName.textContent = path;
  sourceText.textContent = 'Loading actual example source…';
  currentSource = '';
  copyButton.disabled = true;
  try {
    const response = await fetch(new URL(`./${path}`, document.baseURI));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (request !== sourceRequest) return;
    currentSource = text;
    sourceText.textContent = text;
    copyButton.disabled = false;
    copyStatus.textContent = typescript
      ? 'Actual typed consumer. It imports the same game module as the JavaScript example.'
      : 'Actual game module imported by this live playground. No separate snippet to drift.';
  } catch (error: unknown) {
    if (request !== sourceRequest) return;
    sourceText.textContent = 'The example source could not be loaded.';
    copyStatus.textContent = `Source fetch failed: ${String(error)}`;
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', (): void => {
    void selectSource(tab.dataset.language ?? 'javascript');
  });
  tab.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (tabs.indexOf(tab) + 1) % tabs.length;
    const next = tabs[nextIndex];
    if (next) {
      next.focus();
      void selectSource(next.dataset.language ?? 'javascript');
    }
  });
}

copyButton.addEventListener('click', (): void => {
  void (async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error('Clipboard access is unavailable in this context');
      await navigator.clipboard.writeText(currentSource);
      copyStatus.textContent = 'Source copied.';
    } catch {
      copyStatus.textContent =
        'Clipboard access is unavailable. Select the source text to copy it manually.';
      sourcePanel.focus();
    }
  })();
});

void selectSource('javascript');
void restart();

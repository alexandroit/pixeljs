import type { GameController } from './game.js';

export function bindGameControls(
  canvas: HTMLCanvasElement,
  root: Document | HTMLElement,
  getGame: () => GameController | undefined,
): () => void;

export function unlockAudioOnGesture(
  root: Document | HTMLElement,
  getGame: () => GameController | undefined,
): () => void;

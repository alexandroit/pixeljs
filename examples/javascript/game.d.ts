import { createEngine, type AssetBundle, type AssetManifest } from '@pixeljs/core';
import type { Direction, GameSnapshot } from './pacman-model.js';
export { GAME_WIDTH, GAME_HEIGHT } from './pacman-model.js';
export type { Direction, GameSnapshot } from './pacman-model.js';
export type DemoEngine = Awaited<ReturnType<typeof createEngine>>;
/** Where mountGame() finds the asset manifest by default, relative to the page. */
export declare const GAME_MANIFEST: string;
export interface GameOptions {
  renderer?: 'auto' | 'webgl2' | 'canvas2d';
  /** The game's asset manifest: a URL (default GAME_MANIFEST) or the manifest object. */
  manifest?: string | AssetManifest;
  onProgress?: (snapshot: GameSnapshot) => void;
  onError?: (error: unknown) => void;
}
export interface RunOptions {
  /** The bundle engine.loadAssets() returned for the game's manifest. */
  assets: AssetBundle;
  onProgress?: (snapshot: GameSnapshot) => void;
}
export interface GameController {
  readonly engine: DemoEngine;
  readonly snapshot: GameSnapshot;
  setDirection(direction: Direction): void;
  restart(): void;
  pause(): void;
  resume(): void;
  unlockAudio(): Promise<void>;
  dispose(): Promise<void>;
}
export function mountGame(
  canvas: HTMLCanvasElement,
  options?: GameOptions,
): Promise<GameController>;
export function runGame(engine: DemoEngine, options: RunOptions): GameController;

export type Direction = 'up' | 'down' | 'left' | 'right';
export type GameStatus = 'ready' | 'playing' | 'dying' | 'level-clear' | 'game-over';
export interface GameSnapshot {
  readonly score: number;
  readonly lives: number;
  readonly level: number;
  readonly remaining: number;
  readonly status: GameStatus;
}
export interface Actor {
  x: number;
  y: number;
  direction: Direction;
  moving?: boolean;
}
export interface Player extends Actor {
  queued: Direction | null;
  moving: boolean;
}
export interface Ghost extends Actor {
  name: string;
  color: number;
  index: number;
  state: 'waiting' | 'active' | 'eyes' | 'recovering';
  timer: number;
}
export interface GameModel {
  score: number;
  lives: number;
  level: number;
  remaining: number;
  status: GameStatus;
  elapsed: number;
  frightened: number;
  ghostCombo: number;
  mode: 'scatter' | 'chase';
  modeTimer: number;
  phaseTimer: number;
  player: Player;
  ghosts: Ghost[];
  pellets: Uint8Array;
  distances: Int16Array;
  searchQueue: Uint16Array;
}
export const GAME_WIDTH: 224;
export const GAME_HEIGHT: 256;
export const TILE_SIZE: 8;
export const MAZE_X: 4;
export const MAZE_Y: 24;
export const MAZE_COLUMNS: 27;
export const MAZE_ROWS: 27;
export const MAZE: readonly string[];
export const DIRECTIONS: Readonly<
  Record<Direction, Readonly<{ x: number; y: number; opposite: Direction }>>
>;
export function isWalkable(x: number, y: number, allowHouse?: boolean): boolean;
export function createGameModel(): GameModel;
export function getSnapshot(model: GameModel): GameSnapshot;
export function setDirection(model: GameModel, direction: Direction): void;
export function advanceModel(model: GameModel, dt: number): void;
export function restartModel(model: GameModel): void;

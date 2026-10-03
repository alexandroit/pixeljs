// The rules of the game. Replace these rules with your game's: the modes and the
// screen only use the functions below, so chess, checkers, dominoes or any other
// turn-based game for two players fits the same interface. These placeholder rules
// are tic-tac-toe.
//
// A state is plain data and a move is any JSON value (here, a cell from 0 to 8), so
// both can travel between the players' games in online play.
import { createRandom } from '@pixeljs/core/portal';

/** The two players are sides 0 and 1. */
export const SIDES = 2;

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/** The first state of a game. The seed decides who starts, so online players agree. */
export function createState(seed) {
  return { cells: Array(9).fill(-1), turn: createRandom(seed).int(SIDES) };
}

/** The moves the side to play can make: none once the game is over. */
export function legalMoves(state) {
  if (result(state).over) return [];
  return state.cells.flatMap((cell, index) => (cell < 0 ? [index] : []));
}

/** The state after a legal move; the state itself never changes. */
export function applyMove(state, move) {
  const cells = [...state.cells];
  cells[move] = state.turn;
  return { cells, turn: 1 - state.turn };
}

/** `{ over: false }`, `{ over: true, winner: side }` or `{ over: true, draw: true }`. */
export function result(state) {
  for (const [a, b, c] of LINES) {
    const side = state.cells[a];
    if (side >= 0 && side === state.cells[b] && side === state.cells[c])
      return { over: true, winner: side };
  }
  return state.cells.includes(-1) ? { over: false } : { over: true, draw: true };
}

/** The state as short text for online messages: a character per cell, then the side to play. */
export function serialize(state) {
  return state.cells.map((cell) => (cell < 0 ? '.' : cell)).join('') + state.turn;
}

/** The state that serialize() wrote, or null for anything else: never trust a message. */
export function parse(text) {
  if (typeof text !== 'string' || !/^[.01]{9}[01]$/.test(text)) return null;
  const cells = [...text.slice(0, 9)].map((cell) => (cell === '.' ? -1 : Number(cell)));
  return { cells, turn: Number(text[9]) };
}

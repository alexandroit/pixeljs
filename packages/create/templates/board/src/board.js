// The board on screen: drawing it and choosing a move with the keyboard, a gamepad or
// a tap. Replace it together with the rules: it draws a state and returns the rules'
// moves.
import { legalMoves, result } from './rules.js';

const CELL = 40;
const LEFT = 100; // the 3 × 3 board is 120 pixels wide, in the middle of the screen
const TOP = 22;
const COLORS = [10, 5]; // the colors of sides 0 (X) and 1 (O)

export function createBoard(engine) {
  const g = engine.graphics;
  const input = engine.input;
  const pressed = (...codes) => codes.some((code) => input.wasPressed(code));
  let cursor = 4; // the highlighted cell

  function mark(side, x, y, size) {
    if (side === 0)
      for (const d of [-1, 0, 1]) {
        g.line(x - size + d, y - size, x + size + d, y + size, COLORS[0]);
        g.line(x - size + d, y + size, x + size + d, y - size, COLORS[0]);
      }
    else for (const r of [size, size + 1]) g.circle(x, y, r, COLORS[1]);
  }

  return {
    /** The legal move the player chose during this update, or undefined. */
    choose(state) {
      const moves = legalMoves(state);
      const column = cursor % 3;
      if (pressed('ArrowLeft', 'KeyA') || input.wasButtonPressed('Left'))
        cursor += column === 0 ? 2 : -1;
      if (pressed('ArrowRight', 'KeyD') || input.wasButtonPressed('Right'))
        cursor += column === 2 ? -2 : 1;
      if (pressed('ArrowUp', 'KeyW') || input.wasButtonPressed('Up')) cursor = (cursor + 6) % 9;
      if (pressed('ArrowDown', 'KeyS') || input.wasButtonPressed('Down')) cursor = (cursor + 3) % 9;
      const tap = input.pointers.find((pointer) => pointer.pressed);
      const x = tap ? Math.floor((tap.x - LEFT) / CELL) : -1;
      const y = tap ? Math.floor((tap.y - TOP) / CELL) : -1;
      if (x >= 0 && x < 3 && y >= 0 && y < 3) {
        cursor = y * 3 + x;
        if (moves.includes(cursor)) return cursor;
      }
      if (pressed('Enter', 'Space') || input.wasButtonPressed('A'))
        if (moves.includes(cursor)) return cursor;
      return undefined;
    },
    /** Draws the board, the players' names and, while the player may move, the cursor. */
    draw(state, labels, active) {
      g.rect(LEFT - 4, TOP - 4, CELL * 3 + 8, CELL * 3 + 8, 0);
      for (let i = 1; i < 3; i++) {
        g.rect(LEFT + i * CELL - 1, TOP, 2, CELL * 3, 2);
        g.rect(LEFT, TOP + i * CELL - 1, CELL * 3, 2, 2);
      }
      if (active)
        g.rectb(LEFT + (cursor % 3) * CELL + 3, TOP + Math.floor(cursor / 3) * CELL + 3, 34, 34, 7);
      state.cells.forEach((side, cell) => {
        if (side >= 0)
          mark(side, LEFT + (cell % 3) * CELL + 20, TOP + Math.floor(cell / 3) * CELL + 20, 10);
      });
      const over = result(state).over;
      labels.forEach((label, side) => {
        const x = side === 0 ? 48 : 272;
        mark(side, x, 60, 8);
        const color = !over && state.turn === side ? 7 : 3;
        g.text(x - (engine.measureText(label).width >> 1), 80, label, color);
      });
    },
  };
}

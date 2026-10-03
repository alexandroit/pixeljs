// Solo: you against the computer. The computer only uses the rules' functions, so it
// keeps working when you replace the rules: it wins when it can, avoids the moves that
// let you win at once, and picks at random among the rest.
import { createRandom } from '@pixeljs/core/portal';
import { applyMove, createState, legalMoves, result } from '../rules.js';

const YOU = 0;
const THINK = 30; // updates (half a second) before the computer plays

/** The computer's move. A seeded generator makes its games reproducible. */
export function chooseMove(state, random) {
  const moves = legalMoves(state);
  const side = state.turn;
  const win = moves.find((move) => result(applyMove(state, move)).winner === side);
  if (win !== undefined) return win;
  const safe = moves.filter((move) => {
    const next = applyMove(state, move);
    return !legalMoves(next).some((reply) => result(applyMove(next, reply)).winner === next.turn);
  });
  return random.pick(safe.length > 0 ? safe : moves);
}

export function createSolo(seed) {
  const random = createRandom(seed);
  let state = createState(random.next());
  let wait = THINK;
  return {
    labels: ['YOU', 'COMPUTER'],
    get state() {
      return state;
    },
    canPlay: () => state.turn === YOU && !result(state).over,
    play(move) {
      state = applyMove(state, move);
      wait = THINK;
    },
    update() {
      if (state.turn !== YOU && !result(state).over && --wait <= 0)
        state = applyMove(state, chooseMove(state, random));
    },
    status() {
      const outcome = result(state);
      if (outcome.draw) return 'A DRAW! ENTER: PLAY AGAIN';
      if (outcome.over)
        return `${outcome.winner === YOU ? 'YOU WIN' : 'YOU LOSE'}! ENTER: PLAY AGAIN`;
      return state.turn === YOU ? 'YOUR TURN' : 'THE COMPUTER IS THINKING...';
    },
    next() {
      if (!result(state).over) return;
      state = createState(random.next());
      wait = THINK;
    },
    close() {},
  };
}

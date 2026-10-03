// Local: two players take turns on one device (hot seat).
import { createRandom } from '@pixeljs/core/portal';
import { applyMove, createState, result } from '../rules.js';

export function createLocal(seed) {
  const random = createRandom(seed);
  let state = createState(random.next());
  return {
    labels: ['PLAYER 1', 'PLAYER 2'],
    get state() {
      return state;
    },
    canPlay: () => !result(state).over,
    play(move) {
      state = applyMove(state, move);
    },
    update() {},
    status() {
      const outcome = result(state);
      if (outcome.draw) return 'A DRAW! ENTER: PLAY AGAIN';
      if (outcome.over) return `PLAYER ${outcome.winner + 1} WINS! ENTER: PLAY AGAIN`;
      return `PLAYER ${state.turn + 1}, YOUR TURN`;
    },
    next() {
      if (result(state).over) state = createState(random.next());
    },
    close() {},
  };
}

// The game logic of the starters that @pixeljs/create ships for the PixelJS portal,
// run in Node with a stand-in engine and portal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  LEVELS,
  createHero,
  createLevel,
  step,
} from '../packages/create/templates/portal/src/world.js';
import { createGame } from '../packages/create/templates/portal/src/game.js';
import {
  SIDES,
  applyMove,
  createState,
  legalMoves,
  parse,
  result,
  serialize,
} from '../packages/create/templates/board/src/rules.js';
import { chooseMove, createSolo } from '../packages/create/templates/board/src/modes/solo.js';
import { createLocal } from '../packages/create/templates/board/src/modes/local.js';
import { createOnline } from '../packages/create/templates/board/src/modes/online.js';
import { createRandom } from '../packages/core/dist/portal.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const CONTROLS = [-1, 0, 1].flatMap((direction) =>
  [false, true].map((jump) => ({ left: direction < 0, right: direction > 0, jump })),
);

/** Breadth-first search of every hero state: the shortest way to the flag and the coins reached. */
function explore(def) {
  const level = createLevel(def);
  const coins = level.coins.map((coin) => ({ ...coin }));
  level.coins = [];
  const key = (hero) => `${hero.x},${hero.y},${hero.vy},${hero.ground}`;
  const start = createHero(level);
  const seen = new Set([key(start)]);
  const reached = new Set();
  let frontier = [{ hero: start, path: null }];
  let plan = null;
  while (frontier.length > 0) {
    const next = [];
    for (const node of frontier) {
      for (const controls of CONTROLS) {
        const hero = { ...node.hero };
        const event = step(level, hero, controls);
        if (event === 'hurt') continue;
        const path = { controls, previous: node.path };
        const x = Math.floor(hero.x / 16);
        const y = Math.floor(hero.y / 16);
        coins.forEach((coin, index) => {
          if (x < coin.x + 4 && x + 10 > coin.x - 4 && y < coin.y + 4 && y + 12 > coin.y - 4)
            reached.add(index);
        });
        if (event === 'goal') {
          if (!plan) {
            plan = [];
            for (let link = path; link; link = link.previous) plan.unshift(link.controls);
          }
          continue;
        }
        if (!seen.has(key(hero))) {
          seen.add(key(hero));
          next.push({ hero, path });
        }
      }
    }
    frontier = next;
  }
  return { plan, coins: reached.size, total: coins.length };
}

test('every level of the portal starter can be finished, within par, with every coin', async () => {
  const manifest = JSON.parse(
    await readFile('packages/create/templates/portal/public/pixeljs.json', 'utf8'),
  );
  assert.deepEqual(
    LEVELS.map((level) => level.id),
    manifest.levels.map((level) => level.id),
  );
  for (const def of LEVELS) {
    assert.ok(def.map.every((row) => row.length === 20) && def.map.length <= 11, def.id);
    const { plan, coins, total } = explore(def);
    assert.ok(plan, `${def.id} can be finished`);
    assert.ok(total > 0 && coins === total, `every coin of ${def.id} can be reached`);
    assert.ok((plan.length * 1000) / 60 < def.par, `${def.id} can be finished within par`);
    // Integrity: a run lasts longer than the manifest's min_run_ms and the fastest board's min.
    assert.ok((plan.length * 1000) / 60 > manifest.integrity.min_run_ms);
  }
});

/** An engine for game.js: input you control, and drawing that only records text. */
function fakeEngine() {
  const held = new Set();
  let pressed = new Set();
  const texts = [];
  const engine = {
    graphics: new Proxy(
      {},
      {
        get:
          (_, name) =>
          (...args) => {
            if (name === 'text') texts.push(args[2]);
          },
      },
    ),
    input: {
      isDown: (code) => held.has(code),
      wasPressed: (code) => pressed.has(code),
      isButtonDown: () => false,
      wasButtonPressed: () => false,
      axis: () => 0,
      pointers: [],
    },
    audio: { createSound: (options) => options, play: () => {} },
    measureText: (text) => ({ width: text.length * 8, height: text ? 8 : 0 }),
  };
  return {
    engine,
    texts,
    /** Sets the keys held and pressed in the next update. */
    keys(down = [], tapped = []) {
      held.clear();
      for (const code of [...down, ...tapped]) held.add(code);
      pressed = new Set(tapped);
    },
  };
}

/** A portal that records every call and answers like PixelJS does for a signed-in player. */
function fakePortal(saved = { data: null, rev: 0, schema: 0 }, records = {}) {
  const calls = [];
  let runs = 0;
  return {
    calls,
    inPortal: true,
    async levelStart(level) {
      calls.push(['levelStart', level]);
      return `run-${++runs}`;
    },
    async levelEnd(run, outcome) {
      calls.push(['levelEnd', run, outcome]);
      return { ok: true, recorded: true, newBest: { 'level-score': true }, rank: 3 };
    },
    async levels() {
      return records;
    },
    async load(slot) {
      calls.push(['load', slot]);
      return saved;
    },
    async save(slot, data, options) {
      calls.push(['save', slot, JSON.parse(data), options]);
      return { ok: true, rev: options.rev + 1 };
    },
  };
}

test('the portal starter reports every run, its result and the saved progress', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { engine, texts, keys } = fakeEngine();
  const portal = fakePortal();
  const game = createGame(engine, portal);
  await game.loadProgress();
  game.setPlayer({ signedIn: true, handle: 'moonrunner' });
  const tick = (down = [], tapped = []) => {
    keys(down, tapped);
    now += 17; // real time runs a little ahead of game time
    game.update();
    texts.length = 0;
    game.draw();
  };
  tick();
  assert.ok(texts.includes('HELLO, MOONRUNNER!'));
  assert.ok(texts.includes('LOCKED'), 'the next levels are locked');

  // A level the player has not unlocked cannot be selected from the portal.
  game.select('1-3');
  assert.deepEqual(portal.calls, [['load', 'progress']]);

  // Enter starts the first level; the plan of the search finishes it.
  tick([], ['Enter']);
  assert.deepEqual(portal.calls.at(-1), ['levelStart', '1-1']);
  const { plan } = explore(LEVELS[0]);
  for (const controls of plan) {
    const down = [];
    if (controls.left) down.push('ArrowLeft');
    if (controls.right) down.push('ArrowRight');
    if (controls.jump) down.push('ArrowUp');
    tick(down);
  }
  await flush();
  const [name, run, ended] = portal.calls.find((call) => call[0] === 'levelEnd');
  assert.equal(name, 'levelEnd');
  assert.equal(run, 'run-1');
  const timeMs = Math.round((plan.length * 1000) / 60);
  assert.equal(ended.outcome, 'complete');
  assert.equal(ended.timeMs, timeMs);
  assert.equal(ended.scores.fastest, timeMs);
  assert.equal(
    ended.scores['level-score'],
    1000 + ended.stats.coins * 100 + Math.floor((LEVELS[0].par * 2 - timeMs) / 10),
  );
  assert.equal(ended.stars, 2 + (ended.stats.coins === 3 ? 1 : 0), 'finished and within par');
  const save = portal.calls.find((call) => call[0] === 'save');
  assert.deepEqual(save, [
    'save',
    'progress',
    { '1-1': { done: true, stars: ended.stars, score: ended.scores['level-score'] } },
    { rev: 0 },
  ]);
  tick();
  assert.ok(texts.includes('LEVEL COMPLETE!'));
  assert.ok(texts.some((text) => text.startsWith('NEW BEST!')));

  // Back to the menu: the second level is open, and leaving it is a quit.
  tick([], ['Enter']);
  game.select('1-2');
  assert.deepEqual(portal.calls.at(-1), ['levelStart', '1-2']);
  for (let i = 0; i < 30; i++) tick();
  tick([], ['Escape']);
  await flush();
  assert.deepEqual(portal.calls.at(-1), ['levelEnd', 'run-2', { outcome: 'quit', timeMs: 500 }]);

  // Walking into the first gap fails the level, with no score.
  tick([], ['ArrowUp']);
  tick([], ['Enter']);
  assert.deepEqual(portal.calls.at(-1), ['levelStart', '1-1']);
  for (let i = 0; i < 600 && portal.calls.at(-1)[0] !== 'levelEnd'; i++) {
    tick(['ArrowRight']);
    await flush();
  }
  const failed = portal.calls.at(-1);
  assert.equal(failed[2].outcome, 'fail');
  assert.deepEqual(failed[2].scores, {});
  assert.equal(failed[2].stars, 0);
  assert.equal(
    portal.calls.filter((call) => call[0] === 'save').length,
    1,
    'failures save nothing',
  );
});

test('the portal starter merges the save slot with the portal records', async () => {
  const saved = {
    data: JSON.stringify({ '1-1': { done: true, stars: 2, score: 1500 }, extra: { done: true } }),
    rev: 4,
    schema: 1,
  };
  const records = { '1-2': { completed: true, stars: 3, best: { 'level-score': 2100 } } };
  const portal = fakePortal(saved, records);
  const { engine } = fakeEngine();
  const game = createGame(engine, portal);
  await game.loadProgress();
  game.select('1-3'); // open: the portal recorded 1-2 as completed
  assert.deepEqual(portal.calls.at(-1), ['levelStart', '1-3']);

  const damaged = fakePortal({ data: '{not json', rev: 2, schema: 1 });
  const other = createGame(fakeEngine().engine, damaged);
  await other.loadProgress();
  other.select('1-2');
  assert.deepEqual(damaged.calls, [['load', 'progress']], 'a damaged save starts over');
});

test('the board rules: tic-tac-toe behind createState, legalMoves, applyMove and result', () => {
  assert.equal(SIDES, 2);
  const starters = new Set();
  for (let seed = 0; seed < 32; seed++) {
    const state = createState(seed);
    assert.deepEqual(state, createState(seed), 'the seed decides who starts');
    assert.equal(state.turn, createRandom(seed).int(2));
    starters.add(state.turn);
    assert.deepEqual(legalMoves(state), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(result(state), { over: false });
  }
  assert.deepEqual([...starters].sort(), [0, 1]);

  const first = { cells: Array(9).fill(-1), turn: 0 };
  const next = applyMove(first, 4);
  assert.deepEqual(first.cells, Array(9).fill(-1), 'applyMove never changes the state');
  assert.equal(next.cells[4], 0);
  assert.equal(next.turn, 1);
  assert.ok(!legalMoves(next).includes(4));

  const play = (moves, turn = 0) =>
    moves.reduce((state, move) => applyMove(state, move), { cells: Array(9).fill(-1), turn });
  assert.deepEqual(result(play([0, 3, 1, 4, 2])), { over: true, winner: 0 }); // a row
  assert.deepEqual(result(play([0, 1, 3, 2, 6])), { over: true, winner: 0 }); // a column
  assert.deepEqual(result(play([4, 0, 8, 2, 7, 1])), { over: true, winner: 1 }); // a row for O
  assert.deepEqual(result(play([2, 0, 4, 1, 6])), { over: true, winner: 0 }); // a diagonal
  const draw = play([0, 1, 2, 4, 3, 5, 7, 6, 8]);
  assert.deepEqual(result(draw), { over: true, draw: true });
  assert.deepEqual(legalMoves(draw), []);
  assert.deepEqual(legalMoves(play([0, 3, 1, 4, 2])), [], 'no moves once the game is won');

  const middle = play([4, 0, 8]);
  assert.equal(serialize(middle), '1...0...01');
  assert.deepEqual(parse(serialize(middle)), middle);
  for (const text of ['', '1...0...0', '1...0...012', '1...0...02', 'x........0', 7, null])
    assert.equal(parse(text), null, `parse(${JSON.stringify(text)})`);
});

test('the computer player wins when it can, blocks a loss and plays legal moves', () => {
  const random = createRandom(7);
  const state = (cells, turn) => ({ cells, turn });
  // O to play can win on cell 2, and must otherwise block X on cell 5.
  assert.equal(chooseMove(state([1, 1, -1, 0, 0, -1, -1, -1, -1], 1), random), 2);
  assert.equal(chooseMove(state([1, -1, -1, 0, 0, -1, -1, 1, -1], 1), random), 5);
  for (let seed = 0; seed < 20; seed++) {
    const solo = createSolo(seed);
    const think = createRandom(seed + 100);
    for (let turn = 0; turn < 40 && !result(solo.state).over; turn++) {
      if (solo.canPlay()) {
        const move = think.pick(legalMoves(solo.state));
        solo.play(move);
        assert.ok(!solo.canPlay(), 'the computer plays next');
      } else for (let i = 0; i < 30; i++) solo.update();
    }
    const outcome = result(solo.state);
    assert.ok(outcome.over);
    assert.match(solo.status(), /^(YOU WIN|YOU LOSE|A DRAW)! ENTER: PLAY AGAIN$/);
    solo.next();
    assert.deepEqual(result(solo.state), { over: false });
  }
});

test('local play alternates two players on one device', () => {
  const local = createLocal(3);
  assert.deepEqual(local.labels, ['PLAYER 1', 'PLAYER 2']);
  const first = local.state.turn;
  assert.equal(local.status(), `PLAYER ${first + 1}, YOUR TURN`);
  for (const move of [0, 3, 1, 4]) {
    assert.ok(local.canPlay());
    local.play(move);
  }
  local.next(); // ignored while the game runs
  local.play(2);
  assert.deepEqual(result(local.state), { over: true, winner: first });
  assert.ok(!local.canPlay());
  assert.equal(local.status(), `PLAYER ${first + 1} WINS! ENTER: PLAY AGAIN`);
  local.next();
  assert.deepEqual(result(local.state), { over: false });
});

/** Two players' portals around a relay that delivers what each one sends. */
function onlinePair(launch = { mode: 'online' }) {
  const room = (me, state = 'lobby', host = 0) => ({
    code: 'ABC234',
    mode: 'versus',
    private: true,
    state,
    host,
    me,
    min: 2,
    max: 2,
    players: [0, 1].map((slot) => ({
      slot,
      handle: `player${slot}`,
      avatar: 'a01',
      ready: false,
      connected: true,
    })),
  });
  const players = [0, 1].map((me) => {
    const handlers = new Map();
    const calls = [];
    const multiplayer = {
      available: true,
      find: async (options) => (calls.push(['find', options]), { ok: true }),
      host: async (options) => (calls.push(['host', options]), { ok: true, room: room(me) }),
      start: async () => (calls.push(['start']), { ok: true }),
      ready: (ready) => calls.push(['ready', ready]),
      send(data, options = {}) {
        calls.push(['send', data, options.to]);
        for (const other of players)
          if (other.me !== me && (options.to === undefined || options.to === other.me))
            other.handlers.get('message')?.({ from: me, data: structuredClone(data) });
      },
      result: async (placements) => (calls.push(['result', placements]), { ok: true }),
      leave: () => calls.push(['leave']),
      on(event, handler) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    };
    return { me, handlers, calls, portal: { launch, multiplayer } };
  });
  for (const player of players) player.online = createOnline(player.portal, () => {});
  /** An event for every player; `data(me)` gives each player their own view. */
  const emit = (event, data) => {
    for (const player of players) player.handlers.get(event)?.(data(player.me));
  };
  return { players, room, emit };
}

test('online play: the host referees every move and both games agree', async () => {
  const { players, room, emit } = onlinePair();
  const [host, guest] = players;
  assert.deepEqual(
    host.online.panel().choices.map((choice) => choice.label),
    ['QUICK MATCH', 'PRIVATE ROOM'],
  );
  await host.online.panel().choices[1].run();
  assert.deepEqual(host.calls, [['host', { mode: 'versus' }]]);
  assert.equal(host.online.panel().title, 'ROOM ABC234');
  emit('room', (me) => room(me));
  assert.ok(host.online.panel().lines.includes('ENTER: START THE MATCH'));
  assert.ok(guest.online.panel().lines.includes('WAITING FOR THE HOST TO START'));
  host.online.next();
  await flush();
  assert.deepEqual(host.calls.at(-1), ['start']);

  for (const seed of [11, 12]) {
    emit('start', (me) => ({ ...room(me, 'playing'), seed }));
    assert.deepEqual(host.online.state, createState(seed));
    assert.deepEqual(guest.online.state, createState(seed));
    assert.deepEqual(host.online.labels, ['YOU', 'PLAYER1']);
    assert.deepEqual(guest.online.labels, ['PLAYER0', 'YOU']);
    // Play until the end: exactly one game may move at a time.
    for (let turn = 0; !result(host.online.state).over; turn++) {
      const mover = host.online.canPlay() ? host : guest;
      assert.notEqual(host.online.canPlay(), guest.online.canPlay());
      assert.equal(mover.online.status(), 'YOUR TURN');
      mover.online.play(legalMoves(mover.online.state)[turn % 2 === 0 ? 0 : 1] ?? 0);
      assert.deepEqual(guest.online.state, host.online.state);
    }
    // The guest's moves went to the host only; the host sent every state.
    for (const [kind, data, to] of guest.calls.filter((call) => call[0] === 'send')) {
      assert.equal(kind, 'send');
      assert.equal(data.t, 'move');
      assert.equal(to, 0);
    }
    const states = host.calls.filter((call) => call[0] === 'send').map((call) => call[1]);
    assert.ok(states.every((data) => data.t === 'state' && parse(data.state)));
    const outcome = result(host.online.state);
    const report = host.calls.filter((call) => call[0] === 'result').at(-1);
    assert.deepEqual(report[1], outcome.winner === 1 ? [1, 0] : [0, 1]);
    assert.equal(guest.calls.filter((call) => call[0] === 'result').length, 0);
    // A private room returns to its lobby: the host starts the rematch.
    emit('room', (me) => room(me));
    assert.match(host.online.status(), /ENTER: REMATCH$/);
    assert.match(guest.online.status(), /ENTER: READY$/);
    guest.online.next();
    assert.deepEqual(guest.calls.at(-1), ['ready', true]);
    host.online.next();
    await flush();
    assert.deepEqual(host.calls.at(-1), ['start']);
  }
});

test('online play: moves out of turn, illegal moves and forged states are ignored', () => {
  const { players, room, emit } = onlinePair();
  const [host, guest] = players;
  const seed = [...Array(32).keys()].find((value) => createState(value).turn === 0);
  emit('start', (me) => ({ ...room(me, 'playing'), seed }));
  const deliver = (to, from, data) => to.handlers.get('message')({ from, data });
  const before = host.online.state;
  deliver(host, 1, { t: 'move', move: 4 }); // not the guest's turn
  deliver(host, 1, { t: 'state', state: '000000000' + '1' }); // only the host sends states
  assert.equal(host.online.state, before);
  host.online.play(4);
  deliver(host, 1, { t: 'move', move: 4 }); // taken
  deliver(host, 1, { t: 'move', move: 99 });
  deliver(host, 1, { t: 'move', move: '3' });
  deliver(host, 1, 'move');
  assert.deepEqual(host.online.state, applyMove(createState(seed), 4));
  deliver(guest, 1, { t: 'state', state: '0000000000' }); // a state from a non-host slot
  deliver(guest, 0, { t: 'state', state: 'not a state' });
  assert.deepEqual(guest.online.state, host.online.state);
  guest.online.play(0);
  assert.equal(guest.online.state.cells[0], 1);
  assert.deepEqual(guest.online.state, host.online.state);
});

test('online play: a player leaving, a closed room, a guest, an invite and a new host', async () => {
  const { players, room, emit } = onlinePair();
  const [host, guest] = players;
  emit('start', (me) => ({ ...room(me, 'playing'), seed: 5 }));
  host.handlers.get('left')({ slot: 1 });
  assert.equal(host.online.status(), 'YOUR OPPONENT LEFT. ENTER: BACK');
  assert.ok(!host.online.canPlay());
  host.online.next();
  assert.deepEqual(host.calls.at(-1), ['leave']);
  assert.equal(host.online.panel().title, 'PLAY ONLINE');
  assert.equal(host.online.state, null);

  guest.handlers.get('end')({ reason: 'connection' });
  assert.deepEqual(guest.online.panel().lines, ['THE ROOM CLOSED']);

  // A guest is asked to sign in; the portal says so too.
  guest.portal.multiplayer.find = async () => ({ ok: false, reason: 'guest' });
  await guest.online.panel().choices[0].run();
  assert.deepEqual(guest.online.panel().lines, ['SIGN IN TO PLAY ONLINE']);

  // An invite link: the game waits while the portal joins the room.
  const invited = onlinePair({ mode: 'online', room: 'XYZ789' });
  const [, friend] = invited.players;
  assert.equal(friend.online.panel().lines[0], 'JOINING ROOM XYZ789...');
  friend.handlers.get('room')(invited.room(1));
  assert.ok(friend.online.panel().lines.includes('WAITING FOR THE HOST TO START'));
  // The host left the lobby: the guest becomes the host of the room.
  friend.handlers.get('room')({
    ...invited.room(1),
    host: 1,
    players: [invited.room(1).players[1]],
  });
  assert.ok(friend.online.panel().lines.includes('WAITING FOR A PLAYER TO JOIN'));
  friend.online.close();
  assert.deepEqual(friend.calls.at(-1), ['leave']);
});

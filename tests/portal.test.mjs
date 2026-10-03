import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PixelJSError } from '../packages/core/dist/index.js';
import {
  BRIDGE_VERSION,
  attachEngine,
  connectPortal,
  createRandom,
} from '../packages/core/dist/portal.js';

const NONCE = 'n0nce-for-the-tests_42';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const isRange = (error) => error instanceof PixelJSError && error.code === 'RANGE';

/** A minimal browser window for the bridge: events, a location and a parent. */
class FakeWindow extends EventTarget {
  constructor(hash = '') {
    super();
    this.location = { hash };
    this.parent = this;
  }
  postMessage() {}
}

/**
 * A game window inside a portal frame. The portal records what the game posts and
 * answers like a browser would: later, with a structured copy and `event.source`.
 */
function portalFrame({ hash = `#pjs=${NONCE}` } = {}) {
  const portal = new FakeWindow();
  const game = new FakeWindow(hash);
  game.parent = portal;
  const sent = [];
  const waiting = [];
  portal.postMessage = (message, target) => {
    assert.equal(target, '*');
    const copy = structuredClone(message);
    sent.push(copy);
    const index = waiting.findIndex((entry) => entry.type === copy.type);
    if (index >= 0) waiting.splice(index, 1)[0].resolve(copy);
  };
  /** Delivers a message to the game, from the portal unless another source is given. */
  const post = (message, source = portal) =>
    queueMicrotask(() => {
      const event = new Event('message');
      Object.defineProperties(event, {
        data: { value: structuredClone(message) },
        source: { value: source },
      });
      game.dispatchEvent(event);
    });
  /** The next message of `type` the game posts (one already posted counts). */
  const next = (type) => {
    const index = sent.findIndex((message) => message.type === type && !message.taken);
    if (index >= 0) {
      sent[index].taken = true;
      return Promise.resolve(sent[index]);
    }
    return new Promise((resolve) =>
      waiting.push({
        type,
        resolve: (message) => {
          message.taken = true;
          resolve(message);
        },
      }),
    );
  };
  const event = (type, data) => post({ pjs: 2, type, nonce: NONCE, data });
  /** Waits for a request of `type` and replies to it; resolves with the request. */
  const answer = async (type, data) => {
    const request = await next(type);
    post({ pjs: 2, type: 'reply', nonce: NONCE, re: request.id, data });
    return request;
  };
  const strip = (message) => {
    const { taken, ...rest } = message;
    void taken;
    return rest;
  };
  return { game, portal, sent, post, next, event, answer, strip };
}

/** Runs `body` with `frame.game` installed as the global window. */
async function inWindow(game, body) {
  globalThis.window = game;
  try {
    return await body();
  } finally {
    delete globalThis.window;
  }
}

/** Connects through a frame and answers hello with `welcome`. */
async function connected(frame, welcome = {}, options = {}) {
  const connecting = connectPortal({
    engine: '@pixeljs/core@test',
    capabilities: ['pause', 'mute', 'levels', 'scores', 'save', 'multiplayer'],
    ...options,
  });
  const hello = await frame.next('hello');
  frame.event('welcome', {
    bridge: '2.0.0',
    capabilities: ['pause', 'mute', 'levels', 'scores', 'save', 'multiplayer'],
    ...welcome,
  });
  return { portal: await connecting, hello };
}

test('createRandom reproduces mulberry32 exactly', () => {
  const first = (seed) => {
    const random = createRandom(seed);
    return Array.from({ length: 5 }, () => random.next());
  };
  assert.deepEqual(first(0), [1144304738, 1416247, 958946056, 627933444, 2007157716]);
  assert.deepEqual(first(1), [2693262067, 11749833, 2265367787, 4213581821, 4159151403]);
  assert.deepEqual(first(42), [2581720956, 1925393290, 3661312704, 2876485805, 750819978]);
  assert.deepEqual(first(0xdeadbeef), [4043151706, 1147597007, 3315858022, 1538288752, 2042435954]);
  // Seeds are taken modulo 2^32, so negative and large integers are fine.
  assert.deepEqual(first(-1), first(0xffffffff));
  assert.deepEqual(first(2 ** 40 + 42), first(42));

  const ints = createRandom(2026);
  assert.deepEqual(
    Array.from({ length: 8 }, () => ints.int(10)),
    [5, 8, 2, 6, 7, 2, 8, 3],
  );
  const ranges = createRandom(7);
  assert.deepEqual(
    Array.from({ length: 8 }, () => ranges.range(-3, 3)),
    [0, -2, 2, 2, -2, 3, -2, -2],
  );
  assert.equal(createRandom(0).float(), 1144304738 / 2 ** 32);
});

test('createRandom is deterministic, bounded and resumable', () => {
  const a = createRandom(123456789);
  const b = createRandom(123456789);
  for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
  for (let i = 0; i < 1000; i++) {
    const value = a.int(6);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 6);
    const between = a.range(-5, 5);
    assert.ok(Number.isInteger(between) && between >= -5 && between <= 5);
    const float = a.float();
    assert.ok(float >= 0 && float < 1);
    assert.ok(a.next() <= 0xffffffff);
  }
  assert.equal(a.range(4, 4), 4);
  assert.equal(a.int(1), 0);
  assert.ok(a.int(2 ** 32) < 2 ** 32);

  // state() and createRandom(state) continue the same sequence.
  const saved = a.state();
  const resumed = createRandom(saved);
  assert.deepEqual(
    Array.from({ length: 5 }, () => a.next()),
    Array.from({ length: 5 }, () => resumed.next()),
  );
  // fork() takes one step of its parent and is reproducible.
  const parent = createRandom(9);
  const twin = createRandom(9);
  const child = parent.fork();
  assert.equal(child.next(), createRandom(twin.next()).next());
  assert.equal(parent.next(), twin.next());

  // pick() and shuffle() draw the same way for the same seed.
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const one = createRandom(5);
  const two = createRandom(5);
  assert.equal(one.pick(items), two.pick(items));
  const shuffled = one.shuffle([...items]);
  assert.deepEqual(two.shuffle([...items]), shuffled);
  assert.deepEqual([...shuffled].sort(), items);
  const list = [1, 2, 3];
  assert.equal(createRandom(1).shuffle(list), list, 'shuffle() works in place');
  assert.deepEqual(createRandom(1).shuffle([]), []);
});

test('createRandom rejects values it cannot use', () => {
  for (const seed of [0.5, NaN, Infinity, '1', null, undefined, 2 ** 53])
    assert.throws(() => createRandom(seed), isRange);
  const random = createRandom(1);
  for (const max of [0, -1, 1.5, 2 ** 32 + 1, NaN, '6'])
    assert.throws(() => random.int(max), isRange);
  assert.throws(() => random.range(3, 2), isRange);
  assert.throws(() => random.range(0.5, 2), isRange);
  assert.throws(() => random.range(0, 2 ** 32), isRange);
  assert.throws(() => random.pick([]), isRange);
  assert.throws(() => random.pick('abc'), isRange);
  assert.throws(
    () => random.shuffle('abc'),
    (error) => error.code === 'ARGUMENT',
  );
});

test('outside a frame, connectPortal resolves at once and every call still answers', async () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(BRIDGE_VERSION, '2.0.0');
  const started = performance.now();
  const portal = await connectPortal({ timeoutMs: 10_000 });
  assert.ok(performance.now() - started < 1000, 'no wait outside the portal');
  assert.equal(portal.inPortal, false);
  assert.deepEqual(portal.capabilities, []);
  assert.deepEqual(portal.launch, { mode: 'solo' });
  portal.loading(1, 2);
  portal.ready();
  portal.error('nothing to report');
  portal.state({ paused: true });

  const run = await portal.levelStart('1-1');
  assert.match(run, /^local-\d+$/);
  assert.deepEqual(await portal.levelEnd(run, { outcome: 'complete', scores: { total: 10 } }), {
    recorded: false,
    reason: 'not_in_portal',
  });
  assert.deepEqual(await portal.gameOver({ scores: { total: 1 } }), {
    recorded: false,
    reason: 'not_in_portal',
  });
  await portal.levelStart();
  assert.deepEqual(await portal.gameOver(), { recorded: false, reason: 'not_in_portal' });
  assert.deepEqual(await portal.levels(), {});
  assert.deepEqual(await portal.unlock('first-steps'), {
    unlocked: false,
    reason: 'not_in_portal',
  });
  assert.deepEqual(await portal.player(), { signedIn: false });

  // Saves stay in memory, with revisions.
  assert.deepEqual(await portal.load('slot-1'), { data: null, rev: 0, schema: 0 });
  assert.deepEqual(await portal.save('slot-1', '{"level":2}'), { ok: true, rev: 1 });
  assert.deepEqual(await portal.save('slot-1', '{"level":3}', { rev: 1 }), { ok: true, rev: 2 });
  assert.deepEqual(await portal.load('slot-1'), { data: '{"level":3}', rev: 2, schema: 0 });
  assert.deepEqual(await portal.load('slot-2'), { data: null, rev: 0, schema: 0 });

  const online = portal.multiplayer;
  assert.equal(online.available, false);
  for (const call of [
    online.find({ mode: 'versus' }),
    online.host(),
    online.join('ABC234'),
    online.start(),
    online.result([0, 1]),
  ])
    assert.deepEqual(await call, { ok: false, reason: 'not_in_portal' });
  online.ready();
  online.send({ t: 'move', move: 4 });
  online.leave();
  const stop = portal.on('pause', () => assert.fail('no events outside the portal'));
  stop();
  online.on('start', () => {})();
});

test('a top-level page, or a frame without a valid nonce, is outside the portal', async () => {
  for (const [hash, framed] of [
    [`#pjs=${NONCE}`, false],
    ['', true],
    ['#pjs=short', true],
    ['#pjs=has+invalid/chars!', true],
  ]) {
    const frame = portalFrame({ hash });
    if (!framed) frame.game.parent = frame.game;
    const portal = await inWindow(frame.game, () => connectPortal({ timeoutMs: 10_000 }));
    assert.equal(portal.inPortal, false, hash);
    assert.deepEqual(frame.sent, [], 'nothing is posted');
  }
});

test('hello and welcome: capabilities, launch and the first interaction', async () => {
  const frame = portalFrame({ hash: `#level=1-2&pjs=${NONCE}` });
  await inWindow(frame.game, async () => {
    const { portal, hello } = await connected(frame, {
      capabilities: ['pause', 'mute', 'multiplayer', 7],
      launch: { mode: 'online', room: 'ABC234' },
    });
    assert.deepEqual(frame.strip(hello), {
      pjs: 2,
      type: 'hello',
      nonce: NONCE,
      id: undefined,
      data: {
        bridge: '2.0.0',
        engine: '@pixeljs/core@test',
        capabilities: ['pause', 'mute', 'levels', 'scores', 'save', 'multiplayer'],
      },
    });
    assert.equal(portal.inPortal, true);
    assert.deepEqual(portal.capabilities, ['pause', 'mute', 'multiplayer']);
    assert.deepEqual(portal.launch, { mode: 'online', room: 'ABC234' });
    assert.equal(portal.multiplayer.available, true);

    // The first key press or pointer press is reported once.
    frame.game.dispatchEvent(new Event('keydown'));
    frame.game.dispatchEvent(new Event('pointerdown'));
    const interaction = await frame.next('interaction');
    assert.deepEqual(frame.strip(interaction), {
      pjs: 2,
      type: 'interaction',
      nonce: NONCE,
      id: undefined,
      data: {},
    });
    assert.equal(frame.sent.filter((message) => message.type === 'interaction').length, 1);

    portal.loading(3, 4);
    portal.ready();
    portal.state({ muted: true });
    portal.error('x'.repeat(300));
    const types = frame.sent.map((message) => message.type);
    assert.deepEqual(types.slice(-4), ['progress', 'ready', 'state', 'error']);
    assert.deepEqual(frame.sent.at(-4).data, { loaded: 3, total: 4 });
    assert.deepEqual(frame.sent.at(-2).data, { muted: true });
    assert.equal(frame.sent.at(-1).data.message.length, 200);
  });
});

test('welcome without a valid launch keeps solo, and no welcome means outside the portal', async () => {
  const frame = portalFrame();
  await inWindow(frame.game, async () => {
    const { portal } = await connected(frame, { capabilities: 'all', launch: { mode: 3 } });
    assert.equal(portal.inPortal, true);
    assert.deepEqual(portal.capabilities, []);
    assert.deepEqual(portal.launch, { mode: 'solo' });
  });
  const silent = portalFrame();
  await inWindow(silent.game, async () => {
    const started = performance.now();
    const portal = await connectPortal({ timeoutMs: 30 });
    assert.ok(performance.now() - started >= 25, 'waits for the portal');
    assert.equal(portal.inPortal, false);
    assert.deepEqual(await portal.levelEnd('r1', { outcome: 'fail' }), {
      recorded: false,
      reason: 'not_in_portal',
    });
    // A late welcome still connects.
    silent.event('welcome', { capabilities: ['scores'] });
    await flush();
    assert.equal(portal.inPortal, true);
    assert.deepEqual(portal.capabilities, ['scores']);
  });
});

test('messages from another window, with another nonce or protocol are ignored', async () => {
  const frame = portalFrame();
  await inWindow(frame.game, async () => {
    let resolved = false;
    const connecting = connectPortal({ timeoutMs: 10_000 }).then((portal) => {
      resolved = true;
      return portal;
    });
    await frame.next('hello');
    const welcome = { capabilities: ['scores'] };
    frame.post({ pjs: 2, type: 'welcome', nonce: NONCE, data: welcome }, new FakeWindow());
    frame.post({ pjs: 2, type: 'welcome', nonce: 'another-nonce-123456', data: welcome });
    frame.post({ pjs: 1, type: 'welcome', nonce: NONCE, data: welcome });
    frame.post({ pjs: 2, type: 7, nonce: NONCE, data: welcome });
    frame.post('welcome');
    frame.post(null);
    await flush();
    assert.equal(resolved, false);
    frame.event('welcome', welcome);
    const portal = await connecting;
    assert.equal(portal.inPortal, true);
  });
});

test('requests carry an id and resolve with the reply that repeats it', async () => {
  const frame = portalFrame();
  await inWindow(frame.game, async () => {
    const { portal } = await connected(frame);
    const starting = portal.levelStart('1-1');
    const start = await frame.answer('level.start', { ok: true, run: 'run-7', level: '1-1' });
    assert.deepEqual(frame.strip(start), {
      pjs: 2,
      type: 'level.start',
      nonce: NONCE,
      id: 'm1',
      data: { level: '1-1' },
    });
    assert.equal(await starting, 'run-7');

    // A reply to an unknown request, or with another nonce, changes nothing.
    frame.post({ pjs: 2, type: 'reply', nonce: NONCE, re: 'm99', data: { ok: true } });
    const result = {
      outcome: 'complete',
      scores: { 'level-score': 4200, fastest: 51320 },
      timeMs: 51320,
      stars: 3,
      stats: { coins: 37 },
    };
    const ending = portal.levelEnd('run-7', result);
    const end = await frame.next('level.end');
    assert.equal(end.id, 'm2');
    assert.deepEqual(end.data, { run: 'run-7', ...result });
    frame.post({ pjs: 2, type: 'reply', nonce: 'another-nonce-123456', re: 'm2', data: {} });
    const answer = {
      ok: true,
      recorded: true,
      newBest: { 'level-score': true, fastest: false },
      best: { 'level-score': 4200, fastest: 49000 },
      rank: 17,
      unlocked: ['first-steps'],
    };
    frame.post({ pjs: 2, type: 'reply', nonce: NONCE, re: 'm2', data: answer });
    assert.deepEqual(await ending, answer);

    // A new run first ends the open one as "quit"; a refused start gives a failed run.
    const first = portal.levelStart();
    await frame.answer('level.start', { ok: true, run: 'run-8', level: 'main' });
    assert.equal(await first, 'run-8');
    const second = portal.levelStart('1-3');
    const quit = await frame.answer('level.end', { ok: true, recorded: false, reason: 'quit' });
    assert.deepEqual(quit.data, { run: 'run-8', outcome: 'quit' });
    const refused = await frame.answer('level.start', {
      ok: false,
      error: { code: 'unknown_level', message: 'Unknown level' },
    });
    assert.deepEqual(refused.data, { level: '1-3' });
    const failed = await second;
    assert.match(failed, /^failed-\d+$/);
    const count = frame.sent.length;
    assert.deepEqual(await portal.levelEnd(failed, { outcome: 'fail' }), {
      recorded: false,
      reason: 'no_active_run',
    });
    assert.deepEqual(await portal.gameOver(), { recorded: false, reason: 'no_active_run' });
    assert.equal(frame.sent.length, count, 'nothing is sent for runs that never started');

    // gameOver() ends the current run as a failure.
    const third = portal.levelStart();
    await frame.answer('level.start', { ok: true, run: 'run-9' });
    await third;
    const over = portal.gameOver({ scores: { 'high-score': 900 }, timeMs: 3000 });
    const message = await frame.answer('level.end', { ok: false, error: { code: 'guest' } });
    assert.deepEqual(message.data, {
      run: 'run-9',
      outcome: 'fail',
      scores: { 'high-score': 900 },
      timeMs: 3000,
    });
    assert.deepEqual(await over, { recorded: false, reason: 'guest' });
  });
});

test('levels, achievements, saves and the player go through the portal', async () => {
  const frame = portalFrame();
  await inWindow(frame.game, async () => {
    const { portal } = await connected(frame);
    const progress = { '1-1': { completed: true, stars: 3, best: { 'level-score': 4200 } } };
    const levels = portal.levels();
    await frame.answer('levels.get', { ok: true, levels: progress });
    assert.deepEqual(await levels, progress);
    const none = portal.levels();
    await frame.answer('levels.get', { ok: false, error: { code: 'not_granted' } });
    assert.deepEqual(await none, {});

    const unlocking = portal.unlock('untouched');
    assert.deepEqual(
      (await frame.answer('achievement.unlock', { ok: true, unlocked: true })).data,
      {
        id: 'untouched',
      },
    );
    assert.deepEqual(await unlocking, { unlocked: true, reason: undefined });
    const again = portal.unlock('untouched');
    await frame.answer('achievement.unlock', { ok: true, unlocked: false, reason: 'already' });
    assert.deepEqual(await again, { unlocked: false, reason: 'already' });

    const saving = portal.save('slot-1', '{"stars":3}', { rev: 4 });
    const save = await frame.answer('save', { ok: true, rev: 5 });
    assert.deepEqual(save.data, { slot: 'slot-1', data: '{"stars":3}', rev: 4 });
    assert.deepEqual(await saving, { ok: true, rev: 5 });
    const conflict = portal.save('slot-1', 'older');
    assert.deepEqual(
      (await frame.answer('save', { ok: false, error: { code: 'conflict' } })).data,
      { slot: 'slot-1', data: 'older', rev: undefined },
    );
    assert.deepEqual(await conflict, { ok: false, reason: 'conflict' });

    const loading = portal.load('slot-1');
    await frame.answer('load', { ok: true, data: '{"stars":3}', rev: 5, schema: 1 });
    assert.deepEqual(await loading, { data: '{"stars":3}', rev: 5, schema: 1 });
    const empty = portal.load('slot-2');
    await frame.answer('load', { ok: true, data: null, rev: 0, schema: 0 });
    assert.deepEqual(await empty, { data: null, rev: 0, schema: 0 });
    const blocked = portal.load('slot-3');
    await frame.answer('load', { ok: false, error: { code: 'not_granted' } });
    assert.deepEqual(await blocked, { data: null, rev: 0, schema: 0, reason: 'not_granted' });

    const player = portal.player();
    await frame.answer('player.get', { ok: true, signedIn: true, handle: 'moonrunner' });
    assert.deepEqual(await player, { signedIn: true, handle: 'moonrunner' });
  });
});

test('an unanswered request resolves as unavailable after 15 seconds', async (t) => {
  const frame = portalFrame();
  await inWindow(frame.game, async () => {
    const { portal } = await connected(frame);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const ending = portal.levelEnd('run-1', { outcome: 'complete' });
      const saving = portal.save('slot-1', 'data');
      await frame.next('save');
      t.mock.timers.tick(14_999);
      await flush();
      t.mock.timers.tick(1);
      assert.deepEqual(await ending, { recorded: false, reason: 'unavailable' });
      assert.deepEqual(await saving, { ok: false, reason: 'unavailable' });
      // A reply after the timeout is ignored.
      frame.post({ pjs: 2, type: 'reply', nonce: NONCE, re: 'm1', data: { ok: true } });
      await flush();
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('online play: requests, messages to other players and room events', async () => {
  const frame = portalFrame();
  await inWindow(frame.game, async () => {
    const { portal } = await connected(frame);
    const online = portal.multiplayer;
    const room = {
      code: 'ABC234',
      mode: 'versus',
      private: true,
      state: 'lobby',
      host: 0,
      me: 0,
      min: 2,
      max: 2,
      players: [{ slot: 0, handle: 'moonrunner', avatar: 'a01', ready: false, connected: true }],
    };
    const hosting = online.host({ mode: 'versus' });
    assert.deepEqual((await frame.answer('mp.host', { ok: true, room })).data, { mode: 'versus' });
    assert.deepEqual(await hosting, { ok: true, room });
    const finding = online.find();
    assert.deepEqual((await frame.answer('mp.find', { ok: true })).data, { mode: undefined });
    assert.deepEqual(await finding, { ok: true });
    const joining = online.join('XYZ789');
    await frame.answer('mp.join', { ok: false, error: { code: 'guest', message: 'Sign in' } });
    assert.deepEqual(await joining, { ok: false, reason: 'guest' });
    const starting = online.start();
    assert.deepEqual((await frame.answer('mp.start', { ok: true })).data, {});
    assert.deepEqual(await starting, { ok: true });
    const reporting = online.result([1, 0]);
    assert.deepEqual((await frame.answer('mp.result', { ok: true })).data, { placements: [1, 0] });
    assert.deepEqual(await reporting, { ok: true });

    online.send({ t: 'move', move: 4 }, { to: 0 });
    online.send({ t: 'state', state: '....0....1' });
    online.ready(false);
    online.leave();
    const [toHost, toAll, ready, leave] = frame.sent.slice(-4).map(frame.strip);
    assert.deepEqual(toHost, {
      pjs: 2,
      type: 'mp.send',
      nonce: NONCE,
      id: undefined,
      data: { data: { t: 'move', move: 4 }, to: 0 },
    });
    assert.deepEqual(toAll.data, { data: { t: 'state', state: '....0....1' }, to: undefined });
    assert.deepEqual(ready.data, { ready: false });
    assert.deepEqual([leave.type, leave.id, leave.data], ['mp.leave', undefined, {}]);

    const seen = [];
    for (const name of ['room', 'start', 'message', 'left', 'end'])
      online.on(name, (data) => seen.push([name, data]));
    const start = { ...room, state: 'playing', players: [...room.players], seed: 3735928559 };
    frame.event('mp.room', room);
    frame.event('mp.start', start);
    frame.event('mp.message', { from: 1, data: { t: 'move', move: 4 } });
    frame.event('mp.left', { slot: 1 });
    frame.event('mp.end', { reason: 'connection' });
    await flush();
    assert.deepEqual(seen, [
      ['room', room],
      ['start', start],
      ['message', { from: 1, data: { t: 'move', move: 4 } }],
      ['left', { slot: 1 }],
      ['end', { reason: 'connection' }],
    ]);
  });
});

test('portal events reach every listener until it stops listening', async (t) => {
  const frame = portalFrame();
  await inWindow(frame.game, async () => {
    const { portal } = await connected(frame);
    const seen = [];
    const stop = portal.on('mute', (data) => seen.push(['mute', data]));
    portal.on('visibility', (data) => seen.push(['visibility', data]));
    portal.on('select', (data) => seen.push(['select', data]));
    portal.on('pause', (data) => seen.push(['pause', data]));
    frame.event('mute', { muted: true });
    frame.event('visibility', { visible: false, focused: false });
    frame.event('select', { level: '1-2' });
    frame.post({ pjs: 2, type: 'pause', nonce: NONCE });
    await flush();
    stop();
    frame.event('mute', { muted: false });
    await flush();
    assert.deepEqual(seen, [
      ['mute', { muted: true }],
      ['visibility', { visible: false, focused: false }],
      ['select', { level: '1-2' }],
      ['pause', {}],
    ]);

    // A failing listener does not stop the others; its error is thrown later.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let reached = false;
      portal.on('resume', () => {
        throw new Error('listener failed');
      });
      portal.on('resume', () => (reached = true));
      frame.event('resume', {});
      await flush();
      assert.equal(reached, true);
      assert.throws(() => t.mock.timers.tick(1), /listener failed/);
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('attachEngine pauses, resumes and mutes the engine until detached', async () => {
  const frame = portalFrame();
  await inWindow(frame.game, async () => {
    const { portal } = await connected(frame);
    const calls = [];
    const engine = {
      state: 'RUNNING',
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
      audio: { setVolume: (volume) => calls.push(`volume ${volume}`) },
    };
    assert.throws(() => attachEngine(portal, engine, { volume: 2 }), isRange);
    assert.throws(() => attachEngine(portal, engine, { volume: NaN }), isRange);
    const detach = attachEngine(portal, engine, { volume: 0.5 });
    frame.event('pause', {});
    frame.event('resume', {});
    frame.event('mute', { muted: true });
    frame.event('mute', { muted: false });
    frame.event('visibility', { visible: false, focused: false });
    await flush();
    assert.deepEqual(calls, ['pause', 'resume', 'volume 0', 'volume 0.5']);

    // A disposed engine is left alone instead of throwing STATE.
    engine.state = 'DISPOSED';
    frame.event('pause', {});
    await flush();
    engine.state = 'PAUSED';
    detach();
    detach();
    frame.event('resume', {});
    frame.event('mute', { muted: true });
    await flush();
    assert.deepEqual(calls, ['pause', 'resume', 'volume 0', 'volume 0.5']);
  });
});

test('the engine entry never loads the portal, and the portal loads only its own modules', async () => {
  const dist = new URL('../packages/core/dist/', import.meta.url);
  const graph = async (entry) => {
    const seen = new Set();
    const visit = async (url) => {
      if (seen.has(url.href)) return;
      seen.add(url.href);
      const source = await readFile(url, 'utf8');
      const specifiers = /^\s*(?:import|export)\s(?:[^'";]*?\sfrom\s)?\s*['"]([^'"]+)['"]/gm;
      for (const [, specifier] of source.matchAll(specifiers)) {
        assert.ok(specifier.startsWith('.'), `${url.pathname} imports only package files`);
        await visit(new URL(specifier, url));
      }
    };
    await visit(new URL(entry, dist));
    return [...seen].map((href) => href.slice(dist.href.length)).sort();
  };
  const engine = await graph('index.js');
  assert.ok(engine.includes('api/engine.js'));
  assert.deepEqual(
    engine.filter((file) => file.startsWith('portal')),
    [],
  );
  assert.deepEqual(await graph('portal.js'), [
    'api/errors.js',
    'portal.js',
    'portal/bridge.js',
    'portal/engine.js',
    'portal/random.js',
  ]);
});

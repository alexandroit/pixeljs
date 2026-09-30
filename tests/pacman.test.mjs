import test from 'node:test';
import assert from 'node:assert/strict';
import { runGame, GAME_WIDTH, GAME_HEIGHT } from '../examples/javascript/game.js';
import {
  MAZE,
  MAZE_COLUMNS,
  MAZE_ROWS,
  DIRECTIONS,
  createGameModel,
  getSnapshot,
  advanceModel,
  setDirection,
  restartModel,
  isWalkable,
} from '../examples/javascript/pacman-model.js';

function advance(model, seconds) {
  const count = Math.ceil(seconds * 120);
  for (let index = 0; index < count; index++) advanceModel(model, seconds / count);
}
function quiet(model) {
  for (const ghost of model.ghosts) {
    ghost.state = 'waiting';
    ghost.timer = 1000;
  }
  return model;
}
function at(model, x, y, direction = 'left') {
  model.player.x = x;
  model.player.y = y;
  model.player.direction = direction;
  model.player.queued = direction;
  model.status = 'playing';
}

test('original maze has four power pellets and every collectible is reachable', () => {
  const model = createGameModel();
  assert.equal(MAZE.length, MAZE_ROWS);
  assert.ok(MAZE.every((row) => row.length === MAZE_COLUMNS));
  assert.equal(model.remaining, 277);
  assert.equal(model.pellets.filter((value) => value === 2).length, 4);
  const visited = new Set(['13,21']);
  const queue = [[13, 21]];
  for (let index = 0; index < queue.length; index++) {
    const [x, y] = queue[index];
    for (const vector of Object.values(DIRECTIONS)) {
      const nx = x + vector.x,
        ny = y + vector.y,
        key = `${nx},${ny}`;
      if (isWalkable(nx, ny) && !visited.has(key)) {
        visited.add(key);
        queue.push([nx, ny]);
      }
    }
  }
  for (let cell = 0; cell < model.pellets.length; cell++) {
    if (model.pellets[cell])
      assert.ok(visited.has(`${cell % MAZE_COLUMNS},${Math.floor(cell / MAZE_COLUMNS)}`));
  }
  assert.equal(isWalkable(13, 11), false);
  assert.equal(isWalkable(13, 11, true), true);
});

test('ready state never moves enemies or loses lives before the first input', () => {
  const model = createGameModel();
  const before = JSON.stringify({ player: model.player, ghosts: model.ghosts });
  advance(model, 90);
  assert.equal(JSON.stringify({ player: model.player, ghosts: model.ghosts }), before);
  assert.deepEqual(getSnapshot(model), {
    score: 0,
    lives: 3,
    level: 1,
    remaining: 277,
    status: 'ready',
  });
  assert.ok(Object.isFrozen(getSnapshot(model)));
});

test('buffered turns wait for a junction and wall collisions stop exactly at a center', () => {
  const model = quiet(createGameModel());
  setDirection(model, 'left');
  advance(model, 0.1);
  setDirection(model, 'up');
  advance(model, 0.3);
  assert.equal(model.player.y, 21);
  assert.equal(model.player.direction, 'left');
  advance(model, 0.5);
  assert.equal(model.player.x, 9);
  assert.ok(model.player.y < 21);
  assert.equal(model.player.direction, 'up');
  at(model, 1, 21, 'left');
  advance(model, 1);
  assert.equal(model.player.x, 1);
  assert.equal(model.player.y, 21);
  assert.equal(model.player.moving, false);
});

test('a mid-corridor reversal is immediate without jumping across a wall', () => {
  const model = quiet(createGameModel());
  setDirection(model, 'left');
  advance(model, 0.1);
  const previousX = model.player.x;
  setDirection(model, 'right');
  advance(model, 0.05);
  assert.ok(model.player.x > previousX && model.player.x < 13);
  assert.equal(model.player.y, 21);
});

test('pellets score once and power pellets start the frightened timer', () => {
  const model = quiet(createGameModel());
  setDirection(model, 'left');
  advance(model, 0.18);
  assert.equal(model.score, 10);
  assert.equal(model.remaining, 276);
  at(model, 13, 21, 'left');
  advance(model, 0.18);
  assert.equal(model.score, 10);
  at(model, 1, 2, 'up');
  advance(model, 0.18);
  assert.equal(model.score, 60);
  assert.equal(model.remaining, 275);
  assert.ok(model.frightened > 7.8);
  advance(model, 1);
  assert.ok(model.frightened < 7);
});

test('a collision costs one life, preserves collected dots and waits for another input', () => {
  const model = quiet(createGameModel());
  setDirection(model, 'left');
  advance(model, 0.2);
  const remaining = model.remaining;
  Object.assign(model.ghosts[0], { x: model.player.x, y: model.player.y, state: 'active' });
  advanceModel(model, 1 / 120);
  assert.equal(model.status, 'dying');
  assert.equal(model.lives, 2);
  advance(model, 1.3);
  assert.equal(model.status, 'ready');
  assert.equal(model.remaining, remaining);
  assert.equal(model.score, 10);
  assert.equal(model.player.x, 13);
  assert.equal(model.player.y, 21);
  advance(model, 10);
  assert.equal(model.lives, 2);
});

test('powered collisions award escalating points and eyes return home and recover', () => {
  const model = quiet(createGameModel());
  at(model, 13, 21, 'left');
  model.frightened = 8;
  for (const ghost of model.ghosts.slice(0, 2))
    Object.assign(ghost, { x: 13, y: 21, state: 'active' });
  advanceModel(model, 1 / 120);
  assert.equal(model.score, 600);
  assert.equal(model.lives, 3);
  assert.equal(model.ghosts[0].state, 'eyes');
  assert.equal(model.ghosts[1].state, 'eyes');
  Object.assign(model.ghosts[0], { x: 13, y: 10, direction: 'down', state: 'eyes' });
  model.ghosts[1].state = 'waiting';
  model.ghosts[1].timer = 1000;
  at(model, 1, 1, 'left');
  advance(model, 0.4);
  assert.equal(model.ghosts[0].state, 'recovering');
  assert.equal(model.ghosts[0].x, 13);
  assert.equal(model.ghosts[0].y, 13);
  advance(model, 1.5);
  assert.equal(model.ghosts[0].state, 'active');
});

test('frightened ghosts exit the house instead of fleeing away from its door', () => {
  const model = quiet(createGameModel());
  at(model, 1, 1, 'left');
  model.frightened = 8;
  Object.assign(model.ghosts[1], { x: 13, y: 12, direction: 'up', state: 'active' });
  advance(model, 1);
  assert.ok(model.ghosts[1].y < 11);
  assert.ok(model.frightened > 6);
});

test('scatter and chase alternate while power pellets pause the mode clock', () => {
  const model = quiet(createGameModel());
  at(model, 1, 1, 'left');
  advance(model, 7.1);
  assert.equal(model.mode, 'chase');
  model.frightened = 3;
  const timer = model.modeTimer;
  advance(model, 1);
  assert.equal(model.modeTimer, timer);
  advance(model, 23);
  assert.equal(model.mode, 'scatter');
});

test('the last pellet advances the level with score and lives retained', () => {
  const model = quiet(createGameModel());
  model.lives = 2;
  model.pellets.fill(0);
  model.pellets[21 * MAZE_COLUMNS + 12] = 1;
  model.remaining = 1;
  setDirection(model, 'left');
  advance(model, 0.2);
  assert.equal(model.status, 'level-clear');
  assert.equal(model.score, 10);
  assert.equal(model.remaining, 0);
  advance(model, 1.7);
  assert.equal(model.status, 'ready');
  assert.equal(model.level, 2);
  assert.equal(model.remaining, 277);
  assert.equal(model.score, 10);
  assert.equal(model.lives, 2);
});

test('game over freezes play and restart restores a fresh three-life game', () => {
  const model = quiet(createGameModel());
  model.lives = 1;
  setDirection(model, 'right');
  Object.assign(model.ghosts[0], { x: 13, y: 21, state: 'active' });
  advance(model, 1.4);
  assert.equal(model.status, 'game-over');
  assert.equal(model.lives, 0);
  setDirection(model, 'left');
  advance(model, 5);
  assert.equal(model.status, 'game-over');
  restartModel(model);
  assert.deepEqual(getSnapshot(model), getSnapshot(createGameModel()));
});

test('equal input sequences are deterministic and invalid timing/directions fail', () => {
  const first = createGameModel(),
    second = createGameModel();
  for (let tick = 0; tick < 1200; tick++) {
    if (tick % 90 === 0) {
      const direction = Object.keys(DIRECTIONS)[Math.floor(tick / 90) % 4];
      setDirection(first, direction);
      setDirection(second, direction);
    }
    advanceModel(first, 1 / 120);
    advanceModel(second, 1 / 120);
  }
  assert.deepEqual(first, second);
  for (const dt of [-1, 1, Infinity, NaN, '0.1'])
    assert.throws(() => advanceModel(first, dt), RangeError);
  for (const direction of [
    'north',
    null,
    '__proto__',
    1,
    new String('left'),
    { toString: () => 'left' },
  ])
    assert.throws(() => setDirection(first, direction), RangeError);
});

const BUNDLE = {
  image: ['tiles', 'player', 'ghosts'],
  tilemap: ['maze'],
  font: ['arcade'],
  sound: ['waka-a', 'waka-b', 'power', 'ghost', 'death', 'level', 'start'],
  music: ['siren', 'fright'],
};

// A host-only engine and asset bundle that check every call the game makes
// and log its sounds, music and statuses in order. Browser tests run the
// real C/WASM engine with the real asset files.
function controllerFixture({ missing } = {}) {
  const resources = new Set();
  const loaded = new Map();
  for (const [kind, ids] of Object.entries(BUNDLE))
    for (const id of ids) {
      if (`${kind}:${id}` === missing) continue;
      const resource = Object.freeze({ kind, id });
      resources.add(resource);
      loaded.set(`${kind}:${id}`, resource);
    }
  const getter = (kind) => (id) => {
    const found = loaded.get(`${kind}:${id}`);
    if (!found) throw new Error(`The bundle has no ${kind} "${id}".`);
    return found;
  };
  const assets = Object.freeze(
    Object.fromEntries(Object.keys(BUNDLE).map((kind) => [kind, getter(kind)])),
  );
  const owned = (resource, kind) => assert.ok(resources.has(resource) && resource.kind === kind);
  const integers = (...values) => assert.ok(values.every(Number.isInteger), values.join());
  const failure = new Error('Injected failure');
  const log = [];
  let commands = 0;
  let drawing = false;
  let remapped = false;
  let disposal;
  let callbacks;
  const command = () => {
    assert.ok(drawing, 'Drawing is only valid inside draw().');
    commands++;
  };
  const engine = {
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    state: 'READY',
    input: { wasPressed: () => false, wasButtonPressed: () => false, axis: () => 0 },
    audio: {
      play(sound, voice) {
        owned(sound, 'sound');
        assert.ok(Number.isInteger(voice) && voice >= 0 && voice < 4);
        log.push(`sound:${sound.id}`);
      },
      playMusic(music) {
        owned(music, 'music');
        log.push(`music:${music.id}`);
      },
      stopMusic() {
        log.push('music:stop');
      },
      unlock: () => Promise.resolve(),
    },
    measureText(text, font) {
      owned(font, 'font');
      return { width: text.length * 4, height: 5 };
    },
    start(value) {
      callbacks = value;
      engine.state = 'RUNNING';
    },
    pause() {
      engine.state = 'PAUSED';
    },
    resume() {
      engine.state = 'RUNNING';
    },
    dispose() {
      if (!disposal) {
        engine.state = 'DISPOSED';
        resources.clear();
        disposal = Promise.resolve();
      }
      return disposal;
    },
    graphics: {
      clear(color) {
        integers(color);
        command();
      },
      tilemap(map, x, y) {
        owned(map, 'tilemap');
        integers(x, y);
        command();
      },
      sprite(image, x, y, options = {}) {
        owned(image, 'image');
        integers(x, y);
        if (options.rotation !== undefined) assert.ok(Number.isFinite(options.rotation));
        if (options.scale !== undefined) assert.ok(options.scale >= 1 / 16 && options.scale <= 64);
        command();
      },
      text(x, y, value, color, options) {
        owned(options.font, 'font');
        integers(x, y, color);
        assert.equal(value, value.toUpperCase(), 'The arcade font has no lowercase letters.');
        command();
      },
      pixel(x, y, color) {
        integers(x, y, color);
        command();
      },
      rect(x, y, width, height, color) {
        integers(x, y, width, height, color);
        assert.ok(width >= 0 && height >= 0);
        command();
      },
      ellipseFill(x, y, width, height, color) {
        integers(x, y, width, height, color);
        command();
      },
      remap(from, to) {
        integers(from, to);
        remapped = true;
        command();
      },
      resetRemap() {
        remapped = false;
        command();
      },
    },
  };
  return {
    engine,
    assets,
    resources,
    failure,
    log,
    frame() {
      commands = 0;
      callbacks.update(1 / 60);
      drawing = true;
      try {
        callbacks.draw();
      } finally {
        drawing = false;
      }
      assert.equal(remapped, false, 'A remap must not leak into the next drawing.');
      return commands;
    },
  };
}

test('the controller draws the loaded bundle within the command budget and keeps disposal identity', async () => {
  const fixture = controllerFixture();
  const snapshots = [];
  const controller = runGame(fixture.engine, {
    assets: fixture.assets,
    onProgress: (snapshot) => snapshots.push(snapshot),
  });
  assert.ok(fixture.frame() < 4096);
  controller.setDirection('left');
  for (let frame = 0; frame < 60; frame++) assert.ok(fixture.frame() < 4096);
  assert.ok(controller.snapshot.score > 0);
  assert.ok(snapshots.every(Object.isFrozen));
  assert.equal(fixture.resources.size, 14, 'The game creates no resources of its own.');
  const disposal = controller.dispose();
  assert.equal(controller.dispose(), disposal);
  await disposal;
  assert.equal(fixture.resources.size, 0);
  assert.throws(() => controller.setDirection('left'), /disposed/);
  assert.throws(() => controller.restart(), /disposed/);
});

test('sounds and music follow the chase, a power pellet and a lost life', () => {
  const fixture = controllerFixture();
  const { log } = fixture;
  let status;
  const controller = runGame(fixture.engine, {
    assets: fixture.assets,
    onProgress: (snapshot) => {
      if (snapshot.status !== status) log.push(`status:${(status = snapshot.status)}`);
    },
  });
  const run = (seconds, until) => {
    for (let frame = 0; frame < seconds * 60; frame++) {
      fixture.frame();
      if (until()) return;
    }
    assert.fail(`Nothing happened within ${seconds} s: ${log.join(' ')}`);
  };
  fixture.frame();
  assert.deepEqual(log, ['status:ready'], 'Nothing plays before the first move.');
  // West along the start corridor, then south at the first column to the
  // bottom-left power pellet.
  controller.setDirection('left');
  run(5, () => controller.snapshot.remaining <= 268);
  controller.setDirection('down');
  run(5, () => log.includes('sound:power'));
  const power = log.indexOf('sound:power');
  assert.deepEqual(log.slice(1, 3), ['status:playing', 'music:siren']);
  assert.ok(
    log
      .slice(2, power)
      .every((entry) => /^sound:waka-[ab]$/.test(entry) || entry === 'music:siren'),
  );
  assert.equal(log[power + 1], 'music:fright', 'Frightened ghosts replace the siren.');
  run(15, () => log.lastIndexOf('music:siren') > power);
  run(120, () => log.includes('status:dying'));
  const dying = log.indexOf('status:dying');
  assert.ok(log.slice(dying - 2, dying + 1).includes('sound:death'));
  assert.ok(log.slice(dying - 2, dying + 1).includes('music:stop'));
  run(5, () => log.lastIndexOf('status:ready') > dying);
  assert.ok(log.slice(dying).includes('sound:start'), 'A new life plays the start jingle.');
  controller.setDirection('right');
  run(1, () => log.lastIndexOf('music:siren') > dying);
});

test('the controller rejects a missing bundle or entry and guards state changes', async () => {
  const fixture = controllerFixture();
  const controller = runGame(fixture.engine, { assets: fixture.assets });
  await fixture.engine.dispose();
  assert.throws(() => controller.setDirection('up'), /disposed/);
  const bare = controllerFixture();
  assert.throws(() => runGame(bare.engine), TypeError);
  assert.throws(() => runGame(bare.engine, { assets: {} }), TypeError);
  const missing = controllerFixture({ missing: 'music:fright' });
  assert.throws(() => runGame(missing.engine, { assets: missing.assets }), /no music "fright"/);
  assert.equal(missing.engine.state, 'READY', 'Nothing starts without every asset.');
  const accessor = controllerFixture();
  assert.throws(
    () =>
      runGame(accessor.engine, {
        assets: accessor.assets,
        get onProgress() {
          accessor.engine.dispose();
          return () => {};
        },
      }),
    /ready/,
  );
  const notification = controllerFixture();
  assert.throws(
    () =>
      runGame(notification.engine, {
        assets: notification.assets,
        onProgress() {
          throw notification.failure;
        },
      }),
    (error) => error === notification.failure,
  );
  assert.equal(notification.engine.state, 'DISPOSED');
  assert.equal(notification.resources.size, 0);
});

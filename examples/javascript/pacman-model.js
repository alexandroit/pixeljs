// Original PixelJS maze and simulation. No external game code, map or assets.
export const GAME_WIDTH = 224;
export const GAME_HEIGHT = 256;
export const TILE_SIZE = 8;
export const MAZE_X = 4;
export const MAZE_Y = 24;
export const MAZE_COLUMNS = 27;
export const MAZE_ROWS = 27;
export const DIRECTIONS = Object.freeze({
  up: Object.freeze({ x: 0, y: -1, opposite: 'down' }),
  left: Object.freeze({ x: -1, y: 0, opposite: 'right' }),
  down: Object.freeze({ x: 0, y: 1, opposite: 'up' }),
  right: Object.freeze({ x: 1, y: 0, opposite: 'left' }),
});
const DIRECTION_NAMES = Object.keys(DIRECTIONS);
const CELL_COUNT = MAZE_COLUMNS * MAZE_ROWS;
const PLAYER_START = Object.freeze({ x: 13, y: 21 });
const GHOST_SPECS = Object.freeze([
  { name: 'Scarlet', color: 5, x: 13, y: 10, delay: 0, corner: [25, 1] },
  { name: 'Rose', color: 14, x: 13, y: 12, delay: 2, corner: [1, 1] },
  { name: 'Aqua', color: 10, x: 12, y: 13, delay: 4, corner: [25, 25] },
  { name: 'Amber', color: 6, x: 14, y: 13, delay: 6, corner: [1, 25] },
]);

function makeMaze() {
  const cells = new Uint8Array(CELL_COUNT);
  const horizontal = (y, left, right) => {
    for (let x = left; x <= right; x++) cells[y * MAZE_COLUMNS + x] = 1;
  };
  const vertical = (x, top, bottom) => {
    for (let y = top; y <= bottom; y++) cells[y * MAZE_COLUMNS + x] = 1;
  };
  horizontal(1, 1, 11);
  horizontal(1, 15, 25);
  for (const y of [5, 13, 17, 21, 25]) horizontal(y, 1, 25);
  horizontal(9, 1, 9);
  horizontal(9, 11, 15);
  horizontal(9, 17, 25);
  for (const x of [1, 9, 17, 25]) vertical(x, 1, 25);
  for (const x of [5, 21]) {
    vertical(x, 1, 9);
    vertical(x, 13, 25);
  }
  vertical(13, 5, 25);
  // A small ghost house has one northern exit. Its floor never holds pellets.
  for (let y = 11; y <= 15; y++) {
    for (let x = 11; x <= 15; x++) {
      cells[y * MAZE_COLUMNS + x] = Number(x > 11 && x < 15 && y > 11 && y < 15);
    }
  }
  cells[11 * MAZE_COLUMNS + 13] = 1;
  return Object.freeze(
    Array.from({ length: MAZE_ROWS }, (_, y) =>
      Array.from({ length: MAZE_COLUMNS }, (_, x) =>
        cells[y * MAZE_COLUMNS + x] ? '.' : '#',
      ).join(''),
    ),
  );
}

export const MAZE = makeMaze();
export function isWalkable(x, y, allowHouse = false) {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= MAZE_COLUMNS ||
    y >= MAZE_ROWS
  )
    return false;
  if (MAZE[y][x] === '#') return false;
  return allowHouse || !(x >= 12 && x <= 14 && y >= 11 && y <= 14);
}

function seedPellets(model) {
  model.pellets.fill(0);
  model.remaining = 0;
  for (let y = 0; y < MAZE_ROWS; y++) {
    for (let x = 0; x < MAZE_COLUMNS; x++) {
      if (!isWalkable(x, y) || (x === PLAYER_START.x && y === PLAYER_START.y)) continue;
      model.pellets[y * MAZE_COLUMNS + x] = (x === 1 || x === 25) && (y === 1 || y === 25) ? 2 : 1;
      model.remaining++;
    }
  }
}

function resetActors(model) {
  model.player = {
    x: PLAYER_START.x,
    y: PLAYER_START.y,
    direction: 'left',
    queued: null,
    moving: false,
  };
  model.ghosts = GHOST_SPECS.map((spec, index) => ({
    name: spec.name,
    color: spec.color,
    x: spec.x,
    y: spec.y,
    direction: 'up',
    state: 'waiting',
    timer: spec.delay,
    index,
  }));
  model.frightened = 0;
  model.ghostCombo = 0;
  model.mode = 'scatter';
  model.modeTimer = 7;
  model.status = 'ready';
  model.phaseTimer = 0;
}

/** The model is ordinary deterministic game data, independent of DOM and WASM. */
export function createGameModel() {
  const model = {
    score: 0,
    lives: 3,
    level: 1,
    remaining: 0,
    status: 'ready',
    elapsed: 0,
    frightened: 0,
    ghostCombo: 0,
    mode: 'scatter',
    modeTimer: 7,
    phaseTimer: 0,
    player: null,
    ghosts: [],
    pellets: new Uint8Array(CELL_COUNT),
    distances: new Int16Array(CELL_COUNT),
    searchQueue: new Uint16Array(CELL_COUNT),
  };
  seedPellets(model);
  resetActors(model);
  return model;
}

export function restartModel(model) {
  model.score = 0;
  model.lives = 3;
  model.level = 1;
  model.elapsed = 0;
  seedPellets(model);
  resetActors(model);
}

export function getSnapshot(model) {
  return Object.freeze({
    score: model.score,
    lives: model.lives,
    level: model.level,
    remaining: model.remaining,
    status: model.status,
  });
}

export function setDirection(model, direction) {
  if (typeof direction !== 'string' || !Object.hasOwn(DIRECTIONS, direction))
    throw new RangeError('Direction must be up, down, left or right.');
  if (model.status !== 'ready' && model.status !== 'playing') return;
  model.player.queued = direction;
  if (model.status === 'ready') model.status = 'playing';
  // Reversal is immediate inside a corridor. Perpendicular turns remain buffered.
  if (model.player.direction && DIRECTIONS[model.player.direction].opposite === direction)
    model.player.direction = direction;
}

function atCenter(actor) {
  return (
    Math.abs(actor.x - Math.round(actor.x)) < 1e-7 && Math.abs(actor.y - Math.round(actor.y)) < 1e-7
  );
}

function canMove(actor, direction, ghost) {
  const vector = DIRECTIONS[direction];
  return (
    Boolean(vector) &&
    isWalkable(Math.round(actor.x) + vector.x, Math.round(actor.y) + vector.y, ghost)
  );
}

function moveActor(actor, distance, ghost, chooseDirection, reachedCenter) {
  let remaining = distance;
  // At most two centers can be crossed by any bounded simulation substep.
  for (let segment = 0; segment < 4 && remaining > 1e-8; segment++) {
    if (atCenter(actor)) {
      actor.x = Math.round(actor.x);
      actor.y = Math.round(actor.y);
      chooseDirection();
      if (!canMove(actor, actor.direction, ghost)) {
        actor.moving = false;
        return;
      }
    }
    const vector = DIRECTIONS[actor.direction];
    if (!vector) return;
    const value = vector.x !== 0 ? actor.x : actor.y;
    const sign = vector.x || vector.y;
    const boundary = sign > 0 ? Math.floor(value + 1e-7) + 1 : Math.ceil(value - 1e-7) - 1;
    const distanceToCenter = Math.abs(boundary - value);
    const step = Math.min(remaining, distanceToCenter);
    actor.x += vector.x * step;
    actor.y += vector.y * step;
    actor.moving = step > 0;
    remaining -= step;
    if (step + 1e-8 >= distanceToCenter) {
      actor.x = Math.round(actor.x);
      actor.y = Math.round(actor.y);
      if (reachedCenter?.() === false) return;
    }
  }
}

function consumePellet(model) {
  const index = Math.round(model.player.y) * MAZE_COLUMNS + Math.round(model.player.x);
  const pellet = model.pellets[index];
  if (pellet === 0) return true;
  model.pellets[index] = 0;
  model.remaining--;
  model.score += pellet === 2 ? 50 : 10;
  if (pellet === 2) {
    model.frightened = Math.max(3, 8 - (model.level - 1) * 0.35);
    model.ghostCombo = 0;
    for (const ghost of model.ghosts) {
      if (ghost.state === 'active') ghost.direction = DIRECTIONS[ghost.direction].opposite;
    }
  }
  if (model.remaining === 0) {
    model.status = 'level-clear';
    model.phaseTimer = 1.6;
    return false;
  }
  return true;
}

function fillDistances(model, targetX, targetY) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let y = 1; y < MAZE_ROWS - 1; y++) {
    for (let x = 1; x < MAZE_COLUMNS - 1; x++) {
      if (!isWalkable(x, y, true)) continue;
      const distance = Math.abs(x - targetX) + Math.abs(y - targetY);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = y * MAZE_COLUMNS + x;
      }
    }
  }
  model.distances.fill(-1);
  model.distances[bestIndex] = 0;
  model.searchQueue[0] = bestIndex;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const cell = model.searchQueue[head++];
    const x = cell % MAZE_COLUMNS;
    const y = Math.floor(cell / MAZE_COLUMNS);
    for (const direction of DIRECTION_NAMES) {
      const vector = DIRECTIONS[direction];
      const nx = x + vector.x;
      const ny = y + vector.y;
      if (!isWalkable(nx, ny, true)) continue;
      const next = ny * MAZE_COLUMNS + nx;
      if (model.distances[next] >= 0) continue;
      model.distances[next] = model.distances[cell] + 1;
      model.searchQueue[tail++] = next;
    }
  }
}

function chooseGhostDirection(model, ghost) {
  const player = model.player;
  const heading = DIRECTIONS[player.direction] ?? DIRECTIONS.left;
  let targetX;
  let targetY;
  const frightened = ghost.state === 'active' && model.frightened > 0;
  const insideHouse = ghost.y >= 11 && ghost.x >= 12 && ghost.x <= 14 && ghost.y <= 14;
  const flee = frightened && !insideHouse;
  if (ghost.state === 'eyes') {
    targetX = 13;
    targetY = 13;
  } else if (insideHouse) {
    targetX = 13;
    targetY = 9;
  } else if (frightened || model.mode === 'chase') {
    targetX = player.x;
    targetY = player.y;
    if (!frightened && ghost.index === 1) {
      targetX += heading.x * 4;
      targetY += heading.y * 4;
    } else if (!frightened && ghost.index === 2) {
      targetX = 2 * (targetX + heading.x * 2) - model.ghosts[0].x;
      targetY = 2 * (targetY + heading.y * 2) - model.ghosts[0].y;
    } else if (
      !frightened &&
      ghost.index === 3 &&
      Math.hypot(ghost.x - player.x, ghost.y - player.y) < 6
    ) {
      [targetX, targetY] = GHOST_SPECS[ghost.index].corner;
    }
  } else {
    [targetX, targetY] = GHOST_SPECS[ghost.index].corner;
  }
  fillDistances(model, targetX, targetY);
  const possible = DIRECTION_NAMES.filter((direction) => canMove(ghost, direction, true));
  const opposite = DIRECTIONS[ghost.direction].opposite;
  const candidates =
    ghost.state === 'eyes' || possible.length === 1
      ? possible
      : possible.filter((direction) => direction !== opposite);
  let selected = candidates[0] ?? opposite;
  let selectedCost = flee ? -Infinity : Infinity;
  for (let offset = 0; offset < DIRECTION_NAMES.length; offset++) {
    const direction = DIRECTION_NAMES[(offset + ghost.index) % DIRECTION_NAMES.length];
    if (!candidates.includes(direction)) continue;
    const vector = DIRECTIONS[direction];
    const distance =
      model.distances[
        (Math.round(ghost.y) + vector.y) * MAZE_COLUMNS + Math.round(ghost.x) + vector.x
      ];
    if (distance < 0) continue;
    if ((flee && distance > selectedCost) || (!flee && distance < selectedCost)) {
      selected = direction;
      selectedCost = distance;
    }
  }
  ghost.direction = selected;
}

function collide(model) {
  for (const ghost of model.ghosts) {
    if (
      ghost.state !== 'active' ||
      Math.hypot(ghost.x - model.player.x, ghost.y - model.player.y) >= 0.68
    )
      continue;
    if (model.frightened > 0) {
      ghost.state = 'eyes';
      model.score += 200 * 2 ** Math.min(model.ghostCombo, 3);
      model.ghostCombo++;
    } else {
      model.lives--;
      model.status = 'dying';
      model.phaseTimer = 1.2;
      model.player.moving = false;
      return;
    }
  }
}

function tick(model, dt) {
  if (model.status !== 'playing') return;
  if (model.frightened > 0) model.frightened = Math.max(0, model.frightened - dt);
  else {
    model.modeTimer -= dt;
    if (model.modeTimer <= 0) {
      model.mode = model.mode === 'scatter' ? 'chase' : 'scatter';
      model.modeTimer = model.mode === 'chase' ? 20 : Math.max(3, 7 - model.level * 0.3);
      for (const ghost of model.ghosts)
        if (ghost.state === 'active') ghost.direction = DIRECTIONS[ghost.direction].opposite;
    }
  }
  const playerSpeed = Math.min(6.8, 5.8 + (model.level - 1) * 0.12);
  moveActor(
    model.player,
    playerSpeed * dt,
    false,
    () => {
      if (model.player.queued && canMove(model.player, model.player.queued, false))
        model.player.direction = model.player.queued;
    },
    () => consumePellet(model),
  );
  if (model.status !== 'playing') return;
  collide(model);
  if (model.status !== 'playing') return;
  for (const ghost of model.ghosts) {
    if (ghost.state === 'waiting' || ghost.state === 'recovering') {
      ghost.timer -= dt;
      if (ghost.timer > 0) continue;
      ghost.state = 'active';
    }
    const speed =
      ghost.state === 'eyes'
        ? 10
        : model.frightened > 0
          ? 3.3
          : Math.min(6.3, 4.65 + (model.level - 1) * 0.16);
    moveActor(
      ghost,
      speed * dt,
      true,
      () => chooseGhostDirection(model, ghost),
      () => {
        if (ghost.state === 'eyes' && ghost.x === 13 && ghost.y === 13) {
          ghost.state = 'recovering';
          ghost.timer = 1.4;
          return false;
        }
        return true;
      },
    );
  }
  collide(model);
}

export function advanceModel(model, dt) {
  if (!Number.isFinite(dt) || dt < 0 || dt > 0.25)
    throw new RangeError('Simulation dt must be between zero and 0.25 seconds.');
  model.elapsed += dt;
  if (model.status === 'dying' || model.status === 'level-clear') {
    model.phaseTimer -= dt;
    if (model.phaseTimer > 0) return;
    if (model.status === 'dying') {
      if (model.lives === 0) model.status = 'game-over';
      else resetActors(model);
    } else {
      model.level = Math.min(99, model.level + 1);
      seedPellets(model);
      resetActors(model);
    }
    return;
  }
  const count = Math.ceil(dt * 120);
  for (let step = 0; step < count; step++) tick(model, dt / count);
}

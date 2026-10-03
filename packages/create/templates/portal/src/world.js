// The levels and how the hero moves. Positions are kept in 1/16 pixels, so the
// physics uses whole numbers only and plays the same on every device.

export const TILE = 16;
export const SUB = 16;
export const HERO = { w: 10, h: 12 };
const WALK = 20; // 1.25 pixels per update
const JUMP = 64;
const GRAVITY = 3;
const FALL = 80;

// One character per 16 × 16 tile: # ground, o coin, ^ spikes, F flag, P start. Maps are
// 20 tiles wide and up to 11 high; missing rows above them are sky. The ids match
// "levels" in public/pixeljs.json, and par is the time for the third star.
export const LEVELS = [
  {
    id: '1-1',
    name: 'First Steps',
    par: 8000,
    map: [
      '.......o............',
      '......###.....o.....',
      '...###.......###....',
      'P........o.........F',
      '#########..#########',
    ],
  },
  {
    id: '1-2',
    name: 'Up We Go',
    par: 12000,
    map: [
      '...............o....',
      '..................F.',
      '..............######',
      '..........o.........',
      '.........####.......',
      '.....o..............',
      '....####............',
      'P...............o...',
      '####################',
    ],
  },
  {
    id: '1-3',
    name: 'Spike Garden',
    par: 8000,
    map: [
      '........o...........',
      '.......###..........',
      '....o...............',
      '...###..............',
      'P.....^^.....o...^.F',
      '##########...#######',
    ],
  },
];

/** A fresh copy of a level, ready to play. */
export function createLevel(def) {
  const level = { solid: [], spikes: [], coins: [], start: { x: 0, y: 0 }, flag: { x: 0, y: 0 } };
  const sky = Array(11 - def.map.length).fill('.'.repeat(20));
  [...sky, ...def.map].forEach((row, ty) => {
    level.solid.push([...row].map((tile) => tile === '#'));
    [...row].forEach((tile, tx) => {
      const x = tx * TILE;
      const y = ty * TILE;
      if (tile === '^') level.spikes.push({ x, y });
      if (tile === 'o') level.coins.push({ x: x + 8, y: y + 8, taken: false });
      if (tile === 'P') level.start = { x: x + 3, y: y + TILE - HERO.h };
      if (tile === 'F') level.flag = { x, y };
    });
  });
  return level;
}

export function createHero(level) {
  return { x: level.start.x * SUB, y: level.start.y * SUB, vy: 0, ground: false, left: false };
}

const solidAt = (level, x, y) => level.solid[Math.floor(y / TILE)]?.[Math.floor(x / TILE)] === true;

/** Whether the hero's box at (x, y) leaves the screen or overlaps a solid tile at a corner. */
function blocked(level, x, y) {
  const right = x + HERO.w - 1;
  const bottom = y + HERO.h - 1;
  if (x < 0 || right >= level.solid[0].length * TILE) return true;
  return [x, right].some((cx) => solidAt(level, cx, y) || solidAt(level, cx, bottom));
}

/** Moves one sub-pixel at a time, so the hero stops flush; true when something blocked it. */
function move(level, hero, dx, dy) {
  for (let left = Math.abs(dx + dy); left > 0; left--) {
    const x = hero.x + Math.sign(dx);
    const y = hero.y + Math.sign(dy);
    if (blocked(level, Math.floor(x / SUB), Math.floor(y / SUB))) return true;
    hero.x = x;
    hero.y = y;
  }
  return false;
}

/**
 * One update (60 per second) with the player's controls `{ left, right, jump }`.
 * Returns what happened: 'jump', 'coin', 'hurt', 'goal' or ''.
 */
export function step(level, hero, controls) {
  const direction = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
  if (direction) hero.left = direction < 0;
  move(level, hero, direction * WALK, 0);
  let event = '';
  if (controls.jump && hero.ground) {
    hero.vy = -JUMP;
    event = 'jump';
  }
  hero.vy = Math.min(hero.vy + GRAVITY, FALL);
  const hit = move(level, hero, 0, hero.vy);
  hero.ground = hit && hero.vy > 0;
  if (hit) hero.vy = 0;

  const x = Math.floor(hero.x / SUB);
  const y = Math.floor(hero.y / SUB);
  const touches = (bx, by, bw, bh) =>
    x < bx + bw && x + HERO.w > bx && y < by + bh && y + HERO.h > by;
  for (const coin of level.coins) {
    if (!coin.taken && touches(coin.x - 4, coin.y - 4, 8, 8)) {
      coin.taken = true;
      event = 'coin';
    }
  }
  if (y > level.solid.length * TILE || level.spikes.some((s) => touches(s.x + 2, s.y + 8, 12, 8)))
    return 'hurt';
  if (touches(level.flag.x + 4, level.flag.y - 16, 8, 32)) return 'goal';
  return event;
}

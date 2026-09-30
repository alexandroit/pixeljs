import { createEngine } from '@pixeljs/core';
import {
  GAME_WIDTH,
  GAME_HEIGHT,
  TILE_SIZE,
  MAZE_X,
  MAZE_Y,
  MAZE_COLUMNS,
  DIRECTIONS,
  createGameModel,
  advanceModel,
  getSnapshot,
  setDirection as queueDirection,
  restartModel,
} from './pacman-model.js';
export { GAME_WIDTH, GAME_HEIGHT } from './pacman-model.js';

// The maze tiles, sprites, HUD font, sounds and music are ordinary files
// listed in assets/assets.json (tools/generate-pacman-assets.mjs writes
// them). engine.loadAssets() loads them all; this module only draws and
// plays them through the public PixelJS API.

/** Where mountGame() finds the asset manifest by default, relative to the page. */
export const GAME_MANIFEST = 'assets/assets.json';

const DIRECTION_NAMES = Object.keys(DIRECTIONS);
// Keyboard codes and the gamepad button for each direction.
const CONTROLS = [
  ['up', 'ArrowUp', 'KeyW', 'Up'],
  ['left', 'ArrowLeft', 'KeyA', 'Left'],
  ['down', 'ArrowDown', 'KeyS', 'Down'],
  ['right', 'ArrowRight', 'KeyD', 'Right'],
];
// Colors of the default palette, by index.
const SLATE = 2;
const GRAY = 3;
const WHITE = 4;
const RED = 5;
const YELLOW = 7;
const CYAN = 10;
const BLUE = 11;
const PINK = 14;

/** Creates a 224×256 engine, loads the game's assets and starts the game. */
export async function mountGame(canvas, options = {}) {
  const engine = await createEngine({
    canvas,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    renderer: options.renderer ?? 'auto',
    onError: options.onError,
  });
  try {
    const assets = await engine.loadAssets(options.manifest ?? GAME_MANIFEST);
    return runGame(engine, { assets, onProgress: options.onProgress });
  } catch (error) {
    await engine.dispose();
    throw error;
  }
}

/**
 * Starts the game on an idle 224×256 engine, with the bundle that
 * engine.loadAssets() returned for the game's manifest.
 */
export function runGame(engine, options = {}) {
  if (engine.width !== GAME_WIDTH || engine.height !== GAME_HEIGHT)
    throw new RangeError(`The game requires a ${GAME_WIDTH} by ${GAME_HEIGHT} engine.`);
  const progress = options.onProgress;
  if (progress !== undefined && typeof progress !== 'function')
    throw new TypeError('onProgress must be a function.');
  const assets = options.assets;
  if (engine.state !== 'READY')
    throw new Error('Attach the game to a newly created, ready engine.');
  if (typeof assets?.image !== 'function')
    throw new TypeError('assets must be the bundle engine.loadAssets() returned for the game.');
  // The getters throw for a missing entry, before anything starts.
  const maze = assets.tilemap('maze');
  const playerAtlas = assets.image('player');
  const ghostAtlas = assets.image('ghosts');
  const font = assets.font('arcade');
  const sounds = {
    wakaA: assets.sound('waka-a'),
    wakaB: assets.sound('waka-b'),
    power: assets.sound('power'),
    ghost: assets.sound('ghost'),
    death: assets.sound('death'),
    level: assets.sound('level'),
    start: assets.sound('start'),
  };
  const music = { siren: assets.music('siren'), fright: assets.music('fright') };

  const model = createGameModel();
  let disposed = false;
  const active = () => {
    if (disposed || ['DISPOSING', 'DISPOSED', 'FAILED'].includes(engine.state))
      throw new Error('The game has been disposed or failed.');
  };
  // What the previous tick saw, to turn model changes into sounds.
  let seen;
  const remember = () =>
    (seen = {
      remaining: model.remaining,
      combo: model.ghostCombo,
      frightened: model.frightened,
      status: model.status,
    });
  remember();
  let wakaStep = 0;
  let playing = null;
  let previousProgress = '';
  const notify = () => {
    const snapshot = getSnapshot(model);
    const signature = `${snapshot.score}/${snapshot.lives}/${snapshot.level}/${snapshot.remaining}/${snapshot.status}`;
    if (signature !== previousProgress) {
      previousProgress = signature;
      progress?.(snapshot);
    }
  };
  const restart = () => {
    restartModel(model);
    remember();
    engine.audio.play(sounds.start, 0);
  };

  // Sounds follow what changed during the tick. Sounds played before audio
  // is unlocked are dropped; the music wish is kept and starts with audio.
  function playSounds() {
    const { audio } = engine;
    if (model.remaining < seen.remaining) {
      wakaStep = 1 - wakaStep;
      audio.play(wakaStep ? sounds.wakaA : sounds.wakaB, 0);
    }
    if (model.frightened > seen.frightened) audio.play(sounds.power, 1);
    if (model.ghostCombo > seen.combo) audio.play(sounds.ghost, 1);
    if (model.status !== seen.status) {
      if (model.status === 'dying') audio.play(sounds.death, 0);
      else if (model.status === 'level-clear') audio.play(sounds.level, 0);
      else if (model.status === 'ready') audio.play(sounds.start, 0);
    }
    // The siren loops during the chase; frightened ghosts get their own loop.
    const wanted =
      model.status === 'playing' ? (model.frightened > 0 ? music.fright : music.siren) : null;
    if (wanted !== playing) {
      playing = wanted;
      if (wanted) audio.playMusic(wanted);
      else audio.stopMusic();
    }
  }

  function update(dt) {
    const { input } = engine;
    if (
      model.status === 'game-over' &&
      (input.wasPressed('Enter') || input.wasPressed('Space') || input.wasButtonPressed('Start'))
    )
      restart();
    for (const [direction, arrow, letter, button] of CONTROLS) {
      if (input.wasPressed(arrow) || input.wasPressed(letter) || input.wasButtonPressed(button))
        queueDirection(model, direction);
    }
    const x = input.axis('leftX');
    const y = input.axis('leftY');
    if (Math.max(Math.abs(x), Math.abs(y)) > 0.5)
      queueDirection(
        model,
        Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up',
      );
    advanceModel(model, dt);
    playSounds();
    remember();
    notify();
  }

  const text = (value, x, y, color) => engine.graphics.text(x, y, value, color, { font });
  const centered = (value, y, color) =>
    text(value, Math.floor((GAME_WIDTH - engine.measureText(value, font).width + 1) / 2), y, color);

  function drawGhost(ghost) {
    const g = engine.graphics;
    const x = Math.round(MAZE_X + ghost.x * TILE_SIZE + 1);
    const y = Math.round(MAZE_Y + ghost.y * TILE_SIZE + 1);
    const frightened = ghost.state === 'active' && model.frightened > 0;
    const eyes = ghost.state === 'eyes' || ghost.state === 'recovering';
    const frame = Math.floor(model.elapsed * 7) % 2;
    const flash = frightened && model.frightened < 2 && Math.floor(model.elapsed * 7) % 2 === 0;
    if (!eyes)
      g.sprite(ghostAtlas, x, y, {
        sourceX: frame * 7,
        sourceY: (frightened ? (flash ? 5 : 4) : ghost.index) * 7,
        width: 7,
        height: 7,
      });
    if (frightened) {
      const color = flash ? RED : YELLOW;
      for (const dx of [1, 5]) g.pixel(x + dx, y + 2, color);
      for (const dx of [1, 3, 5]) g.pixel(x + dx, y + 5, color);
      for (const dx of [2, 4]) g.pixel(x + dx, y + 4, color);
    } else {
      const vector = DIRECTIONS[ghost.direction];
      g.rect(x + 1, y + 2, 2, 3, WHITE);
      g.rect(x + 4, y + 2, 2, 3, WHITE);
      const eyeX = vector.x > 0 ? 1 : 0;
      const eyeY = vector.y < 0 ? 0 : vector.y > 0 ? 2 : 1;
      g.pixel(x + 1 + eyeX, y + 2 + eyeY, BLUE);
      g.pixel(x + 4 + eyeX, y + 2 + eyeY, BLUE);
    }
  }

  function drawPlayer() {
    const g = engine.graphics;
    const x = Math.round(MAZE_X + model.player.x * TILE_SIZE + 1);
    const y = Math.round(MAZE_Y + model.player.y * TILE_SIZE + 1);
    const direction = Math.max(0, DIRECTION_NAMES.indexOf(model.player.direction));
    if (model.status !== 'dying') {
      const frame = model.player.moving ? Math.floor(model.elapsed * 13) % 3 : 0;
      g.sprite(playerAtlas, x, y, {
        sourceX: frame * 7,
        sourceY: direction * 7,
        width: 7,
        height: 7,
      });
    } else if (model.phaseTimer > 0.55) {
      // Caught: the player spins twice while shrinking, then bursts.
      const spin = Math.min(1, (1.2 - model.phaseTimer) / 0.65);
      g.sprite(playerAtlas, x, y, {
        sourceX: 7,
        sourceY: direction * 7,
        width: 7,
        height: 7,
        rotation: spin * 720,
        scale: Math.max(0.125, 1 - spin),
      });
    } else {
      const radius = Math.round((0.55 - model.phaseTimer) * 18);
      for (const vector of Object.values(DIRECTIONS))
        g.rect(x + 3 + vector.x * radius, y + 3 + vector.y * radius, 2, 2, YELLOW);
    }
  }

  function draw() {
    const g = engine.graphics;
    g.clear(0);
    // A cleared maze flashes: its blue edges are drawn cyan.
    const flash = model.status === 'level-clear' && Math.floor(model.elapsed * 6) % 2 === 0;
    if (flash) g.remap(BLUE, CYAN);
    g.tilemap(maze, MAZE_X, MAZE_Y);
    if (flash) g.resetRemap();
    g.rect(5, 20, 214, 1, SLATE);
    g.rect(5, 243, 214, 1, SLATE);
    g.rect(MAZE_X + 13 * TILE_SIZE, MAZE_Y + 11 * TILE_SIZE + 2, 8, 2, PINK);
    text('SCORE', 6, 3, GRAY);
    text(String(model.score).padStart(6, '0').slice(-6), 6, 11, WHITE);
    text('PAC-MAN', 98, 7, YELLOW);
    text('LEVEL', 194, 3, GRAY);
    text(String(model.level).padStart(2, '0'), 204, 11, YELLOW);
    const blink = Math.floor(model.elapsed * 4) % 2 ? YELLOW : WHITE;
    for (let index = 0; index < model.pellets.length; index++) {
      const pellet = model.pellets[index];
      if (!pellet) continue;
      const x = MAZE_X + (index % MAZE_COLUMNS) * TILE_SIZE + 3;
      const y = MAZE_Y + Math.floor(index / MAZE_COLUMNS) * TILE_SIZE + 3;
      if (pellet === 1) g.rect(x, y, 2, 2, YELLOW);
      else g.ellipseFill(x - 2, y - 2, 6, 6, blink);
    }
    for (const ghost of model.ghosts) drawGhost(ghost);
    if (model.status !== 'game-over') drawPlayer();
    for (let life = 0; life < model.lives; life++)
      g.sprite(playerAtlas, 7 + life * 10, 247, { sourceX: 7, sourceY: 21, width: 7, height: 7 });
    text(`${model.remaining} DOTS`, 172, 248, GRAY);
    if (model.frightened > 0) {
      g.rect(67, 249, 75, 3, SLATE);
      g.rect(67, 249, Math.round(75 * Math.min(1, model.frightened / 8)), 3, BLUE);
    }
    if (model.status === 'ready') {
      g.rect(63, 147, 98, 20, 0);
      centered('READY!', 150, YELLOW);
      centered('ARROWS / WASD', 159, WHITE);
    } else if (model.status === 'level-clear') {
      g.rect(62, 147, 100, 20, 0);
      centered('MAZE CLEARED!', 151, YELLOW);
      centered('NEXT LEVEL', 160, WHITE);
    } else if (model.status === 'game-over') {
      g.rect(44, 132, 136, 36, SLATE);
      g.rect(46, 134, 132, 32, 0);
      centered('GAME OVER', 139, RED);
      centered('ENTER TO RESTART', 153, WHITE);
    }
  }

  try {
    engine.start({ update, draw });
    notify();
  } catch (error) {
    void engine.dispose().catch(() => {});
    throw error;
  }
  return Object.freeze({
    engine,
    get snapshot() {
      return getSnapshot(model);
    },
    setDirection(direction) {
      active();
      queueDirection(model, direction);
      notify();
    },
    restart() {
      active();
      restart();
      notify();
    },
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    unlockAudio: () => engine.audio.unlock(),
    dispose() {
      disposed = true;
      return engine.dispose();
    },
  });
}

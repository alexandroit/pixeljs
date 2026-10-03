// The game's screens: the level menu, play and the result. Every call to the portal
// is marked "PORTAL:"; world.js holds the levels and the movement.
import { HERO, LEVELS, SUB, TILE, createHero, createLevel, step } from './world.js';

const TOP = 4; // the 176-pixel level is drawn below a 4-pixel strip
const SLOT = 'progress'; // the save slot ("save" in public/pixeljs.json)
const KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  jump: ['ArrowUp', 'KeyW', 'Space'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  ok: ['Enter', 'Space'],
  back: ['Escape', 'Backspace'],
};

export function createGame(engine, portal) {
  const g = engine.graphics;
  const input = engine.input;
  const isDown = (codes) => codes.some((code) => input.isDown(code));
  const wasPressed = (codes) => codes.some((code) => input.wasPressed(code));
  const sound = (options) => engine.audio.createSound({ volume: 0.25, ...options });
  const sounds = {
    jump: sound({ frequency: 330, effect: 'slide', slideTo: 660, duration: 0.1 }), // square waves
    coin: sound({ waveform: 'sine', frequency: 1320, duration: 0.15, effect: 'fadeout' }),
    hurt: sound({ waveform: 'noise', frequency: 300, duration: 0.25, effect: 'fadeout' }),
    win: sound({
      bpm: 240,
      notes: ['C5', 'E5', 'G5', 'C6'].map((pitch, step) => ({ step, pitch })),
    }),
  };
  let progress = {}; // the best result per level id: { done, stars, score }
  let rev = 0; // PORTAL: the revision of the loaded save, so a newer one is never overwritten
  let screen = 'menu'; // menu | play | result
  let cursor = 0;
  let greeting = '';
  let touch = false;
  let clock = 0;
  let def, level, hero, run, frames, startedAt, result, answer;

  const best = (id) => progress[id] ?? { done: false, stars: 0, score: 0 };
  const unlocked = (index) => index === 0 || best(LEVELS[index - 1].id).done; // "unlock": "previous"
  const merge = (id, record) => {
    const mine = best(id);
    const next = {
      done: mine.done || Boolean(record.done),
      stars: Math.max(mine.stars, Number(record.stars) || 0),
      score: Math.max(mine.score, Number(record.score) || 0),
    };
    if (next.done || next.stars || next.score) progress[id] = next;
  };

  async function loadProgress() {
    // PORTAL: the save slot (in memory outside the portal), merged with the levels the
    // portal recorded for this player.
    const saved = await portal.load(SLOT);
    rev = saved.rev;
    let data = {};
    try {
      data = JSON.parse(saved.data ?? '{}') ?? {};
    } catch {
      /* A damaged save starts over. */
    }
    const records = await portal.levels();
    for (const { id } of LEVELS) {
      const { completed, stars, best: scores } = records[id] ?? {};
      merge(id, data[id] ?? {});
      merge(id, { done: completed, stars, score: scores?.['level-score'] });
    }
  }

  async function saveProgress() {
    // PORTAL: a cloud save for signed-in players. "conflict" means another device saved
    // first: merge its progress now; the next completed level saves both.
    const saved = await portal.save(SLOT, JSON.stringify(progress), { rev });
    if (saved.ok) rev = saved.rev;
    else if (saved.reason === 'conflict') await loadProgress();
  }

  function start(index) {
    def = LEVELS[index];
    cursor = index;
    level = createLevel(def);
    hero = createHero(level);
    frames = 0;
    startedAt = performance.now();
    // PORTAL: a run is one attempt at one level. Start it when play starts, never on menus.
    run = portal.levelStart(def.id);
    screen = 'play';
  }

  // Game time from the 60 Hz updates: pauses never count, and it never exceeds the real
  // time since levelStart (the portal checks that).
  const gameTime = () =>
    Math.min(Math.round((frames * 1000) / 60), Math.floor(performance.now() - startedAt));

  async function finish(outcome) {
    screen = 'result';
    const timeMs = gameTime();
    const coins = level.coins.filter((coin) => coin.taken).length;
    const scores = {};
    let stars = 0;
    if (outcome === 'complete') {
      // Three stars: finishing, every coin, and the level's par time.
      stars = 1 + (coins === level.coins.length ? 1 : 0) + (timeMs <= def.par ? 1 : 0);
      scores['level-score'] =
        1000 + coins * 100 + Math.max(0, Math.floor((def.par * 2 - timeMs) / 10));
      scores.fastest = timeMs;
      merge(def.id, { done: true, stars, score: scores['level-score'] });
      engine.audio.play(sounds.win, 0);
    } else engine.audio.play(sounds.hurt, 1);
    result = { outcome, timeMs, stars, score: scores['level-score'] ?? 0 };
    // PORTAL: report the run. The achievements of pixeljs.json have rules, so the portal
    // unlocks them from these results; one without a rule would use portal.unlock(id).
    answer = { pending: true };
    answer = await portal.levelEnd(await run, { outcome, scores, timeMs, stars, stats: { coins } });
    if (outcome === 'complete') await saveProgress();
  }

  function quit() {
    // PORTAL: leaving a level early is a "quit": never ranked, but always reported.
    const timeMs = gameTime();
    void run.then((id) => portal.levelEnd(id, { outcome: 'quit', timeMs }));
    screen = 'menu';
  }

  function update() {
    clock++;
    if (input.pointers.some((pointer) => pointer.type === 'touch')) touch = true;
    const tap = input.pointers.find((pointer) => pointer.pressed);
    if (screen === 'menu') {
      if (wasPressed(KEYS.up) || input.wasButtonPressed('Up'))
        cursor = (cursor + LEVELS.length - 1) % LEVELS.length;
      if (wasPressed(KEYS.down) || input.wasButtonPressed('Down'))
        cursor = (cursor + 1) % LEVELS.length;
      const row = tap ? Math.floor((tap.y - 48) / 34) : -1;
      const onRow = tap && tap.x >= 60 && tap.x < 260 && row >= 0 && row < LEVELS.length;
      if (onRow) cursor = row;
      const chosen = onRow || wasPressed(KEYS.ok) || input.wasButtonPressed('A');
      if (chosen && unlocked(cursor)) start(cursor);
    } else if (screen === 'play') {
      if (wasPressed(KEYS.back) || input.wasButtonPressed('Start')) return quit();
      frames++;
      // Touch: hold the left quarter or the next one to walk, the right half to jump.
      const held = (from, to) => input.pointers.some((p) => p.down && p.x >= from && p.x < to);
      const event = step(level, hero, {
        left: isDown(KEYS.left) || input.isButtonDown('Left') || held(0, 80),
        right: isDown(KEYS.right) || input.isButtonDown('Right') || held(80, 160),
        jump: isDown(KEYS.jump) || input.isButtonDown('A') || held(160, 320),
      });
      if (event === 'jump') engine.audio.play(sounds.jump, 0);
      if (event === 'coin') engine.audio.play(sounds.coin, 1);
      if (event === 'goal' || event === 'hurt') void finish(event === 'goal' ? 'complete' : 'fail');
    } else if (!answer.pending && (wasPressed(KEYS.ok) || input.wasButtonPressed('A') || tap)) {
      if (result.outcome === 'complete' && cursor < LEVELS.length - 1) cursor++;
      screen = 'menu';
    }
  }

  const center = (text, y, color) =>
    g.text((320 - engine.measureText(text).width) >> 1, y, text, color);
  function star(x, y, filled) {
    g.triangleFill(x + 4, y, x, y + 8, x + 8, y + 8, filled ? 7 : 3);
    g.triangleFill(x, y + 3, x + 8, y + 3, x + 4, y + 7, filled ? 7 : 3);
  }

  function drawMenu() {
    center('MY PIXELJS GAME', 12, 7);
    center(greeting, 26, 3);
    LEVELS.forEach((d, index) => {
      const y = 48 + index * 34;
      const mine = best(d.id);
      g.rect(60, y, 200, 28, index === cursor ? 2 : 0);
      g.rectb(60, y, 200, 28, index === cursor ? 7 : 2);
      g.text(68, y + 5, `${d.id} ${d.name.toUpperCase()}`, unlocked(index) ? 4 : 3);
      if (!unlocked(index)) g.text(68, y + 16, 'LOCKED', 3);
      else for (let s = 0; s < 3; s++) star(68 + s * 11, y + 16, s < mine.stars);
      const text = mine.score ? `BEST ${mine.score}` : '';
      g.text(252 - engine.measureText(text).width, y + 16, text, 10);
    });
    center(touch ? 'TAP A LEVEL TO PLAY' : 'ARROWS AND ENTER TO PLAY', 160, 3);
  }

  function drawLevel() {
    level.solid.forEach((row, ty) =>
      row.forEach((solid, tx) => {
        if (!solid) return;
        g.rect(tx * TILE, TOP + ty * TILE, TILE, TILE, 15);
        if (!level.solid[ty - 1]?.[tx]) g.rect(tx * TILE, TOP + ty * TILE, TILE, 3, 9);
      }),
    );
    for (const { x, y } of level.spikes)
      g.triangleFill(x + 2, TOP + y + 16, x + 8, TOP + y + 6, x + 14, TOP + y + 16, 3);
    level.coins.forEach((coin, index) => {
      const width = 1 + 2 * Math.round(3 * Math.abs(Math.cos(clock / 10 + index))); // spinning
      if (!coin.taken) g.ellipseFill(coin.x - (width >> 1), TOP + coin.y - 4, width, 8, 7);
    });
    const { x, y } = level.flag;
    g.rect(x + 7, TOP + y - 16, 2, 32, 4);
    g.triangleFill(x + 9, TOP + y - 16, x + 16, TOP + y - 12, x + 9, TOP + y - 8, 5);
    const hx = Math.floor(hero.x / SUB);
    const hy = TOP + Math.floor(hero.y / SUB);
    g.rect(hx, hy, HERO.w, HERO.h, 11);
    g.rect(hx + (hero.left ? 1 : 5), hy + 3, 4, 3, 4);
    const coins = level.coins.filter((coin) => coin.taken).length;
    g.text(4, 6, `${def.id} ${def.name.toUpperCase()}`, 4);
    g.text(4, 16, `COINS ${coins}/${level.coins.length}`, 7);
    g.text(260, 6, `${(frames / 60).toFixed(1)}S`, 4);
  }

  function drawResult() {
    g.rect(60, 40, 200, 96, 0);
    g.rectb(60, 40, 200, 96, result.outcome === 'complete' ? 7 : 5);
    if (result.outcome === 'complete') {
      center('LEVEL COMPLETE!', 50, 7);
      for (let s = 0; s < 3; s++) star(143 + s * 12, 64, s < result.stars);
      center(`SCORE ${result.score}  TIME ${(result.timeMs / 1000).toFixed(1)}S`, 80, 4);
    } else center('OUCH! TRY AGAIN', 64, 5);
    // PORTAL: what the portal answered; newBest lists the leaderboards you improved.
    const newBest = Object.values(answer.newBest ?? {}).some(Boolean);
    const rank = answer.rank ? `RANK #${answer.rank}` : '';
    let message = newBest ? `NEW BEST! ${rank}` : rank;
    if (answer.pending) message = 'SAVING...';
    else if (answer.reason === 'guest') message = 'SIGN IN TO KEEP YOUR SCORES';
    else if (answer.reason === 'not_in_portal') message = 'SCORES COUNT ON PIXELJS.COM';
    center(message, 98, 10);
    if (!answer.pending) center(touch ? 'TAP TO CONTINUE' : 'ENTER TO CONTINUE', 118, 3);
  }

  function draw() {
    g.clear(1);
    if (screen === 'menu') return drawMenu();
    drawLevel();
    if (screen === 'result') drawResult();
  }

  return {
    update,
    draw,
    loadProgress,
    /** PORTAL "player": { signedIn, handle? } is all a game learns about the player. */
    setPlayer({ signedIn, handle }) {
      greeting = signedIn ? `HELLO, ${String(handle).toUpperCase()}!` : 'PLAYING AS A GUEST';
      if (!portal.inPortal) greeting = 'NOT IN THE PORTAL: NOTHING IS RECORDED';
    },
    /** PORTAL "select": a player picked a level in the portal or opened a link to one. */
    select(id) {
      const index = LEVELS.findIndex((d) => d.id === id);
      if (index < 0 || !unlocked(index)) return;
      if (screen === 'play') quit();
      start(index);
    },
  };
}

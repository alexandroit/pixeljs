import { createEngine, type SoundResource } from '@pixeljs/core';

interface Player {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  grounded: boolean;
  left: boolean;
}
interface Platform {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Coin {
  x: number;
  y: number;
  taken: boolean;
}

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`The page has no ${selector} element.`);
  return found;
}
const canvas = element<HTMLCanvasElement>('canvas');
const status = element('#status');
const audioToggle = element('#audio-toggle');

const engine = await createEngine({
  canvas,
  width: 224,
  height: 256,
  onError(error: unknown): void {
    console.error('PixelJS runtime error:', error);
    status.textContent = `Error: ${String(error)}`;
  },
});

// A 12 × 11 hero in palette indices (hex digits); '.' is transparent.
const HERO = [
  '....1111....',
  '..11999911..',
  '.1999999991.',
  '.1944994491.',
  '199419941991',
  '199999999991',
  '199995599991',
  '199999999991',
  '.1999999991.',
  '..11111111..',
  '.11......11.',
];
const hero = engine.createImage({
  width: 12,
  height: HERO.length,
  pixels: Uint8Array.from(HERO.join(''), (cell) => (cell === '.' ? 0 : parseInt(cell, 16))),
  transparentIndex: 0,
});

// Every sound is synthesized: there are no audio files. Effects play on
// voices 0 and 1 and the music on voices 2 and 3, so effects never cut it.
const jumpSound: SoundResource = engine.audio.createSound({
  waveform: 'square',
  frequency: 220,
  effect: 'slide',
  slideTo: 660,
  volume: 0.25,
  duration: 0.12,
});
const coinSound: SoundResource = engine.audio.createSound({
  waveform: 'sine',
  bpm: 300,
  volume: 0.35,
  notes: [
    { step: 0, pitch: 'B5' },
    { step: 1, pitch: 'E6', length: 3, effect: 'fadeout' },
  ],
});
const hurtSound: SoundResource = engine.audio.createSound({
  waveform: 'noise',
  frequency: 300,
  volume: 0.3,
  duration: 0.2,
  effect: 'fadeout',
});
const winSound: SoundResource = engine.audio.createSound({
  waveform: 'square',
  bpm: 240,
  volume: 0.3,
  notes: ['C5', 'E5', 'G5', 'C6'].map((pitch, step) => ({
    step,
    pitch,
    length: step === 3 ? 4 : 1,
  })),
});
// [pitch, step, length in steps]
const MELODY: readonly (readonly [string, number, number?])[] = [
  ['C5', 0],
  ['E5', 2],
  ['G5', 4],
  ['E5', 6],
  ['F5', 8],
  ['A5', 10],
  ['G5', 12, 4],
  ['E5', 16],
  ['G5', 18],
  ['C6', 20],
  ['B5', 22],
  ['A5', 24],
  ['G5', 26],
  ['C5', 28, 4],
];
const theme = engine.audio.createMusic({
  bpm: 132,
  length: 32,
  tracks: [
    {
      voice: 2,
      waveform: 'square',
      volume: 0.1,
      notes: MELODY.map(([pitch, step, length = 2]) => ({ pitch, step, length })),
    },
    {
      voice: 3,
      waveform: 'triangle',
      volume: 0.25,
      notes: ['C3', 'G2', 'F2', 'G2', 'C3', 'E3', 'F2', 'G2'].map((pitch, index) => ({
        step: index * 4,
        length: 3,
        pitch,
      })),
    },
  ],
});
engine.audio.playMusic(theme); // Starts once audio is unlocked.

// Browsers start audio only from a user gesture: the first key press, tap
// or click starts it. The button then mutes and unmutes.
let muted = false;
async function startAudio(): Promise<void> {
  if (engine.audio.capabilities.state !== 'uninitialized') return;
  try {
    await engine.audio.unlock();
    audioToggle.textContent = 'Sound: On';
  } catch {
    /* Blocked: a later gesture tries again. */
  }
}
for (const type of ['keydown', 'pointerdown'])
  addEventListener(type, () => void startAudio(), { capture: true });
audioToggle.addEventListener('click', (): void => {
  if (engine.audio.capabilities.state === 'running') {
    muted = !muted;
    engine.audio.setVolume(muted ? 0 : 1);
    audioToggle.textContent = muted ? 'Sound: Muted' : 'Sound: On';
  }
  canvas.focus({ preventScroll: true });
});

// Platforms are one-way: jump through them from below and land on top.
const platforms: readonly Platform[] = [
  { x: 8, y: 220, w: 208, h: 8 },
  { x: 24, y: 180, w: 64, h: 6 },
  { x: 104, y: 140, w: 64, h: 6 },
  { x: 32, y: 100, w: 64, h: 6 },
  { x: 120, y: 60, w: 80, h: 6 },
];
const spikes: readonly number[] = [140, 148, 156]; // Touching one sends you back to the start.
const flag = { x: 160, y: 36 }; // Appears once every coin is collected.
const player: Player = { x: 20, y: 209, vx: 0, vy: 0, w: 12, h: 11, grounded: false, left: false };
let coins: Coin[] = [];
let score = 0;
let won = false;
let time = 0;

function reset(): void {
  coins = [
    { x: 56, y: 170 },
    { x: 136, y: 130 },
    { x: 64, y: 90 },
    { x: 190, y: 210 },
  ].map((coin) => ({ ...coin, taken: false }));
  score = 0;
  won = false;
  respawn();
  status.textContent = 'Collect every coin, then reach the flag.';
}
function respawn(): void {
  Object.assign(player, { x: 20, y: 209, vx: 0, vy: 0, grounded: false });
}
function touches(x: number, y: number, w: number, h: number): boolean {
  return player.x < x + w && player.x + player.w > x && player.y < y + h && player.y + player.h > y;
}

function update(dt: number): void {
  const input = engine.input;
  time += dt;
  if (won) {
    if (input.wasPressed('Enter') || input.wasPressed('Space') || input.wasButtonPressed('A'))
      reset();
    return;
  }
  // Keyboard, a gamepad's d-pad or its left stick.
  const stick = input.axis('leftX');
  const left = input.isDown('ArrowLeft') || input.isDown('KeyA') || input.isButtonDown('Left');
  const right = input.isDown('ArrowRight') || input.isDown('KeyD') || input.isButtonDown('Right');
  player.vx = left || stick < -0.3 ? -80 : right || stick > 0.3 ? 80 : 0;
  if (player.vx) player.left = player.vx < 0;
  const jump =
    input.wasPressed('ArrowUp') ||
    input.wasPressed('KeyW') ||
    input.wasPressed('Space') ||
    input.wasButtonPressed('A');
  if (jump && player.grounded) {
    player.vy = -220;
    engine.audio.play(jumpSound, 0);
  }
  player.vy = Math.min(300, player.vy + 500 * dt);
  player.x = Math.max(0, Math.min(engine.width - player.w, player.x + player.vx * dt));
  player.y += player.vy * dt;

  player.grounded = false;
  for (const p of platforms) {
    if (player.vy >= 0 && touches(p.x, p.y, p.w, 10) && player.y + player.h <= p.y + 10) {
      player.y = p.y - player.h;
      player.vy = 0;
      player.grounded = true;
    }
  }
  if (player.y > engine.height || spikes.some((x) => touches(x + 1, 214, 6, 6))) {
    engine.audio.play(hurtSound, 1);
    respawn();
  }
  for (const coin of coins) {
    if (!coin.taken && touches(coin.x - 5, coin.y - 5, 10, 10)) {
      coin.taken = true;
      score += 100;
      engine.audio.play(coinSound, 1);
      status.textContent = `Score: ${score}`;
    }
  }
  if (coins.every((coin) => coin.taken) && touches(flag.x, flag.y, 12, 24)) {
    won = true;
    engine.audio.play(winSound, 0);
    status.textContent = `You win with ${score} points! Press Enter to play again.`;
  }
}

function draw(): void {
  const g = engine.graphics;
  g.clear(1);
  // Stars and two hills behind everything.
  for (let row = 0; row < 7; row++)
    for (let x = 16 + (row % 2) * 16; x < 224; x += 32) g.pixel(x, 16 + row * 32, 3);
  g.ellipseFill(-40, 170, 150, 100, 2);
  g.ellipseFill(110, 185, 160, 90, 2);

  for (const p of platforms) {
    g.rect(p.x, p.y, p.w, p.h, 9);
    g.rect(p.x, p.y, p.w, 2, 8);
  }
  for (const x of spikes) g.triangleFill(x, 220, x + 4, 213, x + 8, 220, 3);
  // Coins spin: their width follows a cosine.
  for (const [index, coin] of coins.entries()) {
    if (coin.taken) continue;
    const width = 1 + 2 * Math.round(3 * Math.abs(Math.cos(time * 4 + index)));
    g.ellipseFill(coin.x - (width >> 1), coin.y - 4, width, 8, 7);
  }
  if (coins.every((coin) => coin.taken)) {
    g.rect(flag.x, flag.y, 2, 24, 4);
    g.triangleFill(flag.x + 2, flag.y, flag.x + 14, flag.y + 5, flag.x + 2, flag.y + 10, 5);
  }
  g.sprite(hero, Math.round(player.x), Math.round(player.y), { flipX: player.left });

  g.text(8, 8, `SCORE ${score}`, 4);
  if (won) {
    const message = 'YOU WIN!';
    const { width } = engine.measureText(message);
    g.rect(0, 100, engine.width, 28, 0);
    g.text((engine.width - width) >> 1, 110, message, 7);
  }
}

reset();
engine.start({ update, draw });
canvas.focus({ preventScroll: true });

addEventListener('pagehide', () => void engine.dispose(), { once: true });

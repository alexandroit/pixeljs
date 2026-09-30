import {
  createEngine,
  type Engine,
  type FontResource,
  type ImageResource,
  type MusicResource,
  type PointerSnapshot,
  type SoundResource,
  type TilemapResource,
} from '@pixeljs/core';

const WIDTH = 224;
const HEIGHT = 256;
// The example game's original assets. Vite emits them as files,
// so they load from the app's own origin: https://localhost in the Android shell.
const ASSETS = Object.freeze({
  player: new URL('../../../examples/javascript/assets/player.png', import.meta.url).href,
  tiles: new URL('../../../examples/javascript/assets/tiles.png', import.meta.url).href,
  maze: new URL('../../../examples/javascript/assets/maze.json', import.meta.url).href,
  font: new URL('../../../examples/javascript/assets/arcade-font.json', import.meta.url).href,
  sound: new URL('../../../examples/javascript/assets/sounds/waka-a.json', import.meta.url).href,
  music: new URL('../../../examples/javascript/assets/siren.json', import.meta.url).href,
});
/** A fixed calibration pattern drawn on top of the scene, so checks can read it back. */
const PATTERN = Object.freeze({
  area: { x: 4, y: 26, width: 216, height: 56 },
  swatches: { x: 8, y: 28, width: 10, height: 4, step: 12 },
  sprite: { x: 8, y: 36, background: 1 },
  map: { x: 40, y: 36, cols: 11, rows: 4 },
  text: { x: 8, y: 72, value: 'PIXELJS', color: 7, background: 1 },
});

interface Resources {
  readonly player: ImageResource;
  readonly tiles: ImageResource;
  readonly maze: TilemapResource;
  readonly font: FontResource;
  readonly sound: SoundResource;
  readonly music: MusicResource;
  readonly boop: SoundResource;
}
interface InputSample {
  readonly update: number;
  readonly pointers: readonly PointerSnapshot[];
  readonly pointer: PointerSnapshot;
}
interface FrameSample {
  readonly time: number;
  readonly updates: number;
  readonly droppedUpdates: number;
}
interface LifecycleEvent {
  readonly type: string;
  readonly time: number;
}
/** Read-only diagnostics for the automated emulator checks (tools/test-mobile-android.mjs). */
interface SmokeHooks {
  readonly engine: Engine | null;
  readonly resources: Resources | null;
  readonly assets: typeof ASSETS;
  readonly pattern: typeof PATTERN;
  readonly inputSamples: readonly InputSample[];
  /** Update counters at each drawn frame, to see catch-up after a pause. */
  readonly frames: readonly FrameSample[];
  /** Page and shell lifecycle events in order: 'visibility:hidden', 'pause', 'resume'. */
  readonly lifecycle: readonly LifecycleEvent[];
  readonly enginesCreated: number;
}
declare global {
  interface Window {
    pixeljsSmoke: SmokeHooks;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#screen');
const statusLabel = document.getElementById('status-label');
const statRenderer = document.getElementById('stat-renderer');
const statMem = document.getElementById('stat-mem');
const statFrames = document.getElementById('stat-frames');
const btnAudio = document.getElementById('btn-audio');
const btnPause = document.getElementById('btn-pause');
const btnRecreate = document.getElementById('btn-recreate');

if (!canvas) throw new Error('Canvas element not found');
const screen: HTMLCanvasElement = canvas;

let engine: Engine | null = null;
let resources: Resources | null = null;
let enginesCreated = 0;
let paused = false;
let moveX = 0;
let moveY = 0;
const inputSamples: InputSample[] = [];
const frames: FrameSample[] = [];
const lifecycle: LifecycleEvent[] = [];

const player = { x: 104, y: 180, speed: 100 };
const stars: Array<{ x: number; y: number; speed: number; color: number }> = [];
for (let i = 0; i < 40; i++) {
  stars.push({
    x: Math.floor(Math.random() * WIDTH),
    y: Math.floor(Math.random() * HEIGHT),
    speed: 20 + Math.random() * 60,
    color: Math.random() > 0.5 ? 6 : 7,
  });
}

function setStatus(text: string): void {
  if (statusLabel) statusLabel.textContent = text;
}
function showState(): void {
  if (!engine) return;
  if (engine.state === 'RUNNING') setStatus('RUNNING');
  else if (engine.state === 'PAUSED') setStatus(paused ? 'PAUSED' : 'PAUSED (BACKGROUND)');
}

/** Converts `pixeljs-font` JSON (rows of '#' and '.') into a bitmap font. */
function fontFromJson(target: Engine, data: unknown): FontResource {
  const font = data as Partial<
    Record<'format' | 'version' | 'glyphWidth' | 'glyphHeight' | 'firstChar' | 'glyphs', unknown>
  > | null;
  if (
    font === null ||
    typeof font !== 'object' ||
    font.format !== 'pixeljs-font' ||
    font.version !== 1 ||
    typeof font.glyphWidth !== 'number' ||
    typeof font.glyphHeight !== 'number' ||
    typeof font.firstChar !== 'number' ||
    !Array.isArray(font.glyphs)
  )
    throw new Error('Unsupported font data.');
  const { glyphWidth, glyphHeight, firstChar, glyphs } = font;
  const rowBytes = Math.ceil(glyphWidth / 8);
  const bitmap = new Uint8Array(glyphs.length * glyphHeight * rowBytes);
  glyphs.forEach((glyph: unknown, index) => {
    if (!Array.isArray(glyph) || glyph.length !== glyphHeight) throw new Error('Bad glyph.');
    glyph.forEach((row: unknown, y) => {
      if (typeof row !== 'string' || row.length !== glyphWidth) throw new Error('Bad glyph row.');
      for (let x = 0; x < glyphWidth; x++) {
        const at = (index * glyphHeight + y) * rowBytes + (x >> 3);
        if (row[x] === '#') bitmap[at] = (bitmap[at] ?? 0) | (0x80 >> (x & 7));
      }
    });
  });
  return target.createFont({
    glyphWidth,
    glyphHeight,
    firstChar,
    charCount: glyphs.length,
    fallbackChar: firstChar,
    bitmap,
  });
}

async function loadResources(target: Engine): Promise<Resources> {
  const [player, tiles, fontData, sound, music] = await Promise.all([
    target.loadImage(ASSETS.player, { transparentIndex: 0 }),
    target.loadImage(ASSETS.tiles),
    target.loadJson(ASSETS.font),
    target.audio.loadSound(ASSETS.sound),
    target.audio.loadMusic(ASSETS.music),
  ]);
  const maze = await target.loadTilemap(ASSETS.maze, { tileset: tiles });
  const boop = target.audio.createSound({
    waveform: 'triangle',
    frequency: 440,
    volume: 0.3,
    attack: 0.01,
    decay: 0.04,
    sustain: 0.2,
    release: 0.05,
    duration: 0.1,
  });
  return { player, tiles, maze, font: fontFromJson(target, fontData), sound, music, boop };
}

function recordInput(target: Engine): void {
  const { pointers, pointer } = target.input;
  if (pointers.length === 0 && !pointer.pressed && !pointer.released) return;
  inputSamples.push({ update: target.getStats().updates, pointers, pointer });
  if (inputSamples.length > 256) inputSamples.shift();
}

function update(dt: number): void {
  if (!engine) return;
  recordInput(engine);
  player.x += moveX * player.speed * dt;
  player.y += moveY * player.speed * dt;
  // The ship follows a finger held on the canvas.
  const pointer = engine.input.pointer;
  if (pointer.down) {
    const dx = pointer.x - 8 - player.x;
    const dy = pointer.y - 8 - player.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 4) {
      player.x += (dx / distance) * player.speed * dt;
      player.y += (dy / distance) * player.speed * dt;
    }
  }
  player.x = Math.min(WIDTH - 20, Math.max(4, player.x));
  player.y = Math.min(HEIGHT - 20, Math.max(4, player.y));
  for (const star of stars) {
    star.y += star.speed * dt;
    if (star.y >= HEIGHT) {
      star.y = 0;
      star.x = Math.floor(Math.random() * WIDTH);
    }
  }
  if (statFrames) statFrames.textContent = `${engine.getStats().frames} frames`;
}

function drawPattern(target: Engine, loaded: Resources): void {
  const g = target.graphics;
  const { area, swatches, sprite, map, text } = PATTERN;
  g.rect(area.x, area.y, area.width, area.height, 0);
  for (let index = 0; index < 16; index++)
    g.rect(swatches.x + index * swatches.step, swatches.y, swatches.width, swatches.height, index);
  g.rect(sprite.x, sprite.y, loaded.player.width, loaded.player.height, sprite.background);
  g.sprite(loaded.player, sprite.x, sprite.y);
  g.tilemap(loaded.maze, map.x, map.y, { cols: map.cols, rows: map.rows });
  g.text(text.x, text.y, text.value, text.color, {
    font: loaded.font,
    background: text.background,
  });
}

function draw(): void {
  if (!engine) return;
  const { updates, droppedUpdates } = engine.getStats();
  frames.push({ time: performance.now(), updates, droppedUpdates });
  if (frames.length > 600) frames.shift();
  const g = engine.graphics;
  g.clear(0);
  for (const star of stars) g.pixel(Math.round(star.x), Math.round(star.y), star.color);
  g.rectb(2, 2, WIDTH - 4, HEIGHT - 4, 2);
  const px = Math.round(player.x);
  const py = Math.round(player.y);
  g.rect(px + 4, py, 8, 16, 5);
  g.rect(px, py + 8, 16, 6, 4);
  g.pixel(px + 7, py + 2, 7);
  g.pixel(px + 8, py + 2, 7);
  g.pixel(px + 7, py + 16, 6);
  g.pixel(px + 8, py + 16, 6);
  g.text(8, 8, 'PIXELJS MOBILE SMOKE', 7);
  g.text(8, 18, `POS: ${px},${py}`, 3);
  if (resources) drawPattern(engine, resources);
}

async function startEngine(): Promise<void> {
  if (engine) {
    const previous = engine;
    engine = null;
    resources = null;
    await previous.dispose();
  }
  setStatus('STARTING...');
  const next = await createEngine({
    canvas: screen,
    width: WIDTH,
    height: HEIGHT,
    scaling: 'integer',
    onError(error: unknown) {
      console.error('Mobile smoke engine error:', error);
      setStatus(`ERROR: ${String(error)}`);
    },
  });
  enginesCreated++;
  const loaded = await loadResources(next);
  engine = next;
  resources = loaded;
  const stats = next.getStats();
  if (statRenderer) statRenderer.textContent = stats.renderer.toUpperCase();
  if (statMem) statMem.textContent = `${(stats.coreBytes / 1024).toFixed(1)} KiB`;
  next.start({ update, draw });
  paused = false;
  if (btnPause) btnPause.textContent = 'Pause';
  showState();
}

// Creation and disposal run one at a time, in order.
let engineQueue: Promise<void> = Promise.resolve();
function restart(): void {
  engineQueue = engineQueue.then(startEngine).catch((error: unknown) => {
    console.error('Mobile smoke start failed:', error);
    setStatus(`ERROR: ${String(error)}`);
  });
}

document.querySelectorAll<HTMLButtonElement>('[data-dir]').forEach((button) => {
  const dir = button.dataset['dir'];
  const start = (): void => {
    if (dir === 'up') moveY = -1;
    if (dir === 'down') moveY = 1;
    if (dir === 'left') moveX = -1;
    if (dir === 'right') moveX = 1;
    if (resources && engine?.audio.capabilities.state === 'running')
      engine.audio.play(resources.boop, 0);
  };
  const stop = (): void => {
    if (dir === 'up' || dir === 'down') moveY = 0;
    if (dir === 'left' || dir === 'right') moveX = 0;
  };
  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('pointerleave', stop);
});

btnAudio?.addEventListener('click', async () => {
  if (!engine) return;
  if (engine.audio.capabilities.state === 'running') {
    engine.audio.setVolume(0);
    btnAudio.textContent = 'Sound: Muted';
  } else {
    await engine.audio.unlock();
    engine.audio.setVolume(1);
    btnAudio.textContent = 'Sound: On';
  }
  screen.focus({ preventScroll: true });
});

// The first touch on the canvas is the user gesture that may start audio.
screen.addEventListener(
  'pointerdown',
  async () => {
    if (engine?.audio.capabilities.state !== 'uninitialized') return;
    try {
      await engine.audio.unlock();
      if (btnAudio) btnAudio.textContent = 'Sound: On';
    } catch {
      /* Audio is optional; the game keeps running. */
    }
  },
  { once: true },
);

btnPause?.addEventListener('click', () => {
  if (!engine) return;
  paused = !paused;
  if (paused) engine.pause();
  else engine.resume();
  btnPause.textContent = paused ? 'Resume' : 'Pause';
  showState();
});

btnRecreate?.addEventListener('click', restart);

// The engine pauses itself while the page is hidden or the native shell
// (Capacitor, Cordova) reports the app in the background with `pause`, and
// resumes afterwards; a manual pause stays in place. The label only reports
// it, once the engine's own listeners (registered later) have run.
for (const type of ['visibilitychange', 'pause', 'resume'])
  document.addEventListener(type, (event) => {
    lifecycle.push({
      type:
        event.type === 'visibilitychange' ? `visibility:${document.visibilityState}` : event.type,
      time: performance.now(),
    });
    if (lifecycle.length > 64) lifecycle.shift();
    setTimeout(showState, 0);
  });

window.addEventListener('pagehide', () => {
  void engine?.dispose();
  engine = null;
});

window.pixeljsSmoke = Object.freeze({
  get engine() {
    return engine;
  },
  get resources() {
    return resources;
  },
  assets: ASSETS,
  pattern: PATTERN,
  inputSamples,
  frames,
  lifecycle,
  get enginesCreated() {
    return enginesCreated;
  },
});

restart();

// A board game for two players, ready for the PixelJS portal (pixeljs.com), with three
// ways to play: against the computer, two players on one device, and online. Read this
// file first. rules.js holds the rules (tic-tac-toe, to replace with your game's),
// board.js draws the board, and src/modes/ holds the three modes.
import { createEngine, version } from '@pixeljs/core';
import { attachEngine, connectPortal } from '@pixeljs/core/portal';
import { createBoard } from './board.js';
import { createLocal } from './modes/local.js';
import { createOnline } from './modes/online.js';
import { createSolo } from './modes/solo.js';

const canvas = document.querySelector('canvas');
if (!canvas) throw new Error('The page has no canvas.');

// 1. Connect to the portal with the capabilities public/pixeljs.json declares.
const portal = await connectPortal({
  engine: `@pixeljs/core@${version}`,
  capabilities: ['pause', 'mute', 'multiplayer'],
});

// 2. The engine: 320 × 180 pixels, scaled by whole numbers to fit the window.
let engine;
try {
  engine = await createEngine({ canvas, width: 320, height: 180, scaling: 'integer' });
} catch (error) {
  portal.error(`The game could not start: ${error}`);
  throw error;
}
const g = engine.graphics;
const input = engine.input;
const board = createBoard(engine);
const click = engine.audio.createSound({ waveform: 'square', frequency: 660, duration: 0.05 });
const pressed = (...codes) => codes.some((code) => input.wasPressed(code));
const seed = () => crypto.getRandomValues(new Uint32Array(1))[0];

// 3. The modes all have the same shape: `state` (the board, or null), `labels` (the
//    sides' names), canPlay(), play(move), update(), status(), next() (Enter after a
//    game) and close(); online play adds panel() for its screens without a board.
//    Online events can arrive at any time (an invite link joins a room directly), so the
//    online mode listens from the start and takes over when a room appears.
const online = createOnline(portal, () => (mode = online));
const MODES = {
  solo: { label: 'YOU VS THE COMPUTER', create: () => createSolo(seed()) },
  local: { label: 'TWO PLAYERS, ONE DEVICE', create: () => createLocal(seed()) },
  online: { label: 'PLAY ONLINE', create: () => online.open() },
};
let mode = null; // null shows the game's own menu
let cursor = 0;

// Inside the portal, the player chose the mode on the portal's own buttons
// (portal.launch). Outside it, the game's menu offers solo and local play.
if (portal.inPortal && Object.hasOwn(MODES, portal.launch.mode))
  mode = MODES[portal.launch.mode].create();

const close = () => {
  mode.close();
  mode = null;
};
const menu = () =>
  (portal.multiplayer.available ? ['solo', 'local', 'online'] : ['solo', 'local']).map((id) => ({
    label: MODES[id].label,
    run: () => (mode = MODES[id].create()),
  }));
const choices = (panel) =>
  panel?.choices ? [...panel.choices, { label: 'BACK', run: close }] : [];

/** A list of choices: arrows and Enter, the d-pad and A, or a tap. */
function choose(items) {
  if (pressed('ArrowUp', 'KeyW') || input.wasButtonPressed('Up'))
    cursor = (cursor + items.length - 1) % items.length;
  if (pressed('ArrowDown', 'KeyS') || input.wasButtonPressed('Down'))
    cursor = (cursor + 1) % items.length;
  cursor = Math.min(cursor, items.length - 1);
  const tap = input.pointers.find((pointer) => pointer.pressed);
  const row = tap ? Math.floor((tap.y - 70) / 22) : -1;
  const onRow = tap && tap.x >= 60 && tap.x < 260 && row >= 0 && row < items.length;
  if (onRow) cursor = row;
  if (onRow || pressed('Enter', 'Space') || input.wasButtonPressed('A')) {
    const item = items[cursor];
    cursor = 0;
    item.run();
  }
}

function update() {
  if (!mode) return choose(menu());
  if (pressed('Escape', 'Backspace') || input.wasButtonPressed('B')) return close();
  const before = mode.state;
  mode.update();
  const items = choices(mode.panel?.());
  if (items.length) choose(items);
  else if (mode.state && mode.canPlay()) {
    const move = board.choose(mode.state);
    if (move !== undefined) mode.play(move);
  } else if (
    pressed('Enter', 'Space') ||
    input.wasButtonPressed('A') ||
    input.pointers.some((p) => p.pressed)
  )
    mode.next();
  if (mode?.state && mode.state !== before) engine.audio.play(click);
}

const center = (text, y, color) =>
  g.text((320 - engine.measureText(text).width) >> 1, y, text, color);

function drawMenu(title, lines, items, footer) {
  center(title, 14, 7);
  lines.forEach((line, index) => center(line, 32 + index * 11, 3));
  items.forEach((item, index) => {
    const y = 70 + index * 22;
    g.rect(60, y, 200, 18, index === cursor ? 2 : 0);
    g.rectb(60, y, 200, 18, index === cursor ? 7 : 2);
    center(item.label, y + 5, index === cursor ? 4 : 3);
  });
  center(footer, 164, 3);
}

function draw() {
  g.clear(1);
  if (!mode) {
    const footer = portal.inPortal ? '' : 'ONLINE PLAY WORKS ON PIXELJS.COM';
    return drawMenu('TIC-TAC-TOE', ['A PIXELJS BOARD GAME'], menu(), footer);
  }
  const panel = mode.panel?.();
  if (panel) return drawMenu(panel.title, panel.lines, choices(panel), '');
  board.draw(mode.state, mode.labels, mode.canPlay());
  center(mode.status(), 160, 4);
}

// 4. Start the loop, then let the portal pause, resume and mute the engine.
engine.start({ update, draw });
attachEngine(portal, engine);

// Keys reach the game while the canvas has focus, also after a click beside it.
const focus = () => canvas.focus({ preventScroll: true });
focus();
addEventListener('focus', focus);
addEventListener('mousedown', (event) => {
  if (event.target !== canvas) {
    event.preventDefault();
    focus();
  }
});
// Browsers start sound only after the player's first key press or tap.
const startAudio = () => {
  const state = engine.audio.capabilities.state;
  if (state === 'uninitialized' || state === 'blocked') engine.audio.unlock().catch(() => {});
};
addEventListener('keydown', startAudio, { capture: true });
addEventListener('pointerdown', startAudio, { capture: true });
addEventListener('pagehide', () => void engine.dispose(), { once: true });

// 5. Ready: the portal hides its loading screen (and joins a room from an invite link).
portal.ready();

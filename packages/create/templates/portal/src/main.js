// A PixelJS game ready for the PixelJS portal (pixeljs.com): three levels, leaderboards,
// stars, achievements and a cloud save. Read this file first, then game.js and world.js.
// Outside the portal every portal call still answers, so the game plays the same anywhere.
import { createEngine, version } from '@pixeljs/core';
import { attachEngine, connectPortal } from '@pixeljs/core/portal';
import { createGame } from './game.js';

const canvas = document.querySelector('canvas');
if (!canvas) throw new Error('The page has no canvas.');

// 1. Connect to the portal with the capabilities public/pixeljs.json declares.
const portal = await connectPortal({
  engine: `@pixeljs/core@${version}`,
  capabilities: ['pause', 'mute', 'levels', 'scores', 'achievements', 'save', 'level-select'],
});
portal.loading(0, 2); // the portal shows a loading bar

// 2. The engine: 320 × 180 pixels, scaled by whole numbers to fit the window.
let engine;
try {
  engine = await createEngine({ canvas, width: 320, height: 180, scaling: 'integer' });
} catch (error) {
  portal.error(`The game could not start: ${error}`);
  throw error;
}
portal.loading(1, 2);
const game = createGame(engine, portal);
await game.loadProgress();
game.setPlayer(await portal.player());
portal.on('player', (player) => game.setPlayer(player));
portal.on('select', ({ level }) => game.select(level));
portal.loading(2, 2);

// 3. Start the loop, then let the portal pause, resume and mute the engine.
engine.start({ update: game.update, draw: game.draw });
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

// 4. Ready: the portal hides its loading screen.
portal.ready();

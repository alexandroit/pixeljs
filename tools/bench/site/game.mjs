// B01/B09 startup page: a small production-like game that imports the
// packaged runtime by a relative URL, so it works at the site root and under
// a nested path. It records its startup phases; audio stays untouched until
// the button is clicked (lazy activation).
import { createEngine } from './pixeljs/index.js';
import { drawScene, sceneImages } from './scene.mjs';

const state = { marks: {}, errors: [], renderer: null, audio: 'uninitialized' };
window.pixeljsGame = state;
const mark = (name) => {
  state.marks[name] = performance.now();
};
mark('module');

const renderer = new URLSearchParams(location.search).get('renderer') ?? 'auto';
const canvas = document.querySelector('canvas');
try {
  mark('create-start');
  const engine = await createEngine({
    canvas,
    renderer,
    onError: (error) => state.errors.push(String(error?.code ?? error)),
  });
  mark('create-end');
  state.renderer = engine.capabilities.renderer;
  const images = {};
  for (const [name, image] of Object.entries(sceneImages()))
    images[name] = engine.createImage(image);
  mark('assets-end');
  let frame = 0;
  engine.start({
    update() {
      frame++;
    },
    draw() {
      drawScene(engine.graphics, images, frame);
    },
  });
  // Registered after start(): in each animation frame this runs after the
  // engine's own callback, so the first frame has been submitted.
  const watch = () => {
    if (engine.getStats().frames > 0) mark('first-frame');
    else requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  document.querySelector('[data-audio]').addEventListener('click', async () => {
    mark('unlock-start');
    try {
      await engine.audio.unlock();
      engine.audio.play({ frequency: 440, duration: 0.05, volume: 0.2 });
    } catch (error) {
      state.errors.push(String(error?.code ?? error));
    }
    state.audio = engine.audio.capabilities.state;
    mark('unlock-end');
  });
  window.addEventListener('pagehide', () => void engine.dispose());
} catch (error) {
  state.errors.push(String(error?.code ?? error));
  mark('failed');
}

import * as pixeljs from '/packages/core/dist/index.js';

// Test-only reference to the actual public ESM entrypoint; no mock WASM or heap views.
window.pixeljs = pixeljs;
window.testEngines = [];
window.createTestEngine = async (options = {}) => {
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.style.width = '256px';
  canvas.style.height = '256px';
  document.querySelector('main').append(canvas);
  const engine = await pixeljs.createEngine({
    canvas,
    width: 16,
    height: 16,
    renderer: 'canvas2d',
    ...options,
  });
  window.testEngines.push(engine);
  return { engine, canvas };
};

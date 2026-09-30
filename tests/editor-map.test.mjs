// Tile map editor: tools, validation of sizes and tilesets, and the live
// preview rendered by a running engine with createTilemap + graphics.tilemap.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentPoint,
  mapTiles,
  openEditor,
  openProjectFile,
  previewPixels,
  saveProject,
  startEditor,
  statusText,
} from './editor-harness.mjs';

const DEFAULT_HEX = [
  '#0d111c',
  '#242c42',
  '#474d6f',
  '#79809a',
  '#e7eff6',
  '#fa695d',
  '#f9a75a',
  '#ffdc80',
  '#9fd86b',
  '#38ad87',
  '#32daca',
  '#3f87d4',
  '#795fce',
  '#b676d6',
  '#f0a3c7',
  '#7a5242',
];
const EMPTY = 65535;

let env;
before(async () => {
  env = await startEditor();
});
after(async () => {
  await env?.close();
});

const rows = (width, height, cell, digits) =>
  Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => cell(x, y).toString(16).padStart(digits, '0')).join(''),
  );
/** 16 × 8 tileset of eight 4 × 4 tiles; every tile differs. */
const tilesPixel = (x, y) => ((x >> 2) + (y >> 2) * 4 + ((x + y) % 2) * 8) % 16;

function project({ cols = 6, rows: height = 4, tile = () => EMPTY, transparentIndex } = {}) {
  const tileset = { name: 'tiles', width: 16, height: 8, pixels: rows(16, 8, tilesPixel, 2) };
  if (transparentIndex !== undefined) tileset.transparentIndex = transparentIndex;
  return JSON.stringify({
    format: 'pixeljs-project',
    version: 1,
    palette: DEFAULT_HEX,
    sprites: [tileset, { name: 'other', width: 8, height: 8, pixels: rows(8, 8, () => 5, 2) }],
    maps: [
      {
        name: 'level',
        tileset: 'tiles',
        tileWidth: 4,
        tileHeight: 4,
        cols,
        rows: height,
        tiles: rows(cols, height, tile, 4),
      },
    ],
    sounds: [],
  });
}

async function openMapProject(page, text) {
  await openProjectFile(page, 'maps.pixeljs.json', text);
  await page.waitForFunction(() =>
    document.getElementById('status').textContent.startsWith('Opened'),
  );
  await page.click('#tab-map');
  await page.waitForSelector('#map-canvas[data-zoom]');
}

async function setMapZoom(page, zoom) {
  await page.selectOption('#map-zoom', String(zoom));
  await page.waitForFunction(
    (zoom) => document.getElementById('map-canvas').dataset.zoom === String(zoom),
    zoom,
  );
}

const cellPoint = (page, col, row) => contentPoint(page, '#map-canvas', col * 4 + 2, row * 4 + 2);

async function clickCell(page, col, row, modifiers = []) {
  const point = await cellPoint(page, col, row);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(point.x, point.y);
  for (const key of modifiers) await page.keyboard.up(key);
}

async function dragCells(page, from, to) {
  const start = await cellPoint(page, ...from);
  const end = await cellPoint(page, ...to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

async function pickTileInPicker(page, tile) {
  const box = await page.locator('#tile-picker').boundingBox();
  const zoom = box.width / 16;
  await page.mouse.click(
    box.x + ((tile % 4) * 4 + 2) * zoom,
    box.y + (Math.floor(tile / 4) * 4 + 2) * zoom,
  );
}

const chooseTool = (page, tool) => page.click(`#map-tools [data-tool="${tool}"]`);
const rgb = (index) => {
  const value = Number.parseInt(DEFAULT_HEX[index].slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** Expected 256 × 144 preview: the map drawn at -camera over the background. */
function expectedPreview(tiles, cols, mapRows, camera, background, transparentIndex) {
  const out = [];
  for (let y = 0; y < 144; y++)
    for (let x = 0; x < 256; x++) {
      const mx = x + camera.x;
      const my = y + camera.y;
      let index = background;
      if (mx < cols * 4 && my < mapRows * 4) {
        const tile = tiles[Math.floor(my / 4) * cols + Math.floor(mx / 4)];
        if (tile !== EMPTY) {
          const pixel = tilesPixel((tile % 4) * 4 + (mx % 4), Math.floor(tile / 4) * 4 + (my % 4));
          if (pixel !== transparentIndex) index = pixel;
        }
      }
      out.push(...rgb(index));
    }
  return out;
}

async function waitForMapPreview(page, expected) {
  let shown = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const frame = await previewPixels(page);
    shown = [];
    for (let at = 0; at < frame.rgba.length; at += 4) shown.push(...frame.rgba.slice(at, at + 3));
    if (frame.width === 256 && frame.height === 144 && shown.every((v, at) => v === expected[at]))
      return;
  }
  const mismatch = shown.findIndex((value, at) => value !== expected[at]);
  assert.fail(`the map preview differs first at pixel ${Math.floor(mismatch / 3)}`);
}

test('place, erase, rectangle fill and pick write the expected tile IDs', async () => {
  const { page, errors } = await openEditor(env);
  await openMapProject(page, project());
  await setMapZoom(page, 8);
  const expected = new Array(24).fill(EMPTY);
  const set = (col, row, tile) => (expected[row * 6 + col] = tile);

  await pickTileInPicker(page, 5);
  assert.equal(await page.inputValue('#map-tile-id'), '5');
  await clickCell(page, 0, 0);
  set(0, 0, 5);
  await dragCells(page, [1, 1], [3, 1]);
  for (let col = 1; col <= 3; col++) set(col, 1, 5);
  await chooseTool(page, 'erase');
  await clickCell(page, 2, 1);
  set(2, 1, EMPTY);
  await page.fill('#map-tile-id', '2');
  await page.dispatchEvent('#map-tile-id', 'change');
  await chooseTool(page, 'rect');
  await dragCells(page, [2, 3], [0, 2]);
  for (let col = 0; col <= 2; col++) for (let row = 2; row <= 3; row++) set(col, row, 2);
  // Pick with Alt+click, then with the pick tool.
  await clickCell(page, 0, 0, ['Alt']);
  assert.equal(await page.inputValue('#map-tile-id'), '5');
  await chooseTool(page, 'pick');
  await clickCell(page, 1, 2);
  assert.equal(await page.inputValue('#map-tile-id'), '2');
  // Keyboard: the cursor follows the last click (1, 2); place at (5, 0), then a
  // two-press rectangle down the last column.
  await page.focus('#map-canvas');
  for (let step = 0; step < 2; step++) await page.keyboard.press('ArrowUp');
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('p');
  await page.keyboard.press('Space');
  set(5, 0, 2);
  await page.keyboard.press(']');
  await page.keyboard.press('r');
  await page.keyboard.press('Space');
  for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  const beforeRect = [...expected];
  for (let row = 0; row < 4; row++) set(5, row, 3);
  assert.deepEqual(mapTiles(await saveProject(page), 'level'), expected);
  await page.keyboard.press('Control+z');
  assert.deepEqual(mapTiles(await saveProject(page), 'level'), beforeRect, 'undo');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('map sizes, tile sizes and tileset changes are validated before they apply', async () => {
  const { page, errors } = await openEditor(env);
  const placed = (x, y) => (x + y < 6 ? x + y : EMPTY);
  await openMapProject(page, project({ tile: placed }));
  const original = Array.from({ length: 24 }, (_, at) => placed(at % 6, Math.floor(at / 6)));

  // Resizing keeps the top-left cells and adds empty ones.
  await page.fill('#map-cols', '8');
  await page.fill('#map-rows', '5');
  await page.click('#btn-map-resize');
  const resized = Array.from({ length: 40 }, (_, at) => {
    const [x, y] = [at % 8, Math.floor(at / 8)];
    return x < 6 && y < 4 ? placed(x, y) : EMPTY;
  });
  assert.deepEqual(mapTiles(await saveProject(page), 'level'), resized);
  await page.fill('#map-cols', '257');
  await page.click('#btn-map-resize');
  assert.match(await statusText(page), /1 to 256 cells/);

  // Tile sizes must fit the tileset and keep every placed tile ID valid.
  await page.fill('#map-tile-width', '32');
  await page.click('#btn-map-tileset');
  assert.match(await statusText(page), /smaller than one 32 × 4 tile/);
  await page.fill('#map-tile-width', '8');
  await page.fill('#map-tile-height', '8');
  await page.click('#btn-map-tileset');
  assert.match(await statusText(page), /places tile 5, but that tileset has 2 tiles/);
  await page.selectOption('#map-tileset', { label: 'other (8 × 8)' });
  await page.fill('#map-tile-width', '4');
  await page.fill('#map-tile-height', '4');
  await page.click('#btn-map-tileset');
  assert.match(await statusText(page), /places tile 5, but that tileset has 4 tiles/);

  // The tileset sprite cannot change in ways that would renumber or drop placed tiles.
  await page.click('#tab-sprite');
  await page.selectOption('#sprite-list', { label: 'tiles (16 × 8)' });
  await page.fill('#sprite-width', '20');
  await page.click('#btn-sprite-resize');
  assert.match(await statusText(page), /tiles per row from 4, which would renumber/);
  await page.fill('#sprite-width', '16');
  await page.fill('#sprite-height', '4');
  await page.click('#btn-sprite-resize');
  assert.match(await statusText(page), /places tile 5, which a 16 × 4 tileset would not contain/);
  await page.click('#btn-sprite-delete');
  assert.match(await statusText(page), /is the tileset of “level”/);
  await page.fill('#sprite-height', '12');
  await page.click('#btn-sprite-resize');
  assert.match(await statusText(page), /Resized “tiles” to 16 × 12/);

  const saved = await saveProject(page);
  assert.deepEqual(mapTiles(saved, 'level'), resized);
  const map = saved.maps[0];
  assert.deepEqual([map.tileset, map.tileWidth, map.tileHeight], ['tiles', 4, 4]);
  // Undo the sprite and map resizes.
  await page.click('#btn-undo');
  await page.click('#btn-undo');
  const undone = await saveProject(page);
  assert.equal(undone.sprites[0].height, 8);
  assert.deepEqual(mapTiles(undone, 'level'), original);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('the live map preview draws the expected pixels and follows edits and scrolling', async () => {
  const { page, errors } = await openEditor(env);
  const pattern = (x, y) => ((x * 7 + y * 3) % 9 === 8 ? EMPTY : (x * 7 + y * 3) % 9);
  await openMapProject(page, project({ cols: 100, rows: 60, tile: pattern, transparentIndex: 1 }));
  const tiles = Array.from({ length: 6000 }, (_, at) => pattern(at % 100, Math.floor(at / 100)));
  await setMapZoom(page, 4);
  await page.evaluate(() => {
    const view = document.getElementById('map-viewport');
    view.scrollLeft = 0;
    view.scrollTop = 0;
  });
  await waitForMapPreview(page, expectedPreview(tiles, 100, 60, { x: 0, y: 0 }, 0, 1));
  await page.selectOption('#map-preview-bg', '3');
  await waitForMapPreview(page, expectedPreview(tiles, 100, 60, { x: 0, y: 0 }, 3, 1));

  // Edits are published to the engine between frames.
  await page.fill('#map-tile-id', '6');
  await page.dispatchEvent('#map-tile-id', 'change');
  await clickCell(page, 1, 1);
  tiles[1 * 100 + 1] = 6;
  await waitForMapPreview(page, expectedPreview(tiles, 100, 60, { x: 0, y: 0 }, 3, 1));

  // The preview camera follows the view's scroll position, in map pixels.
  const scrolled = await page.evaluate(() => {
    const view = document.getElementById('map-viewport');
    view.scrollLeft = 402;
    view.scrollTop = 101;
    return { left: view.scrollLeft, top: view.scrollTop };
  });
  const camera = { x: Math.floor(scrolled.left / 4), y: Math.floor(scrolled.top / 4) };
  assert.ok(camera.x > 0 && camera.y > 0, 'the view scrolled in both directions');
  await waitForMapPreview(page, expectedPreview(tiles, 100, 60, camera, 3, 1));
  assert.deepEqual(errors, []);
  await page.context().close();
});

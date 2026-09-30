// Sprite and palette editor, keyboard access and the Sound tab, driven in
// Chromium against the built editor served under the production CSP.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  clickSprite,
  dragSprite,
  openEditor,
  openProjectFile,
  openVerifier,
  previewPixels,
  saveProject,
  spritePixels,
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
const MIB16 = 16 * 1024 * 1024;

let env;
before(async () => {
  env = await startEditor();
});
after(async () => {
  await env?.close();
});

/** A version 1 project holding one sprite `art` whose pixels come from a function. */
function projectWith({ width = 8, height = 8, transparentIndex = 0, pixel }) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += pixel(x, y).toString(16).padStart(2, '0');
    rows.push(row);
  }
  const sprite = { name: 'art', width, height, transparentIndex, pixels: rows };
  if (transparentIndex === null) delete sprite.transparentIndex;
  return JSON.stringify({
    format: 'pixeljs-project',
    version: 1,
    palette: DEFAULT_HEX,
    sprites: [sprite],
    maps: [],
    sounds: [],
  });
}

async function loadArt(page, options) {
  await openProjectFile(page, 'art.pixeljs.json', projectWith(options));
  await page.waitForFunction(() =>
    document.getElementById('status').textContent.startsWith('Opened'),
  );
}

async function setZoom(page, zoom) {
  await page.selectOption('#sprite-zoom', String(zoom));
  await page.waitForFunction(
    (zoom) => document.getElementById('sprite-canvas').dataset.zoom === String(zoom),
    zoom,
  );
}

const chooseColor = (page, index) => page.click(`#palette-grid [data-index="${index}"]`);
const chooseTool = (page, tool) => page.click(`#sprite-tools [data-tool="${tool}"]`);
const undoCount = async (page) => Number(await page.getAttribute('#history-status', 'data-undo'));

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** An independent model of the documented selection semantics. */
class Pixels {
  constructor(width, height, pixel) {
    this.width = width;
    this.height = height;
    this.data = Array.from({ length: width * height }, (_, at) =>
      pixel(at % width, Math.floor(at / width)),
    );
  }
  copy({ x, y, width, height }) {
    const block = [];
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width; col++) block.push(this.data[(y + row) * this.width + x + col]);
    return block;
  }
  write(block, width, height, x, y) {
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width; col++) {
        const tx = x + col;
        const ty = y + row;
        if (tx >= 0 && ty >= 0 && tx < this.width && ty < this.height)
          this.data[ty * this.width + tx] = block[row * width + col];
      }
  }
  fill(rect, value) {
    this.write(
      new Array(rect.width * rect.height).fill(value),
      rect.width,
      rect.height,
      rect.x,
      rect.y,
    );
  }
  move(rect, dx, dy, background) {
    const block = this.copy(rect);
    this.fill(rect, background);
    this.write(block, rect.width, rect.height, rect.x + dx, rect.y + dy);
  }
  flip(rect, horizontal) {
    const block = this.copy(rect);
    const out = block.map((_, at) => {
      const x = at % rect.width;
      const y = Math.floor(at / rect.width);
      return horizontal
        ? block[y * rect.width + (rect.width - 1 - x)]
        : block[(rect.height - 1 - y) * rect.width + x];
    });
    this.write(out, rect.width, rect.height, rect.x, rect.y);
  }
}

/** Reference 4-connected flood fill. */
function flood4(cells, width, height, x, y, color) {
  const target = cells[y * width + x];
  const stack = [[x, y]];
  while (stack.length > 0) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
    if (cells[cy * width + cx] !== target) continue;
    cells[cy * width + cx] = color;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

/** Expected sprite preview: the sprite at (4, 4), then tiled 2 × 2 at (width + 12, 4). */
function expectedPreview(pixels, width, height, transparentIndex, background, palette) {
  const frameWidth = 3 * width + 16;
  const frameHeight = 2 * height + 8;
  const frame = new Array(frameWidth * frameHeight).fill(background);
  const stamp = (left, top) => {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const index = pixels[y * width + x];
        if (index !== transparentIndex) frame[(top + y) * frameWidth + left + x] = index;
      }
  };
  stamp(4, 4);
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 2; col++) stamp(width + 12 + col * width, 4 + row * height);
  return {
    width: frameWidth,
    height: frameHeight,
    rgb: frame.flatMap((index) => rgb(palette[index])),
  };
}

async function waitForPreview(page, expected) {
  let last = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const shown = await previewPixels(page);
    const rgbOnly = [];
    for (let at = 0; at < shown.rgba.length; at += 4) rgbOnly.push(...shown.rgba.slice(at, at + 3));
    last = { width: shown.width, height: shown.height, rgb: rgbOnly };
    if (
      last.width === expected.width &&
      last.height === expected.height &&
      last.rgb.every((value, at) => value === expected.rgb[at])
    )
      return;
  }
  assert.deepEqual(last, expected, 'the live preview shows the expected pixels');
}

test('the default palette matches colors rendered by a real engine', async () => {
  const { page, errors } = await openEditor(env);
  const shown = await page.$$eval('#palette-grid [data-index]', (swatches) =>
    swatches.map((swatch) => swatch.getAttribute('aria-label').split(', ')[1]),
  );
  assert.deepEqual(shown, DEFAULT_HEX);
  const verifier = await openVerifier(env);
  const rendered = await verifier.page.evaluate(() => window.verify.defaultPalette(16));
  const colors = [];
  for (let index = 0; index < 16; index++)
    colors.push(
      `#${rendered
        .slice(index * 4, index * 4 + 3)
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('')}`,
    );
  assert.deepEqual(colors, shown, 'the editor copy equals the engine default palette');
  assert.deepEqual([...errors, ...verifier.errors], []);
  await verifier.page.close();
  await page.context().close();
});

test('each drawing tool writes exactly the expected pixels', async () => {
  const { page, errors } = await openEditor(env);
  await setZoom(page, 16);
  const expected = new Array(256).fill(0);
  const set = (x, y, color) => {
    if (x >= 0 && y >= 0 && x < 16 && y < 16) expected[y * 16 + x] = color;
  };

  // Pen: a drag paints every pixel it crosses in the current color (7).
  await dragSprite(page, [1, 1], [4, 1]);
  for (let x = 1; x <= 4; x++) set(x, 1, 7);
  // Eraser: paints the transparent index (0).
  await chooseTool(page, 'eraser');
  await clickSprite(page, 2, 1);
  set(2, 1, 0);
  // Lines: identical to graphics.line of an independent engine, including the
  // midpoint ties of the second, right-to-left line.
  await chooseColor(page, 11);
  await chooseTool(page, 'line');
  await dragSprite(page, [0, 15], [7, 12], [15, 9]);
  await dragSprite(page, [15, 0], [9, 3]);
  await dragSprite(page, [15, 0], [12, 6]);
  const verifier = await openVerifier(env);
  const lineColor = rgb(DEFAULT_HEX[11]);
  for (const [x0, y0, x1, y1, length] of [
    [0, 15, 15, 9, 16],
    [15, 0, 9, 3, 7],
    [15, 0, 12, 6, 7],
  ]) {
    const line = await verifier.page.evaluate((options) => window.verify.line(options), {
      width: 16,
      height: 16,
      x0,
      y0,
      x1,
      y1,
      color: 11,
    });
    let linePixels = 0;
    for (let at = 0; at < 256; at++)
      if (lineColor.every((value, channel) => line[at * 4 + channel] === value)) {
        expected[at] = 11;
        linePixels++;
      }
    assert.equal(linePixels, length, 'one reference pixel per major-axis step');
  }
  // Rectangle outline, then a filled rectangle dragged from its far corner.
  await chooseColor(page, 9);
  await chooseTool(page, 'rect');
  await dragSprite(page, [6, 3], [10, 6]);
  for (let x = 6; x <= 10; x++)
    for (let y = 3; y <= 6; y++) if (x === 6 || x === 10 || y === 3 || y === 6) set(x, y, 9);
  await chooseColor(page, 10);
  await chooseTool(page, 'rect-fill');
  await dragSprite(page, [13, 14], [11, 11]);
  for (let x = 11; x <= 13; x++) for (let y = 11; y <= 14; y++) set(x, y, 10);
  // Fill: only the 4-connected interior of the outline.
  await chooseColor(page, 12);
  await chooseTool(page, 'fill');
  await clickSprite(page, 8, 4);
  for (let x = 7; x <= 9; x++) for (let y = 4; y <= 5; y++) set(x, y, 12);
  // Below the first line the region is closed only for 4-connected filling:
  // an 8-connected fill would leak through its diagonal steps.
  await chooseColor(page, 13);
  await clickSprite(page, 15, 15);
  flood4(expected, 16, 16, 15, 15, 13);
  // Eyedropper, and Alt+click with another tool.
  await chooseTool(page, 'eyedropper');
  await clickSprite(page, 6, 3);
  assert.equal(await page.textContent('#palette-index'), '9');
  assert.equal(await page.getAttribute('#palette-grid [data-index="9"]', 'aria-checked'), 'true');
  await chooseTool(page, 'pen');
  await clickSprite(page, 12, 12, ['Alt']);
  assert.equal(await page.textContent('#palette-index'), '10');

  assert.deepEqual(spritePixels(await saveProject(page), 'sprite1'), expected);
  assert.deepEqual([...errors, ...verifier.errors], []);
  await verifier.page.close();
  await page.context().close();
});

test('keyboard drawing works and single-key shortcuts never fire while typing', async () => {
  const { page, errors } = await openEditor(env);
  await page.focus('#sprite-canvas');
  // The cursor starts at 0,0: pen at (1,0), then a two-press line from (1,2) to (4,2).
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('l');
  await page.keyboard.press('Space');
  for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const expected = new Array(256).fill(0);
  expected[1] = 7;
  for (let x = 1; x <= 4; x++) expected[2 * 16 + x] = 7;
  assert.deepEqual(spritePixels(await saveProject(page), 'sprite1'), expected);
  assert.equal(await page.getAttribute('[data-tool="line"]', 'aria-pressed'), 'true');

  // In a text field, letters and Ctrl+Z belong to the field.
  const steps = await undoCount(page);
  await page.click('#sprite-name');
  await page.keyboard.press('End');
  await page.keyboard.type('ehv');
  assert.equal(await page.inputValue('#sprite-name'), 'sprite1ehv');
  await page.keyboard.press('Control+z');
  assert.equal(await undoCount(page), steps, 'the project was not undone');
  assert.equal(await page.getAttribute('[data-tool="line"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('[data-tool="eraser"]', 'aria-pressed'), 'false');
  // The same letter outside a field selects the eraser.
  await page.focus('#sprite-canvas');
  await page.keyboard.press('e');
  assert.equal(await page.getAttribute('[data-tool="eraser"]', 'aria-pressed'), 'true');
  const project = await saveProject(page);
  assert.deepEqual(spritePixels(project, project.sprites[0].name), expected, 'no flip happened');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('copy, cut, paste and move use a separate buffer, so overlapping areas stay exact', async () => {
  const { page, errors } = await openEditor(env);
  const pattern = (x, y) => (x < 3 && y < 3 ? 1 + y * 3 + x : 0);
  await loadArt(page, { pixel: pattern });
  await setZoom(page, 24);
  const model = new Pixels(8, 8, pattern);
  await chooseTool(page, 'select');

  // Copy the 3 × 3 block, then paste it over itself at (1, 1).
  await dragSprite(page, [0, 0], [2, 2]);
  await page.keyboard.press('Control+c');
  const clip = model.copy({ x: 0, y: 0, width: 3, height: 3 });
  // A drag inside the selection would move it: deselect first.
  await page.keyboard.press('Escape');
  await dragSprite(page, [1, 1], [2, 2]);
  await page.keyboard.press('Control+v');
  model.write(clip, 3, 3, 1, 1);
  assert.deepEqual(spritePixels(await saveProject(page), 'art'), model.data, 'overlapping paste');

  // The pasted area is selected: move it right by one pixel (overlapping move).
  await page.focus('#sprite-canvas');
  await page.keyboard.press('Alt+ArrowRight');
  model.move({ x: 1, y: 1, width: 3, height: 3 }, 1, 0, 0);
  // Drag inside the selection to move it down by two.
  await dragSprite(page, [3, 2], [3, 3], [3, 4]);
  model.move({ x: 2, y: 1, width: 3, height: 3 }, 0, 2, 0);
  assert.deepEqual(spritePixels(await saveProject(page), 'art'), model.data, 'overlapping moves');

  // Cut leaves the transparent index; paste at a new selection; a move past the edge clips.
  await page.keyboard.press('Control+x');
  const cut = model.copy({ x: 2, y: 3, width: 3, height: 3 });
  model.fill({ x: 2, y: 3, width: 3, height: 3 }, 0);
  await dragSprite(page, [5, 0], [6, 1]);
  await page.keyboard.press('Control+v');
  model.write(cut, 3, 3, 5, 0);
  await page.focus('#sprite-canvas');
  await page.keyboard.press('Alt+ArrowRight');
  const beforeEdge = [...model.data];
  model.move({ x: 5, y: 0, width: 3, height: 3 }, 1, 0, 0);
  assert.deepEqual(spritePixels(await saveProject(page), 'art'), model.data, 'cut, paste, clip');
  // The clipped selection (2 × 3) moves back as a 2-pixel-wide block.
  await page.focus('#sprite-canvas');
  await page.keyboard.press('Alt+ArrowLeft');
  const afterBack = new Pixels(8, 8, (x, y) => model.data[y * 8 + x]);
  afterBack.move({ x: 6, y: 0, width: 2, height: 3 }, -1, 0, 0);
  assert.deepEqual(spritePixels(await saveProject(page), 'art'), afterBack.data);
  // Undo twice restores the state before the move past the edge.
  await page.click('#btn-undo');
  await page.click('#btn-undo');
  assert.deepEqual(spritePixels(await saveProject(page), 'art'), beforeEdge, 'undo of moves');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('flips mirror the whole sprite, or only the selection', async () => {
  const { page, errors } = await openEditor(env);
  const pattern = (x, y) => (x + 2 * y) % 16;
  await loadArt(page, { pixel: pattern, transparentIndex: null });
  await setZoom(page, 24);
  const whole = { x: 0, y: 0, width: 8, height: 8 };
  const model = new Pixels(8, 8, pattern);
  await page.keyboard.press('h');
  model.flip(whole, true);
  assert.deepEqual(spritePixels(await saveProject(page), 'art'), model.data, 'whole flip H');
  await page.click('#btn-flip-v');
  model.flip(whole, false);
  await chooseTool(page, 'select');
  await dragSprite(page, [1, 1], [3, 4]);
  await page.click('#btn-flip-h');
  model.flip({ x: 1, y: 1, width: 3, height: 4 }, true);
  await page.keyboard.press('v');
  model.flip({ x: 1, y: 1, width: 3, height: 4 }, false);
  assert.deepEqual(spritePixels(await saveProject(page), 'art'), model.data, 'selection flips');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('undo and redo keep at most 256 steps', async () => {
  const { page, errors } = await openEditor(env);
  // 256 keyboard pen steps over every pixel (a snake from row to row), then
  // 4 more in color 8 along the first row: 260 steps in total.
  await page.focus('#sprite-canvas');
  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 16; col++) {
      await page.keyboard.press('Space');
      if (col < 15) await page.keyboard.press(row % 2 === 0 ? 'ArrowRight' : 'ArrowLeft');
    }
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press(']');
  for (let row = 0; row < 16; row++) await page.keyboard.press('ArrowUp');
  for (let col = 0; col < 4; col++) {
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
  }
  assert.equal(await undoCount(page), 256);
  for (let step = 0; step < 256; step++) await page.keyboard.press('Control+z');
  assert.equal(await undoCount(page), 0);
  assert.equal(await page.isDisabled('#btn-undo'), true);
  // The first 4 steps fell out of the history; everything later was undone.
  const oldest = new Array(256).fill(0);
  for (let at = 0; at < 4; at++) oldest[at] = 7;
  assert.deepEqual(spritePixels(await saveProject(page), 'sprite1'), oldest);
  await page.focus('#sprite-canvas');
  for (let step = 0; step < 255; step++) await page.keyboard.press('Control+Shift+z');
  await page.click('#btn-redo');
  assert.equal(await page.isDisabled('#btn-redo'), true);
  const latest = new Array(256).fill(7);
  for (let at = 0; at < 4; at++) latest[at] = 8;
  assert.deepEqual(spritePixels(await saveProject(page), 'sprite1'), latest);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('undo history stores deltas and stays within 16 MiB', async () => {
  const { page, errors } = await openEditor(env);
  await page.fill('#sprite-width', '256');
  await page.fill('#sprite-height', '256');
  await page.click('#btn-sprite-resize');
  await setZoom(page, 3);
  await chooseColor(page, 9);
  await chooseTool(page, 'rect-fill');
  await dragSprite(page, [0, 0], [127, 255]);
  const flips = 150;
  for (let flip = 0; flip < flips; flip++) await page.keyboard.press('h');
  const steps = await undoCount(page);
  const bytes = Number(await page.getAttribute('#history-status', 'data-bytes'));
  assert.ok(steps < flips, `the byte budget evicted old steps (${steps} kept)`);
  assert.ok(bytes <= MIB16, `history bytes ${bytes} stay within 16 MiB`);
  assert.ok(bytes + bytes / steps > MIB16, 'the budget is used before evicting');
  assert.ok(bytes / steps < 65536 * 5, 'a full-sprite flip stores about 4 bytes per pixel');
  for (let step = 0; step < steps; step++) await page.keyboard.press('Control+z');
  // Undoing every kept flip leaves the state after the evicted ones.
  const leftHalf = (flips - steps) % 2 === 0;
  const expected = Array.from({ length: 65536 }, (_, at) => (at % 256 < 128 === leftHalf ? 9 : 0));
  assert.deepEqual(spritePixels(await saveProject(page), 'sprite1'), expected);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('palette colors are edited through hex input, bounded and undoable', async () => {
  const { page, errors } = await openEditor(env);
  await setZoom(page, 16);
  await chooseColor(page, 5);
  await page.fill('#palette-hex', '#123456');
  await page.press('#palette-hex', 'Enter');
  assert.equal(
    await page.getAttribute('#palette-grid [data-index="5"]', 'aria-label'),
    'Color 5, #123456',
  );
  await clickSprite(page, 0, 0);
  const palette = [...DEFAULT_HEX];
  palette[5] = '#123456';
  const pixels = new Array(256).fill(0);
  pixels[0] = 5;
  await waitForPreview(page, expectedPreview(pixels, 16, 16, 0, 0, palette));

  // An invalid value changes nothing and says why.
  await page.fill('#palette-hex', '#12345g');
  await page.press('#palette-hex', 'Enter');
  assert.match(await statusText(page), /not a color/);
  assert.equal(await page.getAttribute('#palette-hex', 'aria-invalid'), 'true');
  assert.equal((await saveProject(page)).palette[5], '#123456');

  // Growing the palette recreates the preview engine with 20 colors.
  await page.fill('#palette-size', '20');
  await page.click('#btn-palette-size');
  const labels = await page.$$eval('#palette-grid [data-index]', (swatches) =>
    swatches.map((swatch) => swatch.getAttribute('aria-label').split(', ')[1]),
  );
  assert.equal(labels.length, 20);
  assert.equal(new Set(labels).size, 20, 'new colors are distinct');
  await chooseColor(page, 19);
  await clickSprite(page, 1, 0);
  pixels[1] = 19;
  await waitForPreview(page, expectedPreview(pixels, 16, 16, 0, 0, labels));
  // Shrinking below a used color is refused.
  await page.fill('#palette-size', '10');
  await page.click('#btn-palette-size');
  assert.match(await statusText(page), /use color 19/);
  assert.equal(await page.locator('#palette-grid [data-index]').count(), 20);

  // Undo: the pixel, the size change, the pixel, then the color edit.
  for (let step = 0; step < 4; step++) await page.click('#btn-undo');
  const project = await saveProject(page);
  assert.deepEqual(project.palette, DEFAULT_HEX);
  assert.deepEqual(spritePixels(project, 'sprite1'), new Array(256).fill(0));
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('the live sprite preview draws the expected pixels through a running engine', async () => {
  const { page, errors } = await openEditor(env);
  const pattern = (x, y) => (x === y ? 7 : x === 7 - y ? 9 : y === 0 ? 3 : 0);
  await loadArt(page, { pixel: pattern });
  const model = new Pixels(8, 8, pattern);
  await waitForPreview(page, expectedPreview(model.data, 8, 8, 0, 0, DEFAULT_HEX));
  // Transparent pixels show the preview background.
  await page.selectOption('#sprite-preview-bg', '4');
  await waitForPreview(page, expectedPreview(model.data, 8, 8, 0, 4, DEFAULT_HEX));
  // Edits and undo reach the preview between frames.
  await setZoom(page, 24);
  await chooseColor(page, 12);
  await clickSprite(page, 1, 5);
  model.data[5 * 8 + 1] = 12;
  await waitForPreview(page, expectedPreview(model.data, 8, 8, 0, 4, DEFAULT_HEX));
  await page.click('#btn-undo');
  model.data[5 * 8 + 1] = pattern(1, 5);
  await waitForPreview(page, expectedPreview(model.data, 8, 8, 0, 4, DEFAULT_HEX));
  // Without a transparent index, index 0 is drawn opaque.
  await page.selectOption('#sprite-transparent', 'none');
  await waitForPreview(page, expectedPreview(model.data, 8, 8, null, 4, DEFAULT_HEX));
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('controls are named, reachable by keyboard and show visible focus', async () => {
  const { page, errors } = await openEditor(env);
  const unnamed = await page.evaluate(() => {
    const visible = (element) => element.getClientRects().length > 0;
    const name = (element) => {
      const label = element.getAttribute('aria-label');
      if (label) return label;
      const by = element.getAttribute('aria-labelledby');
      if (by)
        return by
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent)
          .join(' ');
      if (element.labels?.length) return element.labels[0].textContent;
      return element.textContent || element.title;
    };
    return Array.from(
      document.querySelectorAll('button, input, select, canvas[tabindex], [role="radio"]'),
    )
      .filter(visible)
      .filter((element) => !name(element)?.trim())
      .map((element) => element.outerHTML.slice(0, 80));
  });
  assert.deepEqual(unnamed, []);

  const reached = new Set();
  for (let press = 0; press < 80; press++) {
    await page.keyboard.press('Tab');
    reached.add(
      await page.evaluate(
        () => document.activeElement.id || `swatch-${document.activeElement.dataset.index}`,
      ),
    );
  }
  for (const id of [
    'tab-sprite',
    'btn-project-open',
    'btn-project-save',
    'sprite-list',
    'sprite-name',
    'sprite-transparent',
    'btn-import-png',
    'btn-copy',
    'btn-flip-h',
    'btn-nudge-left',
    'sprite-zoom',
    'sprite-grid',
    'sprite-canvas',
    'swatch-7',
    'palette-hex',
    'palette-size',
    'sprite-preview-bg',
  ])
    assert.ok(reached.has(id), `${id} is reachable with Tab`);
  // Tool buttons are plain buttons in the tab order.
  assert.equal(await page.locator('#sprite-tools [data-tool]').count(), 8);

  await page.focus('#btn-project-save');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const outline = await page.$eval('#btn-project-save', (element) => {
    const style = getComputedStyle(element);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
  assert.equal(outline, 'solid 2px');
  await page.focus('#palette-size');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  for (
    let press = 0;
    press < 40 && (await page.evaluate(() => document.activeElement.id)) !== 'sprite-canvas';
    press++
  )
    await page.keyboard.press('Shift+Tab');
  const frame = await page.$eval(
    '#sprite-viewport',
    (element) => getComputedStyle(element).outlineStyle,
  );
  assert.equal(frame, 'solid', 'the focused canvas is framed outside the artwork');
  // Tabs follow the arrow-key pattern.
  await page.focus('#tab-sprite');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-map');
  assert.equal(await page.isVisible('#panel-map'), true);
  assert.deepEqual(errors, []);
  await page.context().close();
});

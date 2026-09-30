// Shared harness for the editor tests: builds apps/editor with Vite into a
// temporary directory, serves it under the production Content-Security-Policy
// together with the built @pixeljs/core package (for independent verification
// engines) and a folder of downloaded exports, and drives Chromium.
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import { productionPolicy } from '../tools/csp.mjs';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

// Independent verification page: a separate engine per check, created from the
// public package exactly as a game would, with the Canvas2D renderer so frames
// can be read back synchronously.
const VERIFY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Editor export verification</title>
<script type="module" src="/verify/verify.js"></script></head><body><main></main></body></html>`;

const VERIFY_JS = `import * as pixeljs from '/packages/core/dist/index.js';

async function withEngine(options, prepare, draw) {
  const canvas = document.createElement('canvas');
  document.querySelector('main').append(canvas);
  const engine = await pixeljs.createEngine({ canvas, renderer: 'canvas2d', ...options });
  try {
    const resources = await prepare(engine);
    let frames = 0;
    engine.start({ update() {}, draw() { draw(engine.graphics, resources); frames += 1; } });
    while (frames < 2) await new Promise((done) => requestAnimationFrame(done));
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return { resources, width: canvas.width, height: canvas.height, rgba: Array.from(data) };
  } finally {
    await engine.dispose();
    canvas.remove();
  }
}

const paletteOption = (palette) => (palette ? { palette } : {});

window.verify = {
  // Every default palette color drawn as one pixel.
  async defaultPalette(count) {
    const result = await withEngine({ width: count, height: 1 }, async () => null, (g) => {
      for (let index = 0; index < count; index++) g.pixel(index, 0, index);
    });
    return result.rgba;
  },
  // A line drawn by graphics.line on a cleared framebuffer.
  async line({ width, height, x0, y0, x1, y1, color, palette }) {
    const result = await withEngine({ width, height, ...paletteOption(palette) }, async () => null, (g) => {
      g.clear(0);
      g.line(x0, y0, x1, y1, color);
    });
    return result.rgba;
  },
  // loadImage(src) drawn twice, over background a (left) and b (right).
  async image({ src, transparentIndex, palette, a, b, width, height }) {
    const result = await withEngine(
      { width: width * 2, height, ...paletteOption(palette) },
      (engine) => engine.loadImage(src, transparentIndex === undefined ? {} : { transparentIndex }),
      (g, image) => {
        g.rect(0, 0, width, height, a);
        g.sprite(image, 0, 0);
        g.rect(width, 0, width, height, b);
        g.sprite(image, width, 0);
      },
    );
    return { width: result.resources.width, height: result.resources.height, rgba: result.rgba };
  },
  // loadImage(tileset) + loadTilemap(map) drawn over a cleared background.
  async tilemap({ tilesetSrc, transparentIndex, mapSrc, palette, background, width, height }) {
    const result = await withEngine(
      { width, height, ...paletteOption(palette) },
      async (engine) => {
        const tileset = await engine.loadImage(
          tilesetSrc,
          transparentIndex === undefined ? {} : { transparentIndex },
        );
        const map = await engine.loadTilemap(mapSrc, { tileset });
        return { map };
      },
      (g, { map }) => {
        g.clear(background);
        g.tilemap(map, 0, 0);
      },
    );
    const { cols, rows, tileWidth, tileHeight } = result.resources.map;
    return { cols, rows, tileWidth, tileHeight, rgba: result.rgba };
  },
  // loadAssets(manifest) and one of its tilemaps drawn over a cleared background.
  async manifest({ src, palette, map, background, width, height }) {
    const kinds = ['images', 'tilemaps', 'fonts', 'sounds', 'music', 'data'];
    const result = await withEngine(
      { width, height, ...paletteOption(palette) },
      async (engine) => {
        const assets = await engine.loadAssets(src);
        return { assets, ids: Object.fromEntries(kinds.map((kind) => [kind, [...assets.ids(kind)]])) };
      },
      (g, { assets }) => {
        g.clear(background);
        g.tilemap(assets.tilemap(map), 0, 0);
      },
    );
    return { ids: result.resources.ids, rgba: result.rgba };
  },
  // Loads exported sounds and music with the public loaders, and creates the
  // same data with createSound/createMusic, returning both resources' properties.
  async audio({ sounds, music }) {
    const canvas = document.createElement('canvas');
    const engine = await pixeljs.createEngine({ canvas, width: 16, height: 16, renderer: 'canvas2d' });
    try {
      const view = (resource) => ({ ...resource });
      const result = { sounds: [], music: [] };
      for (const { src, options } of sounds)
        result.sounds.push({
          loaded: view(await engine.audio.loadSound(src)),
          created: view(engine.audio.createSound(options)),
        });
      for (const { src, options } of music)
        result.music.push({
          loaded: view(await engine.audio.loadMusic(src)),
          created: view(engine.audio.createMusic(options)),
        });
      return result;
    } finally {
      await engine.dispose();
    }
  },
};
window.verifyReady = true;
`;

let built = null;

/** Builds the editor once per test process into a temporary directory. */
async function buildEditor() {
  built ??= (async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'pixeljs-editor-build-'));
    await build({
      configFile: false,
      root: resolve('apps/editor'),
      base: './',
      logLevel: 'error',
      build: { outDir, emptyOutDir: true, assetsInlineLimit: 0, target: 'es2022' },
    });
    return outDir;
  })();
  return built;
}

export async function startEditor() {
  const outDir = await buildEditor();
  const exportsDir = await mkdtemp(join(tmpdir(), 'pixeljs-editor-exports-'));
  const coreDir = resolve('packages/core/dist');
  const policy = await productionPolicy();
  const server = createServer(async (request, response) => {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': policy,
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (path === '/favicon.ico') {
        response.writeHead(204, headers);
        response.end();
        return;
      }
      if (path === '/verify/index.html' || path === '/verify/verify.js') {
        const html = path.endsWith('.html');
        response.writeHead(200, { ...headers, 'Content-Type': html ? MIME['.html'] : MIME['.js'] });
        response.end(html ? VERIFY_HTML : VERIFY_JS);
        return;
      }
      const [root, rest] = path.startsWith('/packages/core/dist/')
        ? [coreDir, path.slice('/packages/core/dist/'.length)]
        : path.startsWith('/exports/')
          ? [exportsDir, path.slice('/exports/'.length)]
          : [outDir, path.slice(1) || 'index.html'];
      const file = resolve(root, rest);
      if (!file.startsWith(root + sep)) {
        response.writeHead(403, headers);
        response.end();
        return;
      }
      const bytes = await readFile(file);
      response.writeHead(200, {
        ...headers,
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404, headers);
      response.end();
    }
  });
  const port = await new Promise((done) =>
    server.listen(0, '127.0.0.1', () => done(server.address().port)),
  );
  const browser = await chromium.launch(
    process.env.PIXELJS_USE_BUNDLED_CHROMIUM ? {} : { channel: 'chrome' },
  );
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    browser,
    exportsDir,
    async close() {
      await browser.close();
      await new Promise((done) => server.close(done));
      await rm(exportsDir, { recursive: true, force: true });
    },
  };
}

/** Opens the editor in a fresh context and records page errors and CSP violations. */
export async function openEditor(env) {
  const context = await env.browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`${env.origin}/index.html`);
  await page.waitForSelector('#sprite-canvas[data-zoom]');
  await page.waitForSelector('#preview-canvas');
  return { page, errors, context };
}

/** Client coordinates of a content pixel of a PixelView canvas (fractions allowed). */
export async function contentPoint(page, selector, x, y) {
  return page.evaluate(
    ({ selector, x, y }) => {
      const canvas = document.querySelector(selector);
      const box = canvas.getBoundingClientRect();
      const zoom = Number(canvas.dataset.zoom);
      return {
        x: box.left + Number(canvas.dataset.originX) + x * zoom,
        y: box.top + Number(canvas.dataset.originY) + y * zoom,
      };
    },
    { selector, x, y },
  );
}

/** Center of sprite pixel (x, y) in the sprite editor. */
export function spriteCell(page, x, y) {
  return contentPoint(page, '#sprite-canvas', x + 0.5, y + 0.5);
}

export async function clickSprite(page, x, y, modifiers = []) {
  const point = await spriteCell(page, x, y);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(point.x, point.y);
  for (const key of modifiers) await page.keyboard.up(key);
}

/** Presses at one sprite pixel, moves through the others and releases at the last. */
export async function dragSprite(page, ...cells) {
  const points = [];
  for (const [x, y] of cells) points.push(await spriteCell(page, x, y));
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 4 });
  await page.mouse.up();
}

// Chrome drops downloads started faster than about ten per second, so tests
// that snapshot state through many saves are spaced out per page.
const recentDownloads = new WeakMap();

/** Runs `action` and returns the download it starts: file name and bytes. */
export async function captureDownload(page, action) {
  const times = recentDownloads.get(page) ?? [];
  recentDownloads.set(page, times);
  while (times.length >= 8 && Date.now() - times[times.length - 8] < 1500)
    await page.waitForTimeout(100);
  times.push(Date.now());
  const [download] = await Promise.all([page.waitForEvent('download'), action()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: await readFile(path) };
}

/** Saves the project through the Save button and returns the parsed file. */
export async function saveProject(page) {
  const file = await captureDownload(page, () => page.click('#btn-project-save'));
  return JSON.parse(file.bytes.toString('utf8'));
}

/** Decodes a saved sprite's hex rows into a flat array of palette indices. */
export function spritePixels(project, name) {
  const sprite = project.sprites.find((item) => item.name === name);
  if (!sprite) throw new Error(`No sprite ${name}`);
  const pixels = [];
  for (const row of sprite.pixels)
    for (let at = 0; at < row.length; at += 2)
      pixels.push(Number.parseInt(row.slice(at, at + 2), 16));
  return pixels;
}

/** Decodes a saved map's hex rows into a flat array of tile IDs. */
export function mapTiles(project, name) {
  const map = project.maps.find((item) => item.name === name);
  if (!map) throw new Error(`No map ${name}`);
  const tiles = [];
  for (const row of map.tiles)
    for (let at = 0; at < row.length; at += 4)
      tiles.push(Number.parseInt(row.slice(at, at + 4), 16));
  return tiles;
}

/** Opens a project (or any file) through the editor's hidden file input. */
export async function openProjectFile(page, name, text) {
  await page.setInputFiles('#file-project', {
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
}

export async function statusText(page) {
  return (await page.textContent('#status')) ?? '';
}

/** Writes a downloaded export into the served /exports/ folder. */
export async function publish(env, path, bytes) {
  const target = join(env.exportsDir, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return `/exports/${path}`;
}

/** Opens the verification page (independent engines) in a new page of the same browser. */
export async function openVerifier(env) {
  const page = await env.browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${env.origin}/verify/index.html`);
  await page.waitForFunction(() => window.verifyReady === true);
  return { page, errors };
}

/** Hex palette strings to a flat RGBA array for createEngine({ palette }). */
export function rgbaPalette(hexColors) {
  return hexColors.flatMap((hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
  });
}

/** Pixels of the live preview canvas, read right after the engine drew a frame. */
export async function previewPixels(page) {
  return page.evaluate(
    () =>
      new Promise((done) => {
        const source = document.getElementById('preview-canvas');
        requestAnimationFrame(() => {
          const copy = document.createElement('canvas');
          copy.width = source.width;
          copy.height = source.height;
          const context = copy.getContext('2d');
          context.drawImage(source, 0, 0);
          done({
            width: copy.width,
            height: copy.height,
            rgba: Array.from(context.getImageData(0, 0, copy.width, copy.height).data),
          });
        });
      }),
  );
}

/** Scrolls a piano roll so a cell is centered, then returns its client point. */
export async function rollPoint(page, prefix, step, pitch, fraction = 0.3) {
  await page.evaluate(
    ({ prefix, step, pitch }) =>
      new Promise((done) => {
        const view = document.getElementById(`${prefix}-roll-viewport`);
        const zoom = Number(document.getElementById(`${prefix}-roll`).dataset.zoom);
        view.scrollTop = (127 - pitch) * zoom - view.clientHeight / 2;
        view.scrollLeft = step * zoom - view.clientWidth / 2;
        requestAnimationFrame(() => requestAnimationFrame(done));
      }),
    { prefix, step, pitch },
  );
  return contentPoint(page, `#${prefix}-roll`, step + fraction, 127 - pitch + 0.5);
}

export async function clickRoll(page, prefix, step, pitch, fraction = 0.3) {
  const point = await rollPoint(page, prefix, step, pitch, fraction);
  await page.mouse.click(point.x, point.y);
}

/** Drags within one visible stretch of a piano roll, from one cell to another. */
export async function dragRoll(page, prefix, [step, pitch], [toStep, toPitch], fraction = 0.3) {
  const start = await rollPoint(page, prefix, step, pitch, fraction);
  const end = await contentPoint(page, `#${prefix}-roll`, toStep + 0.5, 127 - toPitch + 0.5);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

/** Types a value into a field and commits it like a user (Enter fires change). */
export async function setField(page, selector, value) {
  await page.fill(selector, String(value));
  await page.press(selector, 'Enter');
}

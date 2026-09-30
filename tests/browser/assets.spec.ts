import { deflateSync, crc32 } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import type {
  AssetBundle,
  Engine,
  EngineOptions,
  FontResource,
} from '../../packages/core/src/api/types.js';
import { decodeGif } from '../support/gif-decoder.mjs';

// Asset manifests, font files, text measurement, PNG capture and GIF
// recording against the real build, served with the production CSP.

declare global {
  interface Window {
    createTestEngine(
      options?: Partial<EngineOptions>,
    ): Promise<{ engine: Engine; canvas: HTMLCanvasElement }>;
    testEngines: Engine[];
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/harness.html');
  await page.waitForFunction(() => typeof window.createTestEngine === 'function');
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await Promise.all((window.testEngines ?? []).map((engine) => engine.dispose()));
  });
});

/** Sixteen distinct opaque colors, so expected pixels can be computed exactly. */
const PALETTE = Array.from({ length: 16 }, (_, index) => [
  index * 16,
  255 - index * 16,
  (index * 67) & 255,
  255,
]).flat();
const rgba = (index: number): number[] => PALETTE.slice(index * 4, index * 4 + 4);

/** Minimal RGBA PNG writer for fixtures. */
function png(width: number, height: number, pixels: number[][]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    rows.push(0);
    for (let x = 0; x < width; x++) rows.push(...pixels[y * width + x]!);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Served {
  body: string | Buffer;
  type?: string;
  status?: number;
  delay?: number;
  headers?: Record<string, string>;
}
interface RequestLog {
  path: string;
  start: number;
  end: number;
}

/** Serves a virtual file tree under /__assets/ and records concurrency. */
async function serve(page: Page, files: Record<string, Served>) {
  const log = { inFlight: 0, peak: 0, requests: [] as RequestLog[] };
  await page.route('**/__assets/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = files[path];
    const entry = { path, start: Date.now(), end: 0 };
    log.requests.push(entry);
    log.inFlight++;
    log.peak = Math.max(log.peak, log.inFlight);
    try {
      if (file?.delay) await new Promise((resolve) => setTimeout(resolve, file.delay));
      await route.fulfill(
        file
          ? {
              status: file.status ?? 200,
              contentType: file.type ?? 'application/json',
              body: file.body,
              headers: file.headers ?? {},
            }
          : { status: 404, contentType: 'text/plain', body: 'Not found' },
      );
    } catch {
      /* The page cancelled the request. */
    } finally {
      entry.end = Date.now();
      log.inFlight--;
    }
  });
  return log;
}

const json = (value: unknown, delay?: number): Served =>
  delay === undefined ? { body: JSON.stringify(value) } : { body: JSON.stringify(value), delay };
const jsonImage = (fill: number, delay?: number): Served =>
  json({ width: 2, height: 2, pixels: [fill, fill, fill, fill] }, delay);
const manifest = (sections: Record<string, unknown>) =>
  json({ format: 'pixeljs-assets', version: 1, ...sections });

/** A 2-glyph 8 × 3 font for 'A' and 'B': a diagonal and a top bar with one corner. */
const FONT_GLYPHS = [
  ['#.......', '.#......', '..#.....'],
  ['########', '........', '.......#'],
];
const FONT_BYTES = [0x80, 0x40, 0x20, 0xff, 0x00, 0x01];
const fontFile = (encoding: 'bitmap' | 'glyphs', extra: Record<string, unknown> = {}) => ({
  format: 'pixeljs-font',
  version: 1,
  glyphWidth: 8,
  glyphHeight: 3,
  firstChar: 65,
  charCount: 2,
  ...(encoding === 'bitmap'
    ? { bitmap: Buffer.from(FONT_BYTES).toString('base64') }
    : { glyphs: FONT_GLYPHS }),
  ...extra,
});

test('loadFont reads both encodings and draws exactly their glyphs', async ({ page }) => {
  await serve(page, {
    '/__assets/fonts/bitmap.json': json(fontFile('bitmap')),
    '/__assets/fonts/glyphs.json': json(fontFile('glyphs', { fallbackChar: 66 })),
  });
  const result = await page.evaluate(async (palette) => {
    const { engine, canvas } = await window.createTestEngine({ width: 16, height: 6, palette });
    const bitmap = await engine.loadFont('/__assets/fonts/bitmap.json');
    const glyphs = await engine.loadFont('/__assets/fonts/glyphs.json');
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
        engine.graphics.text(0, 0, 'AB', 9, { font: bitmap });
        engine.graphics.text(0, 3, 'A?', 9, { font: glyphs });
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    const data = canvas.getContext('2d')!.getImageData(0, 0, 16, 6).data;
    const on: number[] = [];
    for (let pixel = 0; pixel < 96; pixel++) if (data[pixel * 4] === 9 * 16) on.push(pixel);
    return {
      fields: [bitmap, glyphs].map((font) => ({ ...font })),
      on,
    };
  }, PALETTE);
  expect(result.fields).toEqual([
    { glyphWidth: 8, glyphHeight: 3, firstChar: 65, charCount: 2, fallbackChar: 65 },
    { glyphWidth: 8, glyphHeight: 3, firstChar: 65, charCount: 2, fallbackChar: 66 },
  ]);
  // Both rows: 'A' diagonal at x 0-2; 'B' (and '?' falling back to 'B') at x 8-15.
  const expected: number[] = [];
  for (const top of [0, 3]) {
    const glyph = (x: number, y: number, rows: string[]) =>
      rows.forEach((row, dy) =>
        [...row].forEach((c, dx) => c === '#' && expected.push((top + y + dy) * 16 + x + dx)),
      );
    glyph(0, 0, FONT_GLYPHS[0]!);
    glyph(8, 0, FONT_GLYPHS[1]!);
  }
  expect(result.on).toEqual(expected.sort((a, b) => a - b));
});

test('loadFont rejects malformed, oversized, missing, cancelled and late fonts', async ({
  page,
}) => {
  const oversized = JSON.stringify({ ...fontFile('bitmap'), padding: 'x'.repeat(1024 * 1024) });
  await serve(page, {
    '/__assets/fonts/unknown.json': json(fontFile('bitmap', { color: 3 })),
    '/__assets/fonts/newer.json': json(fontFile('bitmap', { version: 2 })),
    '/__assets/fonts/base64.json': json(fontFile('bitmap', { bitmap: 'gEAg/wA!' })),
    '/__assets/fonts/row.json': json({
      ...fontFile('glyphs'),
      glyphs: [FONT_GLYPHS[0], ['#######', '........', '........']],
    }),
    '/__assets/fonts/duplicate.json': {
      body: JSON.stringify(fontFile('bitmap')).replace(
        '"glyphWidth":8',
        '"glyphWidth":8,"glyphWidth":4',
      ),
    },
    '/__assets/fonts/text.json': { body: 'not json' },
    '/__assets/fonts/large.json': { body: oversized },
    '/__assets/fonts/slow.json': { ...json(fontFile('bitmap')), delay: 300 },
  });
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const outcome = async (action: () => Promise<unknown>) => {
      try {
        await action();
        return 'OK';
      } catch (error) {
        return `${(error as Error & { code: string }).code}: ${(error as Error).message}`;
      }
    };
    const names = ['unknown', 'newer', 'base64', 'row', 'duplicate', 'text', 'large', 'missing'];
    const codes: string[] = [];
    for (const name of names)
      codes.push(await outcome(() => engine.loadFont(`/__assets/fonts/${name}.json`)));
    const controller = new AbortController();
    const aborted = outcome(() =>
      engine.loadFont('/__assets/fonts/slow.json', { signal: controller.signal }),
    );
    controller.abort();
    codes.push(await aborted);
    codes.push(await outcome(() => engine.loadFont('')));
    const late = outcome(() => engine.loadFont('/__assets/fonts/slow.json'));
    await engine.dispose();
    codes.push(await late);
    return codes;
  });
  expect(result.map((entry) => entry.split(':')[0])).toEqual([
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'CAPACITY',
    'ASSET_LOAD',
    'ABORTED',
    'ARGUMENT',
    'STATE',
  ]);
  expect(result[0]).toContain('unknown key "color"');
  expect(result[1]).toContain('newer than this version of PixelJS supports');
  expect(result[4]).toContain('duplicate key "glyphWidth"');
});

test('measureText matches what graphics.text paints', async ({ page }) => {
  await serve(page, { '/__assets/fonts/glyphs.json': json(fontFile('glyphs')) });
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ width: 40, height: 40 });
    const font = await engine.loadFont('/__assets/fonts/glyphs.json');
    const other = (await window.createTestEngine()).engine;
    const foreign = other.createFont({
      glyphWidth: 1,
      glyphHeight: 1,
      charCount: 1,
      bitmap: new Uint8Array(1),
    });
    const sizes = {
      builtin: engine.measureText('HI\nA'),
      custom: engine.measureText('AB\r\nA\n', font),
      empty: engine.measureText(''),
    };
    const codes: string[] = [];
    const attempt = (action: () => unknown) => {
      try {
        action();
        codes.push('OK');
      } catch (error) {
        codes.push((error as Error & { code: string }).code);
      }
    };
    attempt(() => engine.measureText(5 as unknown as string));
    attempt(() => engine.measureText('A', foreign));
    attempt(() => engine.measureText('A', {} as FontResource));
    let inDraw: unknown = null;
    let inUpdate: unknown = null;
    engine.start({
      update() {
        inUpdate ??= engine.measureText('ABC', font);
      },
      draw() {
        inDraw ??= engine.measureText('AB');
        engine.graphics.clear(0);
        engine.graphics.text(0, 0, 'HI\nA', 1, { background: 2 });
        engine.graphics.text(20, 20, 'AB\r\nA\n', 1, { font, background: 3 });
      },
    });
    // Updates start on the second frame; wait until one has run.
    for (let frame = 0; frame < 60 && inUpdate === null; frame++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    const data = canvas.getContext('2d')!.getImageData(0, 0, 40, 40).data;
    const clear = [...data.slice((39 * 40 + 39) * 4, (39 * 40 + 40) * 4)];
    const box = (x0: number, y0: number, x1: number, y1: number) => {
      let right = -1;
      let bottom = -1;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const at = (y * 40 + x) * 4;
          if ([0, 1, 2].every((channel) => data[at + channel] === clear[channel])) continue;
          right = Math.max(right, x - x0);
          bottom = Math.max(bottom, y - y0);
        }
      return { width: right + 1, height: bottom + 1 };
    };
    engine.release(font);
    attempt(() => engine.measureText('A', font));
    await engine.dispose();
    attempt(() => engine.measureText('A'));
    return {
      sizes,
      codes,
      inDraw,
      inUpdate,
      painted: { builtin: box(0, 0, 20, 20), custom: box(20, 20, 40, 40) },
    };
  });
  expect(result.sizes).toEqual({
    builtin: { width: 16, height: 16 },
    custom: { width: 16, height: 9 },
    empty: { width: 0, height: 0 },
  });
  expect(result.codes).toEqual(['ARGUMENT', 'HANDLE', 'HANDLE', 'HANDLE', 'STATE']);
  expect(result.inDraw).toEqual({ width: 16, height: 8 });
  expect(result.inUpdate).toEqual({ width: 24, height: 3 });
  // The painted boxes (glyph backgrounds included) have the measured size;
  // the empty last line paints nothing, so the custom box is one line shorter.
  expect(result.painted.builtin).toEqual(result.sizes.builtin);
  expect(result.painted.custom).toEqual({ width: 16, height: 6 });
});

/** Tiles 0 and 1 of a 4 × 2 PNG tileset use palette colors 3 and 5. */
const TILESET = png(
  4,
  2,
  [3, 3, 5, 5, 3, 3, 5, 5].map((index) => rgba(index)),
);

test('loadAssets loads every kind relative to the manifest and releases the bundle', async ({
  page,
}) => {
  const log = await serve(page, {
    '/__assets/game/manifest.json': manifest({
      images: {
        tiles: { src: 'img/tiles.png' },
        hero: { src: 'img/hero.json', transparentIndex: 0 },
      },
      tilemaps: { level: { src: 'maps/level.json', tileset: 'tiles' } },
      fonts: { small: { src: 'fonts/small.json' } },
      sounds: { beep: { src: 'sfx/beep.json' } },
      music: { theme: { src: 'music/theme.json' } },
      data: { levels: { src: 'data/levels.json' } },
    }),
    '/__assets/game/img/tiles.png': { body: TILESET, type: 'image/png' },
    '/__assets/game/img/hero.json': json({ width: 2, height: 1, pixels: [0, 7] }),
    '/__assets/game/maps/level.json': json({
      cols: 2,
      rows: 1,
      tileWidth: 2,
      tileHeight: 2,
      tiles: [1, 0],
    }),
    '/__assets/game/fonts/small.json': json(fontFile('glyphs')),
    '/__assets/game/sfx/beep.json': json({ waveform: 'sine', frequency: 880, duration: 0.2 }),
    '/__assets/game/music/theme.json': json({
      format: 'pixeljs-music',
      version: 1,
      bpm: 120,
      length: 8,
      tracks: [{ notes: [{ step: 0, pitch: 'C4', length: 4 }] }],
    }),
    '/__assets/game/data/levels.json': json({ count: 3, names: ['a', 'b', 'c'] }),
  });
  const result = await page.evaluate(async (palette) => {
    const { engine, canvas } = await window.createTestEngine({ width: 8, height: 8, palette });
    const baseline = engine.getStats().coreBytes;
    const progress: number[][] = [];
    const bundle = await engine.loadAssets('/__assets/game/manifest.json', {
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });
    const loadedBytes = engine.getStats().coreBytes;
    const tiles = bundle.image('tiles');
    engine.start({
      update() {},
      draw() {
        const g = engine.graphics;
        g.clear(0);
        g.tilemap(bundle.tilemap('level'), 0, 0);
        g.sprite(bundle.image('hero'), 4, 0);
        g.text(0, 4, 'A', 9, { font: bundle.font('small') });
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    const context = canvas.getContext('2d')!;
    const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data];
    const pixels = [pixel(0, 0), pixel(2, 1), pixel(4, 0), pixel(5, 0), pixel(0, 4), pixel(1, 4)];
    const codes: string[] = [];
    const attempt = (action: () => unknown) => {
      try {
        action();
        codes.push('OK');
      } catch (error) {
        codes.push((error as Error & { code: string }).code);
      }
    };
    const summary = {
      ids: (['images', 'tilemaps', 'fonts', 'sounds', 'music', 'data'] as const).map((kind) =>
        bundle.ids(kind),
      ),
      data: bundle.data<{ count: number }>('levels'),
      sound: { ...bundle.sound('beep') },
      music: { ...bundle.music('theme') },
      tileset: bundle.tilemap('level').tileset === tiles,
    };
    attempt(() => bundle.image('nope'));
    attempt(() => bundle.font('tiles'));
    attempt(() => engine.release(tiles));
    bundle.release();
    const releasedBytes = engine.getStats().coreBytes;
    bundle.release();
    attempt(() => bundle.image('tiles'));
    attempt(() => engine.release(tiles));
    return { baseline, loadedBytes, releasedBytes, progress, pixels, summary, codes };
  }, PALETTE);
  expect(result.progress).toEqual([1, 2, 3, 4, 5, 6, 7].map((loaded) => [loaded, 7]));
  expect(result.pixels).toEqual([rgba(5), rgba(3), rgba(0), rgba(7), rgba(9), rgba(0)]);
  expect(result.summary).toEqual({
    ids: [['tiles', 'hero'], ['level'], ['small'], ['beep'], ['theme'], ['levels']],
    data: { count: 3, names: ['a', 'b', 'c'] },
    sound: expect.objectContaining({ waveform: 'sine', frequency: 880, duration: 0.2 }),
    music: { bpm: 120, stepsPerBeat: 4, length: 8, loop: true, tracks: 1 },
    tileset: true,
  });
  // RESOURCE_IN_USE: the bundle's tilemap still holds its tileset.
  expect(result.codes).toEqual(['ARGUMENT', 'ARGUMENT', 'RESOURCE_IN_USE', 'STATE', 'OK']);
  expect(result.loadedBytes).toBeGreaterThan(result.baseline);
  expect(result.releasedBytes).toBe(result.baseline);
  expect(log.requests.map((request) => request.path).sort()).toEqual([
    '/__assets/game/data/levels.json',
    '/__assets/game/fonts/small.json',
    '/__assets/game/img/hero.json',
    '/__assets/game/img/tiles.png',
    '/__assets/game/manifest.json',
    '/__assets/game/maps/level.json',
    '/__assets/game/music/theme.json',
    '/__assets/game/sfx/beep.json',
  ]);
});

test('loadAssets runs at most four requests at once and loads tilemaps after their tilesets', async ({
  page,
}) => {
  const images: Record<string, { src: string }> = {};
  const files: Record<string, Served> = {};
  for (let index = 0; index < 10; index++) {
    images[`i${index}`] = { src: `i${index}.json` };
    files[`/__assets/many/i${index}.json`] = jsonImage(index, 150);
  }
  files['/__assets/many/d0.json'] = json([1], 150);
  files['/__assets/many/d1.json'] = json([2], 150);
  files['/__assets/many/map.json'] = json({
    cols: 1,
    rows: 1,
    tileWidth: 2,
    tileHeight: 2,
    tiles: [0],
  });
  files['/__assets/many/manifest.json'] = manifest({
    tilemaps: { map: { src: 'map.json', tileset: 'i9' } },
    data: { d0: { src: 'd0.json' }, d1: { src: 'd1.json' } },
    images,
  });
  const log = await serve(page, files);
  const loaded = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const bundle = await engine.loadAssets('/__assets/many/manifest.json');
    return bundle.ids('images').length + bundle.ids('data').length + bundle.ids('tilemaps').length;
  });
  expect(loaded).toBe(13);
  expect(log.peak).toBe(4);
  const started = (path: string) => log.requests.find((request) => request.path === path)!;
  const order = log.requests.map((request) => request.path);
  expect(order[0]).toBe('/__assets/many/manifest.json');
  // Every request is delayed, so the first four are the first four entries
  // in manifest order: data and images before the tilemap listed above them.
  expect(order.slice(1, 5).sort()).toEqual([
    '/__assets/many/d0.json',
    '/__assets/many/d1.json',
    '/__assets/many/i0.json',
    '/__assets/many/i1.json',
  ]);
  expect(order.at(-1)).toBe('/__assets/many/map.json');
  expect(started('/__assets/many/map.json').start).toBeGreaterThanOrEqual(
    started('/__assets/many/i9.json').end,
  );
});

test('a failing entry rolls back every resource and keeps its error code', async ({ page }) => {
  await serve(page, {
    '/__assets/fail/manifest.json': manifest({
      images: { a: { src: 'a.json' }, b: { src: 'b.json' }, slow: { src: 'slow.json' } },
      tilemaps: { map: { src: 'map.json', tileset: 'a' } },
      fonts: { broken: { src: 'broken.json' } },
    }),
    '/__assets/fail/a.json': jsonImage(1),
    '/__assets/fail/b.json': jsonImage(2),
    '/__assets/fail/slow.json': jsonImage(3, 400),
    '/__assets/fail/map.json': json({ cols: 1, rows: 1, tileWidth: 2, tileHeight: 2, tiles: [0] }),
    '/__assets/fail/broken.json': json(fontFile('bitmap', { version: 7 }), 150),
    '/__assets/missing/manifest.json': manifest({
      images: { a: { src: 'a.json' } },
      data: { gone: { src: 'gone.json' } },
    }),
    '/__assets/missing/a.json': jsonImage(1),
  });
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const baseline = engine.getStats().coreBytes;
    const outcomes: Array<{ code: string; message: string; bytes: number }> = [];
    for (const name of ['fail', 'missing']) {
      try {
        await engine.loadAssets(`/__assets/${name}/manifest.json`);
        outcomes.push({ code: 'OK', message: '', bytes: engine.getStats().coreBytes });
      } catch (error) {
        outcomes.push({
          code: (error as Error & { code: string }).code,
          message: (error as Error).message,
          bytes: engine.getStats().coreBytes,
        });
      }
    }
    // Nothing leaked: the same resources load again afterwards.
    const image = await engine.loadImage('/__assets/fail/a.json');
    return { baseline, outcomes, reloaded: image.width };
  });
  expect(result.outcomes[0]!.code).toBe('ASSET_DATA');
  expect(result.outcomes[0]!.message).toMatch(/fonts\.broken.*newer/);
  expect(result.outcomes[1]!.code).toBe('ASSET_LOAD');
  expect(result.outcomes[1]!.message).toMatch(/data\.gone.*404/);
  for (const outcome of result.outcomes) expect(outcome.bytes).toBe(result.baseline);
  expect(result.reloaded).toBe(2);
});

test('loadAssets rolls back on abort, disposal and a throwing progress callback', async ({
  page,
}) => {
  const files: Record<string, Served> = {
    '/__assets/slow/manifest.json': manifest({
      images: { a: { src: 'a.json' }, b: { src: 'b.json' }, c: { src: 'c.json' } },
    }),
    '/__assets/slow/a.json': jsonImage(1),
    '/__assets/slow/b.json': jsonImage(2, 50),
    '/__assets/slow/c.json': jsonImage(3, 600),
  };
  const log = await serve(page, files);
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const baseline = engine.getStats().coreBytes;
    const outcome = async (action: () => Promise<unknown>) => {
      try {
        await action();
        return 'OK';
      } catch (error) {
        return `${(error as Error & { code?: string }).code ?? 'plain'}: ${(error as Error).message}`;
      }
    };
    const controller = new AbortController();
    const progress: number[] = [];
    const aborted = outcome(() =>
      engine.loadAssets('/__assets/slow/manifest.json', {
        signal: controller.signal,
        onProgress: (loaded) => {
          progress.push(loaded);
          if (loaded === 2) controller.abort();
        },
      }),
    );
    const abortCode = await aborted;
    const afterAbort = engine.getStats().coreBytes;
    const thrown = await outcome(() =>
      engine.loadAssets('/__assets/slow/manifest.json', {
        onProgress: (loaded) => {
          if (loaded === 1) throw new Error('stop here');
        },
      }),
    );
    const afterThrow = engine.getStats().coreBytes;
    const invalid = await outcome(() =>
      engine.loadAssets('/__assets/slow/manifest.json', {
        onProgress: 5 as unknown as () => void,
      }),
    );
    const started = performance.now();
    const pending = outcome(() => engine.loadAssets('/__assets/slow/manifest.json'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await engine.dispose();
    const disposed = await pending;
    return {
      abortCode,
      progress,
      thrown,
      invalid,
      disposed,
      disposedAfter: performance.now() - started,
      bytes: [baseline, afterAbort, afterThrow],
    };
  });
  expect(result.abortCode.split(':')[0]).toBe('ABORTED');
  expect(result.progress).toEqual([1, 2]);
  expect(result.thrown).toBe('plain: stop here');
  expect(result.invalid.split(':')[0]).toBe('ARGUMENT');
  expect(result.disposed.split(':')[0]).toBe('STATE');
  // Disposal cancels the 600 ms request instead of waiting for it.
  expect(result.disposedAfter).toBeLessThan(500);
  expect(result.bytes[1]).toBe(result.bytes[0]);
  expect(result.bytes[2]).toBe(result.bytes[0]);
  // The invalid onProgress was rejected before the manifest was requested.
  expect(log.requests.filter((request) => request.path.endsWith('manifest.json'))).toHaveLength(3);
});

test('manifests are validated completely before any asset is requested', async ({ page }) => {
  const entry = { src: 'x.json' };
  const files: Record<string, Served> = {
    '/__assets/bad/section.json': manifest({ images: { a: entry }, scripts: { main: entry } }),
    '/__assets/bad/escape.json': manifest({ images: { a: entry, b: { src: '../secret.json' } } }),
    '/__assets/bad/encoded.json': manifest({ data: { a: { src: '%2e%2e/secret.json' } } }),
    '/__assets/bad/absolute.json': manifest({ data: { a: { src: 'https://example.com/x.json' } } }),
    '/__assets/bad/duplicate.json': {
      body: '{"format":"pixeljs-assets","version":1,"images":{"a":{"src":"a.json"},"a":{"src":"b.json"}}}',
    },
    '/__assets/bad/tileset.json': manifest({
      images: { a: entry },
      tilemaps: { m: { src: 'm.json', tileset: 'b' } },
    }),
    '/__assets/bad/unknown.json': manifest({ images: { a: { src: 'a.json', scale: 2 } } }),
    '/__assets/bad/proto.json': {
      body: '{"format":"pixeljs-assets","version":1,"images":{"__proto__":{"src":"a.json"}}}',
    },
    '/__assets/bad/newer.json': json({ format: 'pixeljs-assets', version: 2, images: {} }),
    '/__assets/bad/large.json': { body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }) },
  };
  const log = await serve(page, files);
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const outcome = async (action: () => Promise<unknown>) => {
      try {
        await action();
        return 'OK';
      } catch (error) {
        return `${(error as Error & { code: string }).code}: ${(error as Error).message}`;
      }
    };
    const results: string[] = [];
    for (const name of [
      'section',
      'escape',
      'encoded',
      'absolute',
      'duplicate',
      'tileset',
      'unknown',
      'proto',
      'newer',
      'large',
      'missing',
    ])
      results.push(await outcome(() => engine.loadAssets(`/__assets/bad/${name}.json`)));
    const many = Object.fromEntries(
      Array.from({ length: 1025 }, (_, index) => [`d${index}`, { src: `${index}.json` }]),
    );
    results.push(
      await outcome(() => engine.loadAssets({ format: 'pixeljs-assets', version: 1, data: many })),
    );
    results.push(
      await outcome(() =>
        engine.loadAssets({ format: 'pixeljs-assets', version: 1, data: {}, extra: {} } as never),
      ),
    );
    for (const wrong of [42, null, undefined])
      results.push(await outcome(() => engine.loadAssets(wrong as never)));
    return { results, polluted: ({} as Record<string, unknown>)['src'] };
  });
  expect(result.results.map((entry) => entry.split(':')[0])).toEqual([
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'ASSET_DATA',
    'CAPACITY',
    'ASSET_LOAD',
    'CAPACITY',
    'ASSET_DATA',
    'ARGUMENT',
    'ARGUMENT',
    'ARGUMENT',
  ]);
  expect(result.results[4]).toContain('duplicate key "a"');
  expect(result.results[8]).toContain('newer than this version of PixelJS supports');
  expect(result.polluted).toBeUndefined();
  // Only the manifests themselves were requested.
  expect(log.requests.every((request) => request.path.startsWith('/__assets/bad/'))).toBe(true);
  expect(log.requests).toHaveLength(11);
});

test('entries resolve against the manifest URL after redirects', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright cannot fulfill a redirect status in WebKit.');
  // The redirect target and its entry are real files on the production-CSP server;
  // nothing exists under /__assets/latest/ except the redirect itself.
  const log = await serve(page, {
    '/__assets/latest/manifest.json': {
      status: 302,
      body: '',
      headers: { location: '/tests/browser/fixtures/assets/manifest.json' },
    },
  });
  const info = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    return (await engine.loadAssets('/__assets/latest/manifest.json')).data('info');
  });
  expect(info).toEqual({ version: 7 });
  expect(log.requests.map((request) => request.path)).toEqual(['/__assets/latest/manifest.json']);
});

test('disposal cancels a pending manifest request at once', async ({ page }) => {
  await serve(page, {
    '/__assets/stalled/manifest.json': { ...manifest({ data: {} }), delay: 2000 },
  });
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const started = performance.now();
    const pending = engine.loadAssets('/__assets/stalled/manifest.json').then(
      () => 'OK',
      (error: Error & { code: string }) => error.code,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await engine.dispose();
    return { code: await pending, elapsed: performance.now() - started };
  });
  expect(result.code).toBe('STATE');
  expect(result.elapsed).toBeLessThan(1500);
});

test('an object manifest resolves its paths against the document base URL', async ({ page }) => {
  const log = await serve(page, {
    '/tests/browser/__assets/obj/one.json': json({ value: 1 }),
    '/tests/browser/__assets/obj/tile.json': jsonImage(4),
  });
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const bundle: AssetBundle = await engine.loadAssets({
      format: 'pixeljs-assets',
      version: 1,
      data: { one: { src: '__assets/obj/one.json' } },
      images: { tile: { src: '__assets/obj/tile.json' } },
    });
    return { one: bundle.data('one'), width: bundle.image('tile').width };
  });
  expect(result).toEqual({ one: { value: 1 }, width: 2 });
  expect(log.requests.map((request) => request.path).sort()).toEqual([
    '/tests/browser/__assets/obj/one.json',
    '/tests/browser/__assets/obj/tile.json',
  ]);
});

async function webglAvailable(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl2')));
}

/** Expected RGBA of a logical frame given as palette indices, scaled by `scale`. */
function expectedImage(indices: number[], width: number, scale: number): number[] {
  const height = indices.length / width;
  const out: number[] = [];
  for (let y = 0; y < height * scale; y++)
    for (let x = 0; x < width * scale; x++)
      out.push(...rgba(indices[Math.floor(y / scale) * width + Math.floor(x / scale)]!));
  return out;
}

/** The 5 × 3 test frame: background, one pixel of 7 and a 3 × 2 block of 12. */
function testFrame(background: number): number[] {
  const frame = new Array<number>(15).fill(background);
  frame[0] = 7;
  for (const at of [7, 8, 9, 12, 13, 14]) frame[at] = 12;
  return frame;
}

for (const renderer of ['canvas2d', 'webgl2'] as const) {
  test(`capture returns a PNG of the last presented frame (${renderer})`, async ({ page }) => {
    test.skip(renderer === 'webgl2' && !(await webglAvailable(page)), 'WebGL2 is unavailable.');
    const result = await page.evaluate(
      async ({ kind, palette }) => {
        const { engine } = await window.createTestEngine({
          width: 5,
          height: 3,
          renderer: kind,
          palette,
        });
        const code = async (promise: Promise<unknown>) => {
          try {
            await promise;
            return 'OK';
          } catch (error) {
            return (error as Error & { code: string }).code;
          }
        };
        const decode = async (blob: Blob) => {
          const bitmap = await createImageBitmap(blob, {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
          });
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0);
          return {
            type: blob.type,
            width: bitmap.width,
            height: bitmap.height,
            pixels: [...context.getImageData(0, 0, bitmap.width, bitmap.height).data],
          };
        };
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const beforeFirstFrame = await code(engine.capture());
        let background = 1;
        engine.start({
          update() {},
          draw() {
            engine.graphics.clear(background);
            engine.graphics.pixel(0, 0, 7);
            engine.graphics.rect(2, 1, 3, 2, 12);
          },
        });
        await frame();
        engine.pause();
        const first = engine.capture({ scale: 3 });
        const concurrent = await code(engine.capture());
        // Frames presented while the first capture encodes must not change it.
        background = 2;
        engine.resume();
        await frame();
        await frame();
        engine.pause();
        const scaled = await decode(await first);
        const plain = await decode(await engine.capture());
        const invalid = await code(engine.capture({ scale: 9 }));
        const pending = engine.capture({ scale: 8 });
        void engine.dispose();
        const disposed = await code(pending);
        const afterDispose = await code(engine.capture());
        return { beforeFirstFrame, concurrent, invalid, disposed, afterDispose, scaled, plain };
      },
      { kind: renderer, palette: PALETTE },
    );
    expect(result.beforeFirstFrame).toBe('STATE');
    expect(result.concurrent).toBe('STATE');
    expect(result.invalid).toBe('RANGE');
    expect(result.disposed).toBe('STATE');
    expect(result.afterDispose).toBe('STATE');
    expect(result.scaled).toEqual({
      type: 'image/png',
      width: 15,
      height: 9,
      pixels: expectedImage(testFrame(1), 5, 3),
    });
    expect(result.plain).toEqual({
      type: 'image/png',
      width: 5,
      height: 3,
      pixels: expectedImage(testFrame(2), 5, 1),
    });
  });
}

test('capture keeps the presented palette and needs a new frame after resize', async ({ page }) => {
  const result = await page.evaluate(async (palette) => {
    const { engine } = await window.createTestEngine({ width: 2, height: 1, palette });
    const read = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return [...context.getImageData(0, 0, bitmap.width, bitmap.height).data];
    };
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(1);
        engine.graphics.pixel(1, 0, 3);
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    const replaced = [...palette];
    replaced.splice(4, 4, 1, 2, 3, 255);
    engine.setPalette(replaced);
    const presented = await read(await engine.capture());
    engine.resize(3, 1);
    let afterResize = 'OK';
    try {
      await engine.capture();
    } catch (error) {
      afterResize = (error as Error & { code: string }).code;
    }
    engine.resume();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    const next = await read(await engine.capture());
    return { presented, afterResize, next };
  }, PALETTE);
  expect(result.presented).toEqual([...rgba(1), ...rgba(3)]);
  expect(result.afterResize).toBe('STATE');
  expect(result.next).toEqual([1, 2, 3, 255, ...rgba(3), 1, 2, 3, 255]);
});

/** The browser's own decoding of a GIF's first frame, as RGBA. */
async function browserFirstFrame(page: Page, bytes: number[]) {
  return page.evaluate(async (data) => {
    const blob = new Blob([new Uint8Array(data)], { type: 'image/gif' });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      pixels: [...context.getImageData(0, 0, bitmap.width, bitmap.height).data],
    };
  }, bytes);
}

function rgbOf(indices: number[], width: number, scale: number): number[] {
  const out: number[] = [];
  const image = expectedImage(indices, width, scale);
  for (let at = 0; at < image.length; at += 4) out.push(image[at]!, image[at + 1]!, image[at + 2]!);
  return out;
}

test('a recording round-trips as a looping GIF with the presented frames', async ({ page }) => {
  const result = await page.evaluate(
    async ({ palette }) => {
      const { engine } = await window.createTestEngine({ width: 5, height: 3, palette });
      let frames = 0;
      engine.startRecording({ scale: 2 });
      const recording = engine.recording;
      engine.start({
        update() {},
        draw() {
          // A moving pixel for 12 frames, then a steady final picture.
          engine.graphics.clear(frames < 12 ? 1 : 2);
          engine.graphics.pixel(0, 0, 7);
          engine.graphics.rect(2, 1, 3, 2, 12);
          if (frames < 12) engine.graphics.pixel(frames % 5, 2, 9);
          frames++;
        },
      });
      while (frames < 30) await new Promise((resolve) => requestAnimationFrame(resolve));
      engine.pause();
      const blob = await engine.stopRecording();
      return {
        type: blob.type,
        bytes: [...new Uint8Array(await blob.arrayBuffer())],
        recording,
        after: engine.recording,
      };
    },
    { palette: PALETTE },
  );
  expect(result.recording).toBe(true);
  expect(result.after).toBe(false);
  expect(result.type).toBe('image/gif');
  const gif = decodeGif(result.bytes);
  expect([gif.width, gif.height, gif.loop, gif.globalColors]).toEqual([10, 6, 0, 16]);
  expect(gif.frames.length).toBeGreaterThanOrEqual(2);
  expect(gif.frames.every((frame) => frame.delay >= 2)).toBe(true);
  const first = testFrame(1);
  first[10] = 9;
  expect([...gif.frames[0]!.rgb]).toEqual(rgbOf(first, 5, 2));
  expect([...gif.frames.at(-1)!.rgb]).toEqual(rgbOf(testFrame(2), 5, 2));
  // The browser's own decoder agrees on the first frame.
  expect(await browserFirstFrame(page, result.bytes)).toEqual({
    width: 10,
    height: 6,
    pixels: expectedImage(first, 5, 2),
  });
});

test('a recording keeps only the last maxSeconds of frames', async ({ page }) => {
  const result = await page.evaluate(
    async ({ palette }) => {
      const { engine } = await window.createTestEngine({ width: 16, height: 1, palette });
      let frames = 0;
      engine.startRecording({ maxSeconds: 1 });
      const started = performance.now();
      engine.start({
        update() {},
        draw() {
          // The frame number in binary: one pixel per bit.
          for (let bit = 0; bit < 16; bit++)
            engine.graphics.pixel(bit, 0, (frames >> bit) & 1 ? 15 : 0);
          frames++;
        },
      });
      // At least 1.8 s and 90 frames, so that more than one second of frames exists.
      while (
        performance.now() - started < 8000 &&
        (performance.now() - started < 1800 || frames < 90)
      )
        await new Promise((resolve) => requestAnimationFrame(resolve));
      engine.pause();
      const blob = await engine.stopRecording();
      return { bytes: [...new Uint8Array(await blob.arrayBuffer())], frames };
    },
    { palette: PALETTE },
  );
  const gif = decodeGif(result.bytes);
  const numbers = gif.frames.map((frame) => {
    let value = 0;
    for (let bit = 0; bit < 16; bit++) if (frame.rgb[bit * 3] === 240) value |= 1 << bit;
    return value;
  });
  // Frames older than one second before the newest were dropped.
  expect(numbers[0]).toBeGreaterThan(0);
  // The newest frame is recorded unless it came within 20 ms of the one before.
  expect(result.frames - 1 - numbers.at(-1)!).toBeLessThanOrEqual(3);
  const span = gif.frames.slice(0, -1).reduce((sum, frame) => sum + frame.delay, 0);
  // Recorded frames are at most 270 ms apart (a 250 ms gap cap plus the 20 ms
  // rate limit), so the kept window spans more than 0.7 s even after a stall.
  expect(span).toBeLessThanOrEqual(100);
  expect(span).toBeGreaterThanOrEqual(70);
  // At most 50 frames per second.
  expect(gif.frames.length).toBeLessThanOrEqual(52);
});

test('recording state errors, options and disposal while encoding', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine({ width: 64, height: 64 });
    const codes: string[] = [];
    const attempt = async (action: () => unknown) => {
      try {
        await action();
        codes.push('OK');
      } catch (error) {
        codes.push((error as Error & { code: string }).code);
      }
    };
    await attempt(() => engine.stopRecording());
    await attempt(() => engine.startRecording({ maxSeconds: 0 }));
    await attempt(() => engine.startRecording({ scale: 5 }));
    await attempt(() => engine.startRecording({ scale: 1.5 }));
    await attempt(() => engine.startRecording(null as never));
    await attempt(() => engine.startRecording({ maxSeconds: 2 }));
    await attempt(() => engine.startRecording());
    // Nothing presented while recording.
    await attempt(() => engine.stopRecording());
    let frames = 0;
    engine.startRecording({ scale: 4 });
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(frames % 16);
        engine.graphics.circleFill(frames % 64, 32, 20, (frames + 5) % 16);
        frames++;
      },
    });
    while (frames < 20) await new Promise((resolve) => requestAnimationFrame(resolve));
    engine.pause();
    const encoding = engine.stopRecording();
    await attempt(() => engine.startRecording());
    void engine.dispose();
    await attempt(() => encoding);
    await attempt(() => engine.startRecording());
    return { codes, recording: engine.recording };
  });
  expect(result.codes).toEqual([
    'STATE',
    'RANGE',
    'RANGE',
    'RANGE',
    'ARGUMENT',
    'OK',
    'STATE',
    'STATE',
    'STATE',
    'STATE',
    'STATE',
  ]);
  expect(result.recording).toBe(false);
});

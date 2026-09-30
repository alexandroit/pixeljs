import { readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import type { Engine, EngineOptions } from '../../packages/core/src/api/types.js';

// Regression contracts for defects found during the 2026-09-30 validation.
// The harness is served under the production Content-Security-Policy.

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

/** Minimal original PNG encoder (RGBA8, filter 0) for test fixtures. */
function png(width: number, height: number, rgba: number[]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
    return Buffer.concat([header, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows: number[] = [];
  for (let y = 0; y < height; y++) rows.push(0, ...rgba.slice(y * width * 4, (y + 1) * width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('browser contracts run under the production Content-Security-Policy', async ({ page }) => {
  // A reused local server without the policy would silently weaken every test.
  const config = readFileSync(new URL('../../infra/nginx/pixeljs.conf', import.meta.url), 'utf8');
  const policy = /add_header Content-Security-Policy "([^"]+)"/.exec(config)?.[1];
  expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
  const response = await page.request.get('/tests/browser/harness.html');
  expect(response.headers()['content-security-policy']).toBe(policy);
});

async function webglAvailable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    return Boolean(gl?.getExtension('WEBGL_lose_context'));
  });
}

test('custom fonts draw their own glyphs with fallback and background', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ width: 16, height: 8 });
    // 'A' is a diagonal, 'B' a top bar; '?' is outside the font and falls back to 'B'.
    const bitmap = new Uint8Array(16);
    for (let row = 0; row < 8; row++) {
      bitmap[row] = 0x80 >> row;
      bitmap[8 + row] = row === 0 ? 0xff : 0;
    }
    const font = engine.createFont({
      glyphWidth: 8,
      glyphHeight: 8,
      firstChar: 65,
      charCount: 2,
      fallbackChar: 66,
      bitmap,
    });
    let wrongKind = '';
    try {
      engine.createFont({
        glyphWidth: 8,
        glyphHeight: 8,
        firstChar: 65,
        charCount: 2,
        fallbackChar: 67,
        bitmap,
      });
    } catch (error) {
      wrongKind = (error as Error & { code: string }).code;
    }
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
        engine.graphics.text(0, 0, 'A?', 7, { font, background: 2 });
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    const context = canvas.getContext('2d')!;
    const color = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
    return {
      fallbackOutsideFont: wrongKind,
      diagonal: color(3, 3),
      offDiagonal: color(4, 3),
      fallbackTop: color(12, 0),
      fallbackBody: color(12, 5),
      builtin: color(0, 0),
    };
  });
  expect(result.fallbackOutsideFont).toBe('RANGE');
  expect(result.diagonal).toEqual(result.fallbackTop);
  expect(result.offDiagonal).toEqual(result.fallbackBody);
  expect(result.diagonal).not.toEqual(result.offDiagonal);
});

test('the palette size is fixed at creation and every color must be opaque', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const palette = [0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255];
    const { engine, canvas } = await window.createTestEngine({ width: 4, height: 4, palette });
    const codes: string[] = [];
    const attempt = (action: () => void) => {
      try {
        action();
        codes.push('OK');
      } catch (error) {
        codes.push((error as Error & { code: string }).code);
      }
    };
    attempt(() => engine.setPalette(palette.slice(0, 12)));
    attempt(() => engine.setPalette([...palette.slice(0, 15), 0]));
    attempt(() => engine.createImage({ width: 1, height: 1, pixels: new Uint8Array([4]) }));
    attempt(() => engine.setPalette([1, 2, 3, 255, ...palette.slice(4)]));
    let drawError = '';
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
        try {
          engine.graphics.pixel(0, 0, 4);
        } catch (error) {
          drawError = (error as Error & { code: string }).code;
        }
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    return {
      codes,
      drawError,
      presented: Array.from(canvas.getContext('2d')!.getImageData(1, 1, 1, 1).data),
    };
  });
  expect(result.codes).toEqual(['ARGUMENT', 'RANGE', 'RANGE', 'OK']);
  expect(result.drawError).toBe('RANGE');
  expect(result.presented).toEqual([1, 2, 3, 255]);
});

for (const renderer of ['canvas2d', 'webgl2'] as const) {
  test(`setPaletteColor publishes only with an accepted frame (${renderer})`, async ({ page }) => {
    test.skip(renderer === 'webgl2' && !(await webglAvailable(page)), 'WebGL2 is unavailable.');
    const result = await page.evaluate(async (kind) => {
      const { engine, canvas } = await window.createTestEngine({
        width: 4,
        height: 4,
        renderer: kind,
      });
      const read = (): number[] => {
        if (kind === 'canvas2d')
          return Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data);
        const gl = canvas.getContext('webgl2')!;
        const pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return Array.from(pixel);
      };
      const nextFrame = () =>
        new Promise<number[]>((resolve) => requestAnimationFrame(() => resolve(read())));
      let mode: 'fail' | 'plain' | 'apply' = 'fail';
      const callbacks = {
        update() {},
        draw() {
          engine.graphics.clear(3);
          if (mode !== 'plain') engine.graphics.setPaletteColor(3, 10, 20, 30);
          // A rejected frame must not publish the palette record above.
          if (mode === 'fail') engine.graphics.pixel(0, 0, 99);
        },
      };
      engine.start(callbacks);
      await nextFrame();
      const pausedAfterFailure = engine.state;
      mode = 'plain';
      engine.start(callbacks);
      const before = await nextFrame();
      mode = 'apply';
      await nextFrame();
      const after = await nextFrame();
      return { pausedAfterFailure, before, after };
    }, renderer);
    expect(result.pausedAfterFailure).toBe('PAUSED');
    expect(result.before).not.toEqual([10, 20, 30, 255]);
    expect(result.after).toEqual([10, 20, 30, 255]);
  });
}

test('WebGL restoration keeps a 32-color palette and a size changed while lost', async ({
  page,
}) => {
  test.skip(!(await webglAvailable(page)), 'WEBGL_lose_context is unavailable.');
  const result = await page.evaluate(async () => {
    const palette: number[] = [];
    for (let index = 0; index < 32; index++) palette.push(index * 8, 255 - index * 8, index, 255);
    const { engine, canvas } = await window.createTestEngine({
      width: 8,
      height: 8,
      renderer: 'webgl2',
      palette,
    });
    const gl = canvas.getContext('webgl2')!;
    const extension = gl.getExtension('WEBGL_lose_context')!;
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(20);
        engine.graphics.pixel(engine.width - 1, 0, 31);
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => {
      canvas.addEventListener('webglcontextlost', () => resolve(), { once: true });
      extension.loseContext();
    });
    engine.resize(12, 6);
    await new Promise<void>((resolve) => {
      canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true });
      setTimeout(() => extension.restoreContext(), 50);
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const pixel = (x: number, y: number) => {
      const out = new Uint8Array(4);
      gl.readPixels(x, 5 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return Array.from(out);
    };
    return {
      state: engine.state,
      size: [canvas.width, canvas.height],
      background: pixel(0, 0),
      corner: pixel(11, 0),
    };
  });
  expect(result.state).toBe('RUNNING');
  expect(result.size).toEqual([12, 6]);
  expect(result.background).toEqual([160, 95, 20, 255]);
  expect(result.corner).toEqual([248, 7, 31, 255]);
});

test('loadImage maps a PNG to the palette and rejects oversized or invalid data early', async ({
  page,
}) => {
  // Colors 0 and 10 of the original palette, one transparent pixel and one near color 5.
  const fixture = png(2, 2, [13, 17, 28, 255, 50, 218, 202, 255, 0, 0, 0, 0, 248, 104, 95, 255]);
  const huge = Buffer.from(fixture);
  huge.writeUInt32BE(4096, 16);
  await page.route('**/__fixture.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: fixture }),
  );
  await page.route('**/__huge.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: huge }),
  );
  await page.route('**/__wrapped.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ width: 2, height: 1, pixels: [256, 1] }),
    }),
  );
  const oversized = Buffer.concat([fixture, Buffer.alloc(17 * 1024 * 1024)]);
  await page.route('**/__declared-large.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: oversized }),
  );
  await page.route('**/__slow.png', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 200, contentType: 'image/png', body: fixture }).catch(() => {});
  });
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ width: 2, height: 2 });
    const code = async (action: () => Promise<unknown>) => {
      try {
        await action();
        return 'OK';
      } catch (error) {
        return (error as Error & { code: string }).code;
      }
    };
    const image = await engine.loadImage('/__fixture.png', { transparentIndex: 3 });
    const codes = [
      await code(() => engine.loadImage('/__huge.png')),
      await code(() => engine.loadImage('/__wrapped.json')),
      await code(() => engine.loadImage('/__declared-large.png')),
      await code(() => engine.loadImage('/__fixture.png', { transparentIndex: 16 })),
    ];
    const controller = new AbortController();
    const aborted = code(() => engine.loadImage('/__slow.png', { signal: controller.signal }));
    controller.abort();
    codes.push(await aborted);
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(3);
        engine.graphics.sprite(image, 0, 0);
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    const context = canvas.getContext('2d')!;
    const pixel = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
    const disposed = code(() => engine.loadImage('/__slow.png'));
    await engine.dispose();
    codes.push(await disposed);
    return { codes, pixels: [pixel(0, 0), pixel(1, 0), pixel(0, 1), pixel(1, 1)] };
  });
  expect(result.codes).toEqual(['RANGE', 'RANGE', 'CAPACITY', 'RANGE', 'ABORTED', 'STATE']);
  expect(result.pixels).toEqual([
    [13, 17, 28, 255],
    [50, 218, 202, 255],
    [121, 128, 154, 255],
    [250, 105, 93, 255],
  ]);
});

test('a load cancelled while the browser decodes a PNG skips pixel reading', async ({ page }) => {
  const fixture = png(2, 2, [13, 17, 28, 255, 50, 218, 202, 255, 0, 0, 0, 0, 248, 104, 95, 255]);
  await page.route('**/__decode.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: fixture }),
  );
  const result = await page.evaluate(async () => {
    const decode = window.createImageBitmap.bind(window);
    const contexts = [
      CanvasRenderingContext2D.prototype,
      OffscreenCanvasRenderingContext2D.prototype,
    ];
    const reads = contexts.map((prototype) => prototype.getImageData);
    const close = ImageBitmap.prototype.close;
    let pixelReads = 0;
    let closed = 0;
    contexts.forEach((prototype, index) => {
      prototype.getImageData = function (this: never, ...args: [number, number, number, number]) {
        pixelReads += 1;
        return reads[index]!.apply(this, args);
      };
    });
    ImageBitmap.prototype.close = function (this: ImageBitmap) {
      closed += 1;
      close.call(this);
    };
    const outcomes: string[] = [];
    try {
      for (const cancel of ['abort', 'dispose']) {
        const { engine } = await window.createTestEngine({ width: 2, height: 2 });
        const controller = new AbortController();
        // Cancel exactly while the browser decodes.
        window.createImageBitmap = (async (
          source: ImageBitmapSource,
          options?: ImageBitmapOptions,
        ) => {
          const bitmap = await decode(source, options);
          if (cancel === 'abort') controller.abort();
          else void engine.dispose();
          return bitmap;
        }) as typeof createImageBitmap;
        try {
          await engine.loadImage('/__decode.png', { signal: controller.signal });
          outcomes.push('OK');
        } catch (error) {
          outcomes.push((error as Error & { code: string }).code);
        }
      }
    } finally {
      window.createImageBitmap = decode;
      contexts.forEach((prototype, index) => (prototype.getImageData = reads[index]!));
      ImageBitmap.prototype.close = close;
    }
    return { outcomes, pixelReads, closed };
  });
  expect(result).toEqual({ outcomes: ['ABORTED', 'STATE'], pixelReads: 0, closed: 2 });
});

test('start() after pause() resumes audio together with the game', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const callbacks = {
      update() {},
      draw() {
        engine.graphics.clear(0);
      },
    };
    const settle = async (expected: string) => {
      for (let tries = 0; tries < 100 && engine.audio.capabilities.state !== expected; tries++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return engine.audio.capabilities.state;
    };
    engine.start(callbacks);
    await engine.audio.unlock();
    engine.pause();
    const paused = await settle('suspended');
    engine.start(callbacks);
    return { paused, engine: engine.state, audio: await settle('running') };
  });
  expect(result).toEqual({ paused: 'suspended', engine: 'RUNNING', audio: 'running' });
});

test('music plays on the audio clock and a non-looping piece ends by itself', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const reported: string[] = [];
    // 16 steps at 400 BPM, 16 steps per beat: 0.15 s of music.
    const music = engine.audio.createMusic({
      bpm: 400,
      stepsPerBeat: 16,
      length: 16,
      loop: false,
      tracks: [
        { waveform: 'square', notes: [{ step: 0, pitch: 'C5', length: 4, effect: 'vibrato' }] },
        { voice: 3, waveform: 'noise', notes: [{ step: 8, pitch: 'C3', effect: 'fadeout' }] },
      ],
    });
    const jingle = engine.audio.createSound({
      bpm: 400,
      notes: [
        { step: 0, pitch: 'E5', effect: 'slide' },
        { step: 1, pitch: 'B5' },
      ],
    });
    // Requested before unlock: it starts once audio runs.
    engine.audio.playMusic(music);
    const before = engine.audio.musicPlaying;
    await engine.audio.unlock();
    engine.audio.play(jingle, 1);
    const started = Date.now();
    while (engine.audio.musicPlaying && Date.now() - started < 5000)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      before,
      ended: !engine.audio.musicPlaying,
      state: engine.audio.capabilities.state,
      reported,
    };
  });
  expect(result).toEqual({ before: true, ended: true, state: 'running', reported: [] });
});

test('an optional audio failure is reported without pausing the game', async ({ page }) => {
  // Real fixture files: Chromium does not route worklet module requests.
  const result = await page.evaluate(async () => {
    const outcomes: Array<{
      unlock: string;
      message: string;
      audio: string;
      engine: string;
      reported: string[];
    }> = [];
    for (const name of ['failing-processor', 'late-failure-processor']) {
      const reported: string[] = [];
      const { engine } = await window.createTestEngine({
        audioWorkletUrl: `/tests/browser/fixtures/${name}.js`,
        onError: (error) => reported.push((error as Error & { code: string }).code),
      });
      engine.start({
        update() {},
        draw() {
          engine.graphics.clear(0);
        },
      });
      let unlock = 'OK';
      let message = '';
      try {
        await engine.audio.unlock();
      } catch (error) {
        unlock = (error as Error & { code: string }).code;
        message = (error as Error).message;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      engine.audio.play({ frequency: 440 });
      outcomes.push({
        unlock,
        message,
        audio: engine.audio.capabilities.state,
        engine: engine.state,
        reported,
      });
    }
    return outcomes;
  });
  expect(result[0]).toEqual({
    unlock: 'AUDIO_ERROR',
    message: 'The audio processor failed to start.',
    audio: 'failed',
    engine: 'RUNNING',
    reported: [],
  });
  expect(result[1]).toEqual({
    unlock: 'OK',
    message: '',
    audio: 'failed',
    engine: 'RUNNING',
    reported: ['AUDIO_ERROR'],
  });
});

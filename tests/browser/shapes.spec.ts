import { expect, test } from '@playwright/test';
import type { Engine, EngineOptions } from '../../packages/core/src/api/types.js';

// Ellipses, triangles, flood fill, remapping and rotated/scaled sprites
// through the public API, in both renderers, under the production CSP.

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

test('new primitives draw the same indices and colors in WebGL2 and Canvas2D', async ({ page }) => {
  const available = await page.evaluate(() =>
    Boolean(document.createElement('canvas').getContext('webgl2')),
  );
  test.skip(!available, 'This browser environment does not expose WebGL2.');
  const result = await page.evaluate(async () => {
    const outcomes = [];
    for (const renderer of ['canvas2d', 'webgl2'] as const) {
      const { engine, canvas } = await window.createTestEngine({ renderer, width: 32, height: 24 });
      const arrow = engine.createImage({
        width: 4,
        height: 2,
        pixels: new Uint8Array([8, 8, 9, 0, 8, 8, 9, 9]),
        transparentIndex: 0,
      });
      engine.start({
        update() {},
        draw() {
          const g = engine.graphics;
          g.clear(1);
          g.rectb(0, 0, 32, 24, 2);
          g.ellipseFill(2, 2, 11, 7, 3);
          g.ellipse(2, 11, 11, 11, 4);
          g.triangleFill(16, 2, 30, 4, 20, 12, 5);
          g.triangle(16, 14, 30, 14, 23, 22, 6);
          g.fill(24, 17, 7);
          g.remap(8, 12);
          g.sprite(arrow, 8, 14, { rotation: 90, scale: 2 });
          g.resetRemap();
          g.sprite(arrow, 26, 8, { rotation: 180 });
        },
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      engine.pause();
      const indices = [];
      for (let y = 0; y < 24; y++)
        for (let x = 0; x < 32; x++) indices.push(engine.readPixel(x, y));
      let rgba: number[];
      if (renderer === 'canvas2d') {
        rgba = Array.from(canvas.getContext('2d')!.getImageData(0, 0, 32, 24).data);
      } else {
        const gl = canvas.getContext('webgl2')!;
        const flipped = new Uint8Array(32 * 24 * 4);
        gl.readPixels(0, 0, 32, 24, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
        rgba = [];
        for (let y = 23; y >= 0; y--) rgba.push(...flipped.subarray(y * 128, (y + 1) * 128));
      }
      outcomes.push({ indices, rgba });
    }
    return outcomes;
  });
  const [canvas2d, webgl2] = result;
  expect(webgl2!.indices).toEqual(canvas2d!.indices);
  expect(webgl2!.rgba).toEqual(canvas2d!.rgba);
  const at = (x: number, y: number) => canvas2d!.indices[y * 32 + x];
  expect(at(7, 5)).toBe(3); // Ellipse fill center.
  expect(at(7, 16)).toBe(1); // Inside the outlined ellipse.
  expect(at(2, 16)).toBe(4); // Its left edge.
  expect(at(21, 5)).toBe(5); // Triangle fill.
  expect(at(23, 17)).toBe(7); // Flood-filled inside the outlined triangle.
  expect(at(23, 14)).toBe(6); // Its top edge survives the fill.
  expect(canvas2d!.indices.includes(12)).toBe(true); // Remapped sprite pixels.
  expect(canvas2d!.indices.includes(8)).toBe(true); // Plain after resetRemap().
});

test('readPixel reads the last submitted frame, also during draw()', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const seen: number[] = [];
    let frame = 0;
    engine.start({
      update() {},
      draw() {
        seen.push(engine.readPixel(3, 4));
        engine.graphics.clear(frame === 0 ? 5 : 6);
        frame += 1;
      },
    });
    await new Promise<void>((resolve) => {
      const wait = () => (frame >= 2 ? resolve() : requestAnimationFrame(wait));
      requestAnimationFrame(wait);
    });
    engine.pause();
    const errors: string[] = [];
    for (const [x, y] of [
      [16, 0],
      [0, -1],
      [1.5, 0],
    ] as const) {
      try {
        engine.readPixel(x, y);
      } catch (error) {
        errors.push((error as Error & { code: string }).code);
      }
    }
    return { seen: seen.slice(0, 2), after: engine.readPixel(3, 4), errors };
  });
  expect(result.seen).toEqual([0, 5]);
  expect(result.after).toBe(6);
  expect(result.errors).toEqual(['RANGE', 'RANGE', 'RANGE']);
});

test('new drawing calls validate their arguments before anything is queued', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const image = engine.createImage({ width: 2, height: 2, pixels: new Uint8Array(4) });
    const results: string[] = [];
    engine.start({
      update() {},
      draw() {
        const g = engine.graphics;
        const attempt = (action: () => void) => {
          try {
            action();
            results.push('OK');
          } catch (error) {
            results.push((error as Error & { code: string }).code);
          }
        };
        attempt(() => g.ellipse(0, 0, 16385, 2, 1));
        attempt(() => g.ellipseFill(0, 0, 2, -1, 1));
        attempt(() => g.triangle(0, 0, 1, 1, 2, 2.5, 1));
        attempt(() => g.fill(0, 0, 16));
        attempt(() => g.remap(0, 16));
        attempt(() => g.sprite(image, 0, 0, { rotation: Number.NaN }));
        attempt(() => g.sprite(image, 0, 0, { scale: 0 }));
        attempt(() => g.sprite(image, 0, 0, { scale: 65 }));
        attempt(() => g.sprite(image, 0, 0, { rotation: 45, sourceX: 1, width: 2 }));
        attempt(() => g.sprite(image, 0, 0, { rotation: 720, scale: 1 }));
        attempt(() => g.sprite(image, 0, 0, { rotation: -90, scale: 1 / 16 }));
        // A triangle takes two of the 4,096 records: the second one no longer fits.
        // 3 records so far (a plain sprite and a transformed one); leave 3 free.
        for (let index = 0; index < 4090; index++) g.pixel(0, 0, 1);
        attempt(() => g.triangleFill(0, 0, 3, 0, 0, 3, 1));
        attempt(() => g.triangleFill(0, 0, 3, 0, 0, 3, 1));
        engine.pause();
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return { results, state: engine.state };
  });
  expect(codes.results).toEqual([
    'RANGE',
    'RANGE',
    'RANGE',
    'RANGE',
    'RANGE',
    'RANGE',
    'RANGE',
    'RANGE',
    'RANGE',
    'OK',
    'OK',
    'OK',
    'CAPACITY',
  ]);
});

import { expect, test } from '@playwright/test';
import type { Engine, EngineOptions, ImageResource } from '../../packages/core/src/api/types.js';

interface InputSample {
  down: boolean;
  pressed: boolean;
  pressedAgain: boolean;
  released: boolean;
  pointer: { x: number; y: number; down: boolean; pressed: boolean; released: boolean };
}

declare global {
  interface Window {
    pixeljs: {
      createEngine(options: EngineOptions): Promise<Engine>;
    };
    testEngines: Engine[];
    createTestEngine(
      options?: Partial<EngineOptions>,
    ): Promise<{ engine: Engine; canvas: HTMLCanvasElement }>;
    inputSamples: InputSample[];
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

test('Canvas2D displays exact raster boundaries from the real WASM core', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
        engine.graphics.rect(2, 3, 4, 5, 10);
        engine.graphics.pixel(0, 0, 1);
      },
    });
    return new Promise<{ pixels: number[][]; frames: number }>((resolve) => {
      requestAnimationFrame(() => {
        engine.pause();
        const context = canvas.getContext('2d')!;
        const points = [
          [0, 0],
          [1, 3],
          [2, 3],
          [5, 7],
          [6, 7],
          [2, 8],
          [15, 15],
        ];
        resolve({
          pixels: points.map(([x, y]) => Array.from(context.getImageData(x!, y!, 1, 1).data)),
          frames: engine.getStats().frames,
        });
      });
    });
  });
  expect(result.frames).toBeGreaterThan(0);
  expect(result.pixels[2]).toEqual(result.pixels[3]);
  expect(result.pixels[1]).toEqual(result.pixels[4]);
  expect(result.pixels[1]).toEqual(result.pixels[5]);
  expect(result.pixels[1]).toEqual(result.pixels[6]);
  expect(result.pixels[2]).not.toEqual(result.pixels[1]);
  expect(result.pixels[0]).not.toEqual(result.pixels[1]);
  expect(result.pixels.every((pixel) => pixel[3] === 255)).toBe(true);
});

test('WebGL2 and Canvas2D present identical palette colors and orientation', async ({ page }) => {
  const available = await page.evaluate(() =>
    Boolean(document.createElement('canvas').getContext('webgl2')),
  );
  test.skip(!available, 'This browser environment does not expose WebGL2.');
  const result = await page.evaluate(async () => {
    const canvasEngine = await window.createTestEngine({ renderer: 'canvas2d' });
    const webglEngine = await window.createTestEngine({ renderer: 'webgl2' });
    for (const { engine } of [canvasEngine, webglEngine]) {
      engine.start({
        update() {},
        draw() {
          engine.graphics.clear(0);
          for (let color = 0; color < 16; color += 1) engine.graphics.rect(color, 0, 1, 8, color);
          engine.graphics.rect(2, 10, 3, 4, 7);
          engine.graphics.pixel(15, 15, 15);
        },
      });
    }
    return new Promise<{ canvas: number[]; webgl: number[] }>((resolve) => {
      requestAnimationFrame(() => {
        canvasEngine.engine.pause();
        webglEngine.engine.pause();
        const expected = canvasEngine.canvas.getContext('2d')!.getImageData(0, 0, 16, 16).data;
        const gl = webglEngine.canvas.getContext('webgl2')!;
        const flipped = new Uint8Array(16 * 16 * 4);
        const actual = new Uint8Array(flipped.length);
        gl.readPixels(0, 0, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
        for (let y = 0; y < 16; y += 1) {
          actual.set(flipped.subarray((15 - y) * 64, (16 - y) * 64), y * 64);
        }
        resolve({ canvas: Array.from(expected), webgl: Array.from(actual) });
      });
    });
  });
  expect(result.webgl).toEqual(result.canvas);
});

test('steady frames allocate no additional core memory', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const image = engine.createImage({ width: 2, height: 2, pixels: new Uint8Array([1, 2, 3, 4]) });
    const before = engine.getStats();
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
        engine.graphics.sprite(image, 5, 5);
      },
    });
    await new Promise<void>((resolve) => {
      const check = () => {
        if (engine.getStats().frames >= 30) resolve();
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    engine.pause();
    return { before, after: engine.getStats() };
  });
  expect(result.after.frames).toBeGreaterThanOrEqual(30);
  expect(result.after.coreAllocations).toBe(result.before.coreAllocations);
  expect(result.after.coreBytes).toBe(result.before.coreBytes);
});

test('keyboard edges are stable within a tick and pointer coordinates follow the canvas', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ updateHz: 30 });
    window.inputSamples = [];
    engine.start({
      update() {
        window.inputSamples.push({
          down: engine.input.isDown('ArrowRight'),
          pressed: engine.input.wasPressed('ArrowRight'),
          pressedAgain: engine.input.wasPressed('ArrowRight'),
          released: engine.input.wasReleased('ArrowRight'),
          pointer: engine.input.pointer,
        });
      },
      draw() {
        engine.graphics.clear(0);
      },
    });
    canvas.focus();
  });
  await page.keyboard.down('ArrowRight');
  await expect
    .poll(() =>
      page.evaluate(() => window.inputSamples.some((sample) => sample.down && sample.pressed)),
    )
    .toBe(true);
  await page.keyboard.up('ArrowRight');
  await expect
    .poll(() =>
      page.evaluate(() => window.inputSamples.some((sample) => !sample.down && sample.released)),
    )
    .toBe(true);
  expect(
    await page.evaluate(() =>
      window.inputSamples.every((sample) => sample.pressed === sample.pressedAgain),
    ),
  ).toBe(true);
  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  // Target the middle of pixel 8; fractional layout can round boundary coordinates.
  await page.mouse.move(box!.x + (box!.width * 8.5) / 16, box!.y + (box!.height * 8.5) / 16);
  await page.mouse.down();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.inputSamples.some((sample) => sample.pointer.down && sample.pointer.pressed),
      ),
    )
    .toBe(true);
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.inputSamples.some((sample) => sample.pointer.released)))
    .toBe(true);
  const pointer = await page.evaluate(
    () => window.inputSamples.find((sample) => sample.pointer.pressed)!.pointer,
  );
  expect(pointer.x).toBe(8);
  expect(pointer.y).toBe(8);
});

test('pause stops frames and dispose returns one promise while disabling public calls', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    const before = engine.getStats().frames;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const paused = engine.getStats().frames;
    engine.resume();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const resumed = engine.getStats().frames;
    const first = engine.dispose();
    const same = first === engine.dispose();
    let blocked = false;
    try {
      engine.resume();
    } catch {
      blocked = true;
    }
    await first;
    return { before, paused, resumed, same, blocked, state: engine.state };
  });
  expect(result.paused).toBe(result.before);
  expect(result.resumed).toBeGreaterThan(result.paused);
  expect(result.same).toBe(true);
  expect(result.blocked).toBe(true);
  expect(result.state).toBe('DISPOSED');
});

test('a press and release between ticks preserves both edges without a stuck key', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ updateHz: 30 });
    let resolveSample: (value: { down: boolean; pressed: boolean; released: boolean }) => void;
    const sample = new Promise<{ down: boolean; pressed: boolean; released: boolean }>(
      (resolve) => {
        resolveSample = resolve;
      },
    );
    engine.start({
      update() {
        if (engine.input.wasPressed('KeyA')) {
          resolveSample({
            down: engine.input.isDown('KeyA'),
            pressed: engine.input.wasPressed('KeyA'),
            released: engine.input.wasReleased('KeyA'),
          });
        }
      },
      draw() {
        engine.graphics.clear(0);
      },
    });
    canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
    canvas.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', bubbles: true }));
    return sample;
  });
  expect(result).toEqual({ down: false, pressed: true, released: true });
});

test('dispose from update prevents the rest of that frame', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    let draws = 0;
    let drawsAtDispose = -1;
    let same = false;
    let during = '';
    await new Promise<void>((resolve, reject) => {
      engine.start({
        update() {
          drawsAtDispose = draws;
          const pending = engine.dispose();
          same = pending === engine.dispose();
          during = engine.state;
          pending.then(resolve, reject);
        },
        draw() {
          draws += 1;
          engine.graphics.clear(1);
        },
      });
    });
    return { draws, drawsAtDispose, same, during, state: engine.state };
  });
  expect(result.drawsAtDispose).toBeGreaterThanOrEqual(0);
  expect(result.draws).toBe(result.drawsAtDispose);
  expect(result.same).toBe(true);
  expect(result.during).toBe('DISPOSING');
  expect(result.state).toBe('DISPOSED');
});

test('dispose from draw cancels the unsubmitted command batch', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    const before = Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data);
    await new Promise<void>((resolve, reject) => {
      engine.start({
        update() {},
        draw() {
          engine.graphics.clear(10);
          engine.dispose().then(resolve, reject);
        },
      });
    });
    return {
      state: engine.state,
      before,
      pixel: Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data),
    };
  });
  expect(result.state).toBe('DISPOSED');
  expect(result.pixel).toEqual(result.before);
});

test('async callback rejection is observed, pauses the loop, and reports once', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const unhandled: string[] = [];
    window.addEventListener('unhandledrejection', (event) => unhandled.push(String(event.reason)));
    const errors: string[] = [];
    let draws = 0;
    let drawsAtError = -1;
    const { engine } = await window.createTestEngine({
      onError(error) {
        errors.push(error.message);
        drawsAtError = draws;
        throw new Error('An error handler must not recursively report its own error.');
      },
    });
    engine.start({
      update() {
        return Promise.reject(new Error('Expected rejected async update.'));
      },
      draw() {
        draws += 1;
        engine.graphics.clear(0);
      },
    });
    await new Promise<void>((resolve) => {
      const check = () => (errors.length ? resolve() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { errors, unhandled, draws, drawsAtError, state: engine.state };
  });
  expect(result.errors).toHaveLength(1);
  expect(result.unhandled).toEqual([]);
  expect(result.draws).toBe(result.drawsAtError);
  expect(result.state).toBe('PAUSED');
});

test('images are opaque, engine-scoped, and stale after release', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const a = await window.createTestEngine();
    const b = await window.createTestEngine();
    const image = a.engine.createImage({ width: 1, height: 1, pixels: new Uint8Array([1]) });
    const keys = Object.keys(image);
    let crossEngine = false;
    let forged = false;
    try {
      b.engine.release(image);
    } catch {
      crossEngine = true;
    }
    try {
      a.engine.release({ width: 1, height: 1 } as ImageResource);
    } catch {
      forged = true;
    }
    a.engine.release(image);
    a.engine.release(image);
    const errors: string[] = [];
    const c = await window.createTestEngine({
      onError(error) {
        errors.push(error.message);
      },
    });
    const stale = c.engine.createImage({ width: 1, height: 1, pixels: new Uint8Array([1]) });
    c.engine.release(stale);
    c.engine.start({
      update() {},
      draw() {
        c.engine.graphics.sprite(stale, 0, 0);
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return { keys, crossEngine, forged, errors, state: c.engine.state };
  });
  expect(result.keys.sort()).toEqual(['height', 'width']);
  expect(result.crossEngine).toBe(true);
  expect(result.forged).toBe(true);
  expect(result.errors).toHaveLength(1);
  expect(result.state).toBe('PAUSED');
});

test('JavaScript callers receive runtime validation before invalid input reaches C', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const creationErrors: string[] = [];
    for (const width of [0, -1, 1.5, NaN, Infinity, '16']) {
      try {
        await window.createTestEngine({ width: width as number });
      } catch (error) {
        creationErrors.push((error as Error).name);
      }
    }
    const { engine } = await window.createTestEngine();
    const failures: string[] = [];
    for (const action of [
      () => engine.graphics.clear(0),
      () => engine.createImage({ width: 2, height: 2, pixels: new Uint8Array([1]) }),
      () => engine.createImage({ width: 1, height: 1, pixels: new Uint8Array([16]) }),
      () => engine.createImage({ width: -1, height: 1, pixels: new Uint8Array() }),
    ]) {
      try {
        action();
      } catch (error) {
        failures.push((error as Error).name);
      }
    }
    return { creationErrors, failures, state: engine.state };
  });
  expect(result.creationErrors).toEqual(Array(6).fill('PixelJSError'));
  expect(result.failures).toEqual(Array(4).fill('PixelJSError'));
  expect(result.state).toBe('READY');
});

test('a draw validation error preserves the last complete frame', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const errors: string[] = [];
    const { engine, canvas } = await window.createTestEngine({
      onError(error) {
        errors.push(error.message);
      },
    });
    let invalid = false;
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(invalid ? 10 : 1);
        if (invalid) engine.graphics.rect(NaN, 0, 1, 1, 3);
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const before = Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data);
    invalid = true;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const after = Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data);
    return { before, after, errors, state: engine.state };
  });
  expect(result.after).toEqual(result.before);
  expect(result.errors).toHaveLength(1);
  expect(result.state).toBe('PAUSED');
});

test('WASM 404, MIME, corrupt bytes, and cancellation reject creation clearly', async ({
  page,
}) => {
  await page.route('**/__wrong-mime.wasm', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Not WASM</html>' }),
  );
  await page.route('**/__corrupt.wasm', (route) =>
    route.fulfill({ status: 200, contentType: 'application/wasm', body: 'invalid wasm bytes' }),
  );
  const result = await page.evaluate(async () => {
    const errors: string[] = [];
    for (const wasmUrl of ['/__missing.wasm', '/__wrong-mime.wasm', '/__corrupt.wasm']) {
      try {
        await window.createTestEngine({ wasmUrl });
      } catch (error) {
        errors.push((error as Error & { code: string }).code);
      }
    }
    const controller = new AbortController();
    controller.abort();
    try {
      await window.createTestEngine({ signal: controller.signal });
    } catch (error) {
      errors.push((error as Error & { code: string }).code);
    }
    return errors;
  });
  expect(result).toEqual(['WASM_LOAD', 'WASM_MIME', 'WASM_LOAD', 'ABORTED']);
});

test('normal creation fetches the WASM binary exactly once', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('.wasm')) requests.push(path);
  });
  const state = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    return engine.state;
  });
  expect(state).toBe('READY');
  expect(requests).toEqual(['/packages/core/dist/internal/wasm/engine.wasm']);
});

test('a valid custom WASM URL supplies the actual instantiated binary', async ({ page }) => {
  const binary = await page.request.get('/packages/core/dist/internal/wasm/engine.wasm');
  expect(binary.status()).toBe(200);
  const bytes = await binary.body();
  await page.route('**/__custom-valid.wasm', (route) =>
    route.fulfill({ status: 200, contentType: 'application/wasm', body: bytes }),
  );
  const requests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('.wasm')) requests.push(path);
  });
  const state = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine({ wasmUrl: '/__custom-valid.wasm' });
    return engine.state;
  });
  expect(state).toBe('READY');
  expect(requests).toEqual(['/__custom-valid.wasm']);
});

test('valid WASM magic with a malformed module rejects without fetching a default binary', async ({
  page,
}) => {
  await page.route('**/__malformed-module.wasm', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/wasm',
      body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 255]),
    }),
  );
  const requests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('.wasm')) requests.push(path);
  });
  const result = await page.evaluate(async () => {
    try {
      await window.createTestEngine({ wasmUrl: '/__malformed-module.wasm' });
      return 'UNEXPECTED_SUCCESS';
    } catch (error) {
      return (error as Error & { code: string }).code;
    }
  });
  expect(result).toBe('WASM_LOAD');
  expect(requests).toEqual(['/__malformed-module.wasm']);
});

test('WebGL context loss pauses and manual pause survives restoration', async ({ page }) => {
  const available = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    return Boolean(gl?.getExtension('WEBGL_lose_context'));
  });
  test.skip(!available, 'This browser environment does not expose WEBGL_lose_context.');
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ renderer: 'webgl2' });
    const gl = canvas.getContext('webgl2')!;
    const extension = gl.getExtension('WEBGL_lose_context')!;
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(1);
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => {
      canvas.addEventListener('webglcontextlost', () => resolve(), { once: true });
      extension.loseContext();
    });
    const lost = engine.state;
    engine.pause();
    await new Promise<void>((resolve) => {
      canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true });
      setTimeout(() => extension.restoreContext(), 50);
    });
    const restored = engine.state;
    engine.resume();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return { lost, restored, resumed: engine.state, frames: engine.getStats().frames };
  });
  expect(result.lost).toBe('PAUSED');
  expect(result.restored).toBe('PAUSED');
  expect(result.resumed).toBe('RUNNING');
  expect(result.frames).toBeGreaterThan(0);
});

test('a start callback getter cannot restart an engine after disposing it', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    let calls = 0;
    let getters = 0;
    let code = '';
    try {
      engine.start({
        get update() {
          getters += 1;
          void engine.dispose();
          return () => {
            calls += 1;
          };
        },
        draw() {
          calls += 1;
        },
      });
    } catch (error) {
      code = (error as Error & { code: string }).code;
    }
    await engine.dispose();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return { calls, getters, code, state: engine.state };
  });
  expect(result).toEqual({ calls: 0, getters: 1, code: 'STATE', state: 'DISPOSED' });
});

test('an image option getter cannot upload after disposing its engine', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    let getters = 0;
    let code = '';
    try {
      engine.createImage({
        width: 1,
        height: 1,
        get pixels() {
          getters += 1;
          void engine.dispose();
          return new Uint8Array([1]);
        },
      });
    } catch (error) {
      code = (error as Error & { code: string }).code;
    }
    await engine.dispose();
    return { getters, code, state: engine.state, bytes: engine.getStats().coreBytes };
  });
  expect(result).toEqual({ getters: 1, code: 'STATE', state: 'DISPOSED', bytes: 0 });
});

test('a sprite option getter disposing during draw cancels the complete pending batch', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    const image = engine.createImage({ width: 1, height: 1, pixels: new Uint8Array([1]) });
    const before = Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data);
    let code = '';
    let getters = 0;
    await new Promise<void>((resolve, reject) => {
      engine.start({
        update() {},
        draw() {
          engine.graphics.clear(10);
          try {
            engine.graphics.sprite(image, 0, 0, {
              get flipX() {
                getters += 1;
                engine.dispose().then(resolve, reject);
                return false;
              },
            });
          } catch (error) {
            code = (error as Error & { code: string }).code;
          }
        },
      });
    });
    const after = Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data);
    return { getters, code, state: engine.state, before, after };
  });
  expect(result.getters).toBe(1);
  expect(result.code).toBe('STATE');
  expect(result.state).toBe('DISPOSED');
  expect(result.after).toEqual(result.before);
});

test('pending input overflow reports lost events and resynchronizes the next tick', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ updateHz: 30 });
    let resolveSample: (value: { down: boolean; pressed: boolean }) => void;
    const sample = new Promise<{ down: boolean; pressed: boolean }>((resolve) => {
      resolveSample = resolve;
    });
    engine.start({
      update() {
        if (engine.input.wasPressed('KeyR')) {
          resolveSample({
            down: engine.input.isDown('KeyR'),
            pressed: engine.input.wasPressed('KeyR'),
          });
        }
      },
      draw() {
        engine.graphics.clear(0);
      },
    });
    canvas.focus();
    for (let i = 0; i < 1028; i += 1) {
      const code = `Overflow${i}`;
      canvas.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      canvas.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    }
    const overflows = engine.getStats().inputOverflows;
    const stuck = Array.from({ length: 1028 }, (_, i) => engine.input.isDown(`Overflow${i}`)).some(
      Boolean,
    );
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', bubbles: true }));
    const next = await sample;
    canvas.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', bubbles: true }));
    return { overflows, stuck, next, released: !engine.input.isDown('KeyR') };
  });
  expect(result.overflows).toBeGreaterThan(0);
  expect(result.stuck).toBe(false);
  expect(result.next).toEqual({ down: true, pressed: true });
  expect(result.released).toBe(true);
});

test('secondary pointer cancellation does not end the active primary pointer', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 11, isPrimary: true, bubbles: true }),
    );
    const started = engine.input.pointer.down;
    canvas.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId: 12, isPrimary: false, bubbles: true }),
    );
    const afterSecondaryCancel = engine.input.pointer.down;
    canvas.dispatchEvent(
      new PointerEvent('lostpointercapture', { pointerId: 12, isPrimary: false, bubbles: true }),
    );
    const afterSecondaryLost = engine.input.pointer.down;
    canvas.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId: 11, isPrimary: true, bubbles: true }),
    );
    return {
      started,
      afterSecondaryCancel,
      afterSecondaryLost,
      afterPrimaryCancel: engine.input.pointer.down,
    };
  });
  expect(result).toEqual({
    started: true,
    afterSecondaryCancel: true,
    afterSecondaryLost: true,
    afterPrimaryCancel: false,
  });
});

test('pause and disposal release an active browser pointer capture', async ({ page }) => {
  await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    canvas.addEventListener('pointerdown', (event) => {
      canvas.dataset.testPointerId = String(event.pointerId);
    });
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
      },
    });
  });
  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  try {
    expect(
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas')!;
        return canvas.hasPointerCapture(Number(canvas.dataset.testPointerId));
      }),
    ).toBe(true);
    const paused = await page.evaluate(() => {
      const engine = window.testEngines[0]!;
      const canvas = document.querySelector('canvas')!;
      engine.pause();
      return {
        down: engine.input.pointer.down,
        captured: canvas.hasPointerCapture(Number(canvas.dataset.testPointerId)),
      };
    });
    expect(paused).toEqual({ down: false, captured: false });
    const disposed = await page.evaluate(async () => {
      const engine = window.testEngines[0]!;
      const canvas = document.querySelector('canvas')!;
      await engine.dispose();
      return {
        state: engine.state,
        captured: canvas.hasPointerCapture(Number(canvas.dataset.testPointerId)),
      };
    });
    expect(disposed).toEqual({ state: 'DISPOSED', captured: false });
  } finally {
    await page.mouse.up();
  }
});

test('a simulated RuntimeError is terminal and dispose preserves FAILED', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const errors: string[] = [];
    const { engine } = await window.createTestEngine({
      onError(error) {
        errors.push(error.message);
      },
    });
    // This is a host lifecycle classification test, not evidence of an actual C trap.
    engine.start({
      update() {
        throw new WebAssembly.RuntimeError('Simulated host terminal classification.');
      },
      draw() {
        engine.graphics.clear(0);
      },
    });
    await new Promise<void>((resolve) => {
      const check = () => (errors.length ? resolve() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    const before = engine.state;
    const first = engine.dispose();
    const same = first === engine.dispose();
    await first;
    let blocked = false;
    try {
      engine.resume();
    } catch {
      blocked = true;
    }
    return {
      before,
      after: engine.state,
      same,
      blocked,
      errors,
      bytes: engine.getStats().coreBytes,
    };
  });
  expect(result.before).toBe('FAILED');
  expect(result.after).toBe('FAILED');
  expect(result.same).toBe(true);
  expect(result.blocked).toBe(true);
  expect(result.errors).toEqual(['Simulated host terminal classification.']);
  expect(result.bytes).toBe(0);
});

test('extended raster primitives (line, rectb, circle, circleFill, text) render to canvas2d', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ width: 16, height: 16 });
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
        engine.graphics.line(0, 0, 3, 3, 2);
        engine.graphics.rectb(4, 0, 4, 4, 3);
        engine.graphics.circle(2, 6, 1, 4);
        engine.graphics.circleFill(6, 6, 1, 5);
        engine.graphics.text(8, 0, '!', 7);
      },
    });
    return new Promise<{
      linePixel: number[];
      rectbBorder: number[];
      rectbHole: number[];
      circleBorder: number[];
      circleHole: number[];
      circleFillCenter: number[];
      textPixel: number[];
    }>((resolve) => {
      requestAnimationFrame(() => {
        engine.pause();
        const ctx = canvas.getContext('2d')!;
        const get = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        resolve({
          linePixel: get(1, 1),
          rectbBorder: get(4, 0),
          rectbHole: get(5, 1),
          circleBorder: get(2, 5),
          circleHole: get(2, 6),
          circleFillCenter: get(6, 6),
          textPixel: get(11, 0),
        });
      });
    });
  });
  expect(result.linePixel).not.toEqual(result.rectbHole);
  expect(result.rectbBorder).not.toEqual(result.rectbHole);
  expect(result.circleBorder).not.toEqual(result.circleHole);
  expect(result.circleFillCenter).not.toEqual(result.circleHole);
  expect(result.textPixel).not.toEqual(result.rectbHole);
});

test('tilemaps create, render with culling, and respect lifecycle dependency', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ width: 16, height: 16 });
    const tileset = engine.createImage({
      width: 4,
      height: 4,
      pixels: new Uint8Array([1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]),
    });
    const map = engine.createTilemap({
      cols: 2,
      rows: 2,
      tileWidth: 2,
      tileHeight: 2,
      tileset,
      tiles: [0, 1, 2, 3],
    });
    let releaseFailed = false;
    try {
      engine.release(tileset);
    } catch {
      releaseFailed = true;
    }
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
        engine.graphics.tilemap(map, 0, 0);
      },
    });
    return new Promise<{
      releaseFailed: boolean;
      tile0: number[];
      tile1: number[];
      tile2: number[];
      tile3: number[];
    }>((resolve) => {
      requestAnimationFrame(() => {
        engine.pause();
        const ctx = canvas.getContext('2d')!;
        const get = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        resolve({
          releaseFailed,
          tile0: get(0, 0),
          tile1: get(2, 0),
          tile2: get(0, 2),
          tile3: get(2, 2),
        });
      });
    });
  });
  expect(result.releaseFailed).toBe(true);
  expect(result.tile0).not.toEqual(result.tile1);
  expect(result.tile0).not.toEqual(result.tile2);
  expect(result.tile1).not.toEqual(result.tile3);
});

test('resize dynamically adjusts canvas and rendering dimensions', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ width: 8, height: 8 });
    const initialW = engine.width;
    const initialH = engine.height;
    engine.resize(16, 12);
    const resizedW = engine.width;
    const resizedH = engine.height;
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(5);
      },
    });
    return new Promise<{
      initialW: number;
      initialH: number;
      resizedW: number;
      resizedH: number;
      canvasW: number;
      canvasH: number;
      cornerPixel: number[];
    }>((resolve) => {
      requestAnimationFrame(() => {
        engine.pause();
        const ctx = canvas.getContext('2d')!;
        resolve({
          initialW,
          initialH,
          resizedW,
          resizedH,
          canvasW,
          canvasH,
          cornerPixel: Array.from(ctx.getImageData(15, 11, 1, 1).data),
        });
      });
    });
  });
  expect(result.initialW).toBe(8);
  expect(result.initialH).toBe(8);
  expect(result.resizedW).toBe(16);
  expect(result.resizedH).toBe(12);
  expect(result.canvasW).toBe(16);
  expect(result.canvasH).toBe(12);
  expect(result.cornerPixel[3]).toBe(255);
});

test('setPalette dynamically alters presented canvas colors', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine({ width: 8, height: 8 });
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(1);
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const ctx = canvas.getContext('2d')!;
    const beforeColor = Array.from(ctx.getImageData(0, 0, 1, 1).data);

    // Palette colors are opaque: every alpha must be 255.
    const customPalette = new Uint8Array(16 * 4);
    for (let index = 3; index < customPalette.length; index += 4) customPalette[index] = 255;
    customPalette[1 * 4 + 0] = 255;
    customPalette[1 * 4 + 1] = 0;
    customPalette[1 * 4 + 2] = 255;
    customPalette[1 * 4 + 3] = 255;
    engine.setPalette(customPalette);

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    engine.pause();
    const afterColor = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    return { beforeColor, afterColor };
  });
  expect(result.afterColor).toEqual([255, 0, 255, 255]);
  expect(result.beforeColor).not.toEqual(result.afterColor);
});

test('audio system is lazy and opt-in: visual game starts without AudioContext', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const supported = engine.audio.capabilities.supported;
    const initialState = engine.audio.capabilities.state;

    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
      },
    });

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    return {
      supported,
      initialState,
      stateAfterDraw: engine.audio.capabilities.state,
      engineAudioCap: engine.capabilities.audio,
    };
  });

  expect(result.supported).toBe(true);
  expect(result.engineAudioCap).toBe(true);
  expect(result.initialState).toBe('uninitialized');
  expect(result.stateAfterDraw).toBe('uninitialized');
});

test('audio system unlocks via unlock(), loads AudioWorklet and transitions to running', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const stateBefore = engine.audio.capabilities.state;

    await engine.audio.unlock();
    const stateAfter = engine.audio.capabilities.state;

    // Subsequent unlock() resolves immediately
    await engine.audio.unlock();
    const stateSecond = engine.audio.capabilities.state;

    return { stateBefore, stateAfter, stateSecond };
  });

  expect(result.stateBefore).toBe('uninitialized');
  expect(result.stateAfter).toBe('running');
  expect(result.stateSecond).toBe('running');
});

test('sound resources can be created, loaded, played, stopped, and released with strict error handling', async ({
  page,
}) => {
  await page.route('**/__sound.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        waveform: 'triangle',
        frequency: 330,
        volume: 0.6,
        attack: 0.005,
        decay: 0.01,
        sustain: 0.7,
        release: 0.04,
        duration: 0.15,
      }),
    }),
  );
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    await engine.audio.unlock();

    // createSound validation
    let badWaveform = false;
    try {
      engine.audio.createSound({ waveform: 'invalid' as any });
    } catch {
      badWaveform = true;
    }

    const sound = engine.audio.createSound({
      waveform: 'square',
      frequency: 440,
      volume: 0.5,
      attack: 0.01,
      decay: 0.02,
      sustain: 0.8,
      release: 0.05,
      duration: 0.2,
    });

    // Play sound and test instance stop
    const inst0 = engine.audio.play(sound, 0);
    inst0.stop();

    // Play with auto voice allocation
    const inst1 = engine.audio.play(sound);
    const inst1Voice = inst1.voice;

    // Same-origin sound description (the production CSP blocks data: fetches).
    const loaded = await engine.audio.loadSound('/__sound.json');

    const instLoaded = engine.audio.play(loaded, 2);

    // Stop all audio
    engine.audio.stop();

    // Master volume
    engine.audio.setVolume(0.7);

    // Release resource
    engine.release(sound);
    let playReleasedFailed = false;
    try {
      engine.audio.play(sound);
    } catch (e: any) {
      if (e.code === 'HANDLE') playReleasedFailed = true;
    }

    return {
      badWaveform,
      inst0Voice: inst0.voice,
      inst1VoiceValid: inst1Voice >= 0 && inst1Voice <= 3,
      loadedFreq: loaded.frequency,
      instLoadedVoice: instLoaded.voice,
      playReleasedFailed,
    };
  });

  expect(result.badWaveform).toBe(true);
  expect(result.inst0Voice).toBe(0);
  expect(result.inst1VoiceValid).toBe(true);
  expect(result.loadedFreq).toBe(330);
  expect(result.instLoadedVoice).toBe(2);
  expect(result.playReleasedFailed).toBe(true);
});

test('engine pause and dispose cleanly suspend and tear down the audio system', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    await engine.audio.unlock();
    const runningState = engine.audio.capabilities.state;
    // Devices take a variable time to suspend and resume (Linux audio servers
    // are slower than macOS), so wait for each state instead of a fixed time.
    const settle = async (expected: string) => {
      for (let tries = 0; tries < 150 && engine.audio.capabilities.state !== expected; tries++)
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return engine.audio.capabilities.state;
    };

    engine.pause();
    const pausedState = await settle('suspended');

    engine.resume();
    const resumedState = await settle('running');

    await engine.dispose();
    const disposedState = engine.audio.capabilities.state;

    let unlockAfterDisposeFailed = false;
    try {
      await engine.audio.unlock();
    } catch (e: any) {
      if (e.code === 'STATE') unlockAfterDisposeFailed = true;
    }

    return {
      runningState,
      pausedState,
      resumedState,
      disposedState,
      unlockAfterDisposeFailed,
    };
  });

  expect(result.runningState).toBe('running');
  expect(result.pausedState).toBe('suspended');
  expect(result.resumedState).toBe('running');
  expect(result.disposedState).toBe('disposed');
  expect(result.unlockAfterDisposeFailed).toBe(true);
});

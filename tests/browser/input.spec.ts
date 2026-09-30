import { expect, test, type Page } from '@playwright/test';
import type {
  Engine,
  EngineOptions,
  GamepadSnapshot,
  PointerSnapshot,
  WheelSnapshot,
} from '../../packages/core/src/api/types.js';

// Pointer, wheel, gamepad and viewport contracts, served under the production
// Content-Security-Policy. Synthetic events dispatched between two ticks drive
// the deterministic multi-pointer cases in every browser; trusted mouse,
// wheel and (Chromium) touch input check what browsers actually deliver.

interface Recorder<T> {
  samples: T[];
  /** Resolves with the first sample of a tick that starts after the call. */
  next(): Promise<T>;
}
interface InputKit {
  /** Starts `engine` and records `sample()` once per logical tick. */
  record<T>(engine: Engine, sample: () => T): Recorder<T>;
  /** Dispatches a synthetic pointer event at the center of logical pixel (x, y) of a filled canvas. */
  send(
    canvas: HTMLCanvasElement,
    type: string,
    pointerId: number,
    x: number,
    y: number,
    init?: PointerEventInit,
  ): boolean;
  /** Appends a parent of the given CSS size holding a new canvas. */
  parent(width: number, height: number): { parent: HTMLDivElement; canvas: HTMLCanvasElement };
  create(options: EngineOptions): Promise<Engine>;
  /** Waits (at most about two seconds) until the canvas CSS size differs from `size`. */
  settle(canvas: HTMLCanvasElement, size: number[]): Promise<number[]>;
  cssSize(canvas: HTMLCanvasElement): number[];
}
interface Sample {
  pointers: readonly PointerSnapshot[];
  pointer: PointerSnapshot;
}

declare global {
  interface Window {
    pixeljs: { createEngine(options: EngineOptions): Promise<Engine> };
    testEngines: Engine[];
    createTestEngine(
      options?: Partial<EngineOptions>,
    ): Promise<{ engine: Engine; canvas: HTMLCanvasElement }>;
    inputKit: InputKit;
    recorder: Recorder<unknown>;
    testPads: unknown[];
    wheelDeltas: number[];
    menus: boolean[];
  }
}

async function open(page: Page): Promise<void> {
  await page.goto('/tests/browser/harness.html');
  await page.waitForFunction(() => typeof window.createTestEngine === 'function');
  await page.evaluate(() => {
    window.inputKit = {
      record(engine, sample) {
        const samples: ReturnType<typeof sample>[] = [];
        engine.start({
          update() {
            samples.push(sample());
          },
          draw() {
            engine.graphics.clear(0);
          },
        });
        return {
          samples,
          next() {
            const index = samples.length;
            return new Promise((resolve) => {
              const check = (): void => {
                if (samples.length > index) resolve(samples[index]!);
                else requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            });
          },
        };
      },
      send(canvas, type, pointerId, x, y, init = {}) {
        const rect = canvas.getBoundingClientRect();
        return canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId,
            pointerType: 'touch',
            isPrimary: pointerId === 1,
            clientX: rect.left + ((x + 0.5) * rect.width) / canvas.width,
            clientY: rect.top + ((y + 0.5) * rect.height) / canvas.height,
            button: 0,
            buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      },
      parent(width, height) {
        const parent = document.createElement('div');
        parent.style.width = `${width}px`;
        parent.style.height = `${height}px`;
        const canvas = document.createElement('canvas');
        parent.append(canvas);
        document.querySelector('main')!.append(parent);
        return { parent, canvas };
      },
      async create(options) {
        const engine = await window.pixeljs.createEngine({ renderer: 'canvas2d', ...options });
        window.testEngines.push(engine);
        return engine;
      },
      async settle(canvas, size) {
        for (let frame = 0; frame < 120; frame++) {
          const now = window.inputKit.cssSize(canvas);
          if (!Object.is(now[0], size[0]) || !Object.is(now[1], size[1])) return now;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return window.inputKit.cssSize(canvas);
      },
      cssSize(canvas) {
        return [Number.parseFloat(canvas.style.width), Number.parseFloat(canvas.style.height)];
      },
    };
  });
}

/** Runs a trusted input action and returns every tick sample recorded from just before it. */
async function after<T>(page: Page, action: () => Promise<unknown>): Promise<T[]> {
  const mark = await page.evaluate(() => window.recorder.samples.length);
  await action();
  await page.evaluate(() => window.recorder.next());
  return page.evaluate((from) => window.recorder.samples.slice(from) as T[], mark);
}
const last = <T>(samples: T[]): T => samples[samples.length - 1]!;

test.beforeEach(async ({ page }) => {
  await open(page);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await Promise.all((window.testEngines ?? []).map((engine) => engine.dispose()));
  });
});

test('simultaneous touch contacts keep ids, first-contact order and one-tick edges', async ({
  page,
}) => {
  const ticks = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    const kit = window.inputKit;
    const recorder = kit.record(engine, () => ({
      pointers: engine.input.pointers,
      pointer: engine.input.pointer,
    }));
    await recorder.next();
    kit.send(canvas, 'pointerdown', 1, 2, 3);
    kit.send(canvas, 'pointerdown', 2, 10, 4);
    const two = await recorder.next();
    kit.send(canvas, 'pointerdown', 3, 5, 12);
    kit.send(canvas, 'pointermove', 1, 4, 5);
    const three = await recorder.next();
    kit.send(canvas, 'pointerup', 2, 11, 6);
    const oneUp = await recorder.next();
    const afterUp = await recorder.next();
    kit.send(canvas, 'pointerup', 1, 4, 5);
    kit.send(canvas, 'pointerup', 3, 5, 12);
    const allUp = await recorder.next();
    const none = await recorder.next();
    const frozen =
      Object.isFrozen(two.pointers) &&
      two.pointers.every((pointer) => Object.isFrozen(pointer)) &&
      Object.isFrozen(two.pointer) &&
      two.pointers !== three.pointers;
    return { two, three, oneUp, afterUp, allUp, none, frozen };
  });
  const touch = (id: number, x: number, y: number, state: Partial<PointerSnapshot> = {}) => ({
    id,
    type: 'touch',
    x,
    y,
    buttons: 1,
    down: true,
    pressed: false,
    released: false,
    ...state,
  });
  const [a, b] = ticks.two.pointers.map((pointer) => pointer.id) as [number, number];
  expect(a).toBeGreaterThan(0);
  expect(b).not.toBe(a);
  expect(ticks.two.pointers).toEqual([
    touch(a, 2, 3, { pressed: true }),
    touch(b, 10, 4, { pressed: true }),
  ]);
  // The first touch is the primary pointer.
  expect(ticks.two.pointer).toEqual(touch(a, 2, 3, { pressed: true }));
  const c = ticks.three.pointers[2]!.id;
  expect([a, b]).not.toContain(c);
  expect(ticks.three.pointers).toEqual([
    touch(a, 4, 5),
    touch(b, 10, 4),
    touch(c, 5, 12, { pressed: true }),
  ]);
  expect(ticks.oneUp.pointers).toEqual([
    touch(a, 4, 5),
    touch(b, 11, 6, { down: false, released: true }),
    touch(c, 5, 12),
  ]);
  expect(ticks.afterUp.pointers).toEqual([touch(a, 4, 5), touch(c, 5, 12)]);
  expect(ticks.allUp.pointers).toEqual([
    touch(a, 4, 5, { down: false, released: true }),
    touch(c, 5, 12, { down: false, released: true }),
  ]);
  expect(ticks.allUp.pointer).toEqual({
    ...touch(a, 4, 5, { down: false, released: true }),
    buttons: 0,
  });
  expect(ticks.none.pointers).toEqual([]);
  expect(ticks.none.pointer).toMatchObject({ id: 0, x: 4, y: 5, down: false, released: false });
  expect(ticks.frozen).toBe(true);
});

test('a contact pressed and released between two ticks reports both edges once, with down false', async ({
  page,
}) => {
  const ticks = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    const kit = window.inputKit;
    const mouse = { pointerType: 'mouse' };
    const recorder = kit.record(engine, () => ({
      pointers: engine.input.pointers,
      pointer: engine.input.pointer,
    }));
    await recorder.next();
    kit.send(canvas, 'pointerdown', 1, 7, 7, mouse);
    kit.send(canvas, 'pointerup', 1, 8, 7, mouse);
    const tap = await recorder.next();
    const quiet = await recorder.next();
    // Press, release and press again: two contacts, the second still held.
    kit.send(canvas, 'pointerdown', 1, 1, 1, mouse);
    kit.send(canvas, 'pointerup', 1, 1, 1, mouse);
    kit.send(canvas, 'pointerdown', 1, 2, 2, mouse);
    const again = await recorder.next();
    kit.send(canvas, 'pointerup', 1, 2, 2, mouse);
    return { tap, quiet, again };
  });
  const id = ticks.tap.pointers[0]!.id;
  const snapshot = { id, type: 'mouse', x: 8, y: 7, buttons: 1 };
  expect(ticks.tap.pointers).toEqual([{ ...snapshot, down: false, pressed: true, released: true }]);
  expect(ticks.tap.pointer).toEqual({
    ...snapshot,
    buttons: 0,
    down: false,
    pressed: true,
    released: true,
  });
  expect(ticks.quiet.pointers).toEqual([]);
  expect(ticks.quiet.pointer).toEqual({
    id: 0,
    type: 'mouse',
    x: 8,
    y: 7,
    buttons: 0,
    down: false,
    pressed: false,
    released: false,
  });
  const [first, second] = ticks.again.pointers;
  expect(first).toMatchObject({ x: 1, y: 1, down: false, pressed: true, released: true });
  expect(second).toMatchObject({ x: 2, y: 2, down: true, pressed: true, released: false });
  expect(second!.id).not.toBe(first!.id);
  expect(ticks.again.pointer).toMatchObject({
    id: second!.id,
    down: true,
    pressed: true,
    released: true,
  });
});

test('an eleventh simultaneous contact is ignored and counted as an input overflow', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    const kit = window.inputKit;
    const recorder = kit.record(engine, () => engine.input.pointers);
    await recorder.next();
    const before = engine.getStats().inputOverflows;
    for (let id = 1; id <= 11; id++) kit.send(canvas, 'pointerdown', id, id, 0);
    const counted = engine.getStats().inputOverflows - before;
    const full = await recorder.next();
    kit.send(canvas, 'pointermove', 11, 3, 3);
    kit.send(canvas, 'pointerup', 11, 3, 3);
    const ignored = await recorder.next();
    for (let id = 1; id <= 10; id++) kit.send(canvas, 'pointerup', id, id, 0);
    await recorder.next();
    kit.send(canvas, 'pointerdown', 11, 5, 5);
    const room = await recorder.next();
    kit.send(canvas, 'pointerup', 11, 5, 5);
    return {
      counted,
      full: full.map(({ x, pressed }) => [x, pressed]),
      ignored: ignored.map(({ x, down, released }) => [x, down, released]),
      room: room.map(({ x, y, pressed }) => [x, y, pressed]),
      total: engine.getStats().inputOverflows - before,
    };
  });
  expect(result.counted).toBe(1);
  expect(result.full).toEqual(Array.from({ length: 10 }, (_, index) => [index + 1, true]));
  expect(result.ignored).toEqual(
    Array.from({ length: 10 }, (_, index) => [index + 1, true, false]),
  );
  expect(result.room).toEqual([[5, 5, true]]);
  expect(result.total).toBe(1);
});

test('cancel and lost capture end a contact; blur, hidden, pause and resize leave nothing held', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    const kit = window.inputKit;
    const input = engine.input;
    const describe = (pointers: readonly PointerSnapshot[]) =>
      pointers.map(
        (p) =>
          `${p.x},${p.y}:${p.down ? 'down' : 'up'}${p.pressed ? '+pressed' : ''}${p.released ? '+released' : ''}`,
      );
    const recorder = kit.record(engine, () => describe(input.pointers));
    const now = () => [describe(input.pointers), input.pointer.down];
    await recorder.next();
    const steps: Record<string, unknown> = {};
    kit.send(canvas, 'pointerdown', 1, 1, 1);
    kit.send(canvas, 'pointerdown', 2, 2, 2);
    steps['down'] = await recorder.next();
    kit.send(canvas, 'pointercancel', 1, 1, 1);
    steps['cancel'] = await recorder.next();
    kit.send(canvas, 'lostpointercapture', 2, 2, 2);
    steps['lost'] = await recorder.next();

    kit.send(canvas, 'pointerdown', 1, 3, 3);
    kit.send(canvas, 'pointerdown', 4, 4, 4);
    await recorder.next();
    window.dispatchEvent(new FocusEvent('blur'));
    steps['blurNow'] = now();
    steps['blurTick'] = await recorder.next();
    kit.send(canvas, 'pointerup', 1, 3, 3);
    steps['upAfterBlur'] = await recorder.next();

    kit.send(canvas, 'pointerdown', 5, 5, 5);
    await recorder.next();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    steps['hidden'] = [engine.state, ...now()];
    delete (document as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    steps['visible'] = [engine.state, await recorder.next()];

    kit.send(canvas, 'pointerdown', 6, 6, 6);
    await recorder.next();
    engine.pause();
    steps['paused'] = now();
    engine.resume();
    steps['resumed'] = await recorder.next();

    // A hovering primary pointer at the corner, then a held contact.
    kit.send(canvas, 'pointermove', 1, 15, 15, { pointerType: 'mouse', buttons: 0 });
    kit.send(canvas, 'pointerdown', 7, 9, 9);
    await recorder.next();
    engine.resize(8, 8);
    steps['resized'] = [...now(), input.pointer.x, input.pointer.y];
    steps['resizedTick'] = await recorder.next();
    return steps;
  });
  expect(result).toEqual({
    down: ['1,1:down+pressed', '2,2:down+pressed'],
    cancel: ['1,1:up+released', '2,2:down'],
    lost: ['2,2:up+released'],
    blurNow: [[], false],
    blurTick: [],
    upAfterBlur: [],
    hidden: ['PAUSED', [], false],
    visible: ['RUNNING', []],
    paused: [[], false],
    resumed: [],
    resized: [[], false, 7, 7],
    resizedTick: [],
  });
});

test('mouse buttons form a bitmask, a hovering mouse moves the primary pointer', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    window.recorder = window.inputKit.record(engine, () => ({
      pointers: engine.input.pointers,
      pointer: engine.input.pointer,
    }));
    await window.recorder.next();
  });
  const box = (await page.locator('canvas').boundingBox())!;
  const at = (x: number, y: number): [number, number] => [
    box.x + ((x + 0.5) * box.width) / 16,
    box.y + ((y + 0.5) * box.height) / 16,
  ];
  const hover = await after<Sample>(page, () => page.mouse.move(...at(3, 9)));
  expect(last(hover).pointers).toEqual([]);
  expect(last(hover).pointer).toEqual({
    id: 0,
    type: 'mouse',
    x: 3,
    y: 9,
    buttons: 0,
    down: false,
    pressed: false,
    released: false,
  });
  const right = await after<Sample>(page, () => page.mouse.down({ button: 'right' }));
  expect(last(right).pointers).toMatchObject([
    { type: 'mouse', x: 3, y: 9, buttons: 2, down: true },
  ]);
  expect(right.filter((sample) => sample.pointers[0]?.pressed)).toHaveLength(1);
  expect(last(right).pointer).toMatchObject({ buttons: 2, down: true });
  const id = last(right).pointers[0]!.id;
  const chord = await after<Sample>(page, async () => {
    await page.mouse.move(...at(4, 9));
    await page.mouse.down({ button: 'left' });
  });
  expect(last(chord).pointers).toMatchObject([
    { id, x: 4, buttons: 3, down: true, pressed: false },
  ]);
  const secondary = await after<Sample>(page, () => page.mouse.up({ button: 'left' }));
  expect(last(secondary).pointers).toMatchObject([{ id, buttons: 2, down: true }]);
  const released = await after<Sample>(page, () => page.mouse.up({ button: 'right' }));
  const end = released.find((sample) => sample.pointers[0]?.released);
  expect(end?.pointers).toEqual([
    { id, type: 'mouse', x: 4, y: 9, buttons: 2, down: false, pressed: false, released: true },
  ]);
  const middle = await after<Sample>(page, () => page.mouse.down({ button: 'middle' }));
  expect(last(middle).pointers).toMatchObject([{ buttons: 4, down: true }]);
  expect(last(middle).pointers[0]!.id).not.toBe(id);
  await page.mouse.up({ button: 'middle' });
});

test('the context menu is suppressed only for a press on the canvas', async ({ page }) => {
  // Trusted right presses open the menu on press in these browsers.
  await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    window.recorder = window.inputKit.record(engine, () => engine.input.pointers);
    window.menus = [];
    document.addEventListener('contextmenu', (event) => window.menus.push(event.defaultPrevented));
  });
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  expect(await page.evaluate(() => window.menus)).toEqual([true]);
  // Synthetic menus cover the paths without a press and the release-time menu (Windows).
  const result = await page.evaluate(async () => {
    // Outlast the release grace of the trusted press above.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const canvas = document.querySelector('canvas')!;
    const kit = window.inputKit;
    const mouse = { pointerType: 'mouse' };
    const menu = () =>
      !canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const idle = menu();
    kit.send(canvas, 'pointerdown', 1, 4, 4, { ...mouse, button: 2, buttons: 2 });
    const held = menu();
    kit.send(canvas, 'pointerup', 1, 4, 4, { ...mouse, button: 2 });
    const onRelease = menu();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const later = menu();
    kit.send(canvas, 'pointerdown', 1, 4, 4, mouse);
    kit.send(canvas, 'pointerup', 1, 4, 4, mouse);
    const afterPrimaryClick = menu();
    return { idle, held, onRelease, later, afterPrimaryClick };
  });
  expect(result).toEqual({
    idle: false,
    held: true,
    onRelease: true,
    later: false,
    afterPrimaryClick: false,
  });
});

test('wheel deltas accumulate per tick in lines and clamp to ±100', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    const recorder = window.inputKit.record(engine, () => engine.input.wheel);
    await recorder.next();
    const wheel = (init: WheelEventInit) =>
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }));
    const PIXEL = 0;
    const LINE = 1;
    const PAGE = 2;
    wheel({ deltaY: 32, deltaMode: PIXEL });
    wheel({ deltaX: -3, deltaY: 1, deltaMode: LINE });
    // A page is one logical screen of 8-pixel lines: 16 / 8 = 2 lines.
    wheel({ deltaY: 1, deltaMode: PAGE });
    wheel({ deltaX: 8, deltaMode: PIXEL });
    const mixed = await recorder.next();
    const quiet = await recorder.next();
    wheel({ deltaY: 100000, deltaMode: PIXEL });
    wheel({ deltaX: -1e9, deltaMode: LINE });
    const clamped = await recorder.next();
    wheel({ deltaY: -3200, deltaMode: PIXEL });
    wheel({ deltaY: -3200, deltaMode: PIXEL });
    const up = await recorder.next();
    engine.resize(16, 80);
    wheel({ deltaY: -1, deltaMode: PAGE });
    const tallPage = await recorder.next();
    return {
      mixed,
      quiet,
      clamped,
      up,
      tallPage,
      frozen: Object.isFrozen(mixed) && Object.isFrozen(quiet),
    };
  });
  expect(result.mixed).toEqual({ x: -2.5, y: 5 });
  expect(result.quiet).toEqual({ x: 0, y: 0 });
  expect(result.clamped).toEqual({ x: -100, y: 100 });
  expect(result.up).toEqual({ x: 0, y: -100 });
  expect(result.tallPage).toEqual({ x: 0, y: -10 });
  expect(result.frozen).toBe(true);
});

test('wheel input prevents page scrolling only while the canvas has focus', async ({ page }) => {
  await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    const spacer = document.createElement('div');
    spacer.style.height = '4000px';
    document.querySelector('main')!.append(spacer);
    window.recorder = window.inputKit.record(engine, () => engine.input.wheel);
    window.wheelDeltas = [];
    document.addEventListener('wheel', (event) => window.wheelDeltas.push(event.deltaY));
    canvas.blur();
  });
  // Cancelable synthetic events show whether the (non-passive) listener prevented them.
  const synthetic = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const wheel = () =>
      !canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 16, bubbles: true, cancelable: true }),
      );
    const unfocused = wheel();
    canvas.focus();
    const focused = wheel();
    canvas.blur();
    window.wheelDeltas.length = 0;
    return { unfocused, focused };
  });
  expect(synthetic).toEqual({ unfocused: false, focused: true });
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => document.querySelector('canvas')!.focus());
  const focused = await after<WheelSnapshot>(page, () => page.mouse.wheel(0, 48));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const deltas = await page.evaluate(() => window.wheelDeltas.splice(0));
  expect(deltas.length).toBeGreaterThan(0);
  const lines = focused.reduce((sum, wheel) => sum + wheel.y, 0);
  expect(lines).toBeCloseTo(deltas.reduce((sum, delta) => sum + delta, 0) / 16, 6);
  expect(lines).toBeGreaterThan(0);
  // Unfocused, the page scrolls; the game still sees the movement.
  await page.evaluate(() => document.querySelector('canvas')!.blur());
  const unfocused = await after<WheelSnapshot>(page, () => page.mouse.wheel(0, 48));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(unfocused.reduce((sum, wheel) => sum + wheel.y, 0)).toBeGreaterThan(0);
});

test.describe('gamepads', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const pads: unknown[] = [];
      Object.defineProperty(window, 'testPads', { value: pads });
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads });
    });
    await open(page);
  });

  test('standard pads report buttons, dead-zoned axes and one-tick edges', async ({ page }) => {
    const ticks = await page.evaluate(async () => {
      const button = (pressed: boolean, value = pressed ? 1 : 0) => ({
        pressed,
        touched: pressed,
        value,
      });
      const pad = {
        index: 0,
        id: 'Test pad (STANDARD GAMEPAD)',
        connected: true,
        mapping: 'standard',
        timestamp: 0,
        buttons: Array.from({ length: 17 }, () => button(false)),
        axes: [0.1, -0.15, 0.575, -1],
      };
      pad.buttons[0] = button(true);
      // Chromium reports analog triggers as pressed from a small depth.
      pad.buttons[7] = button(true, 0.4);
      window.testPads.push(pad);
      const { engine } = await window.createTestEngine();
      const input = engine.input;
      const recorder = window.inputKit.record(engine, () => ({
        pads: input.gamepads,
        a: [input.isButtonDown('A'), input.wasButtonPressed('A'), input.wasButtonReleased('A')],
        rt: [input.isButtonDown('RT'), input.wasButtonPressed('RT'), input.wasButtonReleased('RT')],
        axes: [
          input.axis('leftX'),
          input.axis('leftY'),
          input.axis('rightX'),
          input.axis('rightY'),
        ],
        missing: [
          input.isButtonDown('A', 1),
          input.wasButtonPressed('Start', 3),
          input.axis('leftX', 2),
        ],
      }));
      const appeared = await recorder.next();
      pad.buttons[0] = button(false);
      pad.buttons[7] = button(true, 0.6);
      pad.axes = [1.5, Number.NaN, -0.5, 0.15];
      const changed = await recorder.next();
      const held = await recorder.next();
      pad.buttons[0] = button(true);
      const pressed = await recorder.next();
      engine.pause();
      engine.resume();
      const resumed = await recorder.next();
      pad.connected = false;
      const gone = await recorder.next();
      const snapshot = appeared.pads[0]!;
      const frozen =
        Object.isFrozen(appeared.pads) &&
        Object.isFrozen(snapshot) &&
        Object.isFrozen(snapshot.buttons) &&
        Object.isFrozen(snapshot.axes) &&
        appeared.pads !== changed.pads;
      return { appeared, changed, held, pressed, resumed, gone, frozen };
    });
    const buttons = (...indices: number[]) =>
      Array.from({ length: 17 }, (_, index) => indices.includes(index));
    expect(ticks.appeared.pads).toEqual([
      {
        index: 0,
        id: 'Test pad (STANDARD GAMEPAD)',
        mapping: 'standard',
        buttons: buttons(0),
        axes: ticks.appeared.axes,
      },
    ]);
    // No edges in the first tick a pad appears in; a trigger needs more than half its travel.
    expect(ticks.appeared.a).toEqual([true, false, false]);
    expect(ticks.appeared.rt).toEqual([false, false, false]);
    expect(ticks.appeared.axes[0]).toBe(0);
    expect(ticks.appeared.axes[1]).toBe(0);
    expect(ticks.appeared.axes[2]).toBeCloseTo(0.5, 12);
    expect(ticks.appeared.axes[3]).toBe(-1);
    expect(ticks.appeared.missing).toEqual([false, false, 0]);
    expect(ticks.changed.a).toEqual([false, false, true]);
    expect(ticks.changed.rt).toEqual([true, true, false]);
    expect(ticks.changed.pads[0]!.buttons).toEqual(buttons(7));
    expect(ticks.changed.axes[0]).toBe(1);
    expect(ticks.changed.axes[1]).toBe(0);
    expect(ticks.changed.axes[2]).toBeCloseTo(-0.35 / 0.85, 12);
    expect(ticks.changed.axes[3]).toBe(0);
    expect(ticks.held.a).toEqual([false, false, false]);
    expect(ticks.held.rt).toEqual([true, false, false]);
    expect(ticks.pressed.a).toEqual([true, true, false]);
    // Resuming resets input: a button still held is down without a new press.
    expect(ticks.resumed.a).toEqual([true, false, false]);
    expect(ticks.gone.pads).toEqual([]);
    expect(ticks.gone.a).toEqual([false, false, false]);
    expect(ticks.gone.rt).toEqual([false, false, false]);
    expect(ticks.gone.axes).toEqual([0, 0, 0, 0]);
    expect(ticks.frozen).toBe(true);
  });

  test('several pads, unknown mappings and invalid arguments', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const unknown = {
        index: 1,
        id: `${'Pad '.repeat(40)}\u{1F3AE}`,
        connected: true,
        mapping: '',
        buttons: Array.from({ length: 20 }, (_, index) => ({
          pressed: index === 6 || index === 19,
          value: index === 6 ? 0.2 : 0,
        })),
        axes: [0.5, 0, 0, 0, 1, 1],
      };
      window.testPads.push(
        null,
        unknown,
        { index: 7, id: 'Fifth pad', connected: true, mapping: 'standard', buttons: [], axes: [] },
        { index: 2, id: 'Gone', connected: false, mapping: 'standard', buttons: [], axes: [] },
        // Early implementations exposed buttons as numbers.
        {
          index: 3,
          id: 'Legacy',
          connected: true,
          mapping: 'standard',
          buttons: [1, 0, 0.7],
          axes: [],
        },
      );
      const { engine } = await window.createTestEngine();
      const input = engine.input;
      const recorder = window.inputKit.record(engine, () => ({
        pads: input.gamepads,
        down: [
          input.isButtonDown('LT', 1),
          input.isButtonDown('A', 3),
          input.isButtonDown('X', 3),
          input.isButtonDown('A', 2),
        ],
      }));
      const tick = await recorder.next();
      const codes: string[] = [];
      for (const call of [
        () => input.isButtonDown('Z' as never),
        () => input.isButtonDown('a' as never),
        () => input.wasButtonPressed(undefined as never),
        () => input.isButtonDown('A', 4),
        () => input.wasButtonReleased('A', -1),
        () => input.isButtonDown('A', 0.5),
        () => input.axis('up' as never),
        () => input.axis('leftX', '0' as never),
      ]) {
        try {
          call();
          codes.push('OK');
        } catch (error) {
          codes.push((error as Error & { code: string }).code);
        }
      }
      return { tick, codes };
    });
    const [unknown, legacy] = result.tick.pads as [GamepadSnapshot, GamepadSnapshot];
    expect(result.tick.pads.map((pad) => pad.index)).toEqual([1, 3]);
    expect(unknown.mapping).toBe('unknown');
    expect(unknown.id).toHaveLength(128);
    expect(unknown.id.startsWith('Pad Pad')).toBe(true);
    expect(unknown.buttons).toHaveLength(17);
    // Positions only: the trigger rule is for standard pads.
    expect(
      unknown.buttons.map((pressed, index) => (pressed ? index : -1)).filter((i) => i >= 0),
    ).toEqual([6]);
    expect(unknown.axes).toHaveLength(4);
    expect(unknown.axes[0]).toBeCloseTo(0.35 / 0.85, 12);
    expect(legacy.buttons.slice(0, 3)).toEqual([true, false, true]);
    expect(legacy.axes).toEqual([0, 0, 0, 0]);
    expect(result.tick.down).toEqual([true, true, true, false]);
    expect(result.codes).toEqual([
      'ARGUMENT',
      'ARGUMENT',
      'ARGUMENT',
      'RANGE',
      'RANGE',
      'RANGE',
      'ARGUMENT',
      'RANGE',
    ]);
  });

  test('without a usable Gamepad API the list is empty and nothing fails', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const errors: string[] = [];
      const { engine } = await window.createTestEngine({
        onError: (error) => errors.push(error.message),
      });
      const recorder = window.inputKit.record(engine, () => [
        engine.input.gamepads.length,
        engine.input.isButtonDown('Start'),
        engine.input.axis('rightY'),
      ]);
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: undefined });
      await recorder.next();
      const missing = await recorder.next();
      Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        value: () => {
          throw new DOMException('Blocked by a permissions policy.', 'SecurityError');
        },
      });
      await recorder.next();
      const throwing = await recorder.next();
      return { missing, throwing, state: engine.state, errors };
    });
    expect(result).toEqual({
      missing: [0, false, 0],
      throwing: [0, false, 0],
      state: 'RUNNING',
      errors: [],
    });
  });
});

// Expected CSS sizes for a 16 × 9 framebuffer: parents 300 × 200 (A), 100 × 100
// (B) and 5 × 5 (C, where no whole device pixel per logical pixel fits).
const FITS = {
  1: {
    integerA: [288, 162],
    integerB: [96, 54],
    integerC: [5, 2],
    square: [96, 96],
    fitA: [300, 168],
    fitB: [100, 56],
  },
  2: {
    integerA: [296, 166.5],
    integerB: [96, 54],
    integerC: [5, 2.5],
    square: [100, 100],
    fitA: [300, 168.5],
    fitB: [100, 56],
  },
  3: {
    integerA: [298.6667, 168],
    integerB: [96, 54],
    integerC: [5, 2.6667],
    square: [98.6667, 98.6667],
    fitA: [300, 168.6667],
    fitB: [100, 56],
  },
} as const;

for (const ratio of [1, 2, 3] as const) {
  test.describe(`devicePixelRatio ${ratio}`, () => {
    test.use({ deviceScaleFactor: ratio });

    test("'integer' and 'fit' size the canvas to its parent in device pixels", async ({ page }) => {
      const result = await page.evaluate(async () => {
        const kit = window.inputKit;
        const sizes: Record<string, number[]> = {};
        const a = kit.parent(300, 200);
        const integer = await kit.create({
          canvas: a.canvas,
          width: 16,
          height: 9,
          scaling: 'integer',
        });
        sizes['integerA'] = kit.cssSize(a.canvas);
        const rect = a.canvas.getBoundingClientRect();
        const device = [rect.width * devicePixelRatio, rect.height * devicePixelRatio];
        const resize = async (width: number, height: number) => {
          const before = kit.cssSize(a.canvas);
          a.parent.style.width = `${width}px`;
          a.parent.style.height = `${height}px`;
          return kit.settle(a.canvas, before);
        };
        sizes['integerB'] = await resize(100, 100);
        sizes['integerC'] = await resize(5, 5);
        await resize(100, 100);
        integer.resize(8, 8);
        sizes['square'] = kit.cssSize(a.canvas);
        const b = kit.parent(300, 200);
        await kit.create({ canvas: b.canvas, width: 16, height: 9, scaling: 'fit' });
        sizes['fitA'] = kit.cssSize(b.canvas);
        const before = kit.cssSize(b.canvas);
        b.parent.style.width = '100px';
        b.parent.style.height = '100px';
        sizes['fitB'] = await kit.settle(b.canvas, before);
        return {
          ratio: devicePixelRatio,
          sizes,
          device,
          backing: [a.canvas.width, a.canvas.height, b.canvas.width, b.canvas.height],
          rendering: [a.canvas.style.imageRendering, b.canvas.style.imageRendering],
        };
      });
      expect(result.ratio).toBe(ratio);
      for (const [name, [width, height]] of Object.entries(FITS[ratio])) {
        expect(result.sizes[name]![0], name).toBeCloseTo(width, 3);
        expect(result.sizes[name]![1], name).toBeCloseTo(height, 3);
      }
      // Whole device pixels per logical pixel: k × 16 by k × 9.
      const k = Math.round(result.device[0]! / 16);
      expect(result.device[0]).toBeCloseTo(k * 16, 1);
      expect(result.device[1]).toBeCloseTo(k * 9, 1);
      // The backing store stays at the logical size.
      expect(result.backing).toEqual([8, 8, 16, 9]);
      expect(result.rendering).toEqual(['pixelated', 'pixelated']);
    });
  });
}

test('a devicePixelRatio change fits integer scaling again', async ({ page }) => {
  // Browsers report a ratio change (zoom, another monitor) through a resolution
  // media query. Automation cannot move a window between monitors, and
  // Chromium's emulated ratio changes do not fire the query's change event, so
  // the test controls the ratio and delivers that event itself.
  const result = await page.evaluate(async () => {
    const lists: MediaQueryList[] = [];
    const matchMedia = window.matchMedia;
    window.matchMedia = (query: string) => {
      const list = matchMedia.call(window, query);
      lists.push(list);
      return list;
    };
    let ratio = 1;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => ratio });
    try {
      const kit = window.inputKit;
      const { canvas } = kit.parent(300, 200);
      const engine = await kit.create({ canvas, width: 16, height: 9, scaling: 'integer' });
      const before = kit.cssSize(canvas);
      const queries = [lists.at(-1)!.media];
      ratio = 3;
      lists.at(-1)!.dispatchEvent(new Event('change'));
      const after = kit.cssSize(canvas);
      queries.push(lists.at(-1)!.media);
      await engine.dispose();
      ratio = 2;
      for (const list of lists) list.dispatchEvent(new Event('change'));
      return { before, after, queries, disposed: canvas.getAttribute('style') };
    } finally {
      window.matchMedia = matchMedia;
      delete (window as { devicePixelRatio?: number }).devicePixelRatio;
    }
  });
  expect(result.before).toEqual([288, 162]);
  expect(result.after[0]).toBeCloseTo(298.6667, 3);
  expect(result.after[1]).toBe(168);
  expect(result.queries.map((query) => query.replace(/\s/g, ''))).toEqual([
    '(resolution:1dppx)',
    '(resolution:3dppx)',
  ]);
  // Disposal restored the styles and stopped listening.
  expect(result.disposed).toBeNull();
});

test('a detached canvas is fitted once it is attached to a parent', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const kit = window.inputKit;
    const canvas = document.createElement('canvas');
    canvas.style.width = '10px';
    await kit.create({ canvas, width: 16, height: 9, scaling: 'fit' });
    const detached = canvas.style.width;
    const parent = document.createElement('div');
    parent.style.width = '160px';
    parent.style.height = '120px';
    document.querySelector('main')!.append(parent);
    parent.append(canvas);
    return { detached, attached: await kit.settle(canvas, [10, Number.NaN]) };
  });
  expect(result).toEqual({ detached: '10px', attached: [160, 90] });
});

test("fitting leaves room for the canvas's border and padding with either box-sizing", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const kit = window.inputKit;
    const runs = [];
    for (const boxSizing of ['content-box', 'border-box']) {
      const { canvas } = kit.parent(290, 200);
      canvas.style.border = '4px solid';
      canvas.style.padding = '2px';
      canvas.style.boxSizing = boxSizing;
      await kit.create({ canvas, width: 16, height: 9, scaling: 'integer' });
      const rect = canvas.getBoundingClientRect();
      runs.push({
        css: kit.cssSize(canvas),
        border: [rect.width, rect.height],
        // clientWidth includes the 2 px padding on both sides.
        content: [canvas.clientWidth - 4, canvas.clientHeight - 4],
      });
    }
    return runs;
  });
  // 290 × 200 minus 12 px of border and padding leaves 278 × 188: 17 × (16 × 9).
  expect(result).toEqual([
    { css: [272, 153], border: [284, 165], content: [272, 153] },
    { css: [284, 165], border: [284, 165], content: [272, 153] },
  ]);
});

test('invalid scaling options are rejected before loading', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const found: string[] = [];
    for (const scaling of ['stretch', 3, null, 'FIT']) {
      try {
        await window.createTestEngine({ scaling: scaling as never });
        found.push('OK');
      } catch (error) {
        found.push((error as Error & { code: string }).code);
      }
    }
    return found;
  });
  expect(codes).toEqual(['ARGUMENT', 'ARGUMENT', 'ARGUMENT', 'ARGUMENT']);
});

test('manual scaling maps through object-fit contain and ignores presses in the letterbox', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    // A 256 × 128 box shows the 16 × 16 image at 128 × 128, 64 pixels from the left.
    canvas.style.width = '256px';
    canvas.style.height = '128px';
    canvas.style.objectFit = 'contain';
    window.recorder = window.inputKit.record(engine, () => ({
      pointers: engine.input.pointers,
      pointer: engine.input.pointer,
      overflows: engine.getStats().inputOverflows,
    }));
    await window.recorder.next();
  });
  const box = (await page.locator('canvas').boundingBox())!;
  const at = (x: number, y: number): [number, number] => [
    box.x + 64 + (x + 0.5) * 8,
    box.y + (y + 0.5) * 8,
  ];
  await page.mouse.move(...at(3, 5));
  const press = await after<Sample>(page, () => page.mouse.down());
  expect(last(press).pointers).toMatchObject([{ x: 3, y: 5, down: true, buttons: 1 }]);
  // A captured drag leaving the image is clamped to its edges.
  const left = await after<Sample>(page, () => page.mouse.move(box.x + 10, box.y + 200));
  expect(last(left).pointers).toMatchObject([{ x: 0, y: 15, down: true }]);
  const right = await after<Sample>(page, () => page.mouse.move(box.x + 300, box.y - 20));
  expect(last(right).pointers).toMatchObject([{ x: 15, y: 0, down: true }]);
  const up = await after<Sample>(page, () => page.mouse.up());
  expect(up.find((sample) => sample.pointers[0]?.released)?.pointers).toMatchObject([
    { x: 15, y: 0, down: false, released: true },
  ]);
  // Presses starting in either letterbox margin are not the game's.
  for (const x of [20, 236]) {
    await page.mouse.move(box.x + x, box.y + 64);
    const margin = await after<Sample>(page, () => page.mouse.down());
    await page.mouse.up();
    expect(margin.every((sample) => sample.pointers.length === 0)).toBe(true);
    expect(last(margin).pointer.down).toBe(false);
    expect(last(margin).overflows).toBe(0);
  }
  // The image edge itself belongs to the image.
  await page.mouse.move(...at(15, 15));
  const edge = await after<Sample>(page, () => page.mouse.down());
  await page.mouse.up();
  expect(last(edge).pointers).toMatchObject([{ x: 15, y: 15, down: true }]);
});

test('manual scaling honors cover, object-position, borders and padding', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { engine, canvas } = await window.createTestEngine();
    const kit = window.inputKit;
    const recorder = kit.record(engine, () => engine.input.pointers);
    await recorder.next();
    const rect = () => canvas.getBoundingClientRect();
    const press = async (clientX: number, clientY: number) => {
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 1,
          isPrimary: true,
          clientX,
          clientY,
          bubbles: true,
        }),
      );
      canvas.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 1,
          isPrimary: true,
          clientX,
          clientY,
          bubbles: true,
        }),
      );
      return (await recorder.next()).map(({ x, y }) => [x, y]);
    };
    canvas.style.width = '256px';
    canvas.style.height = '128px';
    // Cover: the image is 256 × 256 and centered, so rows 4–11 are visible.
    canvas.style.objectFit = 'cover';
    const cover = [
      await press(rect().left + 4, rect().top + 4),
      await press(rect().right - 1, rect().bottom - 1),
    ];
    // Contain at the top-left corner: the margin is on the right.
    canvas.style.objectFit = 'contain';
    canvas.style.objectPosition = 'left top';
    const topLeft = [
      await press(rect().left + 20, rect().top + 20),
      await press(rect().left + 200, rect().top + 20),
    ];
    // A 16 px padding and 8 px border around a filled 256 × 256 content box.
    canvas.style.objectFit = 'fill';
    canvas.style.objectPosition = '';
    canvas.style.height = '256px';
    canvas.style.padding = '16px';
    canvas.style.border = '8px solid';
    const framed = [
      await press(rect().left + 12, rect().top + 100),
      await press(rect().left + 24 + 5.5 * 16, rect().top + 24 + 0.5 * 16),
    ];
    return { cover, topLeft, framed };
  });
  expect(result).toEqual({
    cover: [[[0, 4]], [[15, 11]]],
    topLeft: [[[2, 2]], []],
    framed: [[], [[5, 0]]],
  });
});

test('dispose restores inline styles and attributes and removes every listener', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const kit = window.inputKit;
    const runs = [];
    for (const scaling of ['integer', 'fit', 'manual'] as const) {
      const { parent, canvas } = kit.parent(120, 80);
      canvas.style.setProperty('touch-action', 'pan-y', 'important');
      canvas.style.width = '40px';
      canvas.style.setProperty('image-rendering', 'auto');
      canvas.style.border = '1px solid';
      canvas.setAttribute('tabindex', '-1');
      const before = canvas.getAttribute('style');
      const engine = await kit.create({ canvas, width: 16, height: 9, scaling });
      const during = [
        canvas.style.width !== '40px',
        canvas.style.imageRendering,
        canvas.style.touchAction,
        canvas.getAttribute('tabindex'),
      ];
      await engine.dispose();
      const restored = canvas.getAttribute('style') === before;
      const tabindex = canvas.getAttribute('tabindex');
      parent.style.width = '300px';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      canvas.focus();
      const wheelPrevented = !canvas.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true }),
      );
      kit.send(canvas, 'pointerdown', 1, 1, 1, { pointerType: 'mouse', button: 2, buttons: 2 });
      const menuPrevented = !canvas.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      runs.push({
        scaling,
        during,
        restored,
        tabindex,
        untouched: canvas.getAttribute('style') === before,
        wheelPrevented,
        menuPrevented,
      });
    }
    // Attributes absent before creation are absent again after disposal, also
    // when nothing read the style attribute in between (browsers update it lazily).
    const { canvas: bare } = kit.parent(120, 80);
    const engine = await kit.create({ canvas: bare, width: 16, height: 9, scaling: 'fit' });
    const bareDuring = [bare.hasAttribute('style'), bare.hasAttribute('tabindex')];
    await engine.dispose();
    const { canvas: unread } = kit.parent(120, 80);
    await (
      await kit.create({ canvas: unread, width: 16, height: 9, scaling: 'integer' })
    ).dispose();
    return {
      runs,
      bareDuring,
      bareAfter: [bare.hasAttribute('style'), bare.hasAttribute('tabindex')],
      unread: [unread.getAttribute('style'), unread.getAttribute('tabindex')],
    };
  });
  const common = {
    restored: true,
    tabindex: '-1',
    untouched: true,
    wheelPrevented: false,
    menuPrevented: false,
  };
  expect(result.runs).toEqual([
    { scaling: 'integer', during: [true, 'pixelated', 'none', '0'], ...common },
    { scaling: 'fit', during: [true, 'pixelated', 'none', '0'], ...common },
    { scaling: 'manual', during: [false, 'auto', 'none', '0'], ...common },
  ]);
  expect(result.bareDuring).toEqual([true, true]);
  expect(result.bareAfter).toEqual([false, false]);
  expect(result.unread).toEqual([null, null]);
});

test.describe('trusted touch', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Trusted multi-touch needs the DevTools Protocol.',
  );
  test.use({ hasTouch: true });

  test('three trusted touches are three pointers with distinct ids', async ({ page }) => {
    await page.evaluate(async () => {
      const { engine } = await window.createTestEngine();
      window.recorder = window.inputKit.record(engine, () => engine.input.pointers);
      await window.recorder.next();
    });
    const box = (await page.locator('canvas').boundingBox())!;
    const point = (id: number, x: number, y: number) => ({
      id,
      x: box.x + ((x + 0.5) * box.width) / 16,
      y: box.y + ((y + 0.5) * box.height) / 16,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    });
    const cdp = await page.context().newCDPSession(page);
    const touches = [point(0, 1, 1), point(1, 8, 8), point(2, 14, 3)];
    const start = await after<readonly PointerSnapshot[]>(page, () =>
      cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches }),
    );
    const held = last(start);
    expect(held.map(({ type, x, y, down }) => [type, x, y, down])).toEqual([
      ['touch', 1, 1, true],
      ['touch', 8, 8, true],
      ['touch', 14, 3, true],
    ]);
    expect(new Set(held.map(({ id }) => id)).size).toBe(3);
    const moved = await after<readonly PointerSnapshot[]>(page, () =>
      cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [touches[0]!, point(1, 9, 10), touches[2]!],
      }),
    );
    expect(last(moved).map(({ id, x, y }) => [id, x, y])).toEqual([
      [held[0]!.id, 1, 1],
      [held[1]!.id, 9, 10],
      [held[2]!.id, 14, 3],
    ]);
    const ended = await after<readonly PointerSnapshot[]>(page, () =>
      cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    );
    const released = ended.flat().filter((pointer) => pointer.released);
    expect(released.map(({ id }) => id).sort()).toEqual(held.map(({ id }) => id).sort());
    expect(await page.evaluate(() => window.recorder.next())).toEqual([]);
  });
});

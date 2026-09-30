import { expect, test } from '@playwright/test';
import type { Engine, EngineOptions } from '../../packages/core/src/api/types.js';

// Lifecycle contracts for native shells, served under the production CSP.
// Capacitor and Cordova report the app leaving the foreground with `pause` and
// `resume` document events: Android WebView keeps the page visible meanwhile
// (observed with WebView 149 in the Capacitor Android emulator run).

declare global {
  interface Window {
    testEngines: Engine[];
    createTestEngine(
      options?: Partial<EngineOptions>,
    ): Promise<{ engine: Engine; canvas: HTMLCanvasElement }>;
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

test('shell pause and resume events pause the engine and its audio like a hidden page', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { engine } = await window.createTestEngine();
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const settle = async (expected: string) => {
      for (let tries = 0; tries < 100 && engine.audio.capabilities.state !== expected; tries++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return engine.audio.capabilities.state;
    };
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(0);
      },
    });
    await engine.audio.unlock();
    await frame();
    const steps: unknown[] = [];
    document.dispatchEvent(new Event('pause'));
    const frames = engine.getStats().frames;
    await frame();
    await frame();
    steps.push(engine.state, engine.getStats().frames === frames, await settle('suspended'));
    document.dispatchEvent(new Event('resume'));
    steps.push(engine.state, await settle('running'));
    // A manual pause is a separate reason: foreground does not end it.
    engine.pause();
    document.dispatchEvent(new Event('pause'));
    document.dispatchEvent(new Event('resume'));
    steps.push(engine.state);
    engine.resume();
    steps.push(engine.state);
    // A resume without a pause changes nothing; after disposal the events are ignored.
    document.dispatchEvent(new Event('resume'));
    steps.push(engine.state);
    await engine.dispose();
    document.dispatchEvent(new Event('pause'));
    document.dispatchEvent(new Event('resume'));
    steps.push(engine.state);
    return steps;
  });
  expect(result).toEqual([
    'PAUSED',
    true,
    'suspended',
    'RUNNING',
    'running',
    'PAUSED',
    'RUNNING',
    'RUNNING',
    'DISPOSED',
  ]);
});

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';

async function hud(page) {
  return page.evaluate(() => {
    const number = (id) => Number(document.getElementById(id).textContent.replaceAll(',', ''));
    return {
      score: number('score-count'),
      lives: number('lives-count'),
      level: number('level-count'),
      pellets: number('pellets-count'),
      status: document.getElementById('game-status').textContent.trim(),
    };
  });
}

async function ready(page) {
  await page.locator('#game-state').filter({ hasText: 'RUNNING' }).waitFor();
  await page.locator('#game-status').filter({ hasText: 'READY' }).waitFor();
  await page.waitForFunction(
    () => Number(document.getElementById('frame-stat').textContent.replaceAll(',', '')) > 0,
  );
  const state = await hud(page);
  assert.equal(state.score, 0);
  assert.equal(state.lives, 3);
  assert.equal(state.level, 1);
  assert.ok(state.pellets > 50, 'A new maze must contain collectible pellets.');
  return state;
}

async function firstViewport(page) {
  const geometry = await page.locator('#game').evaluate((canvas) => {
    const box = canvas.getBoundingClientRect();
    return {
      x: box.x,
      y: box.y,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      pageWidth: document.documentElement.scrollWidth,
      scrollY,
    };
  });
  assert.equal(
    geometry.scrollY,
    0,
    'Initial game visibility must not rely on programmatic scrolling.',
  );
  assert.ok(
    geometry.width >= 224 && geometry.height >= 256,
    'The maze must remain legible at native size or larger.',
  );
  assert.ok(
    geometry.x >= 0 &&
      geometry.y >= 0 &&
      geometry.right <= geometry.viewportWidth &&
      geometry.bottom <= geometry.viewportHeight,
    'The complete game canvas must be visible in the initial viewport.',
  );
  assert.ok(
    geometry.pageWidth <= geometry.viewportWidth,
    'The page must not overflow horizontally.',
  );
  return geometry;
}

// Observe presented canvas pixels through browser APIs, never model state or WASM views.
async function renderedBoard(page) {
  return page.evaluate(
    () =>
      new Promise((resolveFrame) => {
        requestAnimationFrame(() => {
          const canvas = document.getElementById('game');
          const { width, height } = canvas;
          const gl = canvas.getContext('webgl2');
          let pixels;
          if (gl) {
            const bottomUp = new Uint8Array(width * height * 4);
            pixels = new Uint8Array(bottomUp.length);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
            for (let y = 0; y < height; y += 1)
              pixels.set(
                bottomUp.subarray((height - y - 1) * width * 4, (height - y) * width * 4),
                y * width * 4,
              );
          } else pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
          const colors = new Set();
          const yellow = new Uint8Array(width * height);
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              const i = (y * width + x) * 4;
              colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]},${pixels[i + 3]}`);
              // Original yellow sprite, within its initial horizontal corridor.
              if (
                x >= 60 &&
                x <= 160 &&
                y >= 190 &&
                y <= 202 &&
                pixels[i] === 255 &&
                pixels[i + 1] === 220 &&
                pixels[i + 2] === 128 &&
                pixels[i + 3] === 255
              ) {
                yellow[y * width + x] = 1;
              }
            }
          }
          // Pellets share the player's palette index. Identify the connected
          // sprite instead of mixing its position with nearby two-pixel dots.
          let playerPixels = 0;
          let sumX = 0;
          for (let start = 0; start < yellow.length; start += 1) {
            if (!yellow[start]) continue;
            const pending = [start];
            yellow[start] = 0;
            let count = 0;
            let componentX = 0;
            while (pending.length) {
              const pixel = pending.pop();
              const x = pixel % width;
              count += 1;
              componentX += x;
              for (const neighbor of [pixel - 1, pixel + 1, pixel - width, pixel + width]) {
                if (neighbor >= 0 && neighbor < yellow.length && yellow[neighbor]) {
                  yellow[neighbor] = 0;
                  pending.push(neighbor);
                }
              }
            }
            if (count > playerPixels) {
              playerPixels = count;
              sumX = componentX;
            }
          }
          resolveFrame({
            width,
            height,
            colors: colors.size,
            playerPixels,
            playerCenterX: playerPixels ? sumX / playerPixels : null,
          });
        });
      }),
  );
}

async function restart(page, expectedPellets) {
  await page.locator('#restart-game').click();
  const state = await ready(page);
  assert.equal(state.pellets, expectedPellets);
  return state;
}

async function collect(page) {
  await page.waitForFunction(
    () => Number(document.getElementById('score-count').textContent.replaceAll(',', '')) > 0,
  );
  const state = await hud(page);
  assert.ok(state.score > 0);
  assert.equal(state.lives, 3);
  assert.equal(state.status, 'PLAYING');
  return state;
}

export async function verifyPacmanDesktop(page) {
  const initial = await ready(page);
  const viewport = await firstViewport(page);
  await page.waitForTimeout(800);
  assert.deepEqual(
    await hud(page),
    initial,
    'READY must not consume lives, pellets, or time before input.',
  );
  const before = await renderedBoard(page);
  assert.equal(before.width, 224);
  assert.equal(before.height, 256);
  assert.ok(
    before.colors >= 6,
    'The WASM-rendered board must contain the maze, pellets, player, and ghosts.',
  );
  assert.ok(before.playerPixels >= 10, 'The visible yellow player must be present.');

  await page.locator('#game').focus();
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(320);
  await page.keyboard.up('ArrowLeft');
  const arrow = await collect(page);
  const moved = await renderedBoard(page);
  assert.ok(arrow.pellets < initial.pellets);
  assert.ok(
    moved.playerPixels >= 10 && moved.playerCenterX < before.playerCenterX - 3,
    'Arrow input must move the visible player left, not only update the HUD.',
  );

  await page.locator('#pause-game').click();
  await page.locator('#game-state').filter({ hasText: 'PAUSED' }).waitFor();
  const paused = await hud(page);
  await page.waitForTimeout(350);
  assert.deepEqual(
    await hud(page),
    paused,
    'Pause must freeze score, lives, pellets, and game state.',
  );
  await page.locator('#pause-game').click();
  await page.locator('#game-state').filter({ hasText: 'RUNNING' }).waitFor();

  await restart(page, initial.pellets);
  await page.locator('#game').focus();
  await page.keyboard.down('d');
  await page.waitForTimeout(320);
  await page.keyboard.up('d');
  const wasd = await collect(page);
  assert.ok(wasd.pellets < initial.pellets);

  await restart(page, initial.pellets);
  await page.locator('[data-direction="left"]').click();
  const directionButton = await collect(page);
  await restart(page, initial.pellets);
  await page.locator('#dispose-game').click();
  await page.locator('#game-state').filter({ hasText: 'DISPOSED' }).waitFor();
  assert.equal(await page.locator('#memory-stat').textContent(), 'Released');
  await restart(page, initial.pellets);
  await page.evaluate(() => window.scrollTo(0, 0));
  return {
    viewport,
    initial,
    renderedBoard: before,
    movedBoard: moved,
    arrowScore: arrow.score,
    wasdScore: wasd.score,
    directionButtonScore: directionButton.score,
    idleMilliseconds: 800,
    pauseMilliseconds: 350,
    restart: 'reset score, lives, level, and pellets',
    dispose: 'released and restarted',
  };
}

export async function verifyPacmanMobile(page, cdpSession) {
  const initial = await ready(page);
  const viewport = await firstViewport(page);
  await page.waitForTimeout(400);
  assert.deepEqual(await hud(page), initial);
  await page.locator('[data-direction="left"]').tap();
  const touchButton = await collect(page);
  await restart(page, initial.pellets);
  let swipe = {
    status: 'not executed',
    reason:
      'Playwright exposes continuous trusted touch dispatch only through Chromium CDP in this harness.',
  };
  if (cdpSession) {
    await page.locator('#game').evaluate((canvas) => {
      canvas.dataset.testTrustedTouch = 'false';
      canvas.addEventListener(
        'pointerup',
        (event) => {
          canvas.dataset.testTrustedTouch = String(
            event.isTrusted && event.pointerType === 'touch',
          );
        },
        { once: true },
      );
    });
    const box = await page.locator('#game').boundingBox();
    assert.ok(box);
    const y = box.y + box.height / 2;
    const point = (x) => ({ x, y, id: 1, radiusX: 5, radiusY: 5, force: 1 });
    await cdpSession.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point(box.x + box.width * 0.75)],
    });
    try {
      for (let step = 1; step <= 5; step += 1) {
        await cdpSession.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [point(box.x + box.width * (0.75 - step * 0.1))],
        });
        await page.waitForTimeout(16);
      }
    } finally {
      await cdpSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    assert.equal(
      await page.locator('#game').getAttribute('data-test-trusted-touch'),
      'true',
      'The swipe must use trusted browser touch input.',
    );
    const afterSwipe = await collect(page);
    swipe = { status: 'passed', trusted: true, score: afterSwipe.score };
    await page.locator('#game').evaluate((canvas) => {
      delete canvas.dataset.testTrustedTouch;
    });
    await restart(page, initial.pellets);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return { viewport, initial, touchButtonScore: touchButton.score, swipe, physicalDevice: false };
}

async function captureViewport(page, response, browserName, path) {
  if (browserName === 'webkit' && response.headers()['content-security-policy']) {
    // Playwright's WebKit screenshot preparation unconditionally injects
    // <style>body {}</style> to synchronize animations, even with caret:'initial'.
    // Preserve the site's CSP and all error assertions; use the other engines'
    // screenshots while still running WebKit's complete gameplay checks.
    return {
      status: 'skipped',
      reason:
        'Playwright WebKit screenshot preparation injects inline CSS blocked by the site CSP.',
    };
  }
  await page.screenshot({ path, caret: 'initial' });
  return { status: 'captured' };
}

async function main() {
  const baseURL = new URL(process.argv[2] ?? 'http://127.0.0.1:4175/');
  const output = new URL('../artifacts/pacman-browser/', import.meta.url);
  await mkdir(output, { recursive: true });
  const results = [];
  for (const [name, type, options] of [
    [
      'chromium',
      chromium,
      process.env.PIXELJS_USE_BUNDLED_CHROMIUM === '1' ? {} : { channel: 'chrome' },
    ],
    ['firefox', firefox, {}],
    ['webkit', webkit, {}],
  ]) {
    const browser = await type.launch(options);
    try {
      const errors = [];
      const wasm = [];
      const observe = (page) => {
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error' && /content security|violat|refused/i.test(message.text()))
            errors.push(message.text());
        });
        page.on('response', (response) => {
          if (new URL(response.url()).pathname.endsWith('.wasm'))
            wasm.push({
              url: response.url(),
              status: response.status(),
              mime: response.headers()['content-type'],
            });
        });
      };
      const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      observe(desktop);
      const desktopResponse = await desktop.goto(baseURL.href);
      assert.equal(desktopResponse.status(), 200);
      const desktopResult = await verifyPacmanDesktop(desktop);
      const desktopScreenshot = await captureViewport(
        desktop,
        desktopResponse,
        name,
        new URL(`${name}-desktop.png`, output).pathname,
      );
      await desktop.close();
      const mobile = await browser.newPage({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: name !== 'firefox',
      });
      observe(mobile);
      const mobileResponse = await mobile.goto(baseURL.href);
      assert.equal(mobileResponse.status(), 200);
      const cdp = name === 'chromium' ? await mobile.context().newCDPSession(mobile) : null;
      const mobileResult = await verifyPacmanMobile(mobile, cdp);
      const mobileScreenshot = await captureViewport(
        mobile,
        mobileResponse,
        name,
        new URL(`${name}-mobile.png`, output).pathname,
      );
      await mobile.close();
      assert.ok(
        wasm.some(
          (binary) => binary.status === 200 && binary.mime?.split(';')[0] === 'application/wasm',
        ),
      );
      assert.deepEqual(errors, [], 'No runtime or CSP errors are expected.');
      results.push({
        browser: name,
        version: browser.version(),
        desktop: desktopResult,
        mobile: mobileResult,
        screenshotCapture: { desktop: desktopScreenshot, mobile: mobileScreenshot },
        wasm,
        errors,
      });
      console.log(
        `${name} ${browser.version()}: Pac-Man render, idle, input, pause, restart, disposal, first viewport, and touch buttons passed; continuous swipe ${mobileResult.swipe.status}`,
      );
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    new URL('report.json', output),
    `${JSON.stringify({ url: baseURL.href, checkedAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();

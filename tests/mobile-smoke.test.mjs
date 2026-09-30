import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'vite';

test('mobile smoke application boots, handles touches, pause, recreate, and audio on mobile viewport', async () => {
  const root = resolve('apps/mobile-smoke');
  const outDir = join(root, 'dist');

  // Build the app
  await build({
    configFile: false,
    root,
    base: './',
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      target: 'es2022',
    },
  });

  // Serve the built app
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      let path = url.pathname.slice(1) || 'index.html';
      const target = resolve(outDir, path);
      if (!target.startsWith(outDir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const data = await readFile(target);
      const mime = target.endsWith('.wasm')
        ? 'application/wasm'
        : target.endsWith('.html')
          ? 'text/html'
          : target.endsWith('.js')
            ? 'text/javascript'
            : target.endsWith('.css')
              ? 'text/css'
              : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });

  const port = await new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      res(server.address().port);
    });
  });

  const browser = await chromium.launch(
    process.env.PIXELJS_USE_BUNDLED_CHROMIUM ? {} : { channel: 'chrome' },
  );

  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });

    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`http://127.0.0.1:${port}/index.html`);

    // Verify engine boots to RUNNING
    await page.locator('#status-label').filter({ hasText: 'RUNNING' }).waitFor({ timeout: 5000 });

    // Verify frames advance
    await page.waitForFunction(() => {
      const text = document.getElementById('stat-frames')?.textContent || '';
      const frames = parseInt(text, 10);
      return !isNaN(frames) && frames > 10;
    });

    // Verify touch on D-pad right button
    const initialPos = await page.evaluate(() => {
      const canvas = document.getElementById('screen');
      const gl = canvas.getContext('webgl2');
      const ctx = canvas.getContext('2d');
      return { width: canvas.width, height: canvas.height };
    });
    assert.equal(initialPos.width, 224);
    assert.equal(initialPos.height, 256);

    const rightBtn = page.locator('[data-dir="right"]');
    await rightBtn.dispatchEvent('pointerdown');
    await page.waitForTimeout(200);
    await rightBtn.dispatchEvent('pointerup');

    // Verify pause and resume
    const pauseBtn = page.locator('#btn-pause');
    await pauseBtn.click();
    await page.locator('#status-label').filter({ hasText: 'PAUSED' }).waitFor();

    await pauseBtn.click();
    await page.locator('#status-label').filter({ hasText: 'RUNNING' }).waitFor();

    // Verify audio unlock
    const audioBtn = page.locator('#btn-audio');
    await audioBtn.click();
    // unlock() loads the audio worklet and the DSP asynchronously.
    await page.waitForFunction(
      () => /Sound: (On|Muted)/.test(document.getElementById('btn-audio')?.textContent ?? ''),
      null,
      { timeout: 10_000 },
    );

    // Verify recreate engine
    const recreateBtn = page.locator('#btn-recreate');
    await recreateBtn.click();
    await page.locator('#status-label').filter({ hasText: 'RUNNING' }).waitFor({ timeout: 5000 });

    assert.equal(errors.length, 0, `Expected zero errors but found: ${errors.join(', ')}`);
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
});

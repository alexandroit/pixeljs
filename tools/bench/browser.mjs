// Browser benchmarks, orchestrated from Node with Playwright: B01 (full
// pipeline and cold start), B06, B07 (the game with music and bursts on the
// real AudioWorklet), B09, B11 and B12 (real AudioWorklet). Pages come from a
// temporary site served by tools/serve.mjs under the production CSP and the
// production caching headers, with the packaged runtime at the site root and
// under a nested path.
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { chromium, firefox, webkit } from '@playwright/test';
import {
  ROOT,
  aggregate,
  check,
  compact,
  finishResult,
  median,
  row,
  scaled,
  slope,
  summarize,
} from './common.mjs';
import { fixturePng } from './png.mjs';

const SITE_SOURCES = join(ROOT, 'tools/bench/site');
const INSTRUMENT = join(ROOT, 'tools/bench/instrument.mjs');

// -----------------------------------------------------------------------------
// Site, server and browser
// -----------------------------------------------------------------------------

/** A deployable site: the game at / and at /games/demo/, the bench page and fixtures. */
export async function buildSite() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pixeljs-bench-site-')));
  for (const base of ['', 'games/demo/']) {
    await mkdir(join(dir, base), { recursive: true });
    await cp(join(ROOT, 'packages/core/dist'), join(dir, base, 'pixeljs'), { recursive: true });
    await cp(join(SITE_SOURCES, 'game.html'), join(dir, base, 'index.html'));
    await cp(join(SITE_SOURCES, 'game.mjs'), join(dir, base, 'game.mjs'));
    await cp(join(SITE_SOURCES, 'scene.mjs'), join(dir, base, 'scene.mjs'));
  }
  await mkdir(join(dir, 'bench/assets'), { recursive: true });
  await cp(join(SITE_SOURCES, 'bench.html'), join(dir, 'bench/index.html'));
  await cp(join(SITE_SOURCES, 'bench.mjs'), join(dir, 'bench/bench.mjs'));
  await cp(join(SITE_SOURCES, 'fixtures'), join(dir, 'bench/fixtures'), { recursive: true });
  const assets = [];
  for (const size of [16, 64, 256, 1024]) {
    const bytes = fixturePng(size, size, size);
    await writeFile(join(dir, `bench/assets/sprite-${size}.png`), bytes);
    assets.push({ size, bytes: bytes.length, url: `/bench/assets/sprite-${size}.png` });
  }
  return { dir, assets, remove: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Starts tools/serve.mjs with the production CSP, caching headers and a
 * response log; `isolate` adds COOP/COEP for finer timers (not production).
 */
export async function startServer(root, port, { isolate = false } = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs')], {
    env: {
      ...process.env,
      PIXELJS_SERVE_ROOT: root,
      PORT: String(port),
      PIXELJS_SERVE_CSP: 'production',
      PIXELJS_SERVE_CACHE: 'production',
      PIXELJS_SERVE_LOG: '1',
      ...(isolate ? { PIXELJS_SERVE_ISOLATE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const log = [];
  let buffer = '';
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tools/serve.mjs did not start.')), 15000);
    child.once('exit', (code) => reject(new Error(`tools/serve.mjs exited with ${code}.`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      buffer += text;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.startsWith('{')) log.push(JSON.parse(line));
        const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      }
    });
  });
  let sentinels = 0;
  return {
    origin,
    log,
    /** Resolves once every response logged before this call has been read. */
    async sync() {
      const path = `/__bench-sentinel/${++sentinels}`;
      await new Promise((resolve, reject) =>
        get(`${origin}${path}`, (response) => response.resume().on('end', resolve)).on(
          'error',
          reject,
        ),
      );
      for (let wait = 0; wait < 400 && !log.some((entry) => entry.path === path); wait++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      return log.findIndex((entry) => entry.path === path);
    },
    stop: () => child.kill(),
  };
}

export async function launchBrowser(name, { headed }) {
  const types = { chromium, firefox, webkit };
  const options = { headless: !headed };
  if (name === 'chromium') {
    if (!process.env.PIXELJS_USE_BUNDLED_CHROMIUM) options.channel = 'chrome';
    // Unbucketed performance.memory values (Chromium only; still approximate).
    options.args = ['--enable-precise-memory-info'];
  }
  const browser = await types[name].launch(options);
  const browserSession = name === 'chromium' ? await browser.newBrowserCDPSession() : null;
  return {
    name,
    browser,
    browserSession,
    version: browser.version(),
    launch: {
      channel: options.channel ?? 'bundled',
      headless: options.headless,
      args: options.args ?? [],
    },
  };
}

async function newContext(runner) {
  const context = await runner.browser.newContext();
  await context.addInitScript({ path: INSTRUMENT });
  return context;
}

/** Opens the benchmark page in a fresh context with error and warning capture. */
async function openBench(runner) {
  const context = await newContext(runner);
  const page = await context.newPage();
  const errors = [];
  const warnings = { webglContexts: 0, csp: 0 };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (/too many active webgl contexts/i.test(text)) warnings.webglContexts++;
    if (/content security policy/i.test(text)) warnings.csp++;
    if (message.type() === 'error' && !/favicon/.test(message.location().url ?? ''))
      errors.push(text);
  });
  await page.goto(`${runner.origin}/bench/`);
  await page.waitForFunction(() => typeof window.bench === 'object');
  // A real click gives the page user activation, as a player's first input would.
  await page.mouse.click(4, 4);
  const cdp = runner.name === 'chromium' ? await context.newCDPSession(page) : null;
  if (cdp) await cdp.send('Performance.enable');
  return { context, page, cdp, errors, warnings, close: () => context.close() };
}

/** Renderer process RSS summed over renderer processes (OS view, approximate). */
function rendererRss(pids) {
  if (!pids.length) return null;
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    return (
      out
        .split('\n')
        .map(Number)
        .filter((value) => value > 0)
        .reduce((a, b) => a + b, 0) * 1024
    );
  } catch {
    return null;
  }
}

async function rendererPids(runner) {
  if (!runner.browserSession) return [];
  const { processInfo } = await runner.browserSession.send('SystemInfo.getProcessInfo');
  return processInfo.filter((entry) => entry.type === 'renderer').map((entry) => entry.id);
}

/** Chromium DevTools memory and object counts, optionally after a forced full GC. */
async function memory(runner, cdp, { gc = true } = {}) {
  if (!cdp) return null;
  if (gc) await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const metrics = Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((metric) => [metric.name, metric.value]),
  );
  return {
    heapUsed: heap.usedSize,
    heapTotal: heap.totalSize,
    listeners: metrics.JSEventListeners ?? null,
    nodes: metrics.Nodes ?? null,
    documents: metrics.Documents ?? null,
    arrayBuffers: metrics.ArrayBufferContents ?? null,
    audioHandlers: metrics.AudioHandlers ?? null,
    rss: rendererRss(await rendererPids(runner)),
  };
}

const idFor = (runner, id) => (runner.name === 'chromium' ? id : `${id}-${runner.name}`);
const titleFor = (runner, title) => `${title} (${runner.name} ${runner.version})`;
const runtimeFor = (runner) =>
  `${runner.name} ${runner.version} via Playwright (${runner.launch.headless ? 'headless' : 'headed'}, channel ${runner.launch.channel}), GPU "${runner.info?.glRenderer ?? 'unknown'}"; pages served by tools/serve.mjs with the production CSP and caching headers`;
const flat = (runs, key) => runs.flatMap((run) => run[key]);
const perRun = (runs, key) => aggregate(runs.map((run) => summarize(run[key])));

/** Engine CPU per frame: SDK recording in draw() plus submission and presentation. */
const engineCpu = (run) => run.draw.map((value, index) => value + (run.engine[index] ?? 0));

// -----------------------------------------------------------------------------
// Startup loads (B01 cold start and B09)
// -----------------------------------------------------------------------------

function category(path) {
  if (path.endsWith('/engine.wasm')) return 'engine.wasm';
  if (path.endsWith('/audio.wasm')) return 'audio.wasm';
  if (path.endsWith('/processor.js')) return 'worklet';
  if (path.includes('favicon')) return 'favicon';
  if (path.endsWith('/') || path.endsWith('.html')) return 'html';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'js';
  return 'other';
}

/** Loads the game page once in `context`; with `audio`, clicks the sound button. */
async function measureLoad(runner, context, url, audio) {
  const page = await context.newPage();
  const errors = [];
  let csp = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) csp++;
    if (message.type() === 'error' && !/favicon/.test(message.location().url ?? ''))
      errors.push(message.text());
  });
  const logStart = runner.server.log.length;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    () =>
      window.pixeljsGame?.marks['first-frame'] !== undefined ||
      window.pixeljsGame?.marks.failed !== undefined,
    null,
    { timeout: 30000 },
  );
  if (audio) {
    await page.click('[data-audio]');
    await page.waitForFunction(() => window.pixeljsGame.marks['unlock-end'] !== undefined, null, {
      timeout: 30000,
    });
  }
  const data = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const probe = window.__pixeljsBench;
    return {
      marks: window.pixeljsGame.marks,
      pageErrors: window.pixeljsGame.errors,
      renderer: window.pixeljsGame.renderer,
      audio: window.pixeljsGame.audio,
      navigation: navigation && {
        responseEnd: navigation.responseEnd,
        domContentLoaded: navigation.domContentLoadedEventEnd,
        type: navigation.type,
      },
      resources: performance.getEntriesByType('resource').map((entry) => ({
        path: new URL(entry.name).pathname,
        start: entry.startTime,
        end: entry.responseEnd,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
      })),
      wasm: probe?.wasm ?? [],
      audioContexts: probe?.audioContexts.length ?? 0,
    };
  });
  const end = await runner.server.sync();
  const served = runner.server.log
    .slice(logStart, end)
    .filter((entry) => !entry.path.startsWith('/__bench-sentinel/'));
  await page.close();
  const bytes = {};
  const statuses = {};
  for (const entry of served) {
    const kind = category(entry.path);
    bytes[kind] = (bytes[kind] ?? 0) + entry.bytes;
    statuses[`${kind} ${entry.status}`] = (statuses[`${kind} ${entry.status}`] ?? 0) + 1;
  }
  const engineFetch = data.resources.find((entry) => entry.path.endsWith('/engine.wasm'));
  const marks = data.marks;
  return {
    url,
    audio,
    ok:
      marks['first-frame'] !== undefined &&
      errors.length === 0 &&
      data.pageErrors.length === 0 &&
      csp === 0,
    errors: [...errors, ...data.pageErrors],
    csp,
    renderer: data.renderer,
    audioState: data.audio,
    audioContexts: data.audioContexts,
    firstFrameMs: marks['first-frame'] ?? null,
    htmlMs: data.navigation?.responseEnd ?? null,
    moduleMs: marks.module ?? null,
    createMs: marks['create-end'] - marks['create-start'],
    engineFetchMs: engineFetch ? engineFetch.end - engineFetch.start : null,
    instantiateMs: data.wasm[0]?.ms ?? null,
    unlockMs: audio ? marks['unlock-end'] - marks['unlock-start'] : null,
    served,
    bytes,
    statuses,
    paths: served.map((entry) => entry.path),
  };
}

/** Cold: a fresh context (empty HTTP cache). Warm: a second page in the same context. */
async function coldAndWarm(runner, url, audio) {
  const context = await newContext(runner);
  try {
    const cold = await measureLoad(runner, context, url, audio);
    const warm = await measureLoad(runner, context, url, audio);
    return { cold, warm };
  } finally {
    await context.close();
  }
}

// -----------------------------------------------------------------------------
// B01: the character/HUD scene in the full browser pipeline, and cold start
// -----------------------------------------------------------------------------

function phaseRows(label, runs, { cpuTarget = true } = {}) {
  const rows = [
    row({
      scenario: `${label}: engine CPU (draw recording + submit + present)`,
      metric: 'ms per frame',
      stats: aggregate(runs.map((run) => summarize(engineCpu(run)))),
      target: cpuTarget ? { op: '<=', limit: 4, text: 'p95 ≤ 4 ms (engine CPU, desktop)' } : null,
    }),
    row({
      scenario: `${label}: update() game logic`,
      metric: 'ms per call',
      stats: perRun(runs, 'update'),
    }),
    row({
      scenario: `${label}: draw() SDK recording`,
      metric: 'ms per frame',
      stats: perRun(runs, 'draw'),
    }),
    row({
      scenario: `${label}: submit + present after draw()`,
      metric: 'ms per frame',
      stats: perRun(runs, 'engine'),
    }),
  ];
  if (flat(runs, 'submit').length) {
    rows.push(
      row({
        scenario: `${label}: C submission (WebGL split)`,
        metric: 'ms per frame',
        stats: perRun(runs, 'submit'),
      }),
    );
    rows.push(
      row({
        scenario: `${label}: WebGL upload + draw call (CPU)`,
        metric: 'ms per frame',
        stats: perRun(runs, 'present'),
      }),
    );
  }
  if (flat(runs, 'gpu').length)
    rows.push(
      row({
        scenario: `${label}: GPU time (timer query)`,
        metric: 'ms per frame',
        stats: perRun(runs, 'gpu'),
      }),
    );
  rows.push(
    row({
      scenario: `${label}: frame interval (rAF)`,
      metric: 'ms',
      stats: perRun(runs, 'interval'),
    }),
  );
  return rows;
}

const droppedFrames = (runs) => {
  const intervals = flat(runs, 'interval');
  const typical = median(intervals);
  return {
    typical,
    long: intervals.filter((value) => value > typical * 1.5).length,
    total: intervals.length,
  };
};

export async function runB01Browser(runner, settings) {
  const steady = {};
  const pageErrors = [];
  for (const renderer of ['webgl2', 'canvas2d']) {
    const session = await openBench(runner);
    try {
      steady[renderer] = await session.page.evaluate((options) => window.bench.steady(options), {
        renderer,
        warmupMs: settings.warmupMs,
        sampleMs: settings.sampleMs,
        runs: settings.runs,
      });
      pageErrors.push(...session.errors);
    } finally {
      await session.close();
    }
  }
  // Cold start: fresh contexts load the game page at the site root, audio off.
  const loads = [];
  const warmEnd = Date.now() + settings.warmupMs;
  do await coldAndWarm(runner, `${runner.origin}/`, false);
  while (Date.now() < warmEnd);
  const perRunLoads = scaled(settings, 10, 3, 1);
  for (let run = 0; run < settings.runs; run++)
    for (let index = 0; index < perRunLoads; index++) {
      const context = await newContext(runner);
      try {
        loads.push({ run, ...(await measureLoad(runner, context, `${runner.origin}/`, false)) });
      } finally {
        await context.close();
      }
    }
  const loadStats = (key) =>
    aggregate(
      Array.from({ length: settings.runs }, (_, run) =>
        summarize(
          loads.filter((load) => load.run === run && load[key] !== null).map((load) => load[key]),
        ),
      ),
    );
  const webgl = steady.webgl2;
  const canvas = steady.canvas2d;
  const dropped = droppedFrames(webgl.runs);
  const checks = [
    check(
      'WebGL2 variant renders with WebGL2',
      webgl.renderer === 'webgl2',
      webgl.renderer,
      'webgl2',
    ),
    check(
      'Canvas2D variant renders with Canvas2D',
      canvas.renderer === 'canvas2d',
      canvas.renderer,
      'canvas2d',
    ),
    check(
      'Steady frames make no C allocations',
      webgl.allocations.before === webgl.allocations.after &&
        canvas.allocations.before === canvas.allocations.after,
      `webgl2 ${webgl.allocations.before}→${webgl.allocations.after}, canvas2d ${canvas.allocations.before}→${canvas.allocations.after}`,
      'unchanged',
    ),
    check(
      'No engine or page errors',
      webgl.errors.length + canvas.errors.length + pageErrors.length === 0,
      [...webgl.errors, ...canvas.errors, ...pageErrors].join('; ') || 'none',
      'none',
    ),
    check(
      'Every cold load reached its first frame without errors or CSP violations',
      loads.every((load) => load.ok),
      `${loads.filter((load) => load.ok).length} of ${loads.length}`,
      `${loads.length} of ${loads.length}`,
    ),
  ];
  return finishResult({
    id: idFor(runner, 'B01'),
    title: titleFor(runner, '256 × 144 character/HUD scene: full pipeline and cold start'),
    runtime: runtimeFor(runner),
    measures: [
      'The same scene as the core B01 (tools/bench/site/scene.mjs) through the public API in a running engine: update() game logic, draw() (SDK argument validation and command recording), then the engine’s own work after draw() returns (C validation and rasterization, then presentation), timed to the microtask that runs when the frame callback returns.',
      'With WebGL2, the frame’s first texSubImage2D splits C submission from presentation (texture upload and draw-call submission); GPU execution time comes from EXT_disjoint_timer_query_webgl2 where the browser exposes it (disjoint samples discarded). Canvas2D reports submit + present together (its present includes palette expansion and putImageData).',
      'Frame intervals from requestAnimationFrame timestamps, and cold start: a fresh browser context (empty HTTP cache) loads the game page at the site root; time from navigation start to the first submitted frame, with createEngine, the engine.wasm fetch and WebAssembly instantiation.',
    ],
    excludes: [
      'WebGL call time is CPU submission, not GPU completion; the GPU row is the timer-query measurement and is absent where the extension is not exposed. Compositor and display latency are not measured.',
      'Frame intervals are paced by the display/compositor (headless Chromium runs at about 60 Hz), so they show dropped frames rather than cost.',
      'Cold start here keeps the browser process, GPU process and their shader caches warm; it is not a first launch after boot. See B09 for bytes, warm cache and the nested path.',
      'performance.now() is clamped by the browser (Chromium: 100 µs unless the page is cross-origin isolated, 5 µs with --isolate); per-frame percentiles are multiples of the resolution listed under Environment, while means over many frames are far less affected by it.',
    ],
    rows: [
      ...phaseRows('WebGL2', webgl.runs),
      ...phaseRows('Canvas2D', canvas.runs),
      row({
        scenario: 'Cold start: navigation to first frame',
        metric: 'ms',
        stats: loadStats('firstFrameMs'),
      }),
      row({ scenario: 'Cold start: createEngine()', metric: 'ms', stats: loadStats('createMs') }),
      row({
        scenario: 'Cold start: engine.wasm fetch',
        metric: 'ms',
        stats: loadStats('engineFetchMs'),
      }),
      row({
        scenario: 'Cold start: WebAssembly.instantiate (compile + instantiate)',
        metric: 'ms',
        stats: loadStats('instantiateMs'),
      }),
    ],
    checks,
    observations: {
      'GPU timer query available': webgl.gpuTimer,
      'WebGL2 intervals longer than 1.5 × the median interval': `${dropped.long} of ${dropped.total} (median ${dropped.typical.toFixed(2)} ms)`,
      'Frames rendered (WebGL2 / Canvas2D)': `${webgl.stats.frames} / ${canvas.stats.frames}`,
      'Dropped update backlog (WebGL2 / Canvas2D)': `${webgl.stats.droppedUpdates} / ${canvas.stats.droppedUpdates}`,
      'Cold loads measured': loads.length,
    },
    raw: {
      sampleUnit: 'ms',
      steady: Object.fromEntries(
        Object.entries(steady).map(([name, result]) => [
          name,
          {
            ...result,
            runs: result.runs.map((run) =>
              Object.fromEntries(
                Object.entries(run).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? compact(value) : value,
                ]),
              ),
            ),
          },
        ]),
      ),
      coldLoads: loads,
    },
  });
}

// -----------------------------------------------------------------------------
// B06: 1,000 create/load/start/dispose cycles with cancellations
// -----------------------------------------------------------------------------

const EXPECTED = {
  full: (cycle) => cycle.outcome === 'DISPOSED' && cycle.nativeRestored === true,
  audio: (cycle) =>
    cycle.outcome === 'DISPOSED' &&
    cycle.nativeRestored === true &&
    cycle.audioBefore === 'running' &&
    cycle.audioAfter === 'disposed',
  abortCreate: (cycle) => cycle.outcome === 'ABORTED' || cycle.outcome === 'created before abort',
  abortLoad: (cycle) =>
    (cycle.outcome === 'ABORTED' || cycle.outcome === 'loaded before abort') &&
    cycle.nativeRestored === true &&
    cycle.disposed === 'DISPOSED',
  disposeDuringLoad: (cycle) => cycle.outcome === 'STATE' && cycle.disposed === 'DISPOSED',
};

export async function runB06(runner, settings, site) {
  const total = scaled(settings, 1000, 200, 20);
  const chunk = scaled(settings, 100, 50, 10);
  const png = site.assets.find((asset) => asset.size === 16).url;
  const bigPng = site.assets.find((asset) => asset.size === 1024).url;
  const runs = [];
  for (let run = 0; run < settings.runs; run++) {
    const session = await openBench(runner);
    try {
      const lifecycle = (from, to) =>
        session.page.evaluate((options) => window.bench.lifecycle(options), {
          from,
          to,
          png,
          bigPng,
        });
      const warmEnd = Date.now() + settings.warmupMs;
      let warm = 0;
      do await lifecycle(warm, (warm += 10));
      while (Date.now() < warmEnd);
      const checkpoints = [
        {
          cycle: 0,
          page: await session.page.evaluate(() => window.bench.observe()),
          memory: await memory(runner, session.cdp),
        },
      ];
      const cycles = [];
      for (let from = 0; from < total; from += chunk) {
        const to = Math.min(total, from + chunk);
        const result = await lifecycle(from, to);
        cycles.push(...result.cycles);
        checkpoints.push({
          cycle: to,
          page: result.observation,
          memory: await memory(runner, session.cdp),
        });
      }
      // AudioContexts close in the background after dispose(): allow a moment.
      await session.page.waitForTimeout(1000);
      const final = {
        cycle: total,
        page: await session.page.evaluate(() => window.bench.observe()),
        memory: await memory(runner, session.cdp),
      };
      // Attribution (Chromium): cycles of one kind at a time between two
      // forced-GC snapshots, so retention can be assigned to a cycle kind.
      const attribution = {};
      if (session.cdp) {
        const count = scaled(settings, 50, 20, 5);
        for (const only of ['full', 'audio']) {
          const before = await memory(runner, session.cdp);
          const result = await session.page.evaluate((options) => window.bench.lifecycle(options), {
            from: 0,
            to: count,
            png,
            bigPng,
            only,
          });
          await session.page.waitForTimeout(1000);
          const after = await memory(runner, session.cdp);
          attribution[only] = {
            count,
            unexpected: result.cycles.filter((cycle) => !EXPECTED[cycle.kind](cycle)).length,
            listeners: (after.listeners - before.listeners) / count,
            nodes: (after.nodes - before.nodes) / count,
            audioHandlers: (after.audioHandlers - before.audioHandlers) / count,
            heapBytes: (after.heapUsed - before.heapUsed) / count,
          };
        }
      }
      runs.push({
        cycles,
        checkpoints,
        final,
        attribution,
        warnings: { ...session.warnings },
        errors: [...session.errors],
      });
    } finally {
      await session.close();
    }
  }
  const all = runs.flatMap((run) => run.cycles);
  const unexpected = all.filter((cycle) => !EXPECTED[cycle.kind](cycle));
  const byKind = (kind) =>
    aggregate(
      runs.map((run) =>
        summarize(run.cycles.filter((cycle) => cycle.kind === kind).map((cycle) => cycle.ms)),
      ),
    );
  const outcomes = {};
  for (const cycle of all)
    outcomes[`${cycle.kind}: ${cycle.outcome}`] =
      (outcomes[`${cycle.kind}: ${cycle.outcome}`] ?? 0) + 1;
  const cdp = runs[0].final.memory !== null;
  // Leak trend: JS heap after a forced GC at each checkpoint, first checkpoint excluded.
  const heapSlopes = runs.map((run) => {
    const points = run.checkpoints.slice(1);
    return slope(
      points.map((point) => point.cycle),
      points.map((point) => point.memory?.heapUsed ?? NaN),
    );
  });
  const rssSlopes = runs.map((run) => {
    const points = run.checkpoints.slice(1);
    return slope(
      points.map((point) => point.cycle),
      points.map((point) => point.memory?.rss ?? NaN),
    );
  });
  const listenerDelta = Math.max(
    ...runs.map(
      (run) => (run.final.memory?.listeners ?? 0) - (run.checkpoints[0].memory?.listeners ?? 0),
    ),
  );
  const nodeDelta = Math.max(
    ...runs.map((run) => (run.final.memory?.nodes ?? 0) - (run.checkpoints[0].memory?.nodes ?? 0)),
  );
  const openAudio = Math.max(...runs.map((run) => run.final.page.audio.open));
  const canvases = Math.max(
    ...runs.map((run) => run.final.page.canvases - run.checkpoints[0].page.canvases),
  );
  const webglCreated = runs.map(
    (run) => run.final.page.contexts.webgl2 - run.checkpoints[0].page.contexts.webgl2,
  );
  const rows = [
    row({
      scenario: 'Full cycle: create, load PNG, start, 2 frames, release, dispose',
      metric: 'ms per cycle',
      stats: byKind('full'),
    }),
    row({
      scenario: 'Full cycle with audio unlock',
      metric: 'ms per cycle',
      stats: byKind('audio'),
    }),
    row({
      scenario: 'createEngine() aborted',
      metric: 'ms per cycle',
      stats: byKind('abortCreate'),
    }),
    row({
      scenario: 'loadImage() aborted, then dispose',
      metric: 'ms per cycle',
      stats: byKind('abortLoad'),
    }),
    row({
      scenario: 'dispose() during loadImage()',
      metric: 'ms per cycle',
      stats: byKind('disposeDuringLoad'),
    }),
  ];
  if (cdp) {
    rows.push(
      row({
        scenario: 'JS heap trend after forced GC (worst repetition)',
        metric: 'bytes per cycle',
        unit: 'bytes',
        stats: { value: Math.max(...heapSlopes) },
        target: { op: '<=', limit: 1024, text: '≤ 1 KiB per cycle (no leak trend)' },
      }),
      row({
        scenario: 'Renderer RSS trend (worst repetition, OS view)',
        metric: 'bytes per cycle',
        unit: 'bytes',
        stats: { value: Math.max(...rssSlopes) },
      }),
    );
  }
  const checks = [
    check(
      'Every cycle ended as expected',
      unexpected.length === 0,
      unexpected.length
        ? `${unexpected.length} unexpected: ${[...new Set(unexpected.map((cycle) => `${cycle.kind} ${cycle.outcome}`))].slice(0, 5).join(', ')}`
        : `${all.length} cycles`,
      'no unexpected outcome',
    ),
    check(
      'Released images return the accounted C bytes (native ownership)',
      all.filter((cycle) => 'nativeRestored' in cycle).every((cycle) => cycle.nativeRestored),
      `${all.filter((cycle) => cycle.nativeRestored === false).length} mismatches`,
      '0',
    ),
    check(
      'Every AudioContext is closed or collected after dispose',
      openAudio === 0,
      `${openAudio} open`,
      '0',
    ),
    check('No canvas is left in the document', canvases <= 0, `${canvases} extra`, '0'),
    check(
      'No page errors or CSP violations',
      runs.every((run) => run.errors.length === 0 && run.warnings.csp === 0),
      runs
        .flatMap((run) => run.errors)
        .slice(0, 3)
        .join('; ') || 'none',
      'none',
    ),
  ];
  if (cdp) {
    // Per cycle, after a forced GC: nothing may stay reachable (≤ 1 per 20 cycles is noise).
    const retained = (kind) => {
      const worst = (key) => Math.max(...runs.map((run) => run.attribution[kind][key]));
      return {
        listeners: worst('listeners'),
        nodes: worst('nodes'),
        audioHandlers: worst('audioHandlers'),
      };
    };
    const describe = (values) =>
      `${values.listeners.toFixed(2)} listeners, ${values.nodes.toFixed(2)} DOM nodes, ${values.audioHandlers.toFixed(2)} audio nodes per cycle`;
    const plain = retained('full');
    const audio = retained('audio');
    checks.push(
      check(
        'Disposed engines without audio stay unreachable (listeners, DOM nodes)',
        plain.listeners <= 0.05 && plain.nodes <= 0.05,
        describe(plain),
        '≤ 0.05 per cycle',
      ),
      check(
        'Disposed engines that unlocked audio stay unreachable (listeners, DOM nodes)',
        audio.listeners <= 0.05 && audio.nodes <= 0.05,
        describe(audio),
        '≤ 0.05 per cycle',
      ),
    );
  }
  return finishResult({
    id: idFor(runner, 'B06'),
    title: titleFor(
      runner,
      `${total.toLocaleString('en-US')} create/load/start/dispose cycles with cancellations`,
    ),
    runtime: runtimeFor(runner),
    measures: [
      `Per repetition, ${total.toLocaleString('en-US')} cycles in one page through the public API, in a fixed rotation: 6/10 full cycles (createEngine, loadImage of a 16 × 16 PNG, start, two frames, release, dispose), 1/10 with audio unlocked and a note played, 1/10 createEngine aborted with an AbortController (immediately, after a task or after 5 ms), 1/10 loadImage of a 1024 × 1024 PNG aborted the same ways, 1/10 dispose() while that PNG loads. Renderers alternate between auto (WebGL2) and Canvas2D.`,
      'Time per cycle by kind; the outcome of every cycle against its expected outcome.',
      'Native: the accounted C bytes after releasing the image equal those before loading it. Host: canvases left in the document, JS event listeners and DOM nodes (Chromium DevTools counters after a forced GC). GPU: WebGL2 contexts created and the browser’s “too many active WebGL contexts” warnings. Audio: AudioContexts left open after dispose. Memory: JS heap after a forced GC at each checkpoint, its trend per cycle, and renderer RSS from the OS.',
      'Attribution (Chromium): after the mixed cycles, a batch of full cycles and then a batch of audio cycles, each between forced-GC snapshots, give the JS listeners, DOM nodes and audio nodes still reachable per cycle of each kind.',
    ],
    excludes: [
      'dispose() does not promise to return WebAssembly memory to the OS; the RSS trend is reported, not gated. performance.memory and DevTools counters are Chromium-only and approximate.',
      'The engine does not call WEBGL_lose_context on dispose, so WebGL contexts of removed canvases live until garbage collection; the warning count shows how often the browser had to evict them.',
    ],
    rows,
    checks,
    observations: {
      Outcomes: outcomes,
      'JS event listeners / DOM nodes after GC, end minus start (worst repetition)': cdp
        ? `${listenerDelta >= 0 ? '+' : ''}${listenerDelta} / ${nodeDelta >= 0 ? '+' : ''}${nodeDelta}`
        : 'not available outside Chromium',
      'Retention per cycle by kind (last repetition)': cdp
        ? runs.at(-1).attribution
        : 'not available outside Chromium',
      'WebGL2 contexts created per repetition': webglCreated.join(', '),
      '“Too many active WebGL contexts” warnings per repetition': runs
        .map((run) => run.warnings.webglContexts)
        .join(', '),
      'AudioContexts created / closed / collected (last repetition)': (() => {
        const audio = runs.at(-1).final.page.audio;
        return `${audio.created} / ${audio.closed} / ${audio.collected}`;
      })(),
      ...(cdp
        ? {
            'JS heap after GC, start → end (last repetition)': `${runs.at(-1).checkpoints[0].memory.heapUsed} → ${runs.at(-1).final.memory.heapUsed} bytes`,
            'Renderer RSS, start → end (last repetition)': `${runs.at(-1).checkpoints[0].memory.rss} → ${runs.at(-1).final.memory.rss} bytes`,
            'JS heap trend per repetition (bytes/cycle)': heapSlopes
              .map((value) => value.toFixed(1))
              .join(', '),
          }
        : { 'Memory counters': 'not available outside Chromium' }),
    },
    raw: { runs },
  });
}

// -----------------------------------------------------------------------------
// B07: the game with four-track music and event bursts on the real AudioWorklet
// -----------------------------------------------------------------------------

/** Batch acknowledgement latency and batches in flight from the transport records. */
function transportStats(records) {
  const acked = new Map();
  for (const [time, type, epoch, sequence] of records?.acks ?? [])
    if (type === 'ack') acked.set(`${epoch}:${sequence}`, time);
  const latencies = [];
  const timeline = [];
  let batches = 0;
  let maxEvents = 0;
  let maxBytes = 0;
  for (const [time, type, epoch, sequence, events, , bytes] of records?.posts ?? []) {
    if (type !== 'batch') continue;
    batches++;
    maxEvents = Math.max(maxEvents, events);
    maxBytes = Math.max(maxBytes, bytes);
    timeline.push([time, 1]);
    const ack = acked.get(`${epoch}:${sequence}`);
    if (ack !== undefined) {
      latencies.push(ack - time);
      timeline.push([ack, -1]);
    }
  }
  timeline.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let inFlight = 0;
  let maxInFlight = 0;
  for (const [, change] of timeline) {
    inFlight += change;
    maxInFlight = Math.max(maxInFlight, inFlight);
  }
  return {
    latencies,
    batches,
    unacknowledged: batches - latencies.length,
    maxInFlight,
    maxEvents,
    maxJsonBytes: maxBytes,
  };
}

export async function runB07Browser(runner, settings) {
  const session = await openBench(runner);
  let result;
  try {
    result = await session.page.evaluate((options) => window.bench.steady(options), {
      renderer: 'webgl2',
      warmupMs: settings.warmupMs,
      sampleMs: settings.sampleMs,
      runs: settings.runs,
      audio: true,
      burstEvery: scaled(settings, 30, 30, 5),
    });
    result.pageErrors = [...session.errors];
  } finally {
    await session.close();
  }
  const audio = result.audio;
  const transport = transportStats(audio.transport);
  const dropped = droppedFrames(result.runs);
  const context = audio.contexts.last;
  return finishResult({
    id: idFor(runner, 'B07'),
    title: titleFor(
      runner,
      'Four voices with event bursts and four-track music while the game renders',
    ),
    runtime: runtimeFor(runner),
    measures: [
      `The B01 scene rendering with WebGL2 while audio runs on the real AudioWorklet: a looping four-track piece (a note every step, vibrato/slide/fadeout) and, every ${scaled(settings, 30, 30, 5)} updates, a burst of four multi-note sounds (8 notes at 400 BPM) and twelve single notes, i.e. 16 play() calls, more than the four batch credits.`,
      'Engine CPU per frame with audio active, the update() cost including bursts, the burst alone, CAPACITY rejections, and the transport as seen from the main thread: acknowledgement latency per batch (post to ACK), batches in flight and batch sizes (JSON length as a proxy).',
      'AudioContext state, sample rate and latencies as reported by the browser.',
    ],
    excludes: [
      'Audio-thread render time, deadline misses and audible glitches: Chromium exposes no playout statistics here (AudioContext.playoutStats is absent), so glitches are not observable; the DSP cost per quantum is measured in the Node B07.',
      'Headless Chromium mutes output (--mute-audio); the audio graph still runs.',
    ],
    rows: [
      ...phaseRows('With audio', result.runs),
      row({
        scenario: 'Burst of 16 play() calls',
        metric: 'ms per burst',
        stats: perRun(result.runs, 'burst'),
      }),
      row({
        scenario: 'Batch ACK latency (post → ACK)',
        metric: 'ms',
        stats: aggregate([summarize(transport.latencies)]),
      }),
      row({
        scenario: 'Batches in flight (max)',
        metric: 'count',
        unit: 'count',
        stats: { value: transport.maxInFlight },
        target: { op: '<=', limit: 4, text: '≤ 4 credits' },
      }),
      row({
        scenario: 'play() rejected with CAPACITY',
        metric: 'count',
        unit: 'count',
        stats: { value: audio.capacity },
        target: { op: '==', limit: 0, text: '0 under this load' },
      }),
    ],
    checks: [
      check('Audio is running at the end', audio.state === 'running', audio.state, 'running'),
      check(
        'Music is still playing',
        audio.musicPlaying === true,
        String(audio.musicPlaying),
        'true',
      ),
      check(
        'Steady frames make no C allocations',
        result.allocations.before === result.allocations.after,
        `${result.allocations.before}→${result.allocations.after}`,
        'unchanged',
      ),
      check(
        'No engine or page errors',
        result.errors.length + result.pageErrors.length === 0,
        [...result.errors, ...result.pageErrors].join('; ') || 'none',
        'none',
      ),
      check(
        'Every batch was acknowledged',
        transport.unacknowledged <= 4,
        `${transport.unacknowledged} unacknowledged at the end`,
        '≤ 4 (the last credits)',
      ),
    ],
    observations: {
      'Bursts / plays': `${audio.bursts} / ${audio.plays}`,
      'Batches posted / max events per batch / max JSON bytes': `${transport.batches} / ${transport.maxEvents} / ${transport.maxJsonBytes}`,
      AudioContext: context
        ? `${context.state}, ${context.sampleRate} Hz, baseLatency ${context.baseLatency}, outputLatency ${context.outputLatency}, playoutStats ${context.playoutStats ? JSON.stringify(context.playoutStats) : 'not exposed'}`
        : 'none',
      'Intervals longer than 1.5 × the median': `${dropped.long} of ${dropped.total}`,
    },
    raw: {
      ...result,
      runs: result.runs.map((run) =>
        Object.fromEntries(
          Object.entries(run).map(([key, value]) => [
            key,
            Array.isArray(value) ? compact(value) : value,
          ]),
        ),
      ),
    },
  });
}

// -----------------------------------------------------------------------------
// B09: audio off vs lazy activation, cold/warm cache, root and nested path
// -----------------------------------------------------------------------------

async function compressedSize(site, paths) {
  let gzip = 0;
  let brotli = 0;
  let raw = 0;
  for (const path of new Set(paths)) {
    const bytes = await readFile(join(site.dir, path));
    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
    brotli += brotliCompressSync(bytes, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
  }
  return { raw, gzip, brotli };
}

export async function runB09(runner, settings, site) {
  const cells = [];
  for (const base of ['/', '/games/demo/'])
    for (const audio of [false, true]) cells.push({ base, audio });
  const samples = [];
  const warmEnd = Date.now() + settings.warmupMs;
  do await coldAndWarm(runner, `${runner.origin}/`, false);
  while (Date.now() < warmEnd);
  const perRunLoads = scaled(settings, 10, 3, 1);
  for (let run = 0; run < settings.runs; run++)
    for (let index = 0; index < perRunLoads; index++)
      // Rotate the cell order so drift does not favour one cell.
      for (let offset = 0; offset < cells.length; offset++) {
        const cell = cells[(index + run + offset) % cells.length];
        const { cold, warm } = await coldAndWarm(
          runner,
          `${runner.origin}${cell.base}`,
          cell.audio,
        );
        samples.push({ run, base: cell.base, audio: cell.audio, cache: 'cold', ...cold });
        samples.push({ run, base: cell.base, audio: cell.audio, cache: 'warm', ...warm });
      }
  const select = (base, audio, cache) =>
    samples.filter(
      (sample) => sample.base === base && sample.audio === audio && sample.cache === cache,
    );
  const stat = (list, key) =>
    aggregate(
      Array.from({ length: settings.runs }, (_, run) =>
        summarize(
          list
            .filter((sample) => sample.run === run && sample[key] !== null)
            .map((sample) => sample[key]),
        ),
      ),
    );
  const label = (base, audio, cache) =>
    `${cache}, ${base === '/' ? 'root /' : 'nested /games/demo/'}, audio ${audio ? 'unlocked' : 'off'}`;
  const rows = [];
  for (const base of ['/', '/games/demo/'])
    for (const cache of ['cold', 'warm'])
      for (const audio of [false, true])
        rows.push(
          row({
            scenario: `First frame: ${label(base, audio, cache)}`,
            metric: 'ms from navigation',
            stats: stat(select(base, audio, cache), 'firstFrameMs'),
          }),
        );
  for (const cache of ['cold', 'warm'])
    rows.push(
      row({
        scenario: `Audio unlock (click → running): ${cache}, root`,
        metric: 'ms',
        stats: stat(select('/', true, cache), 'unlockMs'),
      }),
    );
  const coldOff = select('/', false, 'cold');
  const typicalBytes = (list, kinds) =>
    median(
      list.map((sample) => kinds.reduce((total, kind) => total + (sample.bytes[kind] ?? 0), 0)),
    );
  const runtimePaths = coldOff[0]?.paths.filter((path) => path.startsWith('/pixeljs/')) ?? [];
  const compressed = await compressedSize(site, runtimePaths);
  const audioPaths =
    select('/', true, 'cold')[0]?.paths.filter((path) =>
      /\/(audio\.wasm|processor\.js)$/.test(path),
    ) ?? [];
  const audioCompressed = await compressedSize(site, audioPaths);
  rows.push(
    row({
      scenario: 'Cold, audio off: bytes before the first frame (served, uncompressed)',
      metric: 'bytes',
      unit: 'bytes',
      stats: { value: typicalBytes(coldOff, ['html', 'js', 'engine.wasm', 'other']) },
    }),
    row({
      scenario: 'Warm, audio off: body bytes (304 revalidation)',
      metric: 'bytes',
      unit: 'bytes',
      stats: {
        value: typicalBytes(select('/', false, 'warm'), ['html', 'js', 'engine.wasm', 'other']),
      },
    }),
    row({
      scenario: 'Cold unlock: audio bytes (audio.wasm + processor.js)',
      metric: 'bytes',
      unit: 'bytes',
      stats: { value: typicalBytes(select('/', true, 'cold'), ['audio.wasm', 'worklet']) },
    }),
    row({
      scenario: 'Runtime JS + WASM before the first frame, brotli 11 (computed)',
      metric: 'bytes',
      unit: 'bytes',
      stats: { value: compressed.brotli },
      target: { op: '<=', limit: 1024 * 1024, text: '≤ 1 MiB compressed (visual runtime target)' },
    }),
  );
  const offSamples = samples.filter((sample) => !sample.audio);
  const onSamples = samples.filter((sample) => sample.audio);
  const nested = samples.filter((sample) => sample.base === '/games/demo/');
  const escaped = nested.flatMap((sample) =>
    sample.paths.filter((path) => !path.startsWith('/games/demo/') && category(path) !== 'favicon'),
  );
  const warmEngine = samples
    .filter((sample) => sample.cache === 'warm')
    .map((sample) => sample.statuses['engine.wasm 304'] ?? 0);
  const checks = [
    check(
      'Every load reached its first frame without errors or CSP violations',
      samples.every((sample) => sample.ok),
      `${samples.filter((sample) => sample.ok).length} of ${samples.length}`,
      `${samples.length} of ${samples.length}`,
    ),
    check(
      'Audio off: no AudioContext and no audio bytes',
      offSamples.every(
        (sample) =>
          sample.audioContexts === 0 &&
          !sample.bytes['audio.wasm'] &&
          !sample.bytes.worklet &&
          !sample.paths.some((path) => /audio\.wasm|processor\.js/.test(path)),
      ),
      `${offSamples.filter((sample) => sample.audioContexts > 0 || sample.paths.some((path) => /audio\.wasm|processor\.js/.test(path))).length} loads touched audio`,
      '0 loads',
    ),
    check(
      'Lazy activation: audio runs after the click',
      onSamples.every((sample) => sample.audioState === 'running'),
      [...new Set(onSamples.map((sample) => sample.audioState))].join(', '),
      'running',
    ),
    check(
      'Nested deployment requests stay under /games/demo/',
      escaped.length === 0,
      escaped.length ? [...new Set(escaped)].join(', ') : 'none outside',
      'none outside',
    ),
    check(
      'Warm loads revalidate engine.wasm with 304',
      warmEngine.every((count) => count === 1),
      `${warmEngine.filter((count) => count === 1).length} of ${warmEngine.length}`,
      `${warmEngine.length} of ${warmEngine.length}`,
    ),
  ];
  return finishResult({
    id: idFor(runner, 'B09'),
    title: titleFor(
      runner,
      'Startup: audio off vs lazy activation, cold/warm cache, root and nested path',
    ),
    runtime: runtimeFor(runner),
    measures: [
      'The game page (tools/bench/site/game.html, the B01 scene) deployed at / and at /games/demo/ with the packaged runtime beside it and relative imports. Each sample: a fresh browser context loads the page (cold: empty HTTP cache), then a second page in the same context loads it again (warm). With audio, Playwright clicks the page’s sound button (a real user gesture) after the first frame.',
      'Time from navigation start to the first submitted frame, the unlock time from click to a running AudioContext, and the bytes the server sent per resource kind (body bytes from the server log, headers excluded), with the HTTP statuses.',
      'The served runtime files needed before the first frame, compressed locally with brotli (quality 11) and gzip (level 9), against the 1 MiB compressed target.',
      'The server answers like the production Nginx site: `Cache-Control: no-cache, no-transform` with ETag/Last-Modified and 304 revalidation, and the production CSP.',
    ],
    excludes: [
      'Network latency and bandwidth (loopback), TLS and HTTP/2; tools/serve.mjs sends uncompressed bodies, so transfer sizes are uncompressed and the compressed sizes are computed, not transferred.',
      'Audio startup happens after the first frame by design; the unlock time includes the audio.wasm download, the worklet module and the processor handshake, but not audible output (headless Chromium mutes output).',
      'Cold here means an empty HTTP cache in a running browser; the browser and GPU processes are already warm.',
    ],
    rows,
    checks,
    observations: {
      'Loads measured': samples.length,
      'Runtime files before the first frame (root, cold)': runtimePaths.join(', '),
      'Runtime size raw / gzip / brotli': `${compressed.raw} / ${compressed.gzip} / ${compressed.brotli} bytes`,
      'Audio files raw / gzip / brotli (after unlock)': `${audioCompressed.raw} / ${audioCompressed.gzip} / ${audioCompressed.brotli} bytes`,
      'Typical HTTP statuses, warm load': JSON.stringify(
        select('/', false, 'warm')[0]?.statuses ?? {},
      ),
      'createEngine() cold / warm (median of p50s)': `${stat(select('/', false, 'cold'), 'createMs').p50.toFixed(2)} / ${stat(select('/', false, 'warm'), 'createMs').p50.toFixed(2)} ms`,
    },
    raw: { samples },
  });
}

// -----------------------------------------------------------------------------
// B11: image upload/decode/publication during play
// -----------------------------------------------------------------------------

export async function runB11(runner, settings, site) {
  const session = await openBench(runner);
  const assets = site.assets.filter((asset) => asset.size >= 64);
  const options = {
    warmupMs: settings.warmupMs,
    sampleMs: settings.sampleMs,
    runs: settings.runs,
    concurrency: 2,
    assets,
    cancelEvery: 5,
    createEveryMs: scaled(settings, 500, 500, 50),
    cancellations: scaled(settings, 50, 20, 5),
  };
  const series = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling && session.cdp) {
      const snapshot = await memory(runner, session.cdp, { gc: false }).catch(() => null);
      if (snapshot) series.push({ t: Date.now(), heapUsed: snapshot.heapUsed, rss: snapshot.rss });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  let result;
  try {
    result = await session.page.evaluate((opts) => window.bench.uploads(opts), options);
  } finally {
    sampling = false;
    await sampler;
    await session.close();
  }
  const baselineIntervals = aggregate(result.baseline.map((run) => summarize(run.interval)));
  const loadedIntervals = aggregate(result.loaded.map((run) => summarize(run.interval)));
  const bySize = (list, size) =>
    aggregate(
      Array.from({ length: settings.runs }, (_, run) =>
        summarize(
          list.filter((entry) => entry.run === run && entry.size === size).map((entry) => entry.ms),
        ),
      ),
    );
  const long = (runs, typical) =>
    runs.flatMap((run) => run.interval).filter((value) => value > typical * 2).length;
  const typical = median(result.baseline.flatMap((run) => run.interval));
  const failedLoads = result.loads.filter((load) => load.outcome !== 'OK');
  const badCancels = result.cancels.filter(
    (cancel) => cancel.outcome !== 'ABORTED' && cancel.outcome !== 'completed first',
  );
  const expectedSlots = 256;
  const rows = [
    row({
      scenario: 'Frame interval, no loads (baseline)',
      metric: 'ms',
      stats: baselineIntervals,
    }),
    row({
      scenario: 'Frame interval during loads and uploads',
      metric: 'ms',
      stats: loadedIntervals,
    }),
    row({
      scenario: 'Frame interval p95 ratio, loads / baseline',
      metric: 'ratio',
      unit: '×',
      stats: { value: loadedIntervals.p95 / baselineIntervals.p95 },
      target: { op: '<=', limit: 1.25, text: 'p95 ratio ≤ 1.25' },
    }),
    row({
      scenario: 'Engine CPU per frame during loads',
      metric: 'ms per frame',
      stats: aggregate(result.loaded.map((run) => summarize(engineCpu(run)))),
      target: { op: '<=', limit: 4, text: 'p95 ≤ 4 ms (engine CPU, desktop)' },
    }),
    ...assets.map((asset) =>
      row({
        scenario: `loadImage() ${asset.size} × ${asset.size} PNG (${asset.bytes} bytes)`,
        metric: 'ms to published',
        stats: bySize(result.loads, asset.size),
      }),
    ),
    row({
      scenario: 'Cancellation: abort() to rejection',
      metric: 'ms',
      stats: aggregate([summarize(result.cancels.map((cancel) => cancel.ms))]),
    }),
    row({
      scenario: 'createImage() 1024 × 1024 between frames (synchronous)',
      metric: 'ms per call',
      stats: aggregate([summarize(result.creates.map((create) => create.ms))]),
    }),
    row({
      scenario: 'Peak performance.memory during loads (Chromium, precise flag)',
      metric: 'bytes',
      unit: 'bytes',
      stats: {
        value: result.peaks.some((peak) => peak.heap === null)
          ? NaN
          : Math.max(...result.peaks.map((peak) => peak.heap)),
      },
    }),
    row({
      scenario: 'Peak accounted C bytes (coreBytes)',
      metric: 'bytes',
      unit: 'bytes',
      stats: { value: Math.max(...result.peaks.map((peak) => peak.coreBytes)) },
    }),
  ];
  if (series.length) {
    rows.push(
      row({
        scenario: 'Peak JS heap sampled via DevTools every 250 ms',
        metric: 'bytes',
        unit: 'bytes',
        stats: { value: Math.max(...series.map((point) => point.heapUsed)) },
      }),
    );
    if (series.some((point) => point.rss))
      rows.push(
        row({
          scenario: 'Peak renderer RSS (OS view)',
          metric: 'bytes',
          unit: 'bytes',
          stats: { value: Math.max(...series.map((point) => point.rss ?? 0)) },
        }),
      );
  }
  const cancelOutcomes = {};
  for (const cancel of result.cancels) {
    const key = `abort ${cancel.wait < 0 ? 'at once' : `after ${cancel.wait} ms`}: ${cancel.outcome}`;
    cancelOutcomes[key] = (cancelOutcomes[key] ?? 0) + 1;
  }
  return finishResult({
    id: idFor(runner, 'B11'),
    title: titleFor(runner, 'Upload, decode and publication during play; cancellation and limits'),
    runtime: runtimeFor(runner),
    measures: [
      'The B01 scene renders (WebGL2) while two loadImage() calls are always in flight, cycling 64 × 64, 256 × 256 and 1024 × 1024 PNGs (every fifth load is aborted at once or after 0–10 ms), and a synchronous 1024 × 1024 createImage() runs between frames every 500 ms; loaded images are drawn, and the oldest is released once eight are live. Baseline repetitions without loads come first.',
      'Frame intervals and engine CPU with and without loads, time from loadImage() to a published image per size, cancellation latency (abort() to rejection), the synchronous upload cost, and peak memory: performance.memory per frame, DevTools JS heap and renderer RSS every 250 ms, and the accounted C bytes.',
      'No partial state: cancelled loads alone leave the accounted C bytes unchanged. Limits: images are created until CAPACITY, which must arrive at the 256-slot resource limit while the engine keeps running.',
    ],
    excludes: [
      'Queue limits inside the engine: there is no loader queue and no decode-concurrency limit yet; concurrency here is bounded by the caller, and peak memory scales with it.',
      'PNG decoding runs in the browser (createImageBitmap) and palette mapping on the main thread; both are included in the load time, and a cancellation cannot interrupt a decode already running.',
      'DevTools heap samples are not forced-GC values; RSS is the OS view of all renderer processes.',
    ],
    rows,
    checks: [
      check(
        'Every load that was not cancelled was published',
        failedLoads.length === 0,
        failedLoads.length
          ? [...new Set(failedLoads.map((load) => load.outcome))].join(', ')
          : `${result.loads.length} published`,
        'all published',
      ),
      check(
        'Cancellations reject with ABORTED (or had already completed)',
        badCancels.length === 0,
        JSON.stringify(cancelOutcomes),
        'ABORTED or completed first',
      ),
      check(
        'Cancelled loads leave the accounted C bytes unchanged',
        result.quiet.before === result.quiet.after,
        `${result.quiet.before} → ${result.quiet.after}`,
        'unchanged',
      ),
      check(
        'Creating images stops with CAPACITY at the 256-slot limit',
        result.capacity.code === 'CAPACITY' &&
          result.capacity.created + result.capacity.liveBefore === expectedSlots,
        `${result.capacity.code} after ${result.capacity.created} + ${result.capacity.liveBefore} live`,
        `CAPACITY at ${expectedSlots}`,
      ),
      check(
        'The engine keeps running at the limit and recovers its bytes',
        result.capacity.state === 'RUNNING' && result.capacity.restored,
        `${result.capacity.state}, restored ${result.capacity.restored}`,
        'RUNNING, restored',
      ),
      check(
        'No engine or page errors',
        result.errors.length + session.errors.length === 0,
        [...result.errors, ...session.errors].join('; ') || 'none',
        'none',
      ),
    ],
    observations: {
      'Loads published / cancelled': `${result.loads.length} / ${result.cancels.length}`,
      'Cancellation outcomes': cancelOutcomes,
      'Intervals longer than 2 × the baseline median (baseline / loads)': `${long(result.baseline, typical)} / ${long(result.loaded, typical)}`,
      'Quiet cancellation outcomes': JSON.stringify(
        result.quiet.outcomes.reduce(
          (counts, outcome) => ({ ...counts, [outcome]: (counts[outcome] ?? 0) + 1 }),
          {},
        ),
      ),
    },
    raw: {
      ...result,
      baseline: result.baseline.map((run) => ({
        interval: compact(run.interval),
        engine: compact(run.engine),
        draw: compact(run.draw),
      })),
      loaded: result.loaded.map((run) => ({
        interval: compact(run.interval),
        engine: compact(run.engine),
        draw: compact(run.draw),
      })),
      memorySeries: series,
    },
  });
}

// -----------------------------------------------------------------------------
// B12: the audio transport on the real AudioWorklet
// -----------------------------------------------------------------------------

export async function runB12Browser(runner, settings) {
  const session = await openBench(runner);
  const options = {
    iterations: scaled(settings, 20, 5, 2),
    burst: 5000,
    cycles: scaled(settings, 200, 50, 20),
    stallUrl: '/bench/fixtures/stall-processor.mjs',
    failingUrl: '/bench/fixtures/failing-processor.mjs',
  };
  let result;
  try {
    result = await session.page.evaluate((opts) => window.bench.transport(opts), options);
  } finally {
    await session.close();
  }
  const real = result.real;
  const drains = real.map((iteration) => {
    const acks = iteration.records.acks.filter((ack) => ack[1] === 'ack');
    return acks.length ? Math.max(...acks.map((ack) => ack[0])) - iteration.burstEnd : null;
  });
  const transport = real.map((iteration) => transportStats(iteration.records));
  const latencies = transport.flatMap((stats) => stats.latencies);
  const values = (key) => real.map((iteration) => iteration[key]).filter((value) => value !== null);
  const { stalled, failing } = result;
  const expectedAdmitted = 1024 + 4;
  return finishResult({
    id: idFor(runner, 'B12'),
    title: titleFor(
      runner,
      'Audio transport on the real AudioWorklet: saturation, STOP, suspend, missing ACK and failure',
    ),
    runtime: runtimeFor(runner),
    measures: [
      `Real processor: ${options.burst} play() calls in one task (no ACK can arrive meanwhile), then the time until every posted batch is acknowledged; STOP with a full queue, and the round trip until a note posted in the new epoch is acknowledged; pause()/resume() and the device state changes; ${options.iterations} iterations.`,
      `Stalled processor (benchmark fixture that completes the handshake and then never reads its port): credits after 2,000 plays, and port traffic after ${options.cycles} stop()/play() cycles.`,
      'Failing processor (benchmark fixture that reports an error 32 quanta after starting): time from unlock to the reported failure, while the game keeps rendering.',
    ],
    excludes: [
      'Audible output and device underruns (headless Chromium mutes output; no playout statistics are exposed). Times come from main-thread timestamps of posts and received messages.',
      'Batch sizes use JSON length as a proxy for the structured clone; the Node B12 reports V8 serialization sizes.',
    ],
    rows: [
      row({
        scenario: 'Burst: play() calls admitted',
        metric: 'count',
        unit: 'count',
        stats: { value: Math.max(...values('admitted')) },
        target: {
          op: '==',
          limit: expectedAdmitted,
          text: `= ${expectedAdmitted} (1,024 queued + 4 in flight)`,
        },
      }),
      row({
        scenario: 'Burst: time to drain the queue (last ACK)',
        metric: 'ms',
        stats: aggregate([summarize(drains.filter((value) => value !== null))]),
      }),
      row({
        scenario: 'Batch ACK latency (post → ACK)',
        metric: 'ms',
        stats: aggregate([summarize(latencies)]),
      }),
      row({
        scenario: 'Batches in flight (max)',
        metric: 'count',
        unit: 'count',
        stats: { value: Math.max(...transport.map((stats) => stats.maxInFlight)) },
        target: { op: '<=', limit: 4, text: '≤ 4 credits' },
      }),
      row({
        scenario: 'stop() with a full queue',
        metric: 'ms per call',
        stats: aggregate([summarize(values('stopCallMs'))]),
      }),
      row({
        scenario: 'STOP round trip (stop() → ACK of the next note)',
        metric: 'ms',
        stats: aggregate([summarize(values('stopRoundTripMs'))]),
      }),
      row({
        scenario: 'pause() → AudioContext suspended',
        metric: 'ms',
        stats: aggregate([summarize(values('suspendMs'))]),
      }),
      row({
        scenario: 'resume() → AudioContext running',
        metric: 'ms',
        stats: aggregate([summarize(values('resumeMs'))]),
      }),
      row({
        scenario: 'Failing processor: unlock → failure reported',
        metric: 'ms',
        stats: { value: failing.failureMs ?? NaN },
      }),
    ],
    checks: [
      check(
        'Every burst admits exactly 1,024 + 4 notes',
        real.every((iteration) => iteration.admitted === expectedAdmitted),
        values('admitted').join(', '),
        String(expectedAdmitted),
      ),
      check(
        'Every posted batch is acknowledged after a burst',
        real.every((iteration) => iteration.drained),
        `${real.filter((iteration) => iteration.drained).length} of ${real.length}`,
        `${real.length} of ${real.length}`,
      ),
      check(
        'No note is sent while paused',
        real.every((iteration) => iteration.postsWhilePaused === 0),
        values('postsWhilePaused').join(', '),
        '0',
      ),
      check(
        'Stalled processor: plays leave ≤ 4 batches posted',
        stalled.afterBurst <= 4,
        `${stalled.afterBurst} posts, ${stalled.admitted} admitted`,
        '≤ 4',
      ),
      check(
        'Stalled processor: port traffic stays bounded across stop()/play() cycles',
        stalled.afterCycles <= stalled.afterBurst + 1,
        `${stalled.afterCycles} posts (${stalled.bytes} JSON bytes) after ${stalled.cycles} cycles`,
        `≤ ${stalled.afterBurst + 1}`,
      ),
      check(
        'Failing processor: reported once, audio failed, context closed',
        failing.reports.length === 1 &&
          failing.reports[0] === 'AUDIO_ERROR' &&
          failing.state === 'failed' &&
          failing.contextState === 'closed',
        `${failing.reports.join(', ') || 'no report'}; ${failing.state}; context ${failing.contextState}`,
        'AUDIO_ERROR once; failed; closed',
      ),
      check(
        'Failing processor: the game keeps running',
        failing.engineState === 'RUNNING' && failing.framesAfter > 0,
        `${failing.engineState}, ${failing.framesAfter} frames in 200 ms after the failure`,
        'RUNNING, frames advancing',
      ),
    ],
    observations: {
      'Unlock (real processor)': `${result.realInfo.unlockMs.toFixed(1)} ms, state ${result.realInfo.state}`,
      'Rejected per burst (CAPACITY)': values('rejected').join(', '),
      'Stalled processor posts after burst / after cycles': `${stalled.afterBurst} / ${stalled.afterCycles}`,
    },
    raw: result,
  });
}

export const BROWSER_BENCHMARKS = Object.freeze({
  B01: runB01Browser,
  B06: runB06,
  B07: runB07Browser,
  B09: runB09,
  B11: runB11,
  B12: runB12Browser,
});

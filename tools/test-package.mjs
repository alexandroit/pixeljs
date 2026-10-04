// Verifies the packed archives as a consumer would receive them: installed
// outside the workspace, built with Vite, served under the production CSP and
// exercised in a real browser. No registry access is needed.
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  rm,
  rename,
  symlink,
  realpath,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname } from 'node:path';
import { createServer } from 'node:http';
import { build, createServer as createViteServer } from 'vite';
import { chromium } from '@playwright/test';
import { productionPolicy } from './csp.mjs';
import { run, npm } from './run.mjs';

const repo = resolve('.');
const core = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
const tool = JSON.parse(await readFile('packages/create/package.json', 'utf8'));
if (tool.version !== core.version)
  throw new Error('@pixeljs/create and @pixeljs/core must be released with the same version.');
await mkdir('artifacts', { recursive: true });
for (const workspace of ['@pixeljs/core', '@pixeljs/create']) {
  run(npm, [
    'pack',
    '--workspace',
    workspace,
    '--pack-destination',
    resolve('artifacts'),
    '--ignore-scripts',
  ]);
}
const archive = resolve(`artifacts/pixeljs-core-${core.version}.tgz`);
const createArchive = resolve(`artifacts/pixeljs-create-${tool.version}.tgz`);
const policy = await productionPolicy();
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Outside a portal frame, @pixeljs/core/portal answers every call by itself, in Node too.
const PORTAL_IN_NODE = `
import { connectPortal, createRandom } from '@pixeljs/core/portal';
const portal = await connectPortal();
const answer = await portal.levelEnd(await portal.levelStart('1-1'), { outcome: 'complete' });
if (portal.inPortal || answer.reason !== 'not_in_portal' || createRandom(0).next() !== 1144304738)
  throw new Error('@pixeljs/core/portal does not work in Node.');
`;

// A strict TypeScript consumer of the portal entry's declarations.
const PORTAL_CONSUMER = `import { createEngine } from '@pixeljs/core';
import {
  attachEngine,
  connectPortal,
  createRandom,
  type LevelEndResult,
  type MatchStart,
  type Portal,
} from '@pixeljs/core/portal';

export async function play(canvas: HTMLCanvasElement): Promise<Portal> {
  const portal = await connectPortal({ capabilities: ['pause', 'mute', 'scores', 'multiplayer'] });
  const engine = await createEngine({ canvas });
  engine.start({ update() {}, draw() {} });
  const detach: () => void = attachEngine(portal, engine, { volume: 0.5 });
  portal.on('mute', ({ muted }) => engine.audio.setVolume(muted ? 0 : 1));
  portal.multiplayer.on('start', (match: MatchStart) => {
    const random = createRandom(match.seed);
    portal.multiplayer.send({ roll: random.range(1, 6) }, { to: match.host });
  });
  void portal.multiplayer.result([0, 1], { draw: true });
  // @ts-expect-error: draw is a boolean, not a string.
  void portal.multiplayer.result([0, 1], { draw: 'true' });
  const run = await portal.levelStart('1-1');
  const answer: LevelEndResult = await portal.levelEnd(run, { outcome: 'complete', scores: { total: 9 } });
  if (answer.newBest?.['total'] === true) detach();
  const saved = await portal.save('slot-1', JSON.stringify({ level: 2 }), { rev: 0 });
  if (!saved.ok) throw new Error(saved.reason);
  // @ts-expect-error: a run ends as 'complete', 'fail' or 'quit'.
  await portal.levelEnd(run, { outcome: 'won' });
  return portal;
}
`;

// A stand-in for the portal page: it frames the game with a nonce in the URL, answers
// the bridge and records every message the game sends.
const FAKE_PORTAL = `const NONCE = 'package-test-nonce-0123';
const launch = JSON.parse(new URLSearchParams(location.search).get('launch') || '{"mode":"solo"}');
const frame = document.createElement('iframe');
frame.src = '/index.html#pjs=' + NONCE;
frame.width = 640;
frame.height = 360;
document.body.append(frame);
window.received = [];
window.portalSend = (type, data, re) =>
  frame.contentWindow.postMessage({ pjs: 2, type, nonce: NONCE, re, data }, '*');
const room = {
  code: 'ABC234', mode: 'versus', private: true, state: 'playing', host: 0, me: 0, min: 2, max: 2,
  players: [0, 1].map((slot) => ({ slot, handle: 'player' + slot, avatar: 'a01', ready: false, connected: true })),
};
window.startMatch = () => {
  window.portalSend('mp.room', room);
  window.portalSend('mp.start', { ...room, seed: 0 });
};
addEventListener('message', (event) => {
  const message = event.data;
  if (event.source !== frame.contentWindow || message?.pjs !== 2 || message.nonce !== NONCE) return;
  window.received.push(message);
  const reply = (data) => window.portalSend('reply', data, message.id);
  if (message.type === 'hello')
    window.portalSend('welcome', { bridge: '2.0.0', capabilities: message.data.capabilities, launch });
  else if (message.type === 'level.start') reply({ ok: true, run: 'run-1', level: message.data.level });
  else if (message.type === 'levels.get') reply({ ok: true, levels: {} });
  else if (message.type === 'load') reply({ ok: true, data: null, rev: 0, schema: 0 });
  else if (message.type === 'player.get') reply({ ok: true, signedIn: true, handle: 'player0' });
  else if (message.id) reply({ ok: true, recorded: true });
});
`;
const PORTAL_STARTERS = new Set(['portal', 'board']);

/** Serves `routes` (URL prefix → directory) with the production CSP. */
async function serve(routes) {
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const [prefix, root] = Object.entries(routes).find(([key]) => path.startsWith(key)) ?? [];
      if (!root) throw new Error('Unknown route');
      const target = resolve(root, path.slice(prefix.length) || 'index.html');
      if (target !== root && !target.startsWith(root + '/')) throw new Error('Invalid path');
      const data = await readFile(target);
      response.writeHead(200, {
        'Content-Type': types[extname(target)] ?? 'application/octet-stream',
        'Content-Security-Policy': policy,
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(data);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** Opens a page that records runtime errors and CSP violations. */
async function openPage(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon/.test(message.location().url ?? ''))
      errors.push(message.text());
  });
  return { page, errors };
}

/** Waits until the first canvas shows more than one color. */
async function waitForPixels(page) {
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const source = document.querySelector('canvas');
        const copy = document.createElement('canvas');
        copy.width = source.width;
        copy.height = source.height;
        const context = copy.getContext('2d');
        requestAnimationFrame(() => {
          context.drawImage(source, 0, 0);
          const data = context.getImageData(0, 0, copy.width, copy.height).data;
          const colors = new Set();
          for (let index = 0; index < data.length; index += 4)
            colors.add((data[index] << 16) | (data[index + 1] << 8) | data[index + 2]);
          resolve(colors.size > 1);
        });
      }),
    undefined,
    { timeout: 10_000 },
  );
}

/** Counts the WebAssembly files a page loaded: the engine's, then the audio worklet's. */
function countWasm(page) {
  const loaded = { count: 0 };
  page.on('response', (response) => {
    if (/\.wasm(\?|$)/.test(response.url()) && response.ok()) loaded.count++;
  });
  return loaded;
}

/** Starts a starter's sound: its button, or for portal starters the first key press. */
async function startSound(page, template, wasm) {
  if (!PORTAL_STARTERS.has(template)) return unlockAudio(page, '#audio-toggle');
  await page.keyboard.press('KeyX');
  for (let wait = 0; wait < 100 && wasm.count < 2; wait++) await page.waitForTimeout(100);
  if (wasm.count < 2) throw new Error(`The ${template} starter did not start its sound.`);
}

/** Clicks an audio toggle and waits for the worklet-backed state to report sound on. */
async function unlockAudio(page, selector) {
  await page.locator(selector).click();
  await page.waitForFunction(
    (target) => document.querySelector(target)?.textContent?.includes('On'),
    selector,
    { timeout: 10_000 },
  );
}

const dir = await realpath(await mkdtemp(join(tmpdir(), 'pixeljs-consumers-')));
const browser = await chromium.launch(
  process.env.PIXELJS_USE_BUNDLED_CHROMIUM ? {} : { channel: 'chrome' },
);
const results = [];
try {
  for (const language of ['javascript', 'typescript']) {
    const root = join(dir, language);
    await mkdir(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: `pixeljs-${language}-consumer`,
        version: '1.0.0',
        private: true,
        type: 'module',
      }),
    );
    run(
      npm,
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', archive],
      { cwd: root },
    );
    const installed = join(root, 'node_modules/@pixeljs/core');
    const installedReal = await realpath(installed);
    if (!installedReal.startsWith(dir))
      throw new Error('Package must be installed outside the workspace, not symlinked.');
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    if (metadata.scripts?.install || metadata.scripts?.postinstall || metadata.dependencies)
      throw new Error('Runtime unexpectedly needs install hooks or dependencies.');
    if (
      metadata.license !== 'MIT' ||
      !(await readFile(join(installed, 'LICENSE'), 'utf8')).includes('MIT License')
    )
      throw new Error('The archive must carry the MIT license text.');
    await access(join(installed, 'dist/internal/audio/processor.js'));
    // The portal entry is in the archive and resolves through the package's exports.
    await access(join(installed, 'dist/portal.js'));
    await access(join(installed, 'dist/portal.d.ts'));
    run(process.execPath, ['--input-type=module', '--eval', PORTAL_IN_NODE], { cwd: root });
    const source = join(root, 'examples');
    await cp(join(repo, 'examples/javascript'), join(source, 'javascript'), { recursive: true });
    await cp(join(repo, 'examples/typescript'), join(source, 'typescript'), { recursive: true });
    if (language === 'typescript') {
      const tsconfig = {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022', 'DOM'],
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          types: [],
        },
        include: [
          'examples/typescript/main.ts',
          'examples/javascript/game.d.ts',
          'portal-consumer.ts',
        ],
      };
      await writeFile(join(root, 'tsconfig.json'), JSON.stringify(tsconfig));
      await writeFile(join(root, 'portal-consumer.ts'), PORTAL_CONSUMER);
      run(process.execPath, [
        join(repo, 'node_modules/typescript/bin/tsc'),
        '-p',
        join(root, 'tsconfig.json'),
      ]);
    }
    const out = join(root, 'dist');
    await build({
      configFile: false,
      root: join(source, language),
      base: './',
      logLevel: 'error',
      build: {
        outDir: out,
        assetsDir: 'build',
        emptyOutDir: true,
        assetsInlineLimit: 0,
        target: 'es2022',
      },
    });
    // The game loads its asset manifest at run time: from assets/ next to the
    // JavaScript page and from ../javascript/assets/ for the TypeScript page.
    if (language === 'javascript')
      await cp(join(source, 'javascript/assets'), join(out, 'assets'), { recursive: true });
    const server = await serve({
      '/games/native/': root,
      '/games/demo/': out,
      '/games/javascript/': join(source, 'javascript'),
    });
    const { page, errors } = await openPage(browser);
    let loadedWasm = 0;
    page.on('response', (response) => {
      if (response.url().endsWith('.wasm') && response.ok()) loadedWasm++;
    });
    try {
      await page.goto(`${server.origin}/games/demo/`);
      await page.locator('[data-pause]').waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-pause]').disabled);
      await waitForPixels(page);
      await page.locator('canvas').focus();
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(120);
      await page.keyboard.up('ArrowRight');
      // That first key press started audio: the AudioWorklet module and the
      // DSP load from the bundle under the CSP.
      for (let wait = 0; wait < 100 && loadedWasm < 2; wait++) await page.waitForTimeout(100);
      await page.locator('[data-mute]').click();
      if ((await page.locator('[data-mute]').getAttribute('aria-pressed')) !== 'true')
        throw new Error('Mute did not work.');
      await page.locator('[data-pause]').click();
      if ((await page.locator('[data-pause]').textContent()) !== 'Resume')
        throw new Error('Pause did not work.');
      if (loadedWasm !== 2 || errors.length)
        throw new Error(`Consumer failed: WASM=${loadedWasm}; errors=${errors.join('; ')}`);
      if (language === 'javascript') {
        await writeFile(
          join(root, 'index.html'),
          '<!doctype html><html lang="en"><meta charset="utf-8"><title>Direct ESM consumer</title><canvas></canvas><script type="module" src="./native.mjs"></script></html>',
        );
        await writeFile(
          join(root, 'native.mjs'),
          `import {createEngine} from './node_modules/@pixeljs/core/dist/index.js';
const engine=await createEngine({canvas:document.querySelector('canvas'),width:8,height:8,renderer:'canvas2d'});
const image=engine.createImage({width:1,height:1,pixels:new Uint8Array([5])});
engine.start({update(){},draw(){engine.graphics.clear(0);engine.graphics.sprite(image,0,0);}});
window.nativeEngine=engine;`,
        );
        loadedWasm = 0;
        await page.goto(`${server.origin}/games/native/`);
        await page.waitForFunction(() => window.nativeEngine?.getStats().frames > 0);
        const direct = await page.evaluate(async () => {
          const engine = window.nativeEngine;
          const pixel = Array.from(
            document.querySelector('canvas').getContext('2d').getImageData(0, 0, 1, 1).data,
          );
          await engine.audio.unlock();
          const audio = engine.audio.capabilities.state;
          await engine.dispose();
          return { pixel, audio, state: engine.state, bytes: engine.getStats().coreBytes };
        });
        if (
          direct.state !== 'DISPOSED' ||
          direct.audio !== 'running' ||
          direct.bytes !== 0 ||
          direct.pixel[3] !== 255 ||
          loadedWasm !== 2 ||
          errors.length
        )
          throw new Error(`Native ESM consumer failed: ${JSON.stringify(direct)} ${errors}`);
      }
      await page.goto('about:blank'); // Executes pagehide teardown in the example.
      results.push({
        consumer: `${language} example`,
        result: 'PASS',
        externalInstall: true,
        typecheck: language === 'typescript',
        nativeEsm: language === 'javascript',
        bundledSubpath: '/games/demo/',
        csp: 'production',
        audio: 'running',
      });
    } finally {
      await page.close();
      await server.close();
    }
  }

  /** Runs a portal starter's build in a stand-in portal page and checks its messages. */
  async function playInPortal(template, dist) {
    const host = join(dir, `portal for ${template}`);
    await mkdir(host);
    await writeFile(
      join(host, 'index.html'),
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Portal</title><body><script type="module" src="./portal.js"></script></body></html>',
    );
    await writeFile(join(host, 'portal.js'), FAKE_PORTAL);
    const server = await serve({ '/portal/': host, '/': dist });
    const { page, errors } = await openPage(browser);
    const sent = (type, count = 1) =>
      page
        .waitForFunction(
          ([kind, n]) => window.received.filter((message) => message.type === kind)[n - 1],
          [type, count],
          { timeout: 10_000 },
        )
        .then((found) => found.jsonValue());
    try {
      const launch = encodeURIComponent(
        JSON.stringify({ mode: template === 'board' ? 'online' : 'solo' }),
      );
      await page.goto(`${server.origin}/portal/?launch=${launch}`);
      const hello = await sent('hello');
      const manifest = JSON.parse(await readFile(join(dist, 'pixeljs.json'), 'utf8'));
      if (
        hello.data.bridge !== '2.0.0' ||
        hello.data.engine !== `@pixeljs/core@${core.version}` ||
        JSON.stringify(hello.data.capabilities) !== JSON.stringify(manifest.capabilities)
      )
        throw new Error(`The ${template} starter said hello wrongly: ${JSON.stringify(hello)}`);
      await sent('ready');
      const canvas = page.frameLocator('iframe').locator('canvas');
      if (template === 'portal') {
        await canvas.click({ position: { x: 2, y: 2 } });
        await sent('interaction');
        await page.keyboard.press('Enter');
        const start = await sent('level.start');
        await page.keyboard.press('Escape');
        const end = await sent('level.end');
        if (start.data.level !== '1-1' || end.data.run !== 'run-1' || end.data.outcome !== 'quit')
          throw new Error(`The portal starter reported its run wrongly: ${JSON.stringify(end)}`);
      } else {
        // An online match in which this player hosts and, with seed 0, plays first.
        await page.evaluate(() => window.startMatch());
        await page.waitForTimeout(300);
        await canvas.click(); // the middle cell
        const first = await sent('mp.send');
        await page.evaluate(() =>
          window.portalSend('mp.message', { from: 1, data: { t: 'move', move: 0 } }),
        );
        const second = await sent('mp.send', 2);
        if (first.data.data.state !== '....0....1' || second.data.data.state !== '1...0....0')
          throw new Error(`The board starter refereed wrongly: ${JSON.stringify([first, second])}`);
      }
      if (errors.length) throw new Error(`${template} starter in a portal frame failed: ${errors}`);
    } finally {
      await page.close();
      await server.close();
    }
  }

  // The scaffolding tool, exactly as packed: generate, build and run every starter.
  const toolRoot = join(dir, 'create-tool');
  await mkdir(toolRoot);
  run('tar', ['-xzf', createArchive, '-C', toolRoot]);
  const toolMetadata = JSON.parse(await readFile(join(toolRoot, 'package/package.json'), 'utf8'));
  if (
    toolMetadata.dependencies ||
    toolMetadata.scripts?.install ||
    toolMetadata.scripts?.postinstall
  )
    throw new Error('@pixeljs/create must not need dependencies or install hooks.');
  for (const template of ['javascript', 'typescript', 'portal', 'board']) {
    const starter = join(dir, `starter ${template}`);
    run(process.execPath, [
      join(toolRoot, 'package/bin/create-pixeljs.js'),
      starter,
      '--template',
      template,
    ]);
    await access(join(starter, '.gitignore'));
    const manifest = JSON.parse(await readFile(join(starter, 'package.json'), 'utf8'));
    if (manifest.dependencies['@pixeljs/core'] !== `^${core.version}`)
      throw new Error('The starter must depend on the core released with the tool.');
    // Place the core archive where npm would, and reuse the locked dev tools.
    const scope = join(starter, 'node_modules/@pixeljs');
    await mkdir(scope, { recursive: true });
    run('tar', ['-xzf', archive, '-C', scope]);
    await rename(join(scope, 'package'), join(scope, 'core'));
    for (const name of ['vite', 'typescript'])
      await symlink(join(repo, 'node_modules', name), join(starter, 'node_modules', name), 'dir');
    if (template === 'typescript')
      run(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', starter]);
    await build({ root: starter, logLevel: 'error' });
    const server = await serve({ '/': join(starter, 'dist') });
    const { page, errors } = await openPage(browser);
    const wasm = countWasm(page);
    try {
      await page.goto(`${server.origin}/`);
      await waitForPixels(page);
      await startSound(page, template, wasm);
      if (errors.length) throw new Error(`${template} starter failed: ${errors.join('; ')}`);
    } finally {
      await page.close();
      await server.close();
    }
    if (PORTAL_STARTERS.has(template)) await playInPortal(template, join(starter, 'dist'));
    // `npm run dev`: the unbundled development server must work too.
    const dev = await createViteServer({
      root: starter,
      logLevel: 'error',
      server: { port: 0, open: false, host: '127.0.0.1' },
    });
    await dev.listen();
    const devPage = await openPage(browser);
    const devWasm = countWasm(devPage.page);
    try {
      await devPage.page.goto(dev.resolvedUrls.local[0]);
      await waitForPixels(devPage.page);
      await startSound(devPage.page, template, devWasm);
      if (devPage.errors.length)
        throw new Error(`${template} dev server failed: ${devPage.errors.join('; ')}`);
    } finally {
      await devPage.page.close();
      await dev.close();
    }
    results.push({
      consumer: `${template} starter from @pixeljs/create`,
      result: 'PASS',
      gitignore: true,
      typecheck: template === 'typescript',
      build: 'vite',
      csp: 'production',
      devServer: true,
      audio: 'running',
      portalFrame: PORTAL_STARTERS.has(template),
    });
  }
  await writeFile('artifacts/package-tests.json', JSON.stringify(results, null, 2) + '\n');
  console.log(
    'PASS: packed @pixeljs/core in JS/TS consumers, its portal entry, and packed @pixeljs/create starters (build, dev server, production CSP, rendering, audio, lifecycle, portal frame).',
  );
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}

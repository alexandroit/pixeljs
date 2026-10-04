// Browser benchmarks through Playwright: B01 (full pipeline and cold start),
// B06, B07 (the game with music and bursts), B09, B11 and B12 (real
// AudioWorklet). B08 and B10 are reported as not executed / not applicable.
// Pages are served by tools/serve.mjs with the production CSP. Usage:
//
//   npm run bench:browser                      full plan, Chromium (Google Chrome channel)
//   npm run bench:browser -- --quick | --smoke indicative only / proves the code runs
//   npm run bench:browser -- --only=B06,B09 --browsers=chromium,firefox,webkit --headed
//   npm run bench:browser -- --isolate         COOP/COEP for 5 µs timers (production sends neither)
//   PIXELJS_TEST_PORT=4184 npm run bench:browser   fixed server port (default: any free port)
//   npm run bench:browser -- --out=/tmp/bench      write outside benchmarks/results
import { performance } from 'node:perf_hooks';
import {
  COVERAGE,
  NOT_EXECUTED,
  environment,
  finishEnvironment,
  finishResult,
  parseSettings,
  renderReport,
  selected,
  writeResults,
} from './bench/common.mjs';
import { BROWSER_BENCHMARKS, buildSite, launchBrowser, startServer } from './bench/browser.mjs';

const argv = process.argv.slice(2);
const option = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const settings = parseSettings(argv);
const browsers = (option('browsers') ?? 'chromium')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
for (const name of browsers)
  if (!['chromium', 'firefox', 'webkit'].includes(name))
    throw new Error(`Unknown browser ${name}.`);
const headed = argv.includes('--headed');
// Cross-origin isolation gives 5 µs timers instead of 100 µs; production sends no COOP/COEP.
const isolate = argv.includes('--isolate');
const port = Number(option('port') ?? process.env.PIXELJS_TEST_PORT ?? 0);

const env = await environment('tools/bench-browser.mjs');
const chosen = Object.keys(BROWSER_BENCHMARKS).filter((id) => selected(settings, id));
console.log(
  `PixelJS browser benchmarks (${settings.mode}) in ${browsers.join(', ')}: ${chosen.join(', ')}; ` +
    `${settings.warmupMs} ms warm-up, ${settings.runs} × ${settings.sampleMs} ms where time-based.`,
);
if (settings.deviations.length)
  console.log(`Deviations from the plan: ${settings.deviations.join('; ')}.`);

const site = await buildSite();
const server = await startServer(site.dir, port, { isolate });
const results = [];
const identities = [];
let workers = null;
try {
  for (const name of browsers) {
    const runner = await launchBrowser(name, { headed });
    Object.assign(runner, { origin: server.origin, server });
    try {
      const context = await runner.browser.newContext();
      const page = await context.newPage();
      await page.goto(`${server.origin}/bench/`);
      await page.waitForFunction(() => typeof window.bench === 'object');
      runner.info = await page.evaluate(() => window.bench.info());
      await context.close();
      workers ??= runner.info.workers;
      identities.push(runner);
      for (const id of chosen) {
        const started = performance.now();
        process.stdout.write(`${name} ${id} ... `);
        try {
          const result = await BROWSER_BENCHMARKS[id](runner, settings, site);
          results.push(result);
          console.log(`${result.status} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
        } catch (error) {
          // A tool failure is reported as such, never as a measurement.
          results.push(
            finishResult({
              id: name === 'chromium' ? id : `${id}-${name}`,
              title: `${id} in ${name} did not complete`,
              measures: [],
              excludes: [],
              rows: [],
              checks: [
                {
                  name: 'The benchmark ran to completion',
                  observed: String(error?.stack ?? error).split('\n')[0],
                  expected: 'completed',
                  status: 'FAIL',
                },
              ],
            }),
          );
          console.log(`ERROR: ${error?.message ?? error}`);
        }
      }
    } finally {
      await runner.browser.close();
    }
  }
} finally {
  server.stop();
  await site.remove();
}
if (selected(settings, 'B08')) results.push(NOT_EXECUTED.B08);
if (selected(settings, 'B10'))
  results.push({
    ...NOT_EXECUTED.B10,
    observations: { 'engine.capabilities.workers observed in the browser': String(workers) },
  });

finishEnvironment(env);
const preface = identities.map(
  (runner) =>
    `- Browser: ${runner.name} ${runner.version} (channel ${runner.launch.channel}, ${runner.launch.headless ? 'headless' : 'headed'}${runner.launch.args.length ? `, ${runner.launch.args.join(' ')}` : ''}); ${runner.info.userAgent}; WebGL "${runner.info.glRenderer}" (${runner.info.glVendor}); GPU timer query ${runner.info.gpuTimer ? 'available' : 'not exposed'}; devicePixelRatio ${runner.info.devicePixelRatio}; performance.now() resolution ${runner.info.timerResolutionMs} ms (${runner.info.crossOriginIsolated ? 'cross-origin isolated' : 'not isolated'})`,
);
preface.push(
  `- Server: tools/serve.mjs on ${server.origin} (loopback), production CSP from infra/nginx/pixeljs.conf, production caching headers (no-cache, ETag, 304), uncompressed bodies${isolate ? '; COOP/COEP added for timer resolution (--isolate, not the production headers)' : ''}`,
);
const markdown = renderReport({
  title: 'PixelJS 0.0.5 browser benchmarks',
  env,
  settings,
  results,
  preface,
  coverage: COVERAGE,
});
const directory = await writeResults(env, results, markdown, settings.out);
console.log(`\n${markdown}\nResults written to ${directory}/`);

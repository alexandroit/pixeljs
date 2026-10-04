// Node benchmarks on the real build artifacts: the core parts of B01–B05, the
// B07 DSP and the B12 audio transport. Browser benchmarks are in
// tools/bench-browser.mjs. Usage:
//
//   npm run bench                     full plan: 5 s warm-up, 5 × 30 s per variant
//   npm run bench -- --quick          1 s warm-up, 2 × 2 s (indicative only)
//   npm run bench -- --smoke          proves the code runs; not a measurement
//   npm run bench -- --only=B03,B04 --warmup=5000 --sample=30000 --runs=5
//   npm run bench -- --out=/tmp/bench write outside benchmarks/results
import { performance } from 'node:perf_hooks';
import {
  COVERAGE,
  NOT_EXECUTED,
  environment,
  finishEnvironment,
  parseSettings,
  renderReport,
  selected,
  writeResults,
} from './bench/common.mjs';
import { NODE_BENCHMARKS } from './bench/core.mjs';

const settings = parseSettings();
const env = await environment('tools/bench.mjs');
// Timed variants per benchmark, for the duration estimate.
const variants = { B01: 3, B02: 1, B03: 3, B04: 4, B05: 8, B07: 2, B12: 3 };
const chosen = Object.keys(NODE_BENCHMARKS).filter((id) => selected(settings, id));
const phases = chosen.reduce((total, id) => total + variants[id], 0);
const estimate = (phases * (settings.warmupMs + settings.runs * settings.sampleMs)) / 60000;
console.log(
  `PixelJS Node benchmarks (${settings.mode}): ${chosen.join(', ')}; ` +
    `${settings.warmupMs} ms warm-up, ${settings.runs} × ${settings.sampleMs} ms per variant; ` +
    `about ${estimate.toFixed(1)} min of sampling.`,
);
if (settings.deviations.length)
  console.log(`Deviations from the plan: ${settings.deviations.join('; ')}.`);
if (env.build.matchesManifest === false)
  console.warn(`Warning: built files differ from the manifest: ${env.build.mismatches.join(', ')}`);

const results = [];
for (const id of chosen) {
  const started = performance.now();
  process.stdout.write(`${id} ... `);
  const result = await NODE_BENCHMARKS[id](settings);
  results.push(result);
  console.log(`${result.status} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}
for (const id of ['B08', 'B10']) if (selected(settings, id)) results.push(NOT_EXECUTED[id]);

finishEnvironment(env);
const markdown = renderReport({
  title: 'PixelJS 0.0.5 Node benchmarks (core, DSP and audio transport)',
  env,
  settings,
  results,
  coverage: COVERAGE,
});
const directory = await writeResults(env, results, markdown, settings.out);
console.log(`\n${markdown}\nResults written to ${directory}/`);

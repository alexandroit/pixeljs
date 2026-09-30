// Shared helpers for the PixelJS benchmark tools (tools/bench.mjs and
// tools/bench-browser.mjs): settings from the command line, statistics,
// targets evaluated on measured data, environment identity and the results
// directory (README.md summary, summary.json and raw samples).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The benchmark plan: at least 5 s warm-up, 30 s sampling and five repetitions. */
export const PLAN = Object.freeze({ warmupMs: 5000, sampleMs: 30000, runs: 5 });
const MODES = Object.freeze({
  full: PLAN,
  quick: { warmupMs: 1000, sampleMs: 2000, runs: 2 },
  smoke: { warmupMs: 50, sampleMs: 200, runs: 1 },
});

/**
 * Reads `--smoke`, `--quick`, `--warmup=`, `--sample=` (ms), `--runs=` and
 * `--only=B01,B03`. Anything below the plan is listed as a deviation.
 */
export function parseSettings(argv = process.argv.slice(2)) {
  const has = (name) => argv.includes(`--${name}`);
  const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const number = (name, fallback) => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new Error(`--${name} must be a non-negative number of milliseconds.`);
    return parsed;
  };
  const mode = has('smoke') ? 'smoke' : has('quick') ? 'quick' : 'full';
  const base = MODES[mode];
  const settings = {
    mode,
    warmupMs: number('warmup', base.warmupMs),
    sampleMs: number('sample', base.sampleMs),
    runs: Math.max(1, Math.round(number('runs', base.runs))),
    only:
      value('only')
        ?.split(',')
        .map((id) => id.trim().toUpperCase())
        .filter(Boolean) ?? null,
    out: value('out') ?? null,
  };
  return { ...settings, deviations: deviations(settings) };
}

export function deviations({ warmupMs, sampleMs, runs }) {
  const list = [];
  if (warmupMs < PLAN.warmupMs)
    list.push(`warm-up ${warmupMs} ms (plan: at least ${PLAN.warmupMs} ms)`);
  if (sampleMs < PLAN.sampleMs)
    list.push(`sampling ${sampleMs} ms per repetition (plan: at least ${PLAN.sampleMs} ms)`);
  if (runs < PLAN.runs) list.push(`${runs} repetition(s) (plan: at least ${PLAN.runs})`);
  return list;
}

export const selected = (settings, id) => !settings.only || settings.only.includes(id);

/** Count-based workloads scale with the mode: full, quick and smoke values. */
export const scaled = (settings, full, quick, smoke) =>
  settings.mode === 'smoke' ? smoke : settings.mode === 'quick' ? quick : full;

// -----------------------------------------------------------------------------
// Statistics
// -----------------------------------------------------------------------------

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted, fraction) {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function median(values) {
  const sorted = Float64Array.from(values).sort();
  if (sorted.length === 0) return NaN;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(samples) {
  const sorted = Float64Array.from(samples).sort();
  let sum = 0;
  for (const value of sorted) sum += value;
  const count = sorted.length;
  return {
    count,
    min: count ? sorted[0] : NaN,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: count ? sorted[count - 1] : NaN,
    mean: count ? sum / count : NaN,
  };
}

/** Across repetitions: the median of each run's percentiles and the spread of run p95s. */
export function aggregate(runStats) {
  const p95s = runStats.map((stats) => stats.p95);
  return {
    runs: runStats.length,
    count: runStats.reduce((total, stats) => total + stats.count, 0),
    p50: median(runStats.map((stats) => stats.p50)),
    p95: median(p95s),
    p99: median(runStats.map((stats) => stats.p99)),
    mean: median(runStats.map((stats) => stats.mean)),
    max: Math.max(...runStats.map((stats) => stats.max)),
    p95Min: Math.min(...p95s),
    p95Max: Math.max(...p95s),
  };
}

/** Rounds millisecond samples to 1 ns for the raw files (no timer here resolves finer). */
export const compact = (samples) => Array.from(samples, (value) => Math.round(value * 1e6) / 1e6);

/** Least-squares slope of y over x (for leak-trend checks). */
export function slope(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return NaN;
  let sx = 0;
  let sy = 0;
  for (let index = 0; index < n; index++) {
    sx += xs[index];
    sy += ys[index];
  }
  const mx = sx / n;
  const my = sy / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index++) {
    numerator += (xs[index] - mx) * (ys[index] - my);
    denominator += (xs[index] - mx) ** 2;
  }
  return denominator === 0 ? NaN : numerator / denominator;
}

// -----------------------------------------------------------------------------
// Rows, targets and checks
// -----------------------------------------------------------------------------

const OPERATORS = {
  '<': (value, limit) => value < limit,
  '<=': (value, limit) => value <= limit,
  '>': (value, limit) => value > limit,
  '>=': (value, limit) => value >= limit,
  '==': (value, limit) => value === limit,
};

/** PASS or FAIL for a stated target, computed from the measured value. */
export function evaluate(value, op, limit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'FAIL';
  const compare = OPERATORS[op];
  if (!compare) throw new Error(`Unknown comparison ${op}`);
  return compare(value, limit) ? 'PASS' : 'FAIL';
}

/**
 * One summary line. `stats` is a distribution (p50/p95/p99) or `{ value }`;
 * `target` is `{ op, limit, statistic, text }` and is evaluated here.
 */
export function row({ scenario, metric, unit = 'ms', stats, target = null }) {
  const statistic = target?.statistic ?? (stats && 'p95' in stats ? 'p95' : 'value');
  const measured = stats?.[statistic];
  return {
    scenario,
    metric,
    unit,
    stats,
    target: target
      ? {
          ...target,
          statistic,
          text: target.text ?? `${statistic} ${target.op} ${formatValue(target.limit, unit)}`,
        }
      : null,
    status: target ? evaluate(measured, target.op, target.limit) : 'INFO',
  };
}

export function check(name, passed, observed, expected) {
  return {
    name,
    observed: String(observed),
    expected: String(expected),
    status: passed ? 'PASS' : 'FAIL',
  };
}

/** A benchmark fails if any target or check fails; with neither it is informational. */
export function overallStatus(result) {
  const statuses = [...(result.rows ?? []), ...(result.checks ?? [])].map((item) => item.status);
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('PASS')) return 'PASS';
  return 'INFO';
}

export function finishResult(result) {
  return { ...result, status: result.status ?? overallStatus(result) };
}

/** Matrix entries that this Mac cannot measure; never reported as results. */
export const NOT_EXECUTED = Object.freeze({
  B08: {
    id: 'B08',
    title: 'At least 15 minutes on a named physical mobile device',
    status: 'NOT RUN',
    note: 'not executed: needs a named physical device',
    measures: [],
    excludes: [
      'No physical Android or iPhone is attached to this machine. Desktop browsers, Playwright WebKit and simulators do not substitute for it.',
    ],
  },
  B10: {
    id: 'B10',
    title: 'E0 versus optional E1/E2 worker execution',
    status: 'N/A',
    note: 'not applicable (no worker runtime)',
    measures: [],
    excludes: [
      'PixelJS has no worker runtime (engine.capabilities.workers is false), so there is nothing to compare against E0.',
    ],
  },
});

/** Where each matrix entry is measured; printed in both reports. */
export const COVERAGE = Object.freeze([
  '| ID | Where it is measured |',
  '| --- | --- |',
  '| B01 | Core part (validation + raster): `npm run bench`. Full browser pipeline and cold start: `npm run bench:browser`. |',
  '| B02–B05 | `npm run bench` (core in Node on the real engine.wasm). |',
  '| B06 | `npm run bench:browser` (1,000 create/load/start/dispose cycles in Chromium). |',
  '| B07 | DSP: `npm run bench`. Game rendering with music, bursts and the real AudioWorklet: `npm run bench:browser`. |',
  '| B08 | Not executed: needs a named physical device. |',
  '| B09 | `npm run bench:browser` (startup bytes and phases, audio off/lazy, cold/warm cache, root and nested path). |',
  '| B10 | Not applicable (no worker runtime). |',
  '| B11 | `npm run bench:browser` (image loads during play, cancellation, peak memory). |',
  '| B12 | Transport with a scripted port: `npm run bench`. Real AudioWorklet in Chromium: `npm run bench:browser`. |',
]);

// -----------------------------------------------------------------------------
// Environment identity
// -----------------------------------------------------------------------------

function command(file, args) {
  try {
    return execFileSync(file, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const KEY_FILES = [
  'dist/index.js',
  'dist/api/engine.js',
  'dist/internal/commands.js',
  'dist/internal/wasm/adapter.js',
  'dist/internal/wasm/engine.mjs',
  'dist/internal/wasm/engine.wasm',
  'dist/internal/wasm/audio.wasm',
  'dist/internal/audio/controller.js',
  'dist/internal/audio/processor.js',
];

/** Hashes the measured files and compares them with artifacts/build-manifest.json. */
export async function buildIdentity() {
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(`${ROOT}artifacts/build-manifest.json`, 'utf8'));
  } catch {
    /* Reported as missing below. */
  }
  const files = {};
  const mismatches = [];
  for (const file of KEY_FILES) {
    const bytes = await readFile(`${ROOT}packages/core/${file}`);
    files[file] = createHash('sha256').update(bytes).digest('hex');
    if (manifest && manifest.files?.[file] !== files[file]) mismatches.push(file);
  }
  return {
    package: manifest?.package ?? null,
    version: manifest?.version ?? null,
    manifest: manifest ? 'artifacts/build-manifest.json' : null,
    matchesManifest: manifest ? mismatches.length === 0 : null,
    mismatches,
    files,
  };
}

export async function environment(tool) {
  const cpus = os.cpus();
  const mac = process.platform === 'darwin';
  let toolchain = null;
  try {
    const pins = JSON.parse(await readFile(`${ROOT}toolchain.json`, 'utf8'));
    toolchain = {
      emscripten: pins.emscripten?.version ?? null,
      node: pins.node ?? null,
      playwright: pins.playwright ?? null,
    };
  } catch {
    /* Optional. */
  }
  return {
    tool,
    recordedAt: new Date().toISOString(),
    git: {
      commit: command('git', ['rev-parse', 'HEAD']),
      branch: command('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
      dirty: (command('git', ['status', '--porcelain', '--untracked-files=no']) ?? '') !== '',
    },
    build: await buildIdentity(),
    buildFlags: 'CMAKE_BUILD_TYPE=Release (tools/build-wasm.mjs); production validation enabled',
    pinnedToolchain: toolchain,
    node: process.version,
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      version: mac ? command('sw_vers', ['-productVersion']) : os.version(),
      model: mac ? command('sysctl', ['-n', 'hw.model']) : null,
    },
    cpu: { model: cpus[0]?.model ?? 'unknown', logical: cpus.length },
    memory: { totalBytes: os.totalmem(), freeBytesAtStart: os.freemem() },
    power: mac ? (command('pmset', ['-g', 'batt'])?.split('\n')[0] ?? null) : null,
    loadAverage: { start: os.loadavg().map((value) => Number(value.toFixed(2))), end: null },
    busy: null,
  };
}

/** Records the end-of-run load and flags a machine that was not quiet. */
export function finishEnvironment(env) {
  env.finishedAt = new Date().toISOString();
  env.loadAverage.end = os.loadavg().map((value) => Number(value.toFixed(2)));
  const threshold = Math.max(1, env.cpu.logical * 0.25);
  env.busyThreshold = threshold;
  env.busy = env.loadAverage.start[0] > threshold || env.loadAverage.end[0] > threshold;
  return env;
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------

export function formatValue(value, unit = 'ms') {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  if (Number.isNaN(value)) return 'n/a';
  if (!Number.isFinite(value)) return String(value);
  if (unit === 'bytes') {
    if (Math.abs(value) >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
    if (Math.abs(value) >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${Math.round(value)} B`;
  }
  const magnitude = Math.abs(value);
  const digits =
    magnitude === 0 ? 0 : magnitude < 0.01 ? 5 : magnitude < 1 ? 4 : magnitude < 100 ? 2 : 1;
  const text = Number.isInteger(value) && unit !== 'ms' ? String(value) : value.toFixed(digits);
  return unit === 'ms' ? `${text} ms` : unit === 'count' || unit === '' ? text : `${text} ${unit}`;
}

const escape = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');

function summaryRows(results) {
  const lines = [
    '| ID | Scenario | Metric | p50 | p95 | p99 | Mean | Target | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of results) {
    if (!result.rows?.length) {
      lines.push(
        `| ${result.id} | ${escape(result.title)} | — | — | — | — | — | — | ${result.status}${result.note ? `: ${escape(result.note)}` : ''} |`,
      );
      continue;
    }
    for (const entry of result.rows) {
      const { stats, unit } = entry;
      const distribution = stats && 'p95' in stats;
      const cells = distribution
        ? [stats.p50, stats.p95, stats.p99, stats.mean].map((value) => formatValue(value, unit))
        : [formatValue(stats?.value, unit), '—', '—', '—'];
      lines.push(
        `| ${result.id} | ${escape(entry.scenario)} | ${escape(entry.metric)} | ${cells.join(' | ')} | ${escape(entry.target?.text ?? '—')} | ${entry.status} |`,
      );
    }
  }
  return lines;
}

function detailSection(result) {
  const lines = [`### ${result.id} — ${result.title}`, '', `Status: **${result.status}**`];
  if (result.note) lines.push('', result.note);
  if (result.runtime) lines.push('', `Runs in: ${result.runtime}`);
  if (result.measures?.length)
    lines.push('', 'Measures:', '', ...result.measures.map((item) => `- ${item}`));
  if (result.excludes?.length)
    lines.push('', 'Does not measure:', '', ...result.excludes.map((item) => `- ${item}`));
  if (result.checks?.length) {
    lines.push('', '| Check | Observed | Expected | Status |', '| --- | --- | --- | --- |');
    for (const item of result.checks)
      lines.push(
        `| ${escape(item.name)} | ${escape(item.observed)} | ${escape(item.expected)} | ${item.status} |`,
      );
  }
  const spread = (result.rows ?? []).filter((entry) => entry.stats && 'p95Min' in entry.stats);
  if (spread.length) {
    lines.push('', 'Run-to-run spread of p95 (min–max over repetitions):', '');
    for (const entry of spread)
      lines.push(
        `- ${entry.scenario}, ${entry.metric}: ${formatValue(entry.stats.p95Min, entry.unit)} – ${formatValue(entry.stats.p95Max, entry.unit)} (${entry.stats.runs} runs, ${entry.stats.count} samples)`,
      );
  }
  if (result.observations && Object.keys(result.observations).length) {
    lines.push('', 'Observations:', '');
    for (const [key, value] of Object.entries(result.observations))
      lines.push(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  if (result.raw) lines.push('', `Raw samples: \`raw/${result.id}.json\``);
  lines.push('');
  return lines;
}

export function renderReport({ title, env, settings, results, preface = [], coverage = [] }) {
  const official = settings.deviations.length === 0 && !env.busy && !env.git.dirty;
  const build = env.build;
  const lines = [
    `# ${title}`,
    '',
    `Recorded: ${env.recordedAt} (finished ${env.finishedAt ?? 'n/a'}) with \`${env.tool}\`, mode \`${settings.mode}\`.`,
    '',
  ];
  if (!official) {
    lines.push(
      '> **Not an acceptance measurement.** ' +
        [
          settings.deviations.length
            ? `Settings deviate from the plan: ${settings.deviations.join('; ')}.`
            : '',
          env.busy
            ? `The machine was busy (1-minute load average ${env.loadAverage.start[0]} at start, ${env.loadAverage.end?.[0]} at end; threshold ${env.busyThreshold}).`
            : '',
          env.git.dirty ? 'The working tree had uncommitted changes.' : '',
        ]
          .filter(Boolean)
          .join(' ') +
        ' PASS/FAIL below is computed from these samples but is indicative only.',
      '',
    );
  }
  lines.push(
    '## Environment',
    '',
    `- Source: commit \`${env.git.commit ?? 'unknown'}\` on \`${env.git.branch ?? 'unknown'}\`${env.git.dirty ? ' (uncommitted changes present)' : ''}`,
    `- Build: ${build.package ?? 'unknown package'} ${build.version ?? ''}; manifest ${build.manifest ?? 'missing (run npm run build)'}; measured files ${build.matchesManifest === null ? 'not compared' : build.matchesManifest ? 'match the manifest' : `DIFFER from the manifest: ${build.mismatches.join(', ')}`}`,
    `- engine.wasm SHA-256: \`${build.files['dist/internal/wasm/engine.wasm']}\``,
    `- audio.wasm SHA-256: \`${build.files['dist/internal/wasm/audio.wasm']}\``,
    `- Build flags: ${env.buildFlags}; pinned Emscripten ${env.pinnedToolchain?.emscripten ?? 'unknown'}`,
    `- Node: ${env.node}`,
    `- OS: ${env.os.platform} ${env.os.version ?? ''} (kernel ${env.os.release}, ${env.os.arch})${env.os.model ? `, model ${env.os.model}` : ''}`,
    `- CPU: ${env.cpu.model}, ${env.cpu.logical} logical CPUs; memory ${formatValue(env.memory.totalBytes, 'bytes')}`,
    `- Power: ${env.power ?? 'not recorded'}`,
    `- Load average (1/5/15 min): start ${env.loadAverage.start.join(' / ')}, end ${env.loadAverage.end?.join(' / ') ?? 'n/a'}; flagged busy above ${env.busyThreshold}: ${env.busy ? 'yes' : 'no'}`,
    ...preface,
    '',
    '## Settings',
    '',
    `- Warm-up ${settings.warmupMs} ms, ${settings.runs} repetition(s) of ${settings.sampleMs} ms sampling (plan: at least ${PLAN.warmupMs} ms, ${PLAN.sampleMs} ms, ${PLAN.runs}).`,
    `- Deviations: ${settings.deviations.length ? settings.deviations.join('; ') : 'none'}.`,
    '- Percentiles use the nearest-rank method. Summary p50/p95/p99 and the mean are medians of the per-repetition values; the spread of the per-repetition p95 is listed per benchmark. A single value is shown in the p50 column.',
    '- Targets are stated per row and evaluated on the measured value (never hard-coded). They are engineering hypotheses from the plan until qualified on named hardware.',
    '',
    '## Summary',
    '',
    ...summaryRows(results),
    '',
  );
  if (coverage.length) lines.push('## Matrix coverage', '', ...coverage, '');
  lines.push('## Details', '');
  for (const result of results) lines.push(...detailSection(result));
  return lines.join('\n');
}

/**
 * Writes README.md, summary.json and raw/<ID>.json under
 * benchmarks/results/<ISO time>/, or under `--out=<directory>` when given.
 */
export async function writeResults(env, results, markdown, out = null) {
  const stamp = env.recordedAt.replaceAll(':', '-');
  const relative = out ? `${out.replace(/\/$/, '')}/${stamp}` : `benchmarks/results/${stamp}`;
  const directory = relative.startsWith('/') ? relative : `${ROOT}${relative}`;
  await mkdir(`${directory}/raw`, { recursive: true });
  for (const result of results)
    if (result.raw)
      await writeFile(`${directory}/raw/${result.id}.json`, JSON.stringify(result.raw));
  const summary = results.map(({ raw, ...rest }) => ({
    ...rest,
    raw: raw ? `raw/${rest.id}.json` : null,
  }));
  await writeFile(
    `${directory}/summary.json`,
    JSON.stringify({ environment: env, benchmarks: summary }, null, 2) + '\n',
  );
  await writeFile(`${directory}/README.md`, markdown);
  return relative;
}

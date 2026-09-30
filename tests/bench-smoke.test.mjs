// Runs every Node benchmark with tiny durations so the benchmark code cannot
// rot: each must execute against the real build and return a well-formed
// result whose statuses are computed from its own data. Timing targets are
// not asserted (this machine may be busy); correctness invariants are.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOT_EXECUTED,
  environment,
  evaluate,
  finishEnvironment,
  overallStatus,
  parseSettings,
  percentile,
  renderReport,
  summarize,
} from '../tools/bench/common.mjs';
import { NODE_BENCHMARKS } from '../tools/bench/core.mjs';

const settings = { ...parseSettings(['--smoke', '--warmup=5', '--sample=20']), runs: 1 };
const STATUSES = new Set(['PASS', 'FAIL', 'INFO']);
const results = new Map();

function assertWellFormed(result, id) {
  assert.equal(result.id, id);
  assert.equal(typeof result.title, 'string');
  assert.ok(result.measures.length > 0 && result.excludes.length > 0, 'states what it measures');
  assert.ok(result.rows.length > 0, 'has summary rows');
  for (const entry of result.rows) {
    assert.ok(STATUSES.has(entry.status), `${id} ${entry.scenario}: ${entry.status}`);
    const { stats } = entry;
    if ('p95' in stats) {
      for (const key of ['p50', 'p95', 'p99'])
        assert.ok(Number.isFinite(stats[key]) && stats[key] >= 0, `${id} ${entry.scenario} ${key}`);
      assert.ok(stats.p50 <= stats.p95 && stats.p95 <= stats.p99, `${id} percentiles are ordered`);
      assert.ok(stats.count > 0 && stats.runs === 1);
    } else assert.ok(Number.isFinite(stats.value), `${id} ${entry.scenario} value`);
    if (entry.target) {
      // The status is recomputed from the measured value, never taken as given.
      const measured = stats[entry.target.statistic];
      assert.equal(entry.status, evaluate(measured, entry.target.op, entry.target.limit));
    } else assert.equal(entry.status, 'INFO');
  }
  for (const item of result.checks) assert.ok(item.status === 'PASS' || item.status === 'FAIL');
  assert.equal(result.status, overallStatus(result));
  assert.ok(result.raw && typeof result.raw === 'object', 'keeps raw samples');
}

const passed = (result, prefix) => {
  const matching = result.checks.filter((item) => item.name.startsWith(prefix));
  assert.ok(matching.length > 0, `${result.id} has checks starting with "${prefix}"`);
  for (const item of matching)
    assert.equal(item.status, 'PASS', `${result.id}: ${item.name} (${item.observed})`);
};

for (const [id, run] of Object.entries(NODE_BENCHMARKS)) {
  test(
    `${id} runs on the real build and reports a well-formed result`,
    { timeout: 60_000 },
    async () => {
      const result = await run(settings);
      assertWellFormed(result, id);
      results.set(id, result);
    },
  );
}

test('engine invariants hold in the core benchmarks', () => {
  for (const id of ['B01', 'B02', 'B03', 'B04', 'B05']) {
    const result = results.get(id);
    assert.ok(result, `${id} ran`);
    passed(result, 'Steady frames make no C allocations');
    passed(result, 'Every measured frame');
  }
  passed(results.get('B01'), 'Rejected twins');
  passed(results.get('B05'), 'Over-cap batch');
  passed(results.get('B05'), 'Rejected batches');
  const ratios = results.get('B03').rows.filter((entry) => entry.unit === '×');
  assert.equal(ratios.length, 2, 'B03 reports both culling ratios');
});

test('the DSP and transport invariants hold', () => {
  const b07 = results.get('B07');
  for (const prefix of ['A renders', 'B output', 'B music', 'B bursts']) passed(b07, prefix);
  const b12 = results.get('B12');
  for (const prefix of [
    'Lost ACKs',
    'Stalled processor',
    'Saturated',
    'Voices were sounding',
    'STOP',
    'ACKs of batches sent before STOP',
    'A note after',
    'Pause',
    'Resume',
    'Device',
    'Failure',
  ])
    passed(b12, prefix);
  const silence = b12.rows.find((entry) => entry.scenario.startsWith('Frames until silence'));
  assert.ok(silence.stats.value <= 64);
});

test('statistics and settings follow the documented rules', () => {
  const sorted = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(percentile(sorted, 0.5), 5);
  assert.equal(percentile(sorted, 0.95), 10);
  assert.equal(percentile(sorted, 0.01), 1);
  const stats = summarize([3, 1, 2]);
  assert.deepEqual([stats.min, stats.p50, stats.max, stats.count], [1, 2, 3, 3]);
  assert.deepEqual(parseSettings([]).deviations, [], 'the default is the full plan');
  assert.equal(parseSettings(['--quick']).deviations.length, 3);
  assert.deepEqual(parseSettings(['--only=b03,B07']).only, ['B03', 'B07']);
  assert.throws(() => parseSettings(['--sample=abc']));
  assert.equal(evaluate(Number.NaN, '<=', 1), 'FAIL', 'a missing measurement never passes');
});

test('the report marks B08 and B10 honestly and lists every result', async () => {
  assert.equal(NOT_EXECUTED.B08.status, 'NOT RUN');
  assert.equal(NOT_EXECUTED.B08.note, 'not executed: needs a named physical device');
  assert.equal(NOT_EXECUTED.B10.status, 'N/A');
  assert.equal(NOT_EXECUTED.B10.note, 'not applicable (no worker runtime)');
  const env = finishEnvironment(await environment('tests/bench-smoke.test.mjs'));
  assert.match(env.build.files['dist/internal/wasm/engine.wasm'], /^[0-9a-f]{64}$/);
  const all = [...results.values(), NOT_EXECUTED.B08, NOT_EXECUTED.B10];
  const markdown = renderReport({ title: 'Smoke', env, settings, results: all });
  assert.match(markdown, /Not an acceptance measurement/);
  assert.match(markdown, /NOT RUN: not executed: needs a named physical device/);
  assert.match(markdown, /N\/A: not applicable \(no worker runtime\)/);
  for (const result of all) assert.ok(markdown.includes(`### ${result.id} — `), result.id);
});

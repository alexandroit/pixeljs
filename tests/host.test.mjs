import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, PixelJSError, version } from '../packages/core/dist/index.js';
import { integer, flag } from '../packages/core/dist/api/errors.js';

test('ESM import has no DOM side effects and exports no raw memory or handles', () => {
  assert.equal(version, '0.0.5');
  assert.equal(typeof createEngine, 'function');
  assert.equal(typeof globalThis.window, 'undefined');
});
test('visual creation without a DOM returns an understandable structured error', async () => {
  await assert.rejects(
    createEngine({ canvas: null }),
    (e) => e instanceof PixelJSError && e.code === 'UNSUPPORTED',
  );
  await assert.rejects(createEngine(null), (e) => e.code === 'ARGUMENT');
});
test('public numeric validation rejects JavaScript coercion, fractions and nonfinite values', () => {
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    1.5,
    '2',
    null,
    undefined,
    {},
    2147483648,
    -2147483649,
  ]) {
    assert.throws(() => integer(value, 'coordinate', -2147483648, 2147483647), PixelJSError);
  }
  assert.equal(integer(-2147483648, 'coordinate', -2147483648, 2147483647), -2147483648);
  assert.equal(integer(2147483647, 'coordinate', -2147483648, 2147483647), 2147483647);
  assert.throws(() => flag(1, 'flipX'), PixelJSError);
  assert.equal(flag(undefined, 'flipX'), false);
});

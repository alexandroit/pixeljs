// Deterministic checks of the DOM-free input and viewport logic in the built
// SDK. Browser behavior (events, capture, focus, layout) is covered by
// tests/browser/input.spec.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PixelJSError } from '../packages/core/dist/index.js';
import { PointerTracker, MAX_POINTERS } from '../packages/core/dist/host/web/pointers.js';
import {
  GamepadTracker,
  GAMEPAD_BUTTONS,
  GAMEPAD_AXES,
  deadZone,
} from '../packages/core/dist/host/web/gamepads.js';
import { wheelLines, WHEEL_LIMIT } from '../packages/core/dist/host/web/input.js';
import {
  fittedSize,
  mapPoint,
  placeContent,
  scalingMode,
} from '../packages/core/dist/host/web/viewport.js';

const code = (expected) => (error) => error instanceof PixelJSError && error.code === expected;
const at = (x, y) => ({ x, y });

test('pointer contacts are latched per tick in first-contact order with stable ids', () => {
  const pointers = new PointerTracker();
  assert.equal(pointers.press(7, 'touch', true, 1, at(1, 2)), true);
  assert.equal(pointers.press(9, 'touch', false, 1, at(3, 4)), true);
  // Nothing is visible before a tick.
  assert.deepEqual(pointers.pointers, []);
  pointers.tick();
  const [first, second] = pointers.pointers;
  assert.ok(Object.isFrozen(pointers.pointers) && Object.isFrozen(first));
  assert.deepEqual(first, {
    id: first.id,
    type: 'touch',
    x: 1,
    y: 2,
    buttons: 1,
    down: true,
    pressed: true,
    released: false,
  });
  assert.notEqual(first.id, second.id);
  const latched = pointers.pointers;
  pointers.move(9, 'touch', false, 0, at(5, 6));
  // Snapshots are copies: later events never change an earlier tick.
  assert.equal(latched[1].x, 3);
  pointers.tick();
  assert.notEqual(pointers.pointers, latched);
  assert.deepEqual(
    pointers.pointers.map(({ id, x, y, pressed }) => [id, x, y, pressed]),
    [
      [first.id, 1, 2, false],
      [second.id, 5, 6, false],
    ],
  );
  assert.equal(pointers.release(7, at(0, 0)), 1);
  pointers.tick();
  assert.deepEqual(
    pointers.pointers.map(({ id, down, released }) => [id, down, released]),
    [
      [first.id, false, true],
      [second.id, true, false],
    ],
  );
  pointers.tick();
  assert.deepEqual(
    pointers.pointers.map(({ id }) => id),
    [second.id],
  );
});

test('a press and release between ticks reports both edges once; a press after it is new', () => {
  const pointers = new PointerTracker();
  pointers.press(1, 'mouse', true, 2, at(4, 4));
  assert.equal(pointers.pointer.down, true);
  assert.equal(pointers.release(1, at(5, 4)), 2);
  pointers.press(1, 'mouse', true, 1, at(6, 4));
  pointers.tick();
  const [tap, again] = pointers.pointers;
  assert.deepEqual(tap, {
    id: tap.id,
    type: 'mouse',
    x: 5,
    y: 4,
    // A released snapshot keeps the buttons held before the release.
    buttons: 2,
    down: false,
    pressed: true,
    released: true,
  });
  assert.deepEqual([again.x, again.down, again.pressed, again.released], [6, true, true, false]);
  assert.notEqual(tap.id, again.id);
  assert.deepEqual(pointers.pointer, {
    id: again.id,
    type: 'mouse',
    x: 6,
    y: 4,
    buttons: 1,
    down: true,
    pressed: true,
    released: true,
  });
  // A catch-up tick does not repeat edges.
  pointers.tick();
  assert.deepEqual(
    pointers.pointers.map(({ pressed, released }) => [pressed, released]),
    [[false, false]],
  );
  assert.equal(pointers.pointer.pressed, false);
});

test('the primary pointer hovers, then reports its last position without a contact', () => {
  const pointers = new PointerTracker();
  assert.deepEqual(pointers.pointer, {
    id: 0,
    type: 'mouse',
    x: 0,
    y: 0,
    buttons: 0,
    down: false,
    pressed: false,
    released: false,
  });
  pointers.move(1, 'pen', true, 0, at(3, 3));
  // A secondary pointer's hover is not the primary pointer.
  pointers.move(2, 'touch', false, 0, at(9, 9));
  assert.deepEqual([pointers.pointer.type, pointers.pointer.x, pointers.pointer.y], ['pen', 3, 3]);
  pointers.press(1, 'pen', true, 1, at(4, 4));
  // While a primary contact is held, hover of other primaries is ignored.
  pointers.move(5, 'mouse', true, 0, at(8, 8));
  pointers.move(1, 'pen', true, 3, at(5, 5));
  assert.deepEqual([pointers.pointer.x, pointers.pointer.buttons], [5, 3]);
  // A zero `buttons` (a source that does not report them) keeps the held buttons.
  pointers.move(1, 'pen', true, 0, null);
  assert.equal(pointers.pointer.buttons, 3);
  assert.equal(pointers.cancel(1), true);
  assert.equal(pointers.cancel(1), false);
  pointers.tick();
  assert.deepEqual(pointers.pointer, {
    id: pointers.pointers[0].id,
    type: 'pen',
    x: 5,
    y: 5,
    buttons: 0,
    down: false,
    pressed: true,
    released: true,
  });
  pointers.tick();
  assert.equal(pointers.pointer.id, 0);
  pointers.resize(4, 4);
  assert.deepEqual([pointers.pointer.x, pointers.pointer.y], [3, 3]);
});

test('contacts beyond the limit are ignored and counted; reset drops everything silently', () => {
  const pointers = new PointerTracker();
  for (let id = 0; id < MAX_POINTERS + 2; id++) pointers.press(id, 'touch', id === 0, 1, at(id, 0));
  assert.equal(pointers.overflows, 2);
  assert.equal(pointers.holds(MAX_POINTERS), false);
  // Chords of a held pointer are not new contacts.
  assert.equal(pointers.press(0, 'touch', true, 3, at(0, 0)), false);
  pointers.tick();
  assert.equal(pointers.pointers.length, MAX_POINTERS);
  // Ended contacts keep their slot until a tick has reported them.
  pointers.release(3, null);
  assert.equal(pointers.press(20, 'touch', false, 1, null), false);
  assert.equal(pointers.overflows, 3);
  pointers.tick();
  assert.equal(pointers.press(20, 'touch', false, 1, null), true);
  assert.equal(pointers.holding, true);
  const held = pointers.reset();
  assert.equal(held.length, MAX_POINTERS);
  assert.equal(pointers.holding, false);
  assert.deepEqual(pointers.pointers, []);
  pointers.tick();
  // No released edges are invented for dropped contacts.
  assert.deepEqual(pointers.pointers, []);
  assert.equal(pointers.release(20, null), 0);
});

test('gamepads: standard names, triggers, dead zone and one-tick edges', () => {
  assert.equal(GAMEPAD_BUTTONS.length, 17);
  assert.deepEqual(GAMEPAD_AXES, ['leftX', 'leftY', 'rightX', 'rightY']);
  const button = (pressed, value = pressed ? 1 : 0) => ({ pressed, value });
  const pad = {
    index: 0,
    id: 'Pad',
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => button(false)),
    axes: [0, 0, 0, 0],
  };
  const pads = new GamepadTracker();
  pad.buttons[0] = button(true);
  pads.poll(() => [pad]);
  // A pad has no edges in the first poll it appears in.
  assert.deepEqual(
    [pads.isButtonDown('A'), pads.wasButtonPressed('A'), pads.wasButtonReleased('A')],
    [true, false, false],
  );
  pad.buttons[0] = button(false);
  pad.buttons[6] = button(true, 0.5);
  pad.buttons[7] = button(false, 0.51);
  pad.buttons[15] = button(true);
  pads.poll(() => [pad]);
  assert.equal(pads.wasButtonReleased('A'), true);
  assert.equal(pads.isButtonDown('LT'), false, 'a trigger needs more than half its travel');
  assert.equal(pads.isButtonDown('RT'), true, 'a trigger value counts even if not flagged');
  assert.deepEqual([pads.isButtonDown('Right'), pads.wasButtonPressed('Right')], [true, true]);
  pads.poll(() => [pad]);
  assert.deepEqual([pads.isButtonDown('Right'), pads.wasButtonPressed('Right')], [true, false]);
  const snapshots = pads.gamepads;
  assert.ok(Object.isFrozen(snapshots) && Object.isFrozen(snapshots[0].buttons));
  assert.ok(Object.isFrozen(snapshots[0].axes));
  // A reset starts a new baseline: held buttons are down without an edge.
  pads.reset();
  assert.deepEqual(pads.gamepads, []);
  assert.equal(pads.isButtonDown('Right'), false);
  pads.poll(() => [pad]);
  assert.deepEqual([pads.isButtonDown('Right'), pads.wasButtonPressed('Right')], [true, false]);
  // A pad that disappears reads as nothing pressed and reports no releases.
  pads.poll(() => [{ ...pad, connected: false }]);
  assert.deepEqual(
    [pads.isButtonDown('Right'), pads.wasButtonReleased('Right'), pads.gamepads.length],
    [false, false, 0],
  );
});

test('gamepads: axes, ids, bounds and hostile sources', () => {
  assert.equal(deadZone(0.15), 0);
  assert.equal(deadZone(-0.15), 0);
  assert.equal(deadZone(1), 1);
  assert.equal(deadZone(-1), -1);
  assert.equal(deadZone(4), 1);
  assert.ok(Math.abs(deadZone(0.575) - 0.5) < 1e-12);
  assert.ok(Math.abs(deadZone(-0.575) + 0.5) < 1e-12);
  for (const value of [Number.NaN, Infinity, -Infinity, '1', null, undefined, {}])
    assert.equal(deadZone(value), 0);
  assert.ok(Object.is(deadZone(-0.1), 0), 'no negative zero');
  const pads = new GamepadTracker();
  const pad = (index, extra = {}) => ({
    index,
    id: `pad ${index}`,
    connected: true,
    mapping: 'standard',
    buttons: [],
    axes: [],
    ...extra,
  });
  const throwing = {
    index: 2,
    connected: true,
    get buttons() {
      throw new Error('broken pad');
    },
  };
  pads.poll(() => [
    pad(3, { id: `${'x'.repeat(127)}\u{1F3AE}`, axes: [0.5, -2, 'x'] }),
    pad(3, { id: 'duplicate index' }),
    pad(4),
    pad(-1),
    pad(1.5),
    null,
    throwing,
    pad(1, { mapping: '', buttons: [0.6, { pressed: true, value: 0.1 }], axes: [0.2] }),
  ]);
  const found = pads.gamepads;
  assert.deepEqual(
    found.map(({ index, mapping }) => [index, mapping]),
    [
      [1, 'unknown'],
      [3, 'standard'],
    ],
  );
  // Truncated to 128 code units, never ending on half a surrogate pair.
  assert.equal(found[1].id, 'x'.repeat(127));
  assert.equal(found[1].axes.length, 4);
  assert.deepEqual(found[1].axes.slice(1), [-1, 0, 0]);
  assert.deepEqual(found[0].buttons.slice(0, 3), [true, true, false]);
  assert.equal(pads.axis('leftX', 1), deadZone(0.2));
  assert.equal(pads.axis('rightY', 2), 0);
  // At most sixteen entries of the browser list are examined.
  pads.poll(() => [...Array(16).fill(null), pad(0)]);
  assert.deepEqual(pads.gamepads, []);
  for (const source of [
    () => {
      throw new Error('SecurityError');
    },
    () => null,
    () => 42,
    () => ({ length: Infinity }),
  ]) {
    pads.poll(source);
    assert.deepEqual(pads.gamepads, []);
  }
  assert.throws(() => pads.isButtonDown('Z'), code('ARGUMENT'));
  assert.throws(() => pads.isButtonDown('toString'), code('ARGUMENT'));
  assert.throws(() => pads.wasButtonPressed(0), code('ARGUMENT'));
  assert.throws(() => pads.isButtonDown('A', 4), code('RANGE'));
  assert.throws(() => pads.wasButtonReleased('A', -1), code('RANGE'));
  assert.throws(() => pads.isButtonDown('A', 1.5), code('RANGE'));
  assert.throws(() => pads.axis('up'), code('ARGUMENT'));
  assert.throws(() => pads.axis('leftX', '0'), code('RANGE'));
  assert.equal(pads.isButtonDown('Home', 3), false);
});

test('wheel deltas become lines and the documented limits hold', () => {
  assert.equal(wheelLines(32, 0, 144), 2);
  assert.equal(wheelLines(-3, 1, 144), -3);
  assert.equal(wheelLines(1, 2, 144), 18);
  // A page is at least one line on tiny framebuffers.
  assert.equal(wheelLines(1, 2, 4), 1);
  // Unknown modes are treated as pixels.
  assert.equal(wheelLines(16, 7, 144), 1);
  for (const delta of [Number.NaN, Infinity, -Infinity]) assert.equal(wheelLines(delta, 1, 144), 0);
  assert.equal(WHEEL_LIMIT, 100);
});

test('fit and integer scaling choose whole device pixels inside the parent', () => {
  const logical = { width: 16, height: 9 };
  const size = (mode, width, height, ratio) =>
    Object.values(fittedSize(mode, { width, height }, logical, ratio)).map(
      (value) => Math.round(value * 1e4) / 1e4,
    );
  assert.deepEqual(size('integer', 300, 200, 1), [288, 162]);
  assert.deepEqual(size('integer', 300, 200, 2), [296, 166.5]);
  assert.deepEqual(size('integer', 300, 200, 3), [298.6667, 168]);
  assert.deepEqual(size('integer', 300, 200, 1.5), [298.6667, 168]);
  // Exactly 29 device pixels per logical pixel, although 16 × 29 / 1.1 × 1.1 / 16
  // evaluates to 28.999999999999996.
  assert.deepEqual(size('integer', (16 * 29) / 1.1, 1000, 1.1), [421.8182, 237.2727]);
  // Below one device pixel per logical pixel, integer falls back to fit.
  assert.deepEqual(size('integer', 5, 5, 1), [5, 2]);
  assert.deepEqual(size('integer', 5, 5, 2), [5, 2.5]);
  assert.deepEqual(size('fit', 300, 200, 1), [300, 168]);
  assert.deepEqual(size('fit', 300, 200, 3), [300, 168.6667]);
  for (const [width, height] of [
    [0, 100],
    [-5, 100],
    [Number.NaN, 100],
  ])
    assert.deepEqual(size('fit', width, height, 1), [0, 0]);
  // An invalid ratio counts as one.
  assert.deepEqual(size('integer', 300, 200, 0), [288, 162]);
  assert.deepEqual(size('integer', 300, 200, Number.NaN), [288, 162]);
});

test('object-fit and object-position place the framebuffer inside the content box', () => {
  const box = { left: 10, top: 20, width: 256, height: 128 };
  const place = (fit, position, scale = 1) =>
    Object.values(placeContent(box, 16, 16, fit, position, scale, scale));
  assert.deepEqual(place('fill', '50% 50%'), [10, 20, 256, 128]);
  assert.deepEqual(place('contain', '50% 50%'), [74, 20, 128, 128]);
  assert.deepEqual(place('contain', '0% 0%'), [10, 20, 128, 128]);
  assert.deepEqual(place('contain', '100% 100%'), [138, 20, 128, 128]);
  assert.deepEqual(place('contain', '10px 20%'), [20, 20, 128, 128]);
  // Forms other than two lengths/percentages count as centered.
  assert.deepEqual(place('contain', 'calc(10% + 2px) 0%'), [74, 20, 128, 128]);
  assert.deepEqual(place('contain', 'right 10px bottom 5px'), [74, 20, 128, 128]);
  assert.deepEqual(place('cover', '50% 50%'), [10, -44, 256, 256]);
  assert.deepEqual(place('none', '50% 50%'), [130, 76, 16, 16]);
  assert.deepEqual(place('none', '50% 50%', 2), [122, 68, 32, 32]);
  assert.deepEqual(place('scale-down', '50% 50%'), [130, 76, 16, 16]);
  assert.deepEqual(
    Object.values(placeContent({ left: 0, top: 0, width: 8, height: 4 }, 16, 16, 'scale-down', '')),
    [2, 0, 4, 4],
  );
  // Unknown values stretch like fill.
  assert.deepEqual(place('stretch', ''), [10, 20, 256, 128]);
});

test('client points map to clamped logical pixels and margins are detected', () => {
  const border = { left: 0, top: 0, width: 256, height: 128 };
  const content = border;
  const image = placeContent(content, 16, 16, 'contain', '50% 50%');
  const map = (x, y) => mapPoint(x, y, border, content, image, 16, 16);
  assert.deepEqual(map(64 + 3.5 * 8, 5.5 * 8), { x: 3, y: 5, margin: false });
  assert.deepEqual(map(20, 64), { x: 0, y: 8, margin: true });
  assert.deepEqual(map(236, 64), { x: 15, y: 8, margin: true });
  // Image edges belong to the image; outside the canvas nothing is a margin.
  assert.deepEqual(map(192, 128), { x: 15, y: 15, margin: false });
  assert.deepEqual(map(-50, 400), { x: 0, y: 15, margin: false });
  assert.deepEqual(map(Number.NaN, Infinity), { x: 0, y: 0, margin: false });
  // Borders and padding outside the content box are margins too.
  const framed = { left: 0, top: 0, width: 304, height: 304 };
  const inner = { left: 24, top: 24, width: 256, height: 256 };
  const filled = placeContent(inner, 16, 16, 'fill', '');
  assert.equal(mapPoint(12, 100, framed, inner, filled, 16, 16).margin, true);
  assert.deepEqual(mapPoint(24 + 5.5 * 16, 30, framed, inner, filled, 16, 16), {
    x: 5,
    y: 0,
    margin: false,
  });
  // With cover, the part of the image outside the content box is hidden.
  const cover = placeContent(border, 16, 16, 'cover', '50% 50%');
  assert.deepEqual(mapPoint(4, 4, border, content, cover, 16, 16), { x: 0, y: 4, margin: false });
});

test('scaling options are validated', () => {
  const view = { ResizeObserver: class {} };
  assert.equal(scalingMode(undefined, view), 'manual');
  assert.equal(scalingMode('manual', {}), 'manual');
  assert.equal(scalingMode('fit', view), 'fit');
  assert.equal(scalingMode('integer', view), 'integer');
  for (const value of ['stretch', 'FIT', 1, null, {}])
    assert.throws(() => scalingMode(value, view), code('ARGUMENT'));
  assert.throws(() => scalingMode('fit', {}), code('UNSUPPORTED'));
});

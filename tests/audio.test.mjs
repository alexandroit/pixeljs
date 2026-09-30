import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AudioController, AUDIO_LIMITS } from '../packages/core/dist/internal/audio/controller.js';
import { PixelJSError } from '../packages/core/dist/api/errors.js';

const audioBytes = await readFile('packages/core/dist/internal/wasm/audio.wasm');
const note = {
  waveform: 0,
  frequency: 440,
  volume: 0.8,
  attack: 0.005,
  decay: 0.01,
  sustain: 0.7,
  release: 0.05,
  duration: 0.2,
  effect: 0,
  slideTo: 0,
};

test('audio.wasm standalone binary exports private ABI and renders all waveforms', async () => {
  assert.ok(audioBytes.length > 0 && audioBytes.length < 32768, 'audio.wasm must be under 32 KiB');
  const module = await WebAssembly.compile(audioBytes);
  assert.equal(WebAssembly.Module.imports(module).length, 0, 'audio.wasm has no imports');
  const { exports } = await WebAssembly.instantiate(module, {});
  exports.__wasm_call_ctors?.();
  const { memory, pxa_initialize, pxa_buffer_offset, pxa_render, pxa_note_on, pxa_note_off } =
    exports;
  const { pxa_stop, pxa_set_master_volume, pxa_is_active } = exports;
  assert.equal(memory.buffer.byteLength, 65536, 'audio WASM uses exactly one 64 KiB page');
  assert.equal(pxa_initialize(48000), 0);
  assert.equal(pxa_is_active(), 0);
  const offset = pxa_buffer_offset();
  const samples = (count) => new Float32Array(memory.buffer, offset, count);
  assert.equal(pxa_render(128), 128);
  assert.ok(samples(128).every((value) => value === 0));

  assert.equal(pxa_note_on(0, 0, 440, 0.8, 0.005, 0.01, 0.7, 0.05, 0.2), 1);
  pxa_render(128);
  assert.ok(samples(128).some((value) => value !== 0));
  assert.ok(samples(128).every((value) => value >= -1 && value <= 1));
  for (const [voice, wave] of [
    [1, 1],
    [2, 2],
    [3, 3],
  ])
    assert.equal(pxa_note_on(voice, wave, 220 * voice, 0.5, 0.001, 0.01, 0.8, 0.02, 0.2), 1);
  for (const block of [16, 64, 128, 256, 512]) {
    assert.equal(pxa_render(block), block);
    assert.ok(samples(block).every((value) => Number.isFinite(value) && Math.abs(value) <= 1));
  }
  // Oversized requests are clamped to the fixed buffer.
  assert.equal(pxa_render(4096), 512);

  // The C boundary rejects values the JavaScript validators also reject.
  assert.equal(pxa_note_on(0, 256, 440, 1, 0, 0, 1, 0, 1), 0, 'waveform 256 must not alias 0');
  assert.equal(pxa_note_on(7, 0, 440, 1, 0, 0, 1, 0, 1), 0, 'voice must be 0-3 or automatic');
  assert.equal(pxa_note_on(0, 0, NaN, 1, 0, 0, 1, 0, 1), 0);
  assert.equal(pxa_note_on(0, 0, 440, 1, 0, 0, 1, 0, 0), 0, 'a note needs a positive gate');
  assert.equal(pxa_note_on(0, 0, 440, 1, 0, 0, 1, 0, Infinity), 0);

  assert.equal(pxa_set_master_volume(0), 0);
  pxa_render(128);
  assert.ok(
    samples(128).every((value) => value === 0),
    'zero master volume is silent',
  );
  assert.equal(pxa_set_master_volume(1), 0);
  assert.equal(pxa_note_off(0), 0);
  assert.equal(pxa_stop(), 0);
  pxa_render(128);
  assert.equal(pxa_is_active(), 0, 'stop fades every voice out within 64 samples');
  pxa_render(128);
  assert.ok(samples(128).every((value) => value === 0));
});

/** A controller wired to a recording port, as if unlock() had succeeded. */
function runningController(reports = []) {
  const controller = new AudioController({ canvas: {} }, (error) => reports.push(error));
  const sent = [];
  const node = {
    port: { postMessage: (message) => sent.push(message), close() {} },
    disconnect() {},
  };
  const context = {
    state: 'running',
    currentTime: 0,
    suspend: async () => {},
    resume: async () => {},
    close: async () => {
      context.state = 'closed';
    },
  };
  Object.assign(controller, { ready: true, state: 'running', context, node });
  const ack = (message) => controller.receive({ type: 'ack', ...message });
  return { controller, sent, ack };
}

test('AudioController validates sounds and never replays notes queued before unlock', async () => {
  const controller = new AudioController({ canvas: {} });
  assert.equal(controller.capabilities.supported, false, 'Node has no Web Audio');
  assert.equal(controller.capabilities.state, 'uninitialized');
  const invalid = [
    [{ waveform: 'sawtooth' }, 'ARGUMENT'],
    [{ frequency: -10 }, 'RANGE'],
    [{ frequency: 30000 }, 'RANGE'],
    [{ volume: 1.5 }, 'RANGE'],
    [{ attack: Number.NaN }, 'RANGE'],
    [{ duration: 0 }, 'RANGE'],
    [{ duration: 61 }, 'RANGE'],
  ];
  for (const [options, code] of invalid)
    assert.throws(
      () => controller.createSound(options),
      (error) => error instanceof PixelJSError && error.code === code,
    );
  const sound = controller.createSound({ waveform: 'square', frequency: 440, duration: 0.25 });
  assert.ok(Object.isFrozen(sound) && sound.duration === 0.25 && sound.sustain === 0.7);
  // Before unlock, play() returns an inert instance and queues nothing.
  for (let index = 0; index < 5000; index++) controller.play(sound);
  assert.equal(controller.pending.length, 0);
  controller.markReleased(sound);
  assert.throws(
    () => controller.play(sound),
    (error) => error.code === 'HANDLE',
  );
  await assert.rejects(controller.unlock(), (error) => error.code === 'UNSUPPORTED');
});

test('audio transport bounds batches, credits, acknowledgements and queued events', () => {
  const { controller, sent, ack } = runningController();
  const sound = controller.createSound({ frequency: 330 });
  for (let index = 0; index < 300; index++) controller.play(sound);
  // Notes leave immediately while credits last; later ones wait and coalesce.
  const batches = sent.filter((message) => message.type === 'batch');
  assert.equal(batches.length, AUDIO_LIMITS.batchesInFlight);
  assert.ok(batches.every((batch) => batch.events.length === 1));
  assert.equal(controller.pending.length, 300 - AUDIO_LIMITS.batchesInFlight);
  // Mismatched, unknown and duplicate acknowledgements return no credit.
  ack({ epoch: 99, sequence: batches[0].sequence });
  ack({ epoch: 0, sequence: 12345 });
  assert.equal(sent.filter((message) => message.type === 'batch').length, 4);
  ack({ epoch: 0, sequence: batches[0].sequence });
  ack({ epoch: 0, sequence: batches[0].sequence });
  const after = sent.filter((message) => message.type === 'batch');
  assert.equal(after.length, 5);
  assert.equal(after[4].events.length, AUDIO_LIMITS.eventsPerBatch);
  assert.equal(controller.pending.length, 296 - AUDIO_LIMITS.eventsPerBatch);
  // A stalled audio thread cannot grow the queue without bound.
  while (controller.pending.length < AUDIO_LIMITS.pendingEvents) controller.play(sound);
  assert.throws(
    () => controller.play(sound),
    (error) => error.code === 'CAPACITY',
  );

  // Stop uses its own path, even with every credit in use: it empties the
  // queue and starts a new epoch. Batches already sent keep their credits
  // until the processor acknowledges them.
  controller.stop();
  assert.deepEqual(sent.at(-1), { type: 'stop', epoch: 1 });
  assert.equal(controller.pending.length, 0);
  const before = sent.length;
  controller.play(sound);
  assert.equal(sent.length, before, 'no credit is free yet');
  ack({ epoch: 0, sequence: batches[1].sequence });
  assert.equal(sent.at(-1).type, 'batch');
  assert.equal(sent.at(-1).epoch, 1, 'an acknowledgement from before the stop returns its credit');

  // Stops made before the processor confirms the previous one wait and
  // coalesce into the newest epoch; its batches wait behind the stop.
  const posted = sent.length;
  controller.stop();
  controller.play(sound);
  controller.stop();
  controller.play(sound);
  assert.equal(sent.length, posted, 'at most one unconfirmed stop is in the port');
  controller.receive({ type: 'stopped', epoch: 2 });
  assert.equal(sent.length, posted, 'confirming a stop never sent changes nothing');
  controller.receive({ type: 'stopped', epoch: 1 });
  assert.deepEqual(sent.at(-1), { type: 'stop', epoch: 3 });
  ack({ epoch: 0, sequence: batches[2].sequence });
  assert.equal(sent.at(-1).type, 'batch');
  assert.equal(sent.at(-1).epoch, 3);
  assert.equal(sent.at(-1).events.length, 1, 'notes queued before the last stop were dropped');
});

test('a processor that reads nothing holds at most the batch credits and one stop', () => {
  const { controller, sent } = runningController();
  const sound = controller.createSound({ frequency: 330 });
  for (let cycle = 0; cycle < 20; cycle++) {
    for (let index = 0; index < 50; index++) controller.play(sound);
    controller.stop();
  }
  for (let index = 0; index < 50; index++) controller.play(sound);
  assert.equal(
    sent.filter((message) => message.type === 'batch').length,
    AUDIO_LIMITS.batchesInFlight,
  );
  assert.deepEqual(
    sent.filter((message) => message.type === 'stop'),
    [{ type: 'stop', epoch: 1 }],
  );
  assert.equal(controller.pending.length, 50, 'only the notes after the last stop wait');
});

test('sound instances stop only their own note and pauses drop new notes', async () => {
  const reports = [];
  const { controller, sent } = runningController(reports);
  const first = controller.play({ frequency: 200 }, 2);
  const second = controller.play({ frequency: 300 }, 2);
  const count = () => sent.flatMap((message) => message.events ?? []).length;
  const events = count();
  first.stop();
  assert.equal(count(), events, 'an older instance cannot stop a newer note on its voice');
  second.stop();
  assert.deepEqual(sent.at(-1).events.at(-1), { kind: 'note_off', voice: 2 });
  assert.throws(
    () => controller.stop({ voice: 2, stop() {} }),
    (error) => error.code === 'HANDLE',
  );
  controller.stop();
  const afterStop = count();
  second.stop();
  assert.equal(count(), afterStop, 'instances from before stop() are inert');

  controller.onPause('manual');
  controller.play({ frequency: 440 });
  assert.equal(controller.pending.length, 0, 'paused audio drops notes instead of bursting later');
  controller.onResume('manual');

  // A processor error is reported once and leaves the controller inert.
  controller.receive({ type: 'error', message: 'boom' });
  controller.receive({ type: 'error', message: 'again' });
  assert.equal(controller.capabilities.state, 'failed');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].code, 'AUDIO_ERROR');
  controller.play({ frequency: 440 });
  assert.equal(controller.pending.length, 0);
  await assert.rejects(controller.unlock(), (error) => error.code === 'STATE');
});

test('stops reach paused audio and full queues; dropped notes never orphan a playing one', () => {
  const { controller, sent } = runningController();
  const events = () => sent.flatMap((message) => message.events ?? []);
  const playing = controller.play({ frequency: 200 }, 1);
  controller.onPause('manual');
  const dropped = controller.play({ frequency: 300 }, 1);
  assert.equal(events().length, 1, 'a note played while paused is dropped');
  dropped.stop();
  controller.stop(dropped);
  assert.equal(events().length, 1, 'the instance of a dropped note does nothing');
  playing.stop();
  assert.deepEqual(events().at(-1), { kind: 'note_off', voice: 1 }, 'the stop is not lost');
  playing.stop();
  assert.equal(events().length, 2, 'an instance stops its note once');
  controller.onResume('manual');

  // Two credits remain; then the stalled audio thread lets the queue fill.
  const early = controller.play({ frequency: 250 }, 3);
  let last = early;
  while (controller.pending.length < AUDIO_LIMITS.pendingEvents)
    last = controller.play({ frequency: 440 }, 3);
  assert.throws(
    () => controller.play({ frequency: 440 }, 3),
    (error) => error.code === 'CAPACITY',
  );
  early.stop();
  assert.equal(controller.pending.length, AUDIO_LIMITS.pendingEvents, 'a replaced note is inert');
  last.stop();
  last.stop();
  assert.equal(controller.pending.length, AUDIO_LIMITS.pendingEvents + 1);
  assert.deepEqual(controller.pending.at(-1), { kind: 'note_off', voice: 3 });
});

test('notes still queued when audio stops are dropped and silence their voices', () => {
  const { controller, sent, ack } = runningController();
  for (let voice = 0; voice < 4; voice += 1) controller.play({ frequency: 200 }, voice);
  const batches = sent.filter((message) => message.type === 'batch');
  assert.equal(batches.length, AUDIO_LIMITS.batchesInFlight);
  controller.play({ frequency: 300 }, 2);
  controller.play({ frequency: 310 }, 2);
  controller.play({ frequency: 320 }, 0);
  controller.onPause('hidden');
  // No credit is free, so the replacement stops wait in the queue.
  assert.deepEqual(controller.pending, [
    { kind: 'note_off', voice: 2 },
    { kind: 'note_off', voice: 0 },
  ]);
  ack({ epoch: 0, sequence: batches[0].sequence });
  assert.deepEqual(sent.at(-1).events, [
    { kind: 'note_off', voice: 2 },
    { kind: 'note_off', voice: 0 },
  ]);
  controller.onResume('hidden');
  assert.equal(controller.pending.length, 0, 'nothing is replayed after the pause');

  // A suspension the page did not ask for (another app took the device).
  for (const batch of batches.slice(1)) ack({ epoch: 0, sequence: batch.sequence });
  ack({ epoch: 0, sequence: sent.at(-1).sequence });
  for (let index = 0; index < 5; index += 1) controller.play({ frequency: 500 }, 1);
  assert.equal(controller.pending.length, 1);
  controller.context.state = 'suspended';
  ack({ epoch: 0, sequence: sent.at(-1).sequence });
  assert.deepEqual(sent.at(-1).events, [{ kind: 'note_off', voice: 1 }]);
});

/** Installs a scripted Web Audio and fetch in Node for startup paths. */
function fakeWebAudio(settings) {
  const { addModule = async () => {}, respond } = settings;
  const saved = { window: globalThis.window, fetch: globalThis.fetch };
  const contexts = [];
  class FakeContext {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule };
    pending = null;
    constructor() {
      contexts.push(this);
    }
    resume() {
      if (settings.resumes ?? true) {
        this.state = 'running';
        return Promise.resolve();
      }
      // Like browsers, a resume still waiting when the context closes rejects.
      return new Promise((_, reject) => {
        this.pending = reject;
      });
    }
    async suspend() {
      this.state = 'suspended';
    }
    async close() {
      this.state = 'closed';
      this.pending?.(new Error('InvalidStateError: the context was closed.'));
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
  }
  globalThis.window = { AudioContext: FakeContext, AudioWorkletNode: class {} };
  globalThis.fetch = respond;
  return {
    contexts,
    restore() {
      globalThis.window = saved.window;
      globalThis.fetch = saved.fetch;
    },
  };
}

const wasmResponse = () =>
  new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), {
    headers: { 'content-type': 'application/wasm' },
  });

// Without the deadline this test would hang, so it carries its own timeout.
test(
  'audio startup fails in bounded time, reports disposal, and releases the device',
  { timeout: 10_000 },
  async (t) => {
    // A download that never finishes fails after the load deadline.
    const stalled = fakeWebAudio({
      respond: (url, init) =>
        new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason)),
        ),
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const controller = new AudioController({ canvas: {} });
      const unlock = controller.unlock();
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(AUDIO_LIMITS.loadTimeoutMs);
      await assert.rejects(
        unlock,
        (error) =>
          error.code === 'AUDIO_ERROR' && error.message === 'The audio files did not load in time.',
      );
      assert.equal(controller.capabilities.state, 'failed');
      assert.equal(stalled.contexts[0].state, 'closed', 'a failed start releases the device');
    } finally {
      t.mock.timers.reset();
      stalled.restore();
    }

    // A worklet module that cannot load also fails and closes the context.
    const broken = fakeWebAudio({
      addModule: async () => {
        throw new Error('AbortError: the module could not be fetched.');
      },
      respond: async () => wasmResponse(),
    });
    try {
      const controller = new AudioController({ canvas: {} });
      await assert.rejects(controller.unlock(), (error) => error.code === 'AUDIO_ERROR');
      assert.equal(broken.contexts[0].state, 'closed');
      await assert.rejects(controller.unlock(), (error) => error.code === 'STATE');
    } finally {
      broken.restore();
    }

    // A device that never answers makes unlock() fail as BLOCKED in bounded
    // time; the next gesture tries again instead of sharing the old attempt.
    const silent = { resumes: false, respond: async () => wasmResponse() };
    const mute = fakeWebAudio(silent);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const controller = new AudioController({ canvas: {} });
      const unlock = controller.unlock();
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(AUDIO_LIMITS.resumeTimeoutMs);
      await assert.rejects(
        unlock,
        (error) =>
          error.code === 'BLOCKED' && error.message === 'The audio device did not start in time.',
      );
      assert.equal(controller.capabilities.state, 'blocked');
      assert.notEqual(mute.contexts[0].state, 'closed', 'a blocked device stays for a retry');
      silent.resumes = true;
      // The retry gets past resume(); this fake has no worklet node, so it
      // then fails as a startup error rather than hanging.
      await assert.rejects(controller.unlock(), (error) => error.code === 'AUDIO_ERROR');
      assert.equal(mute.contexts.length, 1, 'the retry reuses the same context');
    } finally {
      t.mock.timers.reset();
      mute.restore();
    }

    // Disposal while the browser is still resuming is reported as disposal.
    const waiting = fakeWebAudio({ resumes: false, respond: async () => wasmResponse() });
    try {
      const controller = new AudioController({ canvas: {} });
      const unlock = controller.unlock();
      await new Promise((resolve) => setImmediate(resolve));
      await controller.dispose();
      await assert.rejects(unlock, (error) => error.code === 'STATE');
      assert.equal(waiting.contexts[0].state, 'closed');
    } finally {
      waiting.restore();
    }
  },
);

test('disposal detaches the audio graph, so a closed one cannot keep the engine alive', async () => {
  // Browsers may keep the nodes of a closed context; handlers left on them
  // would keep the controller, and through it the engine, reachable.
  const nodes = [];
  class FakeNode {
    onprocessorerror = null;
    constructor() {
      nodes.push(this);
      const port = {
        onmessage: null,
        postMessage(message) {
          if (message.type === 'init')
            queueMicrotask(() => port.onmessage?.({ data: { type: 'ready', version: 3 } }));
        },
        close() {},
      };
      this.port = port;
    }
    connect() {}
    disconnect() {}
  }
  const saved = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = FakeNode;
  const audio = fakeWebAudio({ respond: async () => wasmResponse() });
  try {
    const controller = new AudioController({ canvas: {} });
    await controller.unlock();
    assert.equal(controller.capabilities.state, 'running');
    const [node] = nodes;
    const [context] = audio.contexts;
    assert.equal(typeof node.port.onmessage, 'function');
    assert.equal(typeof node.onprocessorerror, 'function');
    assert.equal(typeof context.onstatechange, 'function');
    await controller.dispose();
    assert.equal(context.state, 'closed');
    assert.equal(node.port.onmessage, null);
    assert.equal(node.onprocessorerror, null);
    assert.equal(context.onstatechange, null);
  } finally {
    audio.restore();
    globalThis.AudioWorkletNode = saved;
  }
});

test('multi-note sounds, effects and music are validated and queued as single events', () => {
  const { controller, sent, ack } = runningController();
  const events = () => sent.flatMap((message) => message.events ?? []);
  const code = (action) => {
    try {
      action();
      return 'OK';
    } catch (error) {
      return error.code;
    }
  };
  // Notes may come in any order; they reach the audio thread sorted by step.
  const jingle = controller.createSound({
    bpm: 240,
    waveform: 'triangle',
    notes: [
      { step: 2, pitch: 'E4', length: 2 },
      { step: 0, pitch: 'C4', effect: 'slide' },
      { step: 4, pitch: 79, waveform: 'noise', volume: 0.5 },
    ],
  });
  assert.equal(jingle.notes, 3);
  assert.ok(Math.abs(jingle.duration - 0.3125) < 1e-9, 'five steps of 1/16 s');
  controller.play(jingle, 1);
  assert.deepEqual(events().at(-1), {
    kind: 'sound',
    voice: 1,
    centiBpm: 24000,
    stepsPerBeat: 4,
    instrument: { volume: 1, attack: 0.005, decay: 0.01, sustain: 0.7, release: 0.05 },
    notes: [
      [0, 1, 60, 255, 1, 1],
      [2, 2, 64, 255, 1, 0],
      [4, 1, 79, 128, 3, 0],
    ],
  });
  controller.play({ frequency: 300, effect: 'slide', slideTo: 600 }, 2);
  assert.equal(events().at(-1).effect, 1);
  assert.equal(events().at(-1).slideTo, 600);
  for (const [options, expected] of [
    [{ effect: 'slide' }, 'RANGE'],
    [{ effect: 'echo' }, 'ARGUMENT'],
    [{ notes: [{ step: 0, pitch: 60 }], frequency: 200 }, 'ARGUMENT'],
    [{ notes: [] }, 'RANGE'],
    [{ notes: Array.from({ length: 65 }, () => ({ step: 0, pitch: 60 })) }, 'RANGE'],
    [{ notes: [{ step: 0, pitch: 'H4' }] }, 'ARGUMENT'],
    [{ notes: [{ step: 0, pitch: 'B9' }] }, 'RANGE'],
    [{ notes: [{ step: 0, pitch: 128 }] }, 'RANGE'],
    [{ notes: [{ step: 4096, pitch: 60 }] }, 'RANGE'],
    [{ notes: [{ step: 0, pitch: 60, length: 0 }] }, 'RANGE'],
    [{ notes: [{ step: 0, pitch: 60 }], bpm: 401 }, 'RANGE'],
    [{ notes: [{ step: 0, pitch: 60 }], stepsPerBeat: 17 }, 'RANGE'],
  ])
    assert.equal(
      code(() => controller.createSound(options)),
      expected,
      JSON.stringify(options),
    );

  const music = controller.createMusic({
    bpm: 128.5,
    length: 16,
    tracks: [
      {
        notes: [
          { step: 8, pitch: 'A3' },
          { step: 0, pitch: 'A4', length: 4 },
        ],
      },
      { voice: 3, waveform: 'sine', volume: 0.5, notes: [] },
    ],
  });
  assert.deepEqual(
    { ...music },
    { bpm: 128.5, stepsPerBeat: 4, length: 16, loop: true, tracks: 2 },
  );
  for (const [options, expected] of [
    [{ bpm: 120, length: 8, tracks: [{ notes: [] }, { voice: 0, notes: [] }] }, 'ARGUMENT'],
    [{ bpm: 120, length: 8, tracks: [{ notes: [{ step: 8, pitch: 60 }] }] }, 'RANGE'],
    [{ bpm: 120, length: 8, tracks: Array.from({ length: 5 }, () => ({ notes: [] })) }, 'RANGE'],
    [{ bpm: 120, length: 8, tracks: [] }, 'RANGE'],
    [{ bpm: 10, length: 8, tracks: [{ notes: [] }] }, 'RANGE'],
    [{ bpm: 120, length: 4097, tracks: [{ notes: [] }] }, 'RANGE'],
    [{ bpm: 120, length: 8, loop: 'yes', tracks: [{ notes: [] }] }, 'ARGUMENT'],
    [{ bpm: 120, length: 8, tracks: [{ voice: 4, notes: [] }] }, 'RANGE'],
  ])
    assert.equal(
      code(() => controller.createMusic(options)),
      expected,
      JSON.stringify(options),
    );

  controller.playMusic(music, { loop: false });
  assert.equal(controller.musicPlaying, true);
  assert.deepEqual(events().at(-1), {
    kind: 'music',
    centiBpm: 12850,
    stepsPerBeat: 4,
    length: 16,
    loop: false,
    tracks: [
      {
        voice: 0,
        instrument: { volume: 1, attack: 0.005, decay: 0.01, sustain: 0.7, release: 0.05 },
        notes: [
          [0, 4, 69, 255, 0, 0],
          [8, 1, 57, 255, 0, 0],
        ],
      },
      {
        voice: 3,
        instrument: { volume: 0.5, attack: 0.005, decay: 0.01, sustain: 0.7, release: 0.05 },
        notes: [],
      },
    ],
  });
  // With every credit in use, repeated music commands keep only the latest.
  controller.playMusic(music);
  controller.stopMusic();
  controller.playMusic(music);
  const queued = controller.pending.filter((event) => event.kind.startsWith('music'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].loop, true);
  // A pause drops queued notes but keeps the music command.
  controller.play({ frequency: 500 }, 0);
  controller.onPause('manual');
  assert.deepEqual(
    controller.pending.map((event) => event.kind),
    ['music', 'note_off'],
  );
  controller.onResume('manual');
  for (const message of sent.filter((entry) => entry.type === 'batch'))
    ack({ epoch: 0, sequence: message.sequence });
  assert.equal(events().at(-2).kind, 'music');
  // The audio thread reports the end of a non-looping piece.
  controller.receive({ type: 'music_end', epoch: 7 });
  assert.equal(controller.musicPlaying, true, 'another epoch is ignored');
  controller.receive({ type: 'music_end', epoch: 0 });
  assert.equal(controller.musicPlaying, false);
  controller.playMusic(music);
  controller.stop();
  assert.equal(controller.musicPlaying, false, 'stop() ends the music too');
  controller.markReleased(music);
  assert.equal(
    code(() => controller.playMusic(music)),
    'HANDLE',
  );
  assert.equal(
    code(() => controller.playMusic({ bpm: 120 })),
    'HANDLE',
  );
});

test('music requested before unlock starts once the audio graph is ready', () => {
  const controller = new AudioController({ canvas: {} });
  const music = controller.createMusic({ bpm: 90, length: 4, tracks: [{ notes: [] }] });
  controller.playMusic(music);
  assert.equal(controller.musicPlaying, true);
  assert.equal(controller.pending.length, 0, 'nothing is queued without a graph');
  const sent = [];
  Object.assign(controller, {
    ready: true,
    state: 'running',
    context: { state: 'running', currentTime: 0, suspend: async () => {}, resume: async () => {} },
    node: { port: { postMessage: (message) => sent.push(message), close() {} }, disconnect() {} },
  });
  controller.sendMusic(); // What unlock() does once the processor is ready.
  assert.equal(sent.at(-1).events[0].kind, 'music');
  assert.equal(sent.at(-1).events[0].centiBpm, 9000);
});

test('the AudioWorklet module runs the real DSP and validates every message', async () => {
  class FakePort {
    sent = [];
    onmessage = null;
    postMessage(message) {
      this.sent.push(message);
    }
  }
  let Processor;
  globalThis.AudioWorkletProcessor = class {
    port = new FakePort();
  };
  globalThis.registerProcessor = (name, constructor) => {
    assert.equal(name, 'pixeljs-audio-processor');
    Processor = constructor;
  };
  globalThis.sampleRate = 48000;
  try {
    await import('../packages/core/dist/internal/audio/processor.js');
  } finally {
    delete globalThis.AudioWorkletProcessor;
    delete globalThis.registerProcessor;
  }
  const processor = new Processor();
  const receive = (data) => processor.port.onmessage({ data });
  const block = (frames = 128) => {
    const output = [new Float32Array(frames), new Float32Array(frames)];
    assert.equal(processor.process([], [output]), true);
    return output;
  };
  assert.ok(
    block()[0].every((value) => value === 0),
    'silent before initialization',
  );
  receive({ type: 'init', version: 1, bytes: new ArrayBuffer(8) });
  receive({ type: 'init', version: 3, epoch: 3, bytes: audioBytes.buffer.slice(0) });
  for (
    let attempt = 0;
    attempt < 100 && !processor.port.sent.some((m) => m.type === 'ready');
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(processor.port.sent[0].type, 'error', 'unsupported versions are refused');
  assert.ok(processor.port.sent.some((message) => message.type === 'ready'));

  receive({
    type: 'batch',
    epoch: 3,
    sequence: 1,
    events: [
      { kind: 'note_on', voice: 0, ...note },
      { kind: 'note_on', voice: 9, ...note },
      { kind: 'note_on', voice: 1, ...note, frequency: Number.NaN },
      { kind: 'note_on', voice: 1, ...note, duration: 0 },
      { kind: 'play_sample', voice: 1 },
      null,
    ],
  });
  assert.deepEqual(processor.port.sent.at(-1), { type: 'ack', epoch: 3, sequence: 1, accepted: 1 });
  const [left, right] = block(300);
  assert.ok(
    left.some((value) => value !== 0),
    'the DSP renders the accepted note',
  );
  assert.deepEqual(right, left, 'mono DSP output is copied to every channel');
  assert.ok(left.every((value) => Math.abs(value) <= 1));

  // Music and multi-note sounds run on the audio clock inside the DSP.
  const instrument = { volume: 1, attack: 0, decay: 0, sustain: 1, release: 0 };
  receive({
    type: 'batch',
    epoch: 3,
    sequence: 10,
    events: [
      {
        kind: 'music',
        centiBpm: 12000,
        stepsPerBeat: 4,
        length: 2,
        loop: false,
        tracks: [{ voice: 2, instrument, notes: [[0, 1, 69, 255, 2, 0]] }],
      },
      {
        kind: 'sound',
        voice: 1,
        centiBpm: 24000,
        stepsPerBeat: 4,
        instrument,
        notes: [[0, 1, 72, 255, 0, 2]],
      },
      { kind: 'note_on', voice: 0, ...note, effect: 1, slideTo: 880 },
      { kind: 'note_on', voice: 0, ...note, effect: 1, slideTo: 0 },
      { kind: 'music', centiBpm: 12000, stepsPerBeat: 4, length: 2, loop: false, tracks: [] },
      {
        kind: 'music',
        centiBpm: 12000,
        stepsPerBeat: 4,
        length: 2,
        loop: false,
        tracks: [{ voice: 4, instrument, notes: [] }],
      },
      {
        kind: 'sound',
        voice: 1,
        centiBpm: 24000,
        stepsPerBeat: 4,
        instrument,
        notes: [
          [2, 1, 72, 255, 0, 0],
          [0, 1, 72, 255, 0, 0],
        ],
      },
    ],
  });
  assert.equal(
    processor.port.sent.at(-1).accepted,
    3,
    'unsorted, voiceless or empty data is refused',
  );
  // 2 steps at 120 BPM (4 per beat) take 12,000 samples; then the piece ends once.
  for (let index = 0; index < 100; index++) block(128);
  const ends = processor.port.sent.filter((message) => message.type === 'music_end');
  assert.deepEqual(ends, [{ type: 'music_end', epoch: 3 }]);
  receive({ type: 'batch', epoch: 3, sequence: 11, events: [{ kind: 'music_stop' }] });
  assert.equal(processor.port.sent.at(-1).accepted, 1);

  // Batches from a cancelled epoch are acknowledged but never played.
  receive({ type: 'stop', epoch: 4 });
  assert.deepEqual(processor.port.sent.at(-1), { type: 'stopped', epoch: 4 });
  receive({ type: 'stop', epoch: 'next' });
  assert.deepEqual(
    processor.port.sent.at(-1),
    { type: 'stopped', epoch: 4 },
    'invalid stops are ignored',
  );
  block(128);
  assert.ok(
    block(128)[0].every((value) => value === 0),
    'stop fades out and stays silent',
  );
  receive({
    type: 'batch',
    epoch: 3,
    sequence: 2,
    events: [{ kind: 'note_on', voice: 0, ...note }],
  });
  assert.deepEqual(processor.port.sent.at(-1), { type: 'ack', epoch: 3, sequence: 2, accepted: 0 });
  assert.ok(block()[0].every((value) => value === 0));
  const flood = Array.from({ length: 500 }, () => ({ kind: 'note_off', voice: 0 }));
  receive({ type: 'batch', epoch: 4, sequence: 3, events: flood });
  assert.equal(processor.port.sent.at(-1).accepted, 64, 'at most 64 events per batch');

  // A trapped DSP is never called again; output stays silent.
  // WebAssembly export objects are frozen: substitute a trapping copy.
  processor.dsp = {
    ...processor.dsp,
    pxa_render() {
      throw new WebAssembly.RuntimeError('unreachable');
    },
  };
  const errors = () => processor.port.sent.filter((message) => message.type === 'error').length;
  const before = errors();
  assert.ok(block()[0].every((value) => value === 0));
  assert.ok(block()[0].every((value) => value === 0));
  assert.equal(errors(), before + 1);
  assert.equal(processor.dsp, null);
});

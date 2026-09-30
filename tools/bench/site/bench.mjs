// In-page workloads for tools/bench-browser.mjs. They use the public
// @pixeljs/core API exactly as a game does and return plain samples; the
// Node side computes statistics and pass/fail. `window.__pixeljsBench` is
// the observation-only instrumentation injected before this page loads.
import { createEngine } from '../pixeljs/index.js';
import { drawScene, sceneImages } from '../scene.mjs';

const now = () => performance.now();
const probe = () => window.__pixeljsBench ?? null;
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const codeOf = (error) => String(error?.code ?? error?.name ?? error);

function newCanvas() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  return canvas;
}

async function framesAfter(engine, count, timeoutMs = 5000) {
  const target = engine.getStats().frames + count;
  const start = now();
  while (engine.getStats().frames < target) {
    if (now() - start > timeoutMs) throw new Error(`No frame within ${timeoutMs} ms.`);
    await nextFrame();
  }
}

async function until(predicate, timeoutMs) {
  const start = now();
  while (!predicate()) {
    if (now() - start > timeoutMs) return false;
    await delay(2);
  }
  return true;
}

function uploadScene(engine) {
  const images = {};
  for (const [name, image] of Object.entries(sceneImages()))
    images[name] = engine.createImage(image);
  return images;
}

const copyNumbers = (object) => {
  if (!object) return null;
  const copy = {};
  for (const key in object) if (typeof object[key] === 'number') copy[key] = object[key];
  return copy;
};

/** AudioContexts seen by the instrumentation: open, closed or already collected. */
function audioContexts() {
  const list = probe()?.audioContexts ?? [];
  let open = 0;
  let closed = 0;
  let collected = 0;
  let last = null;
  for (const entry of list) {
    const context = entry.ref.deref();
    if (!context) collected++;
    else if (context.state === 'closed') closed++;
    else open++;
    if (context) last = context;
  }
  return {
    created: list.length,
    open,
    closed,
    collected,
    last: last && {
      state: last.state,
      sampleRate: last.sampleRate,
      baseLatency: last.baseLatency,
      outputLatency: last.outputLatency,
      playoutStats: copyNumbers(last.playoutStats),
    },
  };
}

/** Compact transport records: [time, type, epoch, sequence, events, note events, JSON bytes]. */
function transportRecords() {
  const state = probe();
  if (!state) return null;
  const notes = (events) =>
    events.filter((event) => event.kind === 'note_on' || event.kind === 'sound').length;
  return {
    posts: state.posts.map((post) => [
      post.t,
      post.type,
      post.epoch ?? null,
      post.sequence ?? null,
      post.events?.length ?? 0,
      post.events ? notes(post.events) : 0,
      post.events ? JSON.stringify(post.events).length : 0,
    ]),
    acks: state.acks.map((ack) => [
      ack.t,
      ack.type ?? null,
      ack.epoch ?? null,
      ack.sequence ?? null,
      ack.accepted ?? null,
    ]),
  };
}

/**
 * Times a game's phases per frame: update() (game logic), draw() (SDK
 * argument validation and command recording) and the engine's work after
 * draw() returns (C submission and presentation), measured to the microtask
 * that runs when the frame callback returns. With WebGL2 the frame's first
 * texSubImage2D splits submission from presentation, and a timer query
 * measures GPU time where EXT_disjoint_timer_query_webgl2 is exposed.
 */
class PhaseRecorder {
  constructor(engine, canvas) {
    this.recording = false;
    this.stopped = false;
    this.runs = [];
    this.current = null;
    this.drawEnd = 0;
    this.presentStart = 0;
    this.pending = [];
    this.free = [];
    this.queryOpen = false;
    this.gl = null;
    this.timer = null;
    if (engine.capabilities.renderer === 'webgl2') {
      const gl = canvas.getContext('webgl2');
      const upload = gl.texSubImage2D;
      const recorder = this;
      gl.texSubImage2D = function (...args) {
        if (recorder.presentStart === 0) recorder.presentStart = now();
        return upload.apply(this, args);
      };
      this.gl = gl;
      this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    }
    let last = null;
    const tick = (time) => {
      if (this.stopped) return;
      if (this.recording && last !== null) this.current.interval.push(time - last);
      last = time;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  begin() {
    this.current = {
      update: [],
      draw: [],
      engine: [],
      submit: [],
      present: [],
      interval: [],
      gpu: [],
      gpuDisjoint: 0,
      burst: [],
    };
    this.runs.push(this.current);
    this.recording = true;
  }

  end() {
    this.recording = false;
  }

  stop() {
    this.stopped = true;
    this.recording = false;
  }

  wrap(callbacks) {
    return {
      update: (dt) => {
        const at = now();
        callbacks.update(dt);
        if (this.recording) this.current.update.push(now() - at);
      },
      draw: () => {
        const at = now();
        callbacks.draw();
        this.drawEnd = now();
        this.presentStart = 0;
        this.collectQueries();
        const record = this.recording ? this.current : null;
        if (record) record.draw.push(this.drawEnd - at);
        const query = record ? this.beginQuery(record) : null;
        const drawEnd = this.drawEnd;
        queueMicrotask(() => {
          const end = now();
          if (query) {
            this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
            this.queryOpen = false;
          }
          if (!record) return;
          record.engine.push(end - drawEnd);
          if (this.presentStart) {
            record.submit.push(this.presentStart - drawEnd);
            record.present.push(end - this.presentStart);
          }
        });
      },
    };
  }

  beginQuery(record) {
    if (!this.timer || this.queryOpen) return null;
    const query = this.free.pop() ?? this.gl.createQuery();
    this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, query);
    this.queryOpen = true;
    this.pending.push({ query, record });
    return query;
  }

  collectQueries() {
    if (!this.timer) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
    while (this.pending.length > 0) {
      const { query, record } = this.pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (disjoint) record.gpuDisjoint++;
      else record.gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      this.free.push(query);
    }
  }
}

/** Four-track music and a burst of multi-note sounds and notes every `burstEvery` updates (B07). */
async function startAudio(engine, recorder, burstEvery) {
  await engine.audio.unlock();
  const waveforms = ['square', 'triangle', 'sine', 'noise'];
  const effects = ['vibrato', 'slide', 'fadeout', 'none'];
  const music = engine.audio.createMusic({
    bpm: 150,
    stepsPerBeat: 4,
    length: 64,
    loop: true,
    tracks: waveforms.map((waveform, track) => ({
      voice: track,
      waveform,
      volume: 0.3,
      notes: Array.from({ length: 64 }, (_, step) => ({
        step,
        length: 1 + (step % 2),
        pitch: 48 + track * 7 + (step % 12),
        effect: effects[track],
      })),
    })),
  });
  engine.audio.playMusic(music);
  const jingles = waveforms.map((waveform, voice) =>
    engine.audio.createSound({
      bpm: 400,
      stepsPerBeat: 16,
      waveform,
      volume: 0.3,
      notes: Array.from({ length: 8 }, (_, note) => ({
        step: note,
        pitch: 60 + ((voice * 5 + note * 3) % 24),
      })),
    }),
  );
  const counts = { plays: 0, capacity: 0, bursts: 0 };
  const play = (sound, voice) => {
    try {
      engine.audio.play(sound, voice);
      counts.plays++;
    } catch (error) {
      if (error?.code !== 'CAPACITY') throw error;
      counts.capacity++;
    }
  };
  let updates = 0;
  const tick = () => {
    if (++updates % burstEvery !== 0) return;
    const at = now();
    for (let voice = 0; voice < 4; voice++) play(jingles[voice], voice);
    for (let note = 0; note < 12; note++)
      play({ frequency: 220 + note * 40, duration: 0.05, volume: 0.2 }, note % 4);
    counts.bursts++;
    if (recorder.recording) recorder.current.burst.push(now() - at);
  };
  return {
    tick,
    info: () => ({
      ...counts,
      state: engine.audio.capabilities.state,
      musicPlaying: engine.audio.musicPlaying,
      contexts: audioContexts(),
      transport: transportRecords(),
    }),
  };
}

/** The smallest positive step of performance.now() (the browser clamps it). */
function timerResolution() {
  let smallest = Infinity;
  let last = performance.now();
  for (let steps = 0, spins = 0; steps < 50 && spins < 5e6; spins++) {
    const current = performance.now();
    if (current > last) {
      smallest = Math.min(smallest, current - last);
      steps++;
    }
    last = current;
  }
  return Number(smallest.toFixed(6));
}

window.bench = {
  /** Browser identity for the report, and B10's worker capability. */
  async info() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const engineCanvas = newCanvas();
    const engine = await createEngine({
      canvas: engineCanvas,
      width: 16,
      height: 16,
      renderer: 'canvas2d',
    });
    const workers = engine.capabilities.workers;
    await engine.dispose();
    engineCanvas.remove();
    const result = {
      userAgent: navigator.userAgent,
      devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      webgl2: Boolean(gl),
      glRenderer: gl ? gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null,
      glVendor: gl ? gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR) : null,
      gpuTimer: Boolean(gl?.getExtension('EXT_disjoint_timer_query_webgl2')),
      memoryApi: 'memory' in performance,
      audioWorklet: typeof AudioWorkletNode === 'function',
      workers,
      crossOriginIsolated: window.crossOriginIsolated === true,
      timerResolutionMs: timerResolution(),
    };
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return result;
  },

  /** B01 (and B07 with `audio`): the HUD scene at steady state, phases per frame. */
  async steady({ renderer = 'auto', warmupMs, sampleMs, runs, audio = false, burstEvery = 30 }) {
    const canvas = newCanvas();
    const errors = [];
    const engine = await createEngine({
      canvas,
      renderer,
      onError: (error) => errors.push(codeOf(error)),
    });
    const images = uploadScene(engine);
    const recorder = new PhaseRecorder(engine, canvas);
    probe()?.resetTransport();
    const sound = audio ? await startAudio(engine, recorder, burstEvery) : null;
    let frame = 0;
    engine.start(
      recorder.wrap({
        update() {
          frame++;
          sound?.tick();
        },
        draw() {
          drawScene(engine.graphics, images, frame);
        },
      }),
    );
    await delay(warmupMs);
    const allocationsBefore = engine.getStats().coreAllocations;
    for (let run = 0; run < runs; run++) {
      recorder.begin();
      await delay(sampleMs);
      recorder.end();
    }
    recorder.stop();
    const result = {
      renderer: engine.capabilities.renderer,
      gpuTimer: Boolean(recorder.timer),
      stats: engine.getStats(),
      allocations: { before: allocationsBefore, after: engine.getStats().coreAllocations },
      state: engine.state,
      errors,
      runs: recorder.runs,
      audio: sound?.info() ?? null,
    };
    await engine.dispose();
    canvas.remove();
    return result;
  },

  /** B06: create/load/start/dispose cycles `from` to `to` with cancellations. */
  async lifecycle({ from, to, png, bigPng, only = null }) {
    const cycles = [];
    for (let index = from; index < to; index++) {
      const kind =
        only ??
        [
          'full',
          'full',
          'abortCreate',
          'full',
          'abortLoad',
          'full',
          'disposeDuringLoad',
          'full',
          'audio',
          'full',
        ][index % 10];
      const renderer = index % 2 === 0 ? 'auto' : 'canvas2d';
      const variant = Math.floor(index / 10) % 3;
      const canvas = newCanvas();
      const start = now();
      let result;
      try {
        result = await CYCLES[kind]({ canvas, renderer, variant, png, bigPng });
      } catch (error) {
        result = { outcome: `threw ${codeOf(error)}` };
      }
      canvas.remove();
      cycles.push({ index, kind, renderer, ms: now() - start, ...result });
    }
    return { cycles, observation: observe() };
  },

  /** B11: image loads and uploads during play, cancellation and limits. */
  async uploads(options) {
    return uploads(options);
  },

  /** B12: the real AudioWorklet transport, a stalled and a failing processor. */
  async transport(options) {
    return transport(options);
  },

  observe: () => observe(),
};

function observe() {
  return {
    canvases: document.querySelectorAll('canvas').length,
    contexts: { ...probe()?.contexts },
    audio: audioContexts(),
    heap: performance.memory?.usedJSHeapSize ?? null,
  };
}

// -----------------------------------------------------------------------------
// B06 cycles. Each resolves to { outcome, ... }; the expected outcomes are
// listed in tools/bench-browser.mjs.
// -----------------------------------------------------------------------------

const abortAt = (variant, controller) =>
  variant === 0 ? controller.abort() : delay(variant === 1 ? 0 : 5).then(() => controller.abort());

async function runFull({ canvas, renderer, png }, audio = false) {
  const engine = await createEngine({ canvas, renderer, width: 64, height: 64 });
  const bytesBefore = engine.getStats().coreBytes;
  const image = await engine.loadImage(png);
  engine.start({
    update() {},
    draw() {
      engine.graphics.clear(1);
      engine.graphics.sprite(image, 8, 8);
    },
  });
  await framesAfter(engine, 2);
  let audioState = null;
  if (audio) {
    await engine.audio.unlock();
    engine.audio.play({ frequency: 330, duration: 0.02, volume: 0.1 });
    audioState = engine.audio.capabilities.state;
  }
  engine.release(image);
  const nativeRestored = engine.getStats().coreBytes === bytesBefore;
  await engine.dispose();
  return {
    outcome: engine.state,
    nativeRestored,
    audioBefore: audioState,
    audioAfter: audio ? engine.audio.capabilities.state : null,
  };
}

const CYCLES = {
  full: (options) => runFull(options),
  audio: (options) => runFull(options, true),
  async abortCreate({ canvas, renderer, variant }) {
    const controller = new AbortController();
    const creating = createEngine({
      canvas,
      renderer,
      width: 64,
      height: 64,
      signal: controller.signal,
    });
    await abortAt(variant, controller);
    try {
      const engine = await creating;
      await engine.dispose();
      return { outcome: 'created before abort' };
    } catch (error) {
      return { outcome: codeOf(error) };
    }
  },
  async abortLoad({ canvas, renderer, variant, bigPng }) {
    const engine = await createEngine({ canvas, renderer, width: 64, height: 64 });
    engine.start({ update() {}, draw() {} });
    const bytesBefore = engine.getStats().coreBytes;
    const controller = new AbortController();
    const loading = engine.loadImage(bigPng, { signal: controller.signal });
    await abortAt(variant, controller);
    let outcome;
    try {
      engine.release(await loading);
      outcome = 'loaded before abort';
    } catch (error) {
      outcome = codeOf(error);
    }
    const nativeRestored = engine.getStats().coreBytes === bytesBefore;
    await engine.dispose();
    return { outcome, nativeRestored, disposed: engine.state };
  },
  async disposeDuringLoad({ canvas, renderer, bigPng }) {
    const engine = await createEngine({ canvas, renderer, width: 64, height: 64 });
    engine.start({ update() {}, draw() {} });
    const loading = engine.loadImage(bigPng);
    const disposing = engine.dispose();
    let outcome;
    try {
      await loading;
      outcome = 'loaded after dispose';
    } catch (error) {
      outcome = codeOf(error);
    }
    await disposing;
    return { outcome, disposed: engine.state };
  },
};

// -----------------------------------------------------------------------------
// B11: loads and uploads during play
// -----------------------------------------------------------------------------

async function uploads({
  warmupMs,
  sampleMs,
  runs,
  concurrency,
  assets,
  cancelEvery,
  createEveryMs,
  cancellations,
}) {
  const canvas = newCanvas();
  const errors = [];
  const engine = await createEngine({ canvas, onError: (error) => errors.push(codeOf(error)) });
  const images = uploadScene(engine);
  const recorder = new PhaseRecorder(engine, canvas);
  const live = [];
  let frame = 0;
  engine.start(
    recorder.wrap({
      update() {
        frame++;
      },
      draw() {
        drawScene(engine.graphics, images, frame);
        const latest = live.at(-1);
        if (latest)
          engine.graphics.sprite(latest, 180, 20, {
            width: Math.min(64, latest.width),
            height: Math.min(64, latest.height),
          });
      },
    }),
  );
  const big = new Uint8Array(1024 * 1024);
  for (let index = 0; index < big.length; index++) big[index] = (index >> 3) % 16;
  const loads = [];
  const cancels = [];
  const creates = [];
  const peaks = [];
  await delay(warmupMs);
  const baseline = [];
  for (let run = 0; run < runs; run++) {
    recorder.begin();
    await delay(sampleMs);
    recorder.end();
    baseline.push(recorder.current);
  }
  const loaded = [];
  for (let run = 0; run < runs; run++) {
    recorder.begin();
    const end = now() + sampleMs;
    // performance.memory is Chromium-only: null elsewhere, never a fake zero.
    const peak = { heap: performance.memory ? 0 : null, coreBytes: 0 };
    let counter = 0;
    const worker = async () => {
      while (now() < end) {
        const number = counter++;
        const asset = assets[number % assets.length];
        if (cancelEvery && number % cancelEvery === cancelEvery - 1) {
          const controller = new AbortController();
          const loading = engine.loadImage(asset.url, { signal: controller.signal });
          const wait = [-1, 0, 2, 5, 10][Math.floor(number / cancelEvery) % 5];
          if (wait >= 0) await delay(wait);
          const at = now();
          controller.abort();
          try {
            engine.release(await loading);
            cancels.push({
              run,
              size: asset.size,
              wait,
              ms: now() - at,
              outcome: 'completed first',
            });
          } catch (error) {
            cancels.push({ run, size: asset.size, wait, ms: now() - at, outcome: codeOf(error) });
          }
          continue;
        }
        const at = now();
        try {
          const image = await engine.loadImage(asset.url);
          loads.push({ run, size: asset.size, ms: now() - at, outcome: 'OK' });
          live.push(image);
          if (live.length > 8) engine.release(live.shift());
        } catch (error) {
          loads.push({ run, size: asset.size, ms: now() - at, outcome: codeOf(error) });
        }
      }
    };
    const creator = async () => {
      while (now() + createEveryMs < end) {
        await delay(createEveryMs);
        const at = now();
        const image = engine.createImage({ width: 1024, height: 1024, pixels: big });
        creates.push({ run, ms: now() - at });
        engine.release(image);
      }
    };
    const sampler = async () => {
      while (now() < end) {
        if (peak.heap !== null) peak.heap = Math.max(peak.heap, performance.memory.usedJSHeapSize);
        peak.coreBytes = Math.max(peak.coreBytes, engine.getStats().coreBytes);
        await nextFrame();
      }
    };
    await Promise.all([...Array.from({ length: concurrency }, worker), creator(), sampler()]);
    recorder.end();
    loaded.push(recorder.current);
    peaks.push(peak);
  }
  // No partial state: cancelled loads, alone, leave the accounted C bytes unchanged.
  while (live.length) engine.release(live.shift());
  const quiet = engine.getStats().coreBytes;
  const quietCancels = [];
  for (let index = 0; index < cancellations; index++) {
    const asset = assets[index % assets.length];
    const controller = new AbortController();
    const loading = engine.loadImage(asset.url, { signal: controller.signal });
    const wait = [-1, 0, 1, 3, 8][index % 5];
    if (wait >= 0) await delay(wait);
    controller.abort();
    try {
      engine.release(await loading);
      quietCancels.push('completed first');
    } catch (error) {
      quietCancels.push(codeOf(error));
    }
  }
  const afterCancels = engine.getStats().coreBytes;
  // Resource slots: fill them with 1 × 1 images until CAPACITY.
  const probeImages = [];
  let capacityCode = 'none';
  for (let index = 0; index < 300; index++) {
    try {
      probeImages.push(engine.createImage({ width: 1, height: 1, pixels: new Uint8Array([1]) }));
    } catch (error) {
      capacityCode = codeOf(error);
      break;
    }
  }
  const stateAtLimit = engine.state;
  for (const image of probeImages) engine.release(image);
  const afterProbe = engine.getStats().coreBytes;
  recorder.stop();
  const result = {
    renderer: engine.capabilities.renderer,
    baseline,
    loaded,
    loads,
    cancels,
    creates,
    peaks,
    quiet: { before: quiet, after: afterCancels, outcomes: quietCancels },
    capacity: {
      created: probeImages.length,
      liveBefore: Object.keys(images).length,
      code: capacityCode,
      state: stateAtLimit,
      restored: afterProbe === quiet,
    },
    errors,
    state: engine.state,
  };
  await engine.dispose();
  canvas.remove();
  return result;
}

// -----------------------------------------------------------------------------
// B12: the audio transport in the browser
// -----------------------------------------------------------------------------

async function transport({ iterations, burst, cycles, stallUrl, failingUrl }) {
  const result = { real: [], stalled: null, failing: null };
  const acked = () =>
    new Set(
      probe()
        .acks.filter((ack) => ack.type === 'ack')
        .map((ack) => `${ack.epoch}:${ack.sequence}`),
    );
  const batchesPosted = () => probe().posts.filter((post) => post.type === 'batch');

  // 1. The real processor: saturation, drain, STOP round trip, suspend/resume.
  {
    const canvas = newCanvas();
    const errors = [];
    const engine = await createEngine({
      canvas,
      renderer: 'canvas2d',
      width: 64,
      height: 64,
      onError: (error) => errors.push(codeOf(error)),
    });
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(1);
      },
    });
    const unlockStart = now();
    await engine.audio.unlock();
    const unlockMs = now() - unlockStart;
    const context = probe().audioContexts.at(-1)?.ref.deref();
    const stateChanges = [];
    context?.addEventListener('statechange', () =>
      stateChanges.push({ t: now(), state: context.state }),
    );
    const sound = engine.audio.createSound({ frequency: 440, duration: 0.03, volume: 0.1 });
    for (let iteration = 0; iteration < iterations; iteration++) {
      probe().resetTransport();
      let admitted = 0;
      let rejected = 0;
      const burstStart = now();
      for (let index = 0; index < burst; index++) {
        try {
          engine.audio.play(sound, index % 4);
          admitted++;
        } catch (error) {
          if (error?.code !== 'CAPACITY') throw error;
          rejected++;
        }
      }
      const burstEnd = now();
      const drained = await until(() => {
        const keys = acked();
        return batchesPosted().every((post) => keys.has(`${post.epoch}:${post.sequence}`));
      }, 10000);
      const records = transportRecords();
      // STOP with a full queue, then a note in the new epoch: its ACK closes the round trip.
      for (let index = 0; index < 2000; index++) {
        try {
          engine.audio.play(sound, index % 4);
        } catch {
          break;
        }
      }
      const stopAt = now();
      engine.audio.stop();
      const stopCallMs = now() - stopAt;
      engine.audio.play(sound, 0);
      const epoch = probe().posts.at(-1)?.epoch;
      const sequence = probe().posts.at(-1)?.sequence;
      await until(() => acked().has(`${epoch}:${sequence}`), 5000);
      const roundTrip = probe().acks.find(
        (ack) => ack.epoch === epoch && ack.sequence === sequence,
      );
      // Suspension by pause(): notes played meanwhile must not be sent.
      await until(() => acked().size >= batchesPosted().length, 5000);
      const pauseAt = now();
      const postsBeforePause = probe().posts.length;
      engine.pause();
      await until(() => engine.audio.capabilities.state === 'suspended', 5000);
      for (let index = 0; index < 100; index++) engine.audio.play(sound, index % 4);
      const postsWhilePaused = probe()
        .posts.slice(postsBeforePause)
        .filter((post) =>
          post.events?.some((event) => event.kind === 'note_on' || event.kind === 'sound'),
        ).length;
      const resumeAt = now();
      engine.resume();
      await until(() => engine.audio.capabilities.state === 'running', 5000);
      const suspended = stateChanges.find(
        (change) => change.t >= pauseAt && change.state === 'suspended',
      );
      const resumed = stateChanges.find(
        (change) => change.t >= resumeAt && change.state === 'running',
      );
      result.real.push({
        admitted,
        rejected,
        burstMs: burstEnd - burstStart,
        drained,
        records,
        burstEnd,
        stopCallMs,
        stopRoundTripMs: roundTrip ? roundTrip.t - stopAt : null,
        suspendMs: suspended ? suspended.t - pauseAt : null,
        resumeMs: resumed ? resumed.t - resumeAt : null,
        postsWhilePaused,
      });
    }
    result.realInfo = {
      unlockMs,
      errors,
      state: engine.audio.capabilities.state,
      contexts: audioContexts(),
    };
    await engine.dispose();
    canvas.remove();
  }

  // 2. A processor that never consumes: credits and repeated stop()/play() cycles.
  {
    const canvas = newCanvas();
    const engine = await createEngine({
      canvas,
      renderer: 'canvas2d',
      width: 64,
      height: 64,
      audioWorkletUrl: stallUrl,
    });
    engine.start({ update() {}, draw() {} });
    await engine.audio.unlock();
    probe().resetTransport();
    let admitted = 0;
    let rejected = 0;
    for (let index = 0; index < 2000; index++) {
      try {
        engine.audio.play({ frequency: 330 }, index % 4);
        admitted++;
      } catch (error) {
        if (error?.code !== 'CAPACITY') throw error;
        rejected++;
      }
    }
    const afterBurst = probe().posts.length;
    for (let cycle = 0; cycle < cycles; cycle++) {
      engine.audio.stop();
      for (let index = 0; index < 300; index++) {
        try {
          engine.audio.play({ frequency: 330 }, index % 4);
        } catch {
          break;
        }
      }
    }
    const records = transportRecords();
    result.stalled = {
      admitted,
      rejected,
      afterBurst,
      afterCycles: probe().posts.length,
      cycles,
      bytes: records.posts.reduce((total, post) => total + post[6], 0),
      acks: records.acks.filter((ack) => ack[1] === 'ack').length,
    };
    await engine.dispose();
    canvas.remove();
  }

  // 3. A processor that fails 32 quanta after starting.
  {
    const canvas = newCanvas();
    const reports = [];
    const engine = await createEngine({
      canvas,
      renderer: 'canvas2d',
      width: 64,
      height: 64,
      audioWorkletUrl: failingUrl,
      onError: (error) => reports.push({ code: codeOf(error), t: now() }),
    });
    engine.start({
      update() {},
      draw() {
        engine.graphics.clear(2);
      },
    });
    const unlockAt = now();
    let unlock = 'OK';
    try {
      await engine.audio.unlock();
    } catch (error) {
      unlock = codeOf(error);
    }
    await until(() => engine.audio.capabilities.state === 'failed', 5000);
    const framesAtFailure = engine.getStats().frames;
    await delay(200);
    const contexts = audioContexts();
    result.failing = {
      unlock,
      state: engine.audio.capabilities.state,
      engineState: engine.state,
      reports: reports.map((report) => report.code),
      failureMs: reports[0] ? reports[0].t - unlockAt : null,
      framesAfter: engine.getStats().frames - framesAtFailure,
      contextState: contexts.last?.state ?? null,
    };
    await engine.dispose();
    canvas.remove();
  }
  return result;
}

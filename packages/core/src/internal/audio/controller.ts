import { integer, PixelJSError, record } from '../../api/errors.js';
import type {
  AudioCapabilities,
  AudioState,
  AudioSystem,
  EngineOptions,
  MusicOptions,
  MusicResource,
  SoundEffect,
  SoundInstance,
  SoundOptions,
  SoundResource,
  SoundWaveform,
} from '../../api/types.js';
import { assetUrl, checkSignal, fetchLimited, parseJson, throwIfAborted } from '../fetch.js';
import { readBinary } from '../wasm/adapter.js';
import {
  EFFECTS,
  type InstrumentData,
  type NoteData,
  parseEffect,
  parseInstrument,
  parseNotes,
  parseTempo,
  parseWaveform,
  SEQUENCE_LIMITS,
  WAVEFORMS,
} from './sequence.js';

/**
 * Transport budgets: batches in flight, events per batch and queued notes;
 * startup limits for downloading the DSP and module, and for the processor.
 */
export const AUDIO_LIMITS = Object.freeze({
  batchesInFlight: 4,
  eventsPerBatch: 64,
  pendingEvents: 1024,
  loadTimeoutMs: 30_000,
  readyTimeoutMs: 10_000,
  resumeTimeoutMs: 5_000,
  soundAssetBytes: 64 * 1024,
  musicAssetBytes: 256 * 1024,
});
const PROCESSOR_VERSION = 3;
const VOICES = 4;

interface NoteOnEvent {
  kind: 'note_on';
  voice: number;
  waveform: number;
  frequency: number;
  volume: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  duration: number;
  effect: number;
  slideTo: number;
}
interface NoteOffEvent {
  kind: 'note_off';
  voice: number;
}
/** A multi-note sound on one voice. */
interface SoundEvent {
  kind: 'sound';
  voice: number;
  centiBpm: number;
  stepsPerBeat: number;
  instrument: InstrumentData;
  notes: readonly NoteData[];
}
interface MusicEvent {
  kind: 'music';
  centiBpm: number;
  stepsPerBeat: number;
  length: number;
  loop: boolean;
  tracks: readonly { voice: number; instrument: InstrumentData; notes: readonly NoteData[] }[];
}
interface MusicStopEvent {
  kind: 'music_stop';
}
type AudioEvent = NoteOnEvent | NoteOffEvent | SoundEvent | MusicEvent | MusicStopEvent;

/** A validated sound: the note event it plays, minus its voice. */
type SoundPlan = Omit<NoteOnEvent, 'voice'> | Omit<SoundEvent, 'voice'>;

/** Validated music, kept per resource for playMusic. */
type MusicPlan = Omit<MusicEvent, 'kind' | 'loop'> & { loop: boolean };

const EFFECT_NAMES = Object.freeze(Object.keys(EFFECTS)) as readonly SoundEffect[];

function frequencyOf(value: unknown, name: string, fallback: number): number {
  const frequency = value ?? fallback;
  if (
    typeof frequency !== 'number' ||
    !Number.isFinite(frequency) ||
    frequency <= 0 ||
    frequency > 24000
  )
    throw new PixelJSError('RANGE', `${name} must be a positive number up to 24000 Hz.`);
  return frequency;
}

/** Validates sound data from JavaScript, JSON assets or resources alike. */
function soundPlan(source: unknown): SoundPlan {
  const options = (source ?? {}) as Record<string, unknown>;
  record(options, 'sound options');
  const waveform = parseWaveform(options['waveform'], 'square');
  const instrument = parseInstrument(options);
  if (options['notes'] !== undefined) {
    for (const key of ['frequency', 'duration', 'effect', 'slideTo'])
      if (options[key] !== undefined)
        throw new PixelJSError('ARGUMENT', `${key} does not apply to a sound with notes.`);
    const tempo = parseTempo(options, 120);
    const notes = parseNotes(
      options['notes'],
      'notes',
      SEQUENCE_LIMITS.soundNotes,
      SEQUENCE_LIMITS.maxSteps,
      waveform,
    );
    if (notes.length === 0) throw new PixelJSError('RANGE', 'notes must hold at least one note.');
    return Object.freeze({
      kind: 'sound',
      centiBpm: tempo.centiBpm,
      stepsPerBeat: tempo.stepsPerBeat,
      instrument,
      notes,
    });
  }
  const effect = parseEffect(options['effect']);
  const duration = options['duration'] ?? 0.1;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 60)
    throw new PixelJSError('RANGE', 'duration must be a positive number up to 60 seconds.');
  const slideTo = effect === EFFECTS.slide ? frequencyOf(options['slideTo'], 'slideTo', NaN) : 0;
  return Object.freeze({
    kind: 'note_on',
    waveform,
    frequency: frequencyOf(options['frequency'], 'frequency', 440),
    ...instrument,
    duration,
    effect,
    slideTo,
  });
}

/**
 * JSON assets may name their format; newer versions are rejected rather
 * than half understood.
 */
function checkFormat(data: Record<string, unknown>, format: string, required: boolean): void {
  if (data['format'] === undefined && !required) return;
  if (data['format'] !== format)
    throw new PixelJSError('ASSET_DATA', `Expected a "${format}" file.`);
  if (data['version'] !== 1)
    throw new PixelJSError(
      'ASSET_DATA',
      `Unsupported ${format} version; this engine reads version 1.`,
    );
}

/** Validates music from JavaScript or JSON. */
function musicPlan(source: unknown): MusicPlan {
  record(source, 'music options');
  const tempo = parseTempo(source);
  const length = integer(source['length'], 'length', 1, SEQUENCE_LIMITS.maxSteps);
  const loop = source['loop'] ?? true;
  if (typeof loop !== 'boolean') throw new PixelJSError('ARGUMENT', 'loop must be a boolean.');
  const list = source['tracks'];
  if (!Array.isArray(list) || list.length === 0 || list.length > SEQUENCE_LIMITS.tracks)
    throw new PixelJSError('RANGE', 'tracks must be an array of 1 to 4 tracks.');
  const voices = new Set<number>();
  const tracks = list.map((value: unknown, index) => {
    const label = `tracks[${index}]`;
    record(value, label);
    const voice =
      value['voice'] === undefined
        ? index
        : integer(value['voice'], `${label}.voice`, 0, VOICES - 1);
    if (voices.has(voice))
      throw new PixelJSError('ARGUMENT', `${label}.voice ${voice} is used by another track.`);
    voices.add(voice);
    const waveform = parseWaveform(value['waveform'], 'square', `${label}.waveform`);
    return Object.freeze({
      voice,
      instrument: parseInstrument(value, `${label}.`),
      notes: parseNotes(
        value['notes'],
        `${label}.notes`,
        SEQUENCE_LIMITS.trackNotes,
        length,
        waveform,
      ),
    });
  });
  return Object.freeze({
    centiBpm: tempo.centiBpm,
    stepsPerBeat: tempo.stepsPerBeat,
    length,
    loop,
    tracks: Object.freeze(tracks),
  });
}

/** Rejects with `timeout()` when `work` has not settled after `milliseconds`. */
function within<T>(work: Promise<T>, milliseconds: number, timeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeout()), milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

/** Rejects with the abort reason when `signal` aborts first; `work` itself cannot be cancelled. */
function settleBefore<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Lazy, optional audio: nothing is created or downloaded before unlock().
 * Failures are reported through `report` and never pause the visual game.
 */
export class AudioController implements AudioSystem {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private output: GainNode | null = null;
  private state: AudioState = 'uninitialized';
  private ready = false;
  private volume = 1;
  private nextVoice = 0;
  /** Per voice, the newest note that stop() may still end; 0 means none. */
  private readonly generations = [0, 0, 0, 0];
  private nextGeneration = 0;
  private readonly instances = new WeakMap<object, { voice: number; generation: number }>();
  private readonly sounds = new WeakMap<object, SoundPlan>();
  private readonly musics = new WeakMap<object, MusicPlan>();
  private readonly released = new WeakSet<object>();
  /** The piece that should be playing, started as soon as audio is ready. */
  private music: MusicPlan | null = null;
  private epoch = 0;
  private sequence = 0;
  /** Batches sent and not yet acknowledged: sequence → epoch. */
  private readonly inFlight = new Map<number, number>();
  /** Epoch of the stop the processor has not confirmed yet. */
  private stopSent: number | null = null;
  /** A stop (for the current epoch) waits for that confirmation. */
  private stopWaiting = false;
  private readonly pending: AudioEvent[] = [];
  private readonly pauses = new Set<'manual' | 'hidden'>();
  private unlocking: Promise<void> | null = null;
  private cancelStartup: ((error: Error) => void) | null = null;
  private loading: AbortController | null = null;

  constructor(
    private readonly options: EngineOptions,
    private readonly report: (error: Error) => void = () => undefined,
  ) {}

  get capabilities(): AudioCapabilities {
    const view = typeof window === 'undefined' ? undefined : window;
    const supported =
      view !== undefined &&
      (typeof view.AudioContext === 'function' ||
        typeof (view as unknown as { webkitAudioContext?: unknown }).webkitAudioContext ===
          'function') &&
      typeof view.AudioWorkletNode === 'function';
    return Object.freeze({ supported, state: this.state });
  }

  /** Must be called from a user gesture. Repeated calls share one attempt. */
  unlock(): Promise<void> {
    if (this.state === 'disposed')
      return Promise.reject(new PixelJSError('STATE', 'Audio was disposed with its engine.'));
    if (this.state === 'failed')
      return Promise.reject(
        new PixelJSError('STATE', 'Audio failed; create a new engine to try again.'),
      );
    if (this.ready && this.context?.state === 'running' && this.pauses.size === 0)
      return Promise.resolve();
    if (!this.capabilities.supported)
      return Promise.reject(
        new PixelJSError('UNSUPPORTED', 'Web Audio with AudioWorklet is not available.'),
      );
    this.unlocking ??= this.start().finally(() => {
      this.unlocking = null;
    });
    return this.unlocking;
  }

  private active(): void {
    if (this.state === 'disposed')
      throw new PixelJSError('STATE', 'The engine was disposed during audio startup.');
  }

  private async start(): Promise<void> {
    try {
      const context = this.context ?? this.createContext();
      if (context.state !== 'running') {
        // A device that never answers (no output, busy driver) must not leave
        // unlock() pending; a later gesture can try again.
        try {
          await within(
            context.resume(),
            AUDIO_LIMITS.resumeTimeoutMs,
            () => new PixelJSError('BLOCKED', 'The audio device did not start in time.'),
          );
        } catch (error) {
          if (error instanceof PixelJSError) throw error;
          throw new PixelJSError('BLOCKED', 'The browser blocked audio playback.', {
            cause: error,
          });
        }
      }
      this.active();
      if (context.state !== 'running')
        throw new PixelJSError('BLOCKED', 'Audio needs a user gesture such as a click or key.');
      if (!this.ready) await this.load(context);
      this.active();
      this.state = 'running';
      // Music requested before unlock starts now.
      if (this.music) this.sendMusic();
      // Unlocking while the game is paused keeps the device suspended.
      if (this.pauses.size > 0) this.suspend();
    } catch (value) {
      // Whatever an interrupted step reported, disposal is the reason.
      if (this.state === 'disposed')
        throw value instanceof PixelJSError && value.code === 'STATE'
          ? value
          : new PixelJSError('STATE', 'The engine was disposed during audio startup.', {
              cause: value,
            });
      const error =
        value instanceof PixelJSError
          ? value
          : new PixelJSError('AUDIO_ERROR', 'Audio could not start.', { cause: value });
      if (this.state !== 'failed') this.state = error.code === 'BLOCKED' ? 'blocked' : 'failed';
      if (this.state === 'failed') void this.shutdown();
      throw error;
    }
  }

  private createContext(): AudioContext {
    const view = window as unknown as { webkitAudioContext?: typeof AudioContext };
    const AudioContextClass = window.AudioContext ?? view.webkitAudioContext;
    if (!AudioContextClass)
      throw new PixelJSError('UNSUPPORTED', 'Web Audio with AudioWorklet is not available.');
    const context = new AudioContextClass();
    context.onstatechange = () => {
      if (!this.ready || this.state === 'disposed' || this.state === 'failed') return;
      if (context.state === 'running') this.state = 'running';
      else if (context.state !== 'closed') this.state = 'suspended';
      // Sends stops that waited for credit; a suspension drops queued notes.
      this.flush();
    };
    this.context = context;
    return context;
  }

  private async load(context: AudioContext): Promise<void> {
    const wasmUrl =
      this.options.audioWasmUrl !== undefined
        ? assetUrl(this.options.audioWasmUrl, 'audioWasmUrl')
        : new URL('../wasm/audio.wasm', import.meta.url);
    // A same-origin module satisfies `script-src 'self'`; blob: URLs would not.
    const moduleUrl =
      this.options.audioWorkletUrl !== undefined
        ? assetUrl(this.options.audioWorkletUrl, 'audioWorkletUrl')
        : new URL('./processor.js', import.meta.url);
    // A stalled download must not leave unlock() pending forever.
    const loading = new AbortController();
    this.loading = loading;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      loading.abort();
    }, AUDIO_LIMITS.loadTimeoutMs);
    let binary: Uint8Array;
    try {
      binary = await readBinary(wasmUrl, loading.signal);
      this.active();
      await settleBefore(context.audioWorklet.addModule(moduleUrl.href), loading.signal);
    } catch (error) {
      if (timedOut)
        throw new PixelJSError('AUDIO_ERROR', 'The audio files did not load in time.', {
          cause: error,
        });
      throw error;
    } finally {
      clearTimeout(deadline);
      this.loading = null;
    }
    this.active();
    const node = new AudioWorkletNode(context, 'pixeljs-audio-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node = node;
    await this.handshake(node, binary);
    this.active();
    const output = context.createGain();
    output.gain.value = this.volume;
    node.connect(output);
    output.connect(context.destination);
    this.output = output;
    this.ready = true;
  }

  /** Transfers the DSP bytes and waits, bounded, for the processor to start. */
  private handshake(node: AudioWorkletNode, binary: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error): void => {
        clearTimeout(timer);
        this.cancelStartup = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => settle(new PixelJSError('AUDIO_ERROR', 'The audio processor did not start in time.')),
        AUDIO_LIMITS.readyTimeoutMs,
      );
      this.cancelStartup = settle;
      node.onprocessorerror = () =>
        settle(new PixelJSError('AUDIO_ERROR', 'The audio processor failed to start.'));
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { type?: unknown; message?: unknown } | null;
        if (message?.type === 'ready') {
          node.port.onmessage = (next: MessageEvent<unknown>) => this.receive(next.data);
          node.onprocessorerror = () => this.fail('The audio processor stopped with an error.');
          settle();
        } else if (message?.type === 'error') {
          settle(
            new PixelJSError('AUDIO_ERROR', `Audio processor error: ${String(message.message)}`),
          );
        } else if (message?.type === 'stopped') {
          this.receive(message);
        }
      };
      const bytes = binary.slice().buffer;
      // The processor starts in the current epoch, so no earlier stop is due.
      this.stopWaiting = false;
      node.port.postMessage(
        { type: 'init', version: PROCESSOR_VERSION, epoch: this.epoch, bytes },
        [bytes],
      );
    });
  }

  private receive(data: unknown): void {
    const message = data as {
      type?: unknown;
      epoch?: unknown;
      sequence?: unknown;
      message?: unknown;
    } | null;
    if (message?.type === 'music_end') {
      if (message.epoch === this.epoch) this.music = null;
    } else if (message?.type === 'ack') {
      // Each batch returns its credit exactly once, also after a stop: until
      // the processor has taken a batch, it occupies the port. Unknown,
      // mismatched and duplicate acknowledgements return nothing.
      if (typeof message.sequence !== 'number') return;
      if (this.inFlight.get(message.sequence) !== message.epoch) return;
      this.inFlight.delete(message.sequence);
      this.flush();
    } else if (message?.type === 'stopped') {
      if (message.epoch !== this.stopSent) return;
      this.stopSent = null;
      this.flush();
    } else if (message?.type === 'error') {
      this.fail(`Audio processor error: ${String(message.message)}`);
    }
  }

  private fail(reason: string): void {
    if (this.state === 'disposed' || this.state === 'failed') return;
    this.state = 'failed';
    void this.shutdown();
    this.report(new PixelJSError('AUDIO_ERROR', reason));
  }

  /** Failure is final for this engine, so the audio device is released now. */
  private shutdown(): Promise<void> {
    this.teardownGraph();
    const context = this.context;
    this.context = null;
    if (context) context.onstatechange = null;
    if (!context || context.state === 'closed') return Promise.resolve();
    return context.close().catch(() => undefined);
  }

  private teardownGraph(): void {
    this.ready = false;
    this.music = null;
    this.pending.length = 0;
    this.inFlight.clear();
    this.stopSent = null;
    this.stopWaiting = false;
    // Handlers left on a closed graph would keep this engine reachable.
    if (this.node) {
      this.node.onprocessorerror = null;
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node.port.close();
    }
    this.node = null;
    this.output?.disconnect();
    this.output = null;
  }

  /** True only while notes can actually be heard now. */
  private accepting(): boolean {
    return (
      this.ready &&
      this.state === 'running' &&
      this.pauses.size === 0 &&
      this.context?.state === 'running'
    );
  }

  /**
   * Queues a note. When audio is not running (not unlocked, blocked,
   * suspended, paused or failed) the note is dropped: it is never replayed
   * later as a burst, and its instance does nothing. The returned instance
   * can stop only this note, and only while it is the newest on its voice.
   */
  play(sound?: SoundOptions | SoundResource, explicitVoice?: number): SoundInstance {
    if (
      sound !== undefined &&
      sound !== null &&
      typeof sound === 'object' &&
      this.released.has(sound)
    )
      throw new PixelJSError('HANDLE', 'Sound resource has been released.');
    const plan =
      sound !== undefined && sound !== null && typeof sound === 'object'
        ? (this.sounds.get(sound) ?? soundPlan(sound))
        : soundPlan(sound);
    const requested =
      explicitVoice === undefined ? undefined : integer(explicitVoice, 'voice', 0, VOICES - 1);
    const admitted = this.accepting();
    if (admitted && this.pending.length >= AUDIO_LIMITS.pendingEvents)
      throw new PixelJSError('CAPACITY', 'Too many sounds are waiting for the audio thread.');
    const voice = requested ?? this.allocateVoice();
    // Only an admitted note replaces the voice's stoppable note.
    if (!admitted) return this.instance(voice, 0);
    this.nextGeneration += 1;
    this.generations[voice] = this.nextGeneration;
    this.pending.push({ ...plan, voice } as AudioEvent);
    this.flush();
    return this.instance(voice, this.nextGeneration);
  }

  private instance(voice: number, generation: number): SoundInstance {
    const instance: SoundInstance = Object.freeze({
      voice,
      stop: () => this.stopNote(voice, generation),
    });
    this.instances.set(instance, { voice, generation });
    return instance;
  }

  /** Stops one instance, or every sound through the reserved stop path. */
  stop(instance?: SoundInstance): void {
    if (instance !== undefined) {
      const entry =
        typeof instance === 'object' && instance !== null
          ? this.instances.get(instance)
          : undefined;
      if (!entry) throw new PixelJSError('HANDLE', 'Expected a sound instance returned by play().');
      this.stopNote(entry.voice, entry.generation);
      return;
    }
    this.epoch = (this.epoch + 1) % 0x100000000;
    this.pending.length = 0;
    this.generations.fill(0);
    this.music = null;
    this.stopWaiting = true;
    this.sendStop();
  }

  /**
   * Posts the pending stop unless an earlier one is unconfirmed; stops made
   * meanwhile coalesce into the newest epoch, so a processor that reads
   * nothing holds at most the batch credits and one stop. The port is
   * ordered: batches sent before a stop are cancelled, even while the
   * processor is still starting.
   */
  private sendStop(): void {
    const node = this.node;
    if (!node || !this.stopWaiting || this.stopSent !== null) return;
    this.stopWaiting = false;
    this.stopSent = this.epoch;
    node.port.postMessage({ type: 'stop', epoch: this.epoch });
  }

  /** Round-robin keeps each voice's instance generation meaningful. */
  private allocateVoice(): number {
    const voice = this.nextVoice;
    this.nextVoice = (voice + 1) % VOICES;
    return voice;
  }

  /**
   * Ends a voice's newest note once. The stop is queued even while paused or
   * suspended, and even when notes fill the queue: every stop consumes a
   * stoppable note, so stops add at most one event per voice to the queue.
   */
  private stopNote(voice: number, generation: number): void {
    if (generation === 0 || this.generations[voice] !== generation) return;
    this.generations[voice] = 0;
    if (!this.ready) return;
    this.pending.push({ kind: 'note_off', voice });
    this.flush();
  }

  /** Output gain in [0, 1], applied once by the host graph with a short ramp. */
  setVolume(volume: number): void {
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1)
      throw new PixelJSError('RANGE', 'volume must be a number between 0 and 1.');
    this.volume = volume;
    if (this.output && this.context)
      this.output.gain.setTargetAtTime(volume, this.context.currentTime, 0.015);
  }

  createSound(options: SoundOptions): SoundResource {
    record(options, 'sound options');
    const plan = soundPlan(options);
    const waveform = (options.waveform ?? 'square') as SoundWaveform;
    const view =
      plan.kind === 'note_on'
        ? {
            frequency: plan.frequency,
            duration: plan.duration,
            effect: EFFECT_NAMES[plan.effect] ?? 'none',
            notes: 0,
          }
        : {
            frequency: 440 * 2 ** (((plan.notes[0]?.[2] ?? 69) - 69) / 12),
            duration:
              (Math.max(...plan.notes.map((note) => note[0] + note[1])) * 6000) /
              (plan.centiBpm * plan.stepsPerBeat),
            effect: 'none' as SoundEffect,
            notes: plan.notes.length,
          };
    const sound = Object.freeze({
      waveform,
      volume: plan.kind === 'note_on' ? plan.volume : plan.instrument.volume,
      attack: plan.kind === 'note_on' ? plan.attack : plan.instrument.attack,
      decay: plan.kind === 'note_on' ? plan.decay : plan.instrument.decay,
      sustain: plan.kind === 'note_on' ? plan.sustain : plan.instrument.sustain,
      release: plan.kind === 'note_on' ? plan.release : plan.instrument.release,
      ...view,
    }) as unknown as SoundResource;
    this.sounds.set(sound, plan);
    return sound;
  }

  createMusic(options: MusicOptions): MusicResource {
    const plan = musicPlan(options);
    const music = Object.freeze({
      bpm: plan.centiBpm / 100,
      stepsPerBeat: plan.stepsPerBeat,
      length: plan.length,
      loop: plan.loop,
      tracks: plan.tracks.length,
    }) as unknown as MusicResource;
    this.musics.set(music, plan);
    return music;
  }

  async loadMusic(src: string, options: { signal?: AbortSignal } = {}): Promise<MusicResource> {
    record(options, 'loadMusic options');
    const url = assetUrl(src, 'src');
    const signal = checkSignal(options.signal);
    const { bytes } = await fetchLimited(url, {
      limit: AUDIO_LIMITS.musicAssetBytes,
      code: 'ASSET_LOAD',
      signal,
    });
    throwIfAborted(signal);
    const data = parseJson(bytes, 'ASSET_DATA');
    record(data, 'music asset');
    checkFormat(data, 'pixeljs-music', true);
    return this.createMusic(data as unknown as MusicOptions);
  }

  /**
   * Plays a piece from its start. Before audio is ready it starts once it
   * is; while paused it starts with the device.
   */
  playMusic(music: MusicResource, options: { loop?: boolean } = {}): void {
    const plan = typeof music === 'object' && music !== null ? this.musics.get(music) : undefined;
    if (!plan || this.released.has(music))
      throw new PixelJSError('HANDLE', 'Expected music from createMusic() or loadMusic().');
    record(options, 'playMusic options');
    const loop = options.loop ?? plan.loop;
    if (typeof loop !== 'boolean') throw new PixelJSError('ARGUMENT', 'loop must be a boolean.');
    if (this.state === 'disposed' || this.state === 'failed') return;
    this.music = { ...plan, loop };
    this.sendMusic();
  }

  stopMusic(): void {
    this.music = null;
    this.sendMusic();
  }

  get musicPlaying(): boolean {
    return this.music !== null;
  }

  /** Replaces any queued music command with the current wish. */
  private sendMusic(): void {
    if (!this.ready || !this.node) return;
    const kept = this.pending.filter(
      (event) => event.kind !== 'music' && event.kind !== 'music_stop',
    );
    this.pending.length = 0;
    this.pending.push(...kept);
    this.pending.push(this.music ? { kind: 'music', ...this.music } : { kind: 'music_stop' });
    this.flush();
  }

  async loadSound(src: string, options: { signal?: AbortSignal } = {}): Promise<SoundResource> {
    record(options, 'loadSound options');
    const url = assetUrl(src, 'src');
    const signal = checkSignal(options.signal);
    const { bytes } = await fetchLimited(url, {
      limit: AUDIO_LIMITS.soundAssetBytes,
      code: 'ASSET_LOAD',
      signal,
    });
    throwIfAborted(signal);
    const data = parseJson(bytes, 'ASSET_DATA');
    record(data, 'sound asset');
    checkFormat(data, 'pixeljs-sound', false);
    return this.createSound(data as SoundOptions);
  }

  isSound(value: object): boolean {
    return this.sounds.has(value);
  }

  markReleased(resource: object): void {
    this.released.add(resource);
  }

  private suspend(): void {
    // Not accepting any more: queued notes become stops before the device
    // pauses, so none of them sounds late when it resumes.
    this.flush();
    if (this.context?.state === 'running') void this.context.suspend().catch(() => undefined);
  }

  onPause(reason: 'manual' | 'hidden'): void {
    this.pauses.add(reason);
    this.suspend();
  }

  /** Audio resumes only when every pause reason has cleared. */
  onResume(reason: 'manual' | 'hidden'): void {
    this.pauses.delete(reason);
    if (
      this.pauses.size === 0 &&
      this.ready &&
      this.state !== 'failed' &&
      this.state !== 'disposed'
    )
      void this.context?.resume().catch(() => undefined);
  }

  /** Stops scheduling immediately; settles once the device is closed. */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.loading?.abort();
    this.cancelStartup?.(
      new PixelJSError('STATE', 'The engine was disposed during audio startup.'),
    );
    await this.shutdown();
  }

  /**
   * Sends queued events while credits last. When audio is not running, only
   * stops are sent: each queued note is dropped and silences its voice
   * instead, because its note-on would have replaced what played there.
   */
  private flush(): void {
    const node = this.node;
    if (!node || !this.ready) return;
    // Batches of the new epoch would be dropped before the processor saw its stop.
    this.sendStop();
    if (this.stopWaiting) return;
    if (
      !this.accepting() &&
      this.pending.some((event) => event.kind === 'note_on' || event.kind === 'sound')
    ) {
      const control: AudioEvent[] = [];
      const voices = new Set<number>();
      for (const event of this.pending) {
        if (event.kind === 'music' || event.kind === 'music_stop') control.push(event);
        else voices.add(event.voice);
      }
      this.pending.length = 0;
      this.pending.push(...control);
      for (const voice of voices) this.pending.push({ kind: 'note_off', voice });
    }
    while (this.inFlight.size < AUDIO_LIMITS.batchesInFlight && this.pending.length > 0) {
      this.sequence = (this.sequence + 1) % 0x100000000;
      this.inFlight.set(this.sequence, this.epoch);
      node.port.postMessage({
        type: 'batch',
        epoch: this.epoch,
        sequence: this.sequence,
        events: this.pending.splice(0, AUDIO_LIMITS.eventsPerBatch),
      });
    }
  }
}

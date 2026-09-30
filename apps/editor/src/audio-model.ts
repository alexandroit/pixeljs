import type {
  MusicOptions,
  NoteOptions,
  SoundEffect,
  SoundOptions,
  SoundWaveform,
  TrackOptions,
} from '@pixeljs/core';
import { bool, fail, has, int, list, num, record, type Json } from './json.js';

export const WAVEFORMS: readonly SoundWaveform[] = ['square', 'triangle', 'sine', 'noise'];
export const EFFECTS: readonly SoundEffect[] = ['none', 'slide', 'vibrato', 'fadeout'];

/** The engine's documented audio limits, checked before anything plays or saves. */
export const AUDIO_LIMITS = Object.freeze({
  sounds: 64,
  music: 16,
  soundNotes: 64,
  trackNotes: 512,
  tracks: 4,
  voices: 4,
  maxSteps: 4096,
  minBpm: 20,
  maxBpm: 400,
  maxStepsPerBeat: 16,
  maxFrequency: 24000,
  maxDuration: 60,
  maxStage: 10,
});

/** One note in steps; notes are immutable values, replaced on every edit. */
export interface Note {
  readonly step: number;
  readonly length: number;
  /** MIDI note 0–127 (C4 = 60). */
  readonly pitch: number;
  readonly volume: number;
  /** null: the sound's or track's waveform. */
  readonly waveform: SoundWaveform | null;
  readonly effect: SoundEffect;
}

export interface Instrument {
  readonly waveform: SoundWaveform;
  readonly volume: number;
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

/** The engine's defaults for an instrument (SoundOptions and TrackOptions). */
export const DEFAULT_INSTRUMENT: Instrument = Object.freeze({
  waveform: 'square',
  volume: 1,
  attack: 0.005,
  decay: 0.01,
  sustain: 0.7,
  release: 0.05,
});

export interface Sound {
  readonly uid: number;
  name: string;
  /** A multi-note sound (a jingle) instead of a single note. */
  multi: boolean;
  instrument: Instrument;
  /** Single note: frequency (Hz), gate duration (s), effect and slide target (Hz). */
  frequency: number;
  duration: number;
  effect: SoundEffect;
  slideTo: number;
  /** Multi-note: tempo and notes. */
  bpm: number;
  stepsPerBeat: number;
  notes: readonly Note[];
}

export interface Track {
  readonly uid: number;
  voice: number;
  instrument: Instrument;
  notes: readonly Note[];
}

export interface Music {
  readonly uid: number;
  name: string;
  bpm: number;
  stepsPerBeat: number;
  /** Length of the piece in steps. */
  length: number;
  loop: boolean;
  tracks: readonly Track[];
}

let nextUid = 1;

export function makeNote(fields: Partial<Note> & Pick<Note, 'step' | 'pitch'>): Note {
  return Object.freeze({ length: 1, volume: 1, waveform: null, effect: 'none', ...fields });
}

export function createSound(
  name: string,
  fields: Partial<Omit<Sound, 'uid' | 'name'>> = {},
): Sound {
  return {
    uid: nextUid++,
    name,
    multi: false,
    instrument: DEFAULT_INSTRUMENT,
    frequency: 440,
    duration: 0.1,
    effect: 'none',
    slideTo: 880,
    bpm: 120,
    stepsPerBeat: 4,
    notes: [],
    ...fields,
  };
}

export function createTrack(
  voice: number,
  fields: Partial<Omit<Track, 'uid' | 'voice'>> = {},
): Track {
  return { uid: nextUid++, voice, instrument: DEFAULT_INSTRUMENT, notes: [], ...fields };
}

export function createMusic(
  name: string,
  fields: Partial<Omit<Music, 'uid' | 'name'>> = {},
): Music {
  return {
    uid: nextUid++,
    name,
    bpm: 120,
    stepsPerBeat: 4,
    length: 32,
    loop: true,
    tracks: [createTrack(0)],
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Pitches

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SEMITONES: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C4' for 60; sharps, octaves -1 to 9. */
export function pitchName(pitch: number): string {
  return `${NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** The engine's pitch names: a letter, optional '#' or 'b', octave -1–9; null when invalid. */
export function parsePitchName(text: string): number | null {
  const match = /^([A-G])([#b]?)(-1|[0-9])$/.exec(text);
  if (!match) return null;
  const pitch =
    (Number(match[3]) + 1) * 12 +
    (SEMITONES[match[1]!] ?? 0) +
    (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0);
  return pitch >= 0 && pitch <= 127 ? pitch : null;
}

export function pitchFrequency(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(pitch % 12);
}

/** Seconds covered by `steps` at a tempo. */
export function stepSeconds(steps: number, bpm: number, stepsPerBeat: number): number {
  return (steps * 60) / (bpm * stepsPerBeat);
}

// ---------------------------------------------------------------------------
// Note lists: monophonic editing helpers (one voice plays one note at a time)

export function noteAt(notes: readonly Note[], step: number, pitch?: number): Note | undefined {
  return notes.find(
    (note) =>
      step >= note.step &&
      step < note.step + note.length &&
      (pitch === undefined || note.pitch === pitch),
  );
}

/** True when `note` overlaps no other note of the list (except `ignore`). */
export function fits(notes: readonly Note[], note: Note, ignore?: Note): boolean {
  return notes.every(
    (other) =>
      other === ignore ||
      note.step + note.length <= other.step ||
      other.step + other.length <= note.step,
  );
}

/** The longest length up to `wanted` that keeps a note at `step` clear of the next note. */
export function roomAt(
  notes: readonly Note[],
  step: number,
  wanted: number,
  ignore?: Note,
): number {
  let limit = Math.min(wanted, AUDIO_LIMITS.maxSteps);
  for (const other of notes)
    if (other !== ignore && other.step > step) limit = Math.min(limit, other.step - step);
  return Math.max(1, limit);
}

export function sortNotes(notes: readonly Note[]): Note[] {
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.step - b.note.step || a.index - b.index)
    .map(({ note }) => note);
}

export function replaceNote(notes: readonly Note[], old: Note | null, next: Note | null): Note[] {
  const kept = notes.filter((note) => note !== old);
  return sortNotes(next ? [...kept, next] : kept);
}

// ---------------------------------------------------------------------------
// Validation, mirroring the engine's ranges for SoundOptions and MusicOptions

function waveform(value: unknown, path: string): SoundWaveform {
  if (typeof value !== 'string' || !(WAVEFORMS as readonly string[]).includes(value))
    fail(path, `expected one of ${WAVEFORMS.join(', ')}.`);
  return value as SoundWaveform;
}

function effect(value: unknown, path: string): SoundEffect {
  if (typeof value !== 'string' || !(EFFECTS as readonly string[]).includes(value))
    fail(path, `expected one of ${EFFECTS.join(', ')}.`);
  return value as SoundEffect;
}

function optional<T>(fields: Json, key: string, fallback: T, parse: (value: unknown) => T): T {
  return has(fields, key) ? parse(fields[key]) : fallback;
}

const INSTRUMENT_KEYS = ['waveform', 'volume', 'attack', 'decay', 'sustain', 'release'];

function parseInstrument(fields: Json, path: string): Instrument {
  const stage = (key: keyof Instrument, max: number) =>
    optional(fields, key, DEFAULT_INSTRUMENT[key] as number, (value) =>
      num(value, `${path}.${key}`, 0, max),
    );
  return Object.freeze({
    waveform: optional(fields, 'waveform', DEFAULT_INSTRUMENT.waveform, (value) =>
      waveform(value, `${path}.waveform`),
    ),
    volume: stage('volume', 1),
    attack: stage('attack', AUDIO_LIMITS.maxStage),
    decay: stage('decay', AUDIO_LIMITS.maxStage),
    sustain: stage('sustain', 1),
    release: stage('release', AUDIO_LIMITS.maxStage),
  });
}

function parsePitch(value: unknown, path: string): number {
  if (typeof value === 'number') return int(value, path, 0, 127);
  const pitch = typeof value === 'string' ? parsePitchName(value) : null;
  if (pitch === null)
    fail(path, "expected a MIDI note 0–127 or a name such as 'C4', 'F#3' or 'Bb5'.");
  return pitch;
}

function parseNotes(
  value: unknown,
  path: string,
  min: number,
  max: number,
  endStep: number,
): Note[] {
  const notes = list(value, path, min, max).map((entry, index) => {
    const label = `${path}[${index}]`;
    const fields = record(
      entry,
      label,
      ['step', 'pitch'],
      ['length', 'volume', 'waveform', 'effect'],
    );
    return makeNote({
      step: int(fields['step'], `${label}.step`, 0, endStep - 1),
      length: optional(fields, 'length', 1, (item) =>
        int(item, `${label}.length`, 1, AUDIO_LIMITS.maxSteps),
      ),
      pitch: parsePitch(fields['pitch'], `${label}.pitch`),
      volume: optional(fields, 'volume', 1, (item) => num(item, `${label}.volume`, 0, 1)),
      waveform: optional<SoundWaveform | null>(fields, 'waveform', null, (item) =>
        waveform(item, `${label}.waveform`),
      ),
      effect: optional(fields, 'effect', 'none', (item) => effect(item, `${label}.effect`)),
    });
  });
  return sortNotes(notes);
}

const TEMPO = (fields: Json, path: string, bpmFallback: number | null) => ({
  bpm:
    bpmFallback === null || has(fields, 'bpm')
      ? num(fields['bpm'], `${path}.bpm`, AUDIO_LIMITS.minBpm, AUDIO_LIMITS.maxBpm)
      : bpmFallback,
  stepsPerBeat: optional(fields, 'stepsPerBeat', 4, (value) =>
    int(value, `${path}.stepsPerBeat`, 1, AUDIO_LIMITS.maxStepsPerBeat),
  ),
});

/**
 * Parses one sound entry: a name plus the engine's SoundOptions. Stricter than
 * the engine only where a field would be ignored (tempo on a single note,
 * `slideTo` without the slide effect), so saving never drops data.
 */
export function parseSound(value: unknown, path: string): Sound {
  const single = ['frequency', 'duration', 'effect', 'slideTo'];
  const multi = ['notes', 'bpm', 'stepsPerBeat'];
  const fields = record(value, path, ['name'], [...INSTRUMENT_KEYS, ...single, ...multi]);
  const name = fields['name'];
  if (typeof name !== 'string') fail(`${path}.name`, 'expected a string.');
  const instrument = parseInstrument(fields, path);
  if (has(fields, 'notes')) {
    for (const key of single)
      if (has(fields, key)) fail(`${path}.${key}`, 'does not apply to a sound with notes.');
    const tempo = TEMPO(fields, path, 120);
    const notes = parseNotes(
      fields['notes'],
      `${path}.notes`,
      1,
      AUDIO_LIMITS.soundNotes,
      AUDIO_LIMITS.maxSteps,
    );
    return createSound(name, { multi: true, instrument, ...tempo, notes });
  }
  for (const key of ['bpm', 'stepsPerBeat'])
    if (has(fields, key)) fail(`${path}.${key}`, 'applies only to a sound with notes.');
  const soundEffect = optional(fields, 'effect', 'none', (item) => effect(item, `${path}.effect`));
  if (soundEffect === 'slide' && !has(fields, 'slideTo'))
    fail(path, 'the slide effect needs “slideTo”.');
  if (soundEffect !== 'slide' && has(fields, 'slideTo'))
    fail(`${path}.slideTo`, 'applies only to the slide effect.');
  const hertz = (item: unknown, key: string) =>
    num(item, `${path}.${key}`, 0, AUDIO_LIMITS.maxFrequency, true);
  return createSound(name, {
    instrument,
    frequency: optional(fields, 'frequency', 440, (item) => hertz(item, 'frequency')),
    duration: optional(fields, 'duration', 0.1, (item) =>
      num(item, `${path}.duration`, 0, AUDIO_LIMITS.maxDuration, true),
    ),
    effect: soundEffect,
    slideTo: soundEffect === 'slide' ? hertz(fields['slideTo'], 'slideTo') : 880,
  });
}

/** Parses one music entry: a name plus the engine's MusicOptions. */
export function parseMusic(value: unknown, path: string): Music {
  const fields = record(value, path, ['name', 'bpm', 'length', 'tracks'], ['stepsPerBeat', 'loop']);
  const name = fields['name'];
  if (typeof name !== 'string') fail(`${path}.name`, 'expected a string.');
  const tempo = TEMPO(fields, path, null);
  const length = int(fields['length'], `${path}.length`, 1, AUDIO_LIMITS.maxSteps);
  const loop = optional(fields, 'loop', true, (item) => bool(item, `${path}.loop`));
  const voices = new Set<number>();
  const tracks = list(fields['tracks'], `${path}.tracks`, 1, AUDIO_LIMITS.tracks).map(
    (entry, index) => {
      const label = `${path}.tracks[${index}]`;
      const track = record(entry, label, ['notes'], ['voice', ...INSTRUMENT_KEYS]);
      const voice = optional(track, 'voice', index, (item) =>
        int(item, `${label}.voice`, 0, AUDIO_LIMITS.voices - 1),
      );
      if (voices.has(voice)) fail(`${label}.voice`, `voice ${voice} is used by another track.`);
      voices.add(voice);
      return createTrack(voice, {
        instrument: parseInstrument(track, label),
        notes: parseNotes(track['notes'], `${label}.notes`, 0, AUDIO_LIMITS.trackNotes, length),
      });
    },
  );
  return createMusic(name, { ...tempo, length, loop, tracks });
}

// ---------------------------------------------------------------------------
// Canonical output: exactly the engine's option shapes, every field explicit

export function noteOptions(note: Note): NoteOptions {
  const options: { -readonly [K in keyof NoteOptions]: NoteOptions[K] } = {
    step: note.step,
    length: note.length,
    pitch: pitchName(note.pitch),
    volume: note.volume,
  };
  if (note.waveform !== null) options.waveform = note.waveform;
  if (note.effect !== 'none') options.effect = note.effect;
  return options;
}

function instrumentOptions(instrument: Instrument) {
  const { waveform, volume, attack, decay, sustain, release } = instrument;
  return { waveform, volume, attack, decay, sustain, release };
}

export function soundOptions(sound: Sound): SoundOptions {
  const { waveform, volume, attack, decay, sustain, release } = instrumentOptions(sound.instrument);
  if (sound.multi)
    return {
      waveform,
      volume,
      attack,
      decay,
      sustain,
      release,
      bpm: sound.bpm,
      stepsPerBeat: sound.stepsPerBeat,
      notes: sortNotes(sound.notes).map(noteOptions),
    };
  return {
    waveform,
    frequency: sound.frequency,
    volume,
    attack,
    decay,
    sustain,
    release,
    duration: sound.duration,
    effect: sound.effect,
    ...(sound.effect === 'slide' ? { slideTo: sound.slideTo } : {}),
  };
}

/** MusicOptions; `audible` keeps a track's notes (preview mute/solo), all by default. */
export function musicOptions(
  music: Music,
  audible: (track: Track) => boolean = () => true,
): MusicOptions {
  const tracks: TrackOptions[] = music.tracks.map((track) => ({
    voice: track.voice,
    ...instrumentOptions(track.instrument),
    notes: audible(track) ? sortNotes(track.notes).map(noteOptions) : [],
  }));
  return {
    bpm: music.bpm,
    stepsPerBeat: music.stepsPerBeat,
    length: music.length,
    loop: music.loop,
    tracks,
  };
}

import { integer, PixelJSError, record } from '../../api/errors.js';
import type { SoundEffect, SoundWaveform } from '../../api/types.js';

/** Limits shared with the C DSP and the worklet processor. */
export const SEQUENCE_LIMITS = Object.freeze({
  soundNotes: 64,
  trackNotes: 512,
  tracks: 4,
  maxSteps: 4096,
  minBpm: 20,
  maxBpm: 400,
  maxStepsPerBeat: 16,
});

export const WAVEFORMS: Readonly<Record<SoundWaveform, number>> = Object.freeze({
  square: 0,
  triangle: 1,
  sine: 2,
  noise: 3,
});

export const EFFECTS: Readonly<Record<SoundEffect, number>> = Object.freeze({
  none: 0,
  slide: 1,
  vibrato: 2,
  fadeout: 3,
});

/** [step, length, pitch, volume 0–255, waveform, effect], as the processor receives it. */
export type NoteData = readonly [number, number, number, number, number, number];

export interface InstrumentData {
  readonly volume: number;
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

export interface TempoData {
  readonly bpm: number;
  readonly centiBpm: number;
  readonly stepsPerBeat: number;
}

const SEMITONES: Readonly<Record<string, number>> = Object.freeze({
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
});

/** MIDI note 0–127, or a name: letter, optional '#' or 'b', octave -1–9 (C4 = 60). */
export function parsePitch(value: unknown, name: string): number {
  if (typeof value === 'number') return integer(value, name, 0, 127);
  const match = typeof value === 'string' ? /^([A-G])([#b]?)(-1|[0-9])$/.exec(value) : null;
  if (!match)
    throw new PixelJSError(
      'ARGUMENT',
      `${name} must be a MIDI note 0–127 or a name such as 'C4', 'F#3' or 'Bb5'.`,
    );
  const [, letter = 'C', accidental, octave = '4'] = match;
  const pitch =
    (Number(octave) + 1) * 12 +
    (SEMITONES[letter] ?? 0) +
    (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
  if (pitch < 0 || pitch > 127) throw new PixelJSError('RANGE', `${name} is outside MIDI 0–127.`);
  return pitch;
}

export function parseWaveform(value: unknown, fallback: SoundWaveform, name = 'waveform'): number {
  const waveform = value ?? fallback;
  if (typeof waveform !== 'string' || !Object.hasOwn(WAVEFORMS, waveform))
    throw new PixelJSError('ARGUMENT', `${name} must be 'square', 'triangle', 'sine' or 'noise'.`);
  return WAVEFORMS[waveform as SoundWaveform];
}

export function parseEffect(value: unknown, name = 'effect'): number {
  const effect = value ?? 'none';
  if (typeof effect !== 'string' || !Object.hasOwn(EFFECTS, effect))
    throw new PixelJSError('ARGUMENT', `${name} must be 'none', 'slide', 'vibrato' or 'fadeout'.`);
  return EFFECTS[effect as SoundEffect];
}

function span(value: unknown, name: string, fallback: number, max: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < 0 || result > max)
    throw new PixelJSError('RANGE', `${name} must be a number between 0 and ${max}.`);
  return result;
}

export function parseInstrument(options: Record<string, unknown>, prefix = ''): InstrumentData {
  return Object.freeze({
    volume: span(options['volume'], `${prefix}volume`, 1, 1),
    attack: span(options['attack'], `${prefix}attack`, 0.005, 10),
    decay: span(options['decay'], `${prefix}decay`, 0.01, 10),
    sustain: span(options['sustain'], `${prefix}sustain`, 0.7, 1),
    release: span(options['release'], `${prefix}release`, 0.05, 10),
  });
}

export function parseTempo(options: Record<string, unknown>, bpmFallback?: number): TempoData {
  const bpm = options['bpm'] ?? bpmFallback;
  if (
    typeof bpm !== 'number' ||
    !Number.isFinite(bpm) ||
    bpm < SEQUENCE_LIMITS.minBpm ||
    bpm > SEQUENCE_LIMITS.maxBpm
  )
    throw new PixelJSError(
      'RANGE',
      `bpm must be a number between ${SEQUENCE_LIMITS.minBpm} and ${SEQUENCE_LIMITS.maxBpm}.`,
    );
  const stepsPerBeat =
    options['stepsPerBeat'] === undefined
      ? 4
      : integer(options['stepsPerBeat'], 'stepsPerBeat', 1, SEQUENCE_LIMITS.maxStepsPerBeat);
  return Object.freeze({ bpm, centiBpm: Math.round(bpm * 100), stepsPerBeat });
}

/**
 * Validates a note list and orders it by step (stable), since the DSP
 * plays notes in step order. Notes default to the sound's waveform.
 */
export function parseNotes(
  source: unknown,
  name: string,
  limit: number,
  endStep: number,
  waveform: number,
): readonly NoteData[] {
  if (!Array.isArray(source) || source.length > limit)
    throw new PixelJSError('RANGE', `${name} must be an array of at most ${limit} notes.`);
  const notes = source.map((value: unknown, index): NoteData => {
    const label = `${name}[${index}]`;
    record(value, label);
    const step = integer(value['step'], `${label}.step`, 0, endStep - 1);
    const length =
      value['length'] === undefined
        ? 1
        : integer(value['length'], `${label}.length`, 1, SEQUENCE_LIMITS.maxSteps);
    const volume = span(value['volume'], `${label}.volume`, 1, 1);
    return Object.freeze([
      step,
      length,
      parsePitch(value['pitch'], `${label}.pitch`),
      Math.round(volume * 255),
      value['waveform'] === undefined
        ? waveform
        : parseWaveform(value['waveform'], 'square', `${label}.waveform`),
      parseEffect(value['effect'], `${label}.effect`),
    ] as const);
  });
  return Object.freeze(notes.sort((left, right) => left[0] - right[0]));
}

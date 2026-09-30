import { EFFECTS, WAVEFORMS, parsePitchName, pitchName, type Note } from './audio-model.js';
import { byId, fillSelect, intValue, type Status } from './dom.js';
import type { PianoRoll } from './piano-roll.js';
import type { SoundEffect, SoundWaveform } from '@pixeljs/core';

/**
 * Fields for the selected note of a piano roll. Every change replaces the
 * note as one undo step; invalid values are refused and the field restored.
 */
export class NoteInspector {
  private readonly fields: HTMLFieldSetElement;
  private readonly step: HTMLInputElement;
  private readonly length: HTMLInputElement;
  private readonly pitch: HTMLInputElement;
  private readonly volume: HTMLInputElement;
  private readonly waveform: HTMLSelectElement;
  private readonly effect: HTMLSelectElement;
  private note: Note | null = null;

  constructor(
    prefix: string,
    private readonly roll: PianoRoll,
    private readonly status: Status,
  ) {
    this.fields = byId(`${prefix}-fields`, HTMLFieldSetElement);
    this.step = byId(`${prefix}-step`, HTMLInputElement);
    this.length = byId(`${prefix}-length`, HTMLInputElement);
    this.pitch = byId(`${prefix}-pitch`, HTMLInputElement);
    this.volume = byId(`${prefix}-volume`, HTMLInputElement);
    this.waveform = byId(`${prefix}-waveform`, HTMLSelectElement);
    this.effect = byId(`${prefix}-effect`, HTMLSelectElement);
    fillSelect(
      this.waveform,
      [
        { value: 'inherit', label: 'Instrument waveform' },
        ...WAVEFORMS.map((name) => ({ value: name, label: name })),
      ],
      'inherit',
    );
    fillSelect(
      this.effect,
      EFFECTS.map((name) => ({ value: name, label: name })),
      'none',
    );
    const apply = (changes: Partial<Note> | string, label: string) => {
      if (typeof changes === 'string') this.status.error(changes);
      else if (this.roll.replaceSelected(changes, label)) return;
      this.show(this.note, true);
    };
    this.step.addEventListener('change', () => {
      const step = intValue(this.step);
      apply(step >= 0 ? { step } : 'The step is a whole number from 0.', 'Move note');
    });
    this.length.addEventListener('change', () => {
      const length = intValue(this.length);
      apply(
        length >= 1 && length <= 4096 ? { length } : 'The length is 1 to 4096 steps.',
        'Resize note',
      );
    });
    this.pitch.addEventListener('change', () => {
      const typed = this.pitch.value.trim();
      const text = typed.charAt(0).toUpperCase() + typed.slice(1);
      const number = /^\d+$/.test(text) ? Number(text) : null;
      const pitch = number !== null && number <= 127 ? number : parsePitchName(text);
      apply(
        pitch === null
          ? `“${text}” is not a pitch: use a name such as C4 or F#3, or MIDI 0–127.`
          : { pitch },
        'Change pitch',
      );
    });
    this.volume.addEventListener('change', () => {
      const volume = Number(this.volume.value);
      apply(
        this.volume.value.trim() !== '' && volume >= 0 && volume <= 1
          ? { volume }
          : 'The volume is 0 to 1.',
        'Note volume',
      );
    });
    this.waveform.addEventListener('change', () => {
      const value = this.waveform.value;
      apply({ waveform: value === 'inherit' ? null : (value as SoundWaveform) }, 'Note waveform');
    });
    this.effect.addEventListener('change', () => {
      apply({ effect: this.effect.value as SoundEffect }, 'Note effect');
    });
    this.show(null);
  }

  /** Shows a note; `force` also rewrites the focused field (after a refused value). */
  show(note: Note | null, force = false): void {
    this.note = note;
    this.fields.disabled = note === null;
    const active = document.activeElement;
    const set = (input: HTMLInputElement, value: string) => {
      if (force || active !== input) input.value = value;
    };
    set(this.step, note ? String(note.step) : '');
    set(this.length, note ? String(note.length) : '');
    set(this.pitch, note ? pitchName(note.pitch) : '');
    set(this.volume, note ? String(note.volume) : '');
    this.waveform.value = note?.waveform ?? 'inherit';
    this.effect.value = note?.effect ?? 'none';
  }
}

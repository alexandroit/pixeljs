import type { SoundEffect, SoundWaveform } from '@pixeljs/core';
import type { AudioPreview } from './audio-preview.js';
import {
  AUDIO_LIMITS,
  EFFECTS,
  WAVEFORMS,
  createSound,
  makeNote,
  soundOptions,
  stepSeconds,
  type Instrument,
  type Note,
  type Sound,
} from './audio-model.js';
import { bindNumber, byId, fillSelect, report, type Status } from './dom.js';
import { download, soundFile } from './exports.js';
import { NoteInspector } from './note-inspector.js';
import { PianoRoll, ROLL_ZOOMS, type RollTool } from './piano-roll.js';
import { freeName } from './project.js';
import type { Studio } from './studio.js';

const INSTRUMENT_FIELDS = ['volume', 'attack', 'decay', 'sustain', 'release'] as const;

/** Shared by the Sound and Music tabs: waveform and envelope fields of an instrument. */
export function bindInstrument(
  prefix: string,
  status: Status,
  current: () => Instrument | null,
  apply: (instrument: Instrument, label: string) => string | null,
  restore: () => void,
): void {
  const waveform = byId(`${prefix}-waveform`, HTMLSelectElement);
  fillSelect(
    waveform,
    WAVEFORMS.map((name) => ({ value: name, label: name })),
    'square',
  );
  waveform.addEventListener('change', () => {
    const instrument = current();
    if (!instrument) return;
    const problem = apply({ ...instrument, waveform: waveform.value as SoundWaveform }, 'Waveform');
    if (problem) {
      status.error(problem);
      restore();
    }
  });
  for (const key of INSTRUMENT_FIELDS)
    bindNumber(
      byId(`${prefix}-${key}`, HTMLInputElement),
      status,
      (value) => {
        const instrument = current();
        return instrument ? apply({ ...instrument, [key]: value }, `Instrument ${key}`) : null;
      },
      restore,
    );
}

/** Shows an instrument; `force` also rewrites a focused field (after a refused value). */
export function showInstrument(prefix: string, instrument: Instrument | null, force = false): void {
  byId(`${prefix}-waveform`, HTMLSelectElement).value = instrument?.waveform ?? 'square';
  for (const key of INSTRUMENT_FIELDS) {
    const input = byId(`${prefix}-${key}`, HTMLInputElement);
    if (force || document.activeElement !== input)
      input.value = instrument ? String(instrument[key]) : '';
    input.disabled = !instrument;
  }
}

/** Columns shown for a sound's notes: room after the last note, in whole groups. */
function soundColumns(sound: Sound, grouping: number): number {
  const end = Math.max(0, ...sound.notes.map((note) => note.step + note.length));
  return Math.min(
    AUDIO_LIMITS.maxSteps,
    Math.max(32, Math.ceil((end + grouping) / grouping) * grouping),
  );
}

/**
 * Sound editor: named single-note sounds (waveform, frequency, envelope,
 * duration, effect) and multi-note sounds (a piano roll of up to 64 notes at
 * a tempo), previewed through the engine's own synthesizer.
 */
export class SoundPanel {
  readonly roll: PianoRoll;
  private readonly inspector: NoteInspector;
  private shownSound: Sound | null = null;

  constructor(
    private readonly studio: Studio,
    private readonly status: Status,
    private readonly audio: AudioPreview,
  ) {
    const panel = this;
    this.roll = new PianoRoll(
      byId('sound-roll-viewport', HTMLDivElement),
      byId('sound-roll', HTMLCanvasElement),
      byId('sound-roll-sizer', HTMLDivElement),
      {
        notes: () => panel.sound?.notes ?? [],
        ghosts: () => [],
        steps: () => (panel.sound ? soundColumns(panel.sound, panel.roll.grouping) : 32),
        endStep: () => AUDIO_LIMITS.maxSteps,
        maxNotes: () => AUDIO_LIMITS.soundNotes,
        commit: (notes, label) => {
          const sound = panel.sound;
          if (!sound) return 'No sound is selected.';
          return studio.updateSound(sound, { notes }, label);
        },
        playhead: () => null,
        selected: (note) => panel.inspector.show(note),
        message: (text, error) => (error ? status.error(text) : status.info(text)),
      },
    );
    this.inspector = new NoteInspector('sound-note', this.roll, status);
    studio.onInteractionFlush(() => this.roll.finish());
    this.bind();
    studio.on((event) => {
      if (event === 'project' || event === 'active' || event === 'sounds') this.sync();
    });
    audio.onChange(() => this.showAudioState());
    this.sync();
  }

  get sound(): Sound | null {
    return this.studio.activeSound;
  }

  private update(values: Parameters<Studio['updateSound']>[1], label: string): string | null {
    const sound = this.sound;
    return sound ? this.studio.updateSound(sound, values, label) : null;
  }

  private bind(): void {
    const list = byId('sound-list', HTMLSelectElement);
    list.addEventListener('change', () => {
      const sound = this.studio.project.sounds.find((item) => String(item.uid) === list.value);
      this.studio.selectSound(sound ?? null);
    });
    const names = () => this.studio.project.sounds.map((item) => item.name);
    byId('btn-sound-new', HTMLButtonElement).addEventListener('click', () => {
      const sound = createSound(freeName('sound', names()));
      report(this.status, this.studio.addSound(sound), `Added sound “${sound.name}”.`);
    });
    byId('btn-sound-duplicate', HTMLButtonElement).addEventListener('click', () => {
      const current = this.sound;
      if (!current) return;
      const sound = createSound(freeName(`${current.name.slice(0, 24)}-copy`, names()), {
        multi: current.multi,
        instrument: current.instrument,
        frequency: current.frequency,
        duration: current.duration,
        effect: current.effect,
        slideTo: current.slideTo,
        bpm: current.bpm,
        stepsPerBeat: current.stepsPerBeat,
        notes: current.notes,
      });
      report(
        this.status,
        this.studio.addSound(sound, `Duplicate ${current.name}`),
        `Duplicated “${current.name}” as “${sound.name}”.`,
      );
    });
    byId('btn-sound-delete', HTMLButtonElement).addEventListener('click', () => {
      const sound = this.sound;
      if (sound)
        report(this.status, this.studio.deleteSound(sound), `Deleted sound “${sound.name}”.`);
    });
    const name = byId('sound-name', HTMLInputElement);
    name.addEventListener('change', () => {
      const sound = this.sound;
      if (sound && !report(this.status, this.studio.renameSound(sound, name.value.trim())))
        name.value = sound.name;
    });
    const mode = byId('sound-mode', HTMLSelectElement);
    mode.addEventListener('change', () => {
      const sound = this.sound;
      if (!sound) return;
      const multi = mode.value === 'notes';
      // A sound with notes needs at least one: start with a single C5.
      const notes: readonly Note[] =
        multi && sound.notes.length === 0
          ? [makeNote({ step: 0, pitch: 72, length: 2 })]
          : sound.notes;
      report(
        this.status,
        this.update({ multi, notes }, multi ? 'Sound with notes' : 'Single-note sound'),
      );
      this.sync();
      if (multi) this.roll.revealPitch(this.sound?.notes[0]?.pitch ?? 72);
    });
    bindInstrument(
      'sound',
      this.status,
      () => this.sound?.instrument ?? null,
      (instrument, label) => this.update({ instrument }, label),
      () => this.sync(true),
    );
    const numbers: Array<
      [string, 'frequency' | 'duration' | 'slideTo' | 'bpm' | 'stepsPerBeat', string]
    > = [
      ['sound-frequency', 'frequency', 'Frequency'],
      ['sound-duration', 'duration', 'Duration'],
      ['sound-slide-to', 'slideTo', 'Slide target'],
      ['sound-bpm', 'bpm', 'Tempo'],
      ['sound-steps-per-beat', 'stepsPerBeat', 'Steps per beat'],
    ];
    for (const [id, key, label] of numbers)
      bindNumber(
        byId(id, HTMLInputElement),
        this.status,
        (value) => this.update({ [key]: value }, label),
        () => this.sync(true),
      );
    const effect = byId('sound-effect', HTMLSelectElement);
    fillSelect(
      effect,
      EFFECTS.map((item) => ({ value: item, label: item })),
      'none',
    );
    effect.addEventListener('change', () => {
      report(this.status, this.update({ effect: effect.value as SoundEffect }, 'Sound effect'));
      this.sync();
    });
    byId('btn-sound-play', HTMLButtonElement).addEventListener('click', () => void this.play());
    byId('btn-sound-stop', HTMLButtonElement).addEventListener('click', () => this.stop());
    byId('btn-export-sound', HTMLButtonElement).addEventListener('click', () => {
      const sound = this.sound;
      if (!sound) return;
      download(`${sound.name}.json`, new Blob([soundFile(sound)], { type: 'application/json' }));
      this.status.info(`Exported ${sound.name}.json (pixeljs-sound for audio.loadSound).`);
    });
    bindRollView('sound', this.roll);
  }

  async play(): Promise<void> {
    const sound = this.sound;
    if (!sound) return;
    try {
      await this.audio.playSound(soundOptions(sound));
      this.status.info(`Playing “${sound.name}”.`);
    } catch (error) {
      this.status.error(`Could not play “${sound.name}”: ${(error as Error).message}`);
    }
    this.showAudioState();
  }

  stop(): void {
    this.audio.stop();
    this.status.info('Stopped all sound.');
  }

  private showAudioState(): void {
    byId('sound-audio-state', HTMLSpanElement).textContent = `Audio: ${this.audio.state}`;
  }

  /** Refreshes the list and fields; `force` also rewrites the focused field. */
  private sync(force = false): void {
    const sound = this.sound;
    fillSelect(
      byId('sound-list', HTMLSelectElement),
      this.studio.project.sounds.map((item) => ({
        value: String(item.uid),
        label: `${item.name} (${item.multi ? `${item.notes.length} notes` : `${item.frequency} Hz`})`,
      })),
      sound ? String(sound.uid) : '',
    );
    const set = (id: string, value: string) => {
      const input = byId(id, HTMLInputElement);
      if (force || document.activeElement !== input) input.value = value;
      input.disabled = !sound;
    };
    set('sound-name', sound?.name ?? '');
    set('sound-frequency', sound ? String(sound.frequency) : '');
    set('sound-duration', sound ? String(sound.duration) : '');
    set('sound-slide-to', sound ? String(sound.slideTo) : '');
    set('sound-bpm', sound ? String(sound.bpm) : '');
    set('sound-steps-per-beat', sound ? String(sound.stepsPerBeat) : '');
    byId('sound-mode', HTMLSelectElement).value = sound?.multi ? 'notes' : 'note';
    byId('sound-effect', HTMLSelectElement).value = sound?.effect ?? 'none';
    byId('sound-slide-to', HTMLInputElement).disabled = !sound || sound.effect !== 'slide';
    showInstrument('sound', sound?.instrument ?? null, force);
    const multi = !!sound?.multi;
    byId('sound-single', HTMLFieldSetElement).hidden = multi;
    byId('sound-multi', HTMLFieldSetElement).hidden = !multi;
    byId('sound-roll-area', HTMLDivElement).hidden = !multi;
    byId('sound-single-help', HTMLDivElement).hidden = multi;
    byId('sound-note-panel', HTMLElement).hidden = !multi;
    const summary = byId('sound-summary', HTMLParagraphElement);
    if (sound?.multi) {
      const end = Math.max(...sound.notes.map((note) => note.step + note.length));
      const seconds = stepSeconds(end, sound.bpm, sound.stepsPerBeat);
      summary.textContent = `${sound.notes.length} of ${AUDIO_LIMITS.soundNotes} notes, ${seconds.toFixed(2)} s plus release.`;
    } else summary.textContent = sound ? `${sound.duration} s plus release.` : '';
    if (sound !== this.shownSound) {
      this.shownSound = sound;
      this.roll.select(null);
      const first = sound?.notes[0];
      this.roll.cursor = { step: 0, pitch: first?.pitch ?? 72 };
      this.roll.revealPitch(first?.pitch ?? 72);
    }
    this.roll.sync();
    this.showAudioState();
  }

  onShow(): void {
    this.sync();
    this.roll.revealPitch(this.roll.selectedNote?.pitch ?? this.roll.cursor.pitch);
  }

  shortcut(event: KeyboardEvent): boolean {
    return rollShortcut(
      event,
      this.roll,
      'sound',
      () => void this.play(),
      () => this.stop(),
    );
  }
}

/** Wires a roll's grouping, zoom, tool and delete controls (ids share `prefix`). */
export function bindRollView(prefix: string, roll: PianoRoll): void {
  const grouping = byId(`${prefix}-grouping`, HTMLSelectElement);
  grouping.addEventListener('change', () => roll.setGrouping(Number(grouping.value)));
  roll.setGrouping(Number(grouping.value));
  const zoom = byId(`${prefix}-roll-zoom`, HTMLSelectElement);
  fillSelect(
    zoom,
    ROLL_ZOOMS.map((level) => ({ value: String(level), label: `${level} px` })),
    String(roll.view.zoom),
  );
  zoom.addEventListener('change', () => roll.view.setZoom(Number(zoom.value)));
  for (const button of rollToolButtons(prefix))
    button.addEventListener('click', () =>
      setRollTool(prefix, roll, button.dataset['tool'] as RollTool),
    );
  byId(`btn-${prefix}-note-delete`, HTMLButtonElement).addEventListener('click', () =>
    roll.deleteSelected(),
  );
}

function rollToolButtons(prefix: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(`#${prefix}-roll-tools [data-tool]`),
  );
}

function setRollTool(prefix: string, roll: PianoRoll, tool: RollTool): void {
  roll.finish();
  roll.tool = tool;
  for (const button of rollToolButtons(prefix))
    button.setAttribute('aria-pressed', String(button.dataset['tool'] === tool));
}

/** Tab shortcuts shared by both audio editors: D, E, P, Escape, G, + and −. */
export function rollShortcut(
  event: KeyboardEvent,
  roll: PianoRoll,
  prefix: string,
  play: () => void,
  stop: () => void,
): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const key = event.key.toLowerCase();
  if (key === 'd') setRollTool(prefix, roll, 'draw');
  else if (key === 'e') setRollTool(prefix, roll, 'erase');
  else if (key === 'p') play();
  else if (key === 'escape') stop();
  else if (key === 'g') {
    const grouping = byId(`${prefix}-grouping`, HTMLSelectElement);
    grouping.value = grouping.value === '8' ? '6' : '8';
    roll.setGrouping(Number(grouping.value));
  } else if (key === '+' || key === '=' || key === '-' || key === '_') {
    const index = ROLL_ZOOMS.indexOf(roll.view.zoom) + (key === '+' || key === '=' ? 1 : -1);
    const level = ROLL_ZOOMS[Math.max(0, Math.min(ROLL_ZOOMS.length - 1, index))]!;
    byId(`${prefix}-roll-zoom`, HTMLSelectElement).value = String(level);
    roll.view.setZoom(level);
  } else return false;
  return true;
}

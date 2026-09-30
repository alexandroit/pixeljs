import type { AudioPreview } from './audio-preview.js';
import {
  AUDIO_LIMITS,
  createMusic,
  createTrack,
  musicOptions,
  stepSeconds,
  type Music,
  type Track,
} from './audio-model.js';
import { bindNumber, byId, fillSelect, report, type Status } from './dom.js';
import { download, musicFile } from './exports.js';
import { NoteInspector } from './note-inspector.js';
import { PianoRoll } from './piano-roll.js';
import { freeName } from './project.js';
import { bindInstrument, bindRollView, rollShortcut, showInstrument } from './sound-panel.js';
import type { Studio } from './studio.js';

/**
 * Music editor: pieces of up to four tracks, each on its own voice with its
 * own instrument and a piano roll of up to 512 notes. Mute and solo only
 * shape the preview; they are not part of the saved or exported music.
 */
export class MusicPanel {
  readonly roll: PianoRoll;
  private readonly inspector: NoteInspector;
  private track: Track | null = null;
  private shownMusic: Music | null = null;
  private readonly muted = new Set<number>();
  private readonly soloed = new Set<number>();
  private frame = 0;

  constructor(
    private readonly studio: Studio,
    private readonly status: Status,
    private readonly audio: AudioPreview,
  ) {
    const panel = this;
    this.roll = new PianoRoll(
      byId('music-roll-viewport', HTMLDivElement),
      byId('music-roll', HTMLCanvasElement),
      byId('music-roll-sizer', HTMLDivElement),
      {
        notes: () => panel.track?.notes ?? [],
        ghosts: () =>
          panel.music?.tracks
            .filter((track) => track !== panel.track)
            .flatMap((track) => track.notes) ?? [],
        steps: () => panel.music?.length ?? 32,
        endStep: () => panel.music?.length ?? 32,
        maxNotes: () => AUDIO_LIMITS.trackNotes,
        commit: (notes, label) => {
          const music = panel.music;
          const track = panel.track;
          if (!music || !track) return 'No track is selected.';
          return studio.updateTrack(music, track, { notes }, label);
        },
        playhead: () => panel.audio.position(),
        selected: (note) => panel.inspector.show(note),
        message: (text, error) => (error ? status.error(text) : status.info(text)),
      },
    );
    this.inspector = new NoteInspector('music-note', this.roll, status);
    studio.onInteractionFlush(() => this.roll.finish());
    this.bind();
    studio.on((event) => {
      if (event === 'project' || event === 'active' || event === 'music') this.sync();
    });
    audio.onChange(() => this.showTransport());
    this.sync();
  }

  get music(): Music | null {
    return this.studio.activeMusic;
  }

  private update(values: Parameters<Studio['updateMusic']>[1], label: string): string | null {
    const music = this.music;
    return music ? this.studio.updateMusic(music, values, label) : null;
  }

  private updateTrack(values: Parameters<Studio['updateTrack']>[2], label: string): string | null {
    const music = this.music;
    const track = this.track;
    return music && track ? this.studio.updateTrack(music, track, values, label) : null;
  }

  private bind(): void {
    const list = byId('music-list', HTMLSelectElement);
    list.addEventListener('change', () => {
      const music = this.studio.project.music.find((item) => String(item.uid) === list.value);
      this.studio.selectMusic(music ?? null);
    });
    const names = () => this.studio.project.music.map((item) => item.name);
    byId('btn-music-new', HTMLButtonElement).addEventListener('click', () => {
      const music = createMusic(freeName('music', names()));
      report(this.status, this.studio.addMusic(music), `Added music “${music.name}”.`);
    });
    byId('btn-music-duplicate', HTMLButtonElement).addEventListener('click', () => {
      const current = this.music;
      if (!current) return;
      const music = createMusic(freeName(`${current.name.slice(0, 24)}-copy`, names()), {
        bpm: current.bpm,
        stepsPerBeat: current.stepsPerBeat,
        length: current.length,
        loop: current.loop,
        tracks: current.tracks.map((track) =>
          createTrack(track.voice, { instrument: track.instrument, notes: track.notes }),
        ),
      });
      report(
        this.status,
        this.studio.addMusic(music, `Duplicate ${current.name}`),
        `Duplicated “${current.name}” as “${music.name}”.`,
      );
    });
    byId('btn-music-delete', HTMLButtonElement).addEventListener('click', () => {
      const music = this.music;
      if (music)
        report(this.status, this.studio.deleteMusic(music), `Deleted music “${music.name}”.`);
    });
    const name = byId('music-name', HTMLInputElement);
    name.addEventListener('change', () => {
      const music = this.music;
      if (music && !report(this.status, this.studio.renameMusic(music, name.value.trim())))
        name.value = music.name;
    });
    const numbers: Array<[string, 'bpm' | 'stepsPerBeat' | 'length', string]> = [
      ['music-bpm', 'bpm', 'Tempo'],
      ['music-steps-per-beat', 'stepsPerBeat', 'Steps per beat'],
      ['music-length', 'length', 'Length'],
    ];
    for (const [id, key, label] of numbers)
      bindNumber(
        byId(id, HTMLInputElement),
        this.status,
        (value) => this.update({ [key]: value }, label),
        () => this.sync(true),
      );
    const loop = byId('music-loop', HTMLInputElement);
    loop.addEventListener('change', () => {
      report(this.status, this.update({ loop: loop.checked }, loop.checked ? 'Loop' : 'No loop'));
      this.sync();
    });

    const tracks = byId('music-track-list', HTMLSelectElement);
    tracks.addEventListener('change', () => {
      this.selectTrack(
        this.music?.tracks.find((track) => String(track.uid) === tracks.value) ?? null,
      );
    });
    byId('btn-track-add', HTMLButtonElement).addEventListener('click', () => {
      const music = this.music;
      if (!music) return;
      const used = new Set(music.tracks.map((track) => track.voice));
      const voice = [0, 1, 2, 3].find((candidate) => !used.has(candidate));
      if (voice === undefined) {
        this.status.error(`A piece has at most ${AUDIO_LIMITS.tracks} tracks, one per voice.`);
        return;
      }
      const track = createTrack(voice);
      if (report(this.status, this.update({ tracks: [...music.tracks, track] }, 'Add track')))
        this.selectTrack(track);
    });
    byId('btn-track-remove', HTMLButtonElement).addEventListener('click', () => {
      const music = this.music;
      const track = this.track;
      if (!music || !track) return;
      if (music.tracks.length === 1) {
        this.status.error('A piece needs at least one track.');
        return;
      }
      report(
        this.status,
        this.update({ tracks: music.tracks.filter((item) => item !== track) }, 'Remove track'),
      );
    });
    const voice = byId('track-voice', HTMLSelectElement);
    fillSelect(
      voice,
      [0, 1, 2, 3].map((index) => ({ value: String(index), label: `Voice ${index}` })),
      '0',
    );
    voice.addEventListener('change', () => {
      report(this.status, this.updateTrack({ voice: Number(voice.value) }, 'Track voice'));
      this.sync();
    });
    bindInstrument(
      'track',
      this.status,
      () => this.track?.instrument ?? null,
      (instrument, label) => this.updateTrack({ instrument }, label),
      () => this.sync(true),
    );
    for (const [id, set] of [
      ['track-mute', this.muted],
      ['track-solo', this.soloed],
    ] as const) {
      const box = byId(id, HTMLInputElement);
      box.addEventListener('change', () => {
        const track = this.track;
        if (!track) return;
        if (box.checked) set.add(track.uid);
        else set.delete(track.uid);
        this.sync();
        // The preview mix changes at once: playing music restarts with it.
        if (this.audio.musicPlaying) void this.play();
      });
    }
    byId('btn-music-play', HTMLButtonElement).addEventListener('click', () => void this.play());
    byId('btn-music-stop', HTMLButtonElement).addEventListener('click', () => this.stop());
    byId('btn-export-music', HTMLButtonElement).addEventListener('click', () => {
      const music = this.music;
      if (!music) return;
      download(`${music.name}.json`, new Blob([musicFile(music)], { type: 'application/json' }));
      this.status.info(`Exported ${music.name}.json (pixeljs-music for audio.loadMusic).`);
    });
    bindRollView('music', this.roll);
  }

  private audible(track: Track): boolean {
    return this.soloed.size > 0 ? this.soloed.has(track.uid) : !this.muted.has(track.uid);
  }

  async play(): Promise<void> {
    const music = this.music;
    if (!music) return;
    try {
      await this.audio.playMusic(musicOptions(music, (track) => this.audible(track)));
      this.status.info(`Playing “${music.name}”.`);
      this.follow();
    } catch (error) {
      this.status.error(`Could not play “${music.name}”: ${(error as Error).message}`);
    }
    this.showTransport();
  }

  stop(): void {
    this.audio.stopMusic();
    this.status.info('Stopped the music.');
  }

  /** Redraws the playhead each frame until the music stops or ends. */
  private follow(): void {
    cancelAnimationFrame(this.frame);
    const tick = () => {
      this.showTransport();
      this.roll.view.invalidate();
      if (this.audio.musicPlaying) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private showTransport(): void {
    const transport = byId('music-transport', HTMLSpanElement);
    const playing = this.audio.musicPlaying;
    const position = this.audio.position();
    transport.dataset['playing'] = String(playing);
    transport.textContent = playing
      ? `Playing, near step ${Math.floor(position ?? 0)} (approximate)`
      : 'Stopped';
    byId('music-audio-state', HTMLSpanElement).textContent = `Audio: ${this.audio.state}`;
    if (!playing) this.roll.view.invalidate();
  }

  private selectTrack(track: Track | null): void {
    this.roll.finish();
    this.track = track;
    this.roll.select(null);
    this.sync();
    const first = track?.notes[0];
    if (first) this.roll.revealPitch(first.pitch);
  }

  /** Refreshes lists and fields; `force` also rewrites the focused field. */
  private sync(force = false): void {
    const music = this.music;
    if (music !== this.shownMusic) {
      this.shownMusic = music;
      this.track = music?.tracks[0] ?? null;
      this.roll.select(null);
      this.roll.revealPitch(this.track?.notes[0]?.pitch ?? 72);
    }
    if (music && this.track && !music.tracks.includes(this.track))
      this.track =
        music.tracks.find((track) => track.uid === this.track?.uid) ?? music.tracks[0] ?? null;
    const track = this.track;
    fillSelect(
      byId('music-list', HTMLSelectElement),
      this.studio.project.music.map((item) => ({
        value: String(item.uid),
        label: `${item.name} (${item.tracks.length} track${item.tracks.length === 1 ? '' : 's'})`,
      })),
      music ? String(music.uid) : '',
    );
    fillSelect(
      byId('music-track-list', HTMLSelectElement),
      (music?.tracks ?? []).map((item, index) => ({
        value: String(item.uid),
        label: `Track ${index + 1} · voice ${item.voice} · ${item.instrument.waveform} · ${item.notes.length} notes${
          this.soloed.has(item.uid) ? ' · solo' : this.muted.has(item.uid) ? ' · muted' : ''
        }`,
      })),
      track ? String(track.uid) : '',
    );
    const set = (id: string, value: string, enabled: boolean) => {
      const input = byId(id, HTMLInputElement);
      if (force || document.activeElement !== input) input.value = value;
      input.disabled = !enabled;
    };
    set('music-name', music?.name ?? '', !!music);
    set('music-bpm', music ? String(music.bpm) : '', !!music);
    set('music-steps-per-beat', music ? String(music.stepsPerBeat) : '', !!music);
    set('music-length', music ? String(music.length) : '', !!music);
    byId('music-loop', HTMLInputElement).checked = music?.loop ?? false;
    byId('track-voice', HTMLSelectElement).value = String(track?.voice ?? 0);
    byId('track-mute', HTMLInputElement).checked = !!track && this.muted.has(track.uid);
    byId('track-solo', HTMLInputElement).checked = !!track && this.soloed.has(track.uid);
    showInstrument('track', track?.instrument ?? null, force);
    byId('music-summary', HTMLParagraphElement).textContent = music
      ? `${music.length} steps, ${stepSeconds(music.length, music.bpm, music.stepsPerBeat).toFixed(2)} s per ${music.loop ? 'loop' : 'play'}.`
      : '';
    this.roll.sync();
    this.showTransport();
  }

  onShow(): void {
    this.sync();
    this.roll.revealPitch(this.roll.selectedNote?.pitch ?? this.roll.cursor.pitch);
  }

  shortcut(event: KeyboardEvent): boolean {
    return rollShortcut(
      event,
      this.roll,
      'music',
      () => void this.play(),
      () => this.stop(),
    );
  }
}

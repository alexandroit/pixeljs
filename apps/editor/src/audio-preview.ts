import {
  createEngine,
  type Engine,
  type MusicOptions,
  type SoundInstance,
  type SoundOptions,
} from '@pixeljs/core';

/**
 * The editor's sound output: one engine used only for audio (its canvas is
 * never shown and its loop never starts), so previews use exactly the
 * runtime's validation, AudioWorklet and DSP. Audio is unlocked on the first
 * preview, from the user's click. A failed engine or audio system is disposed
 * and replaced on the next preview.
 */
export class AudioPreview {
  private pending: Promise<Engine> | null = null;
  private engine: Engine | null = null;
  private sound: SoundInstance | null = null;
  private music: { started: number; stepsPerSecond: number; length: number; loop: boolean } | null =
    null;
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly onProblem: (message: string) => void) {}

  /** Called after every state change the UI shows (start, stop, unlock). */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private async ready(): Promise<Engine> {
    const current = this.engine;
    if (
      current &&
      current.state !== 'FAILED' &&
      current.state !== 'DISPOSED' &&
      current.audio.capabilities.state !== 'failed'
    )
      return current;
    if (current) {
      this.engine = null;
      void current.dispose();
    }
    this.pending ??= (async () => {
      const canvas = document.createElement('canvas');
      try {
        return await createEngine({
          canvas,
          width: 16,
          height: 16,
          onError: (error) => this.onProblem(`Audio: ${error.message}`),
        });
      } finally {
        this.pending = null;
      }
    })();
    this.engine = await this.pending;
    return this.engine;
  }

  private async unlocked(): Promise<Engine> {
    const engine = await this.ready();
    await engine.audio.unlock();
    this.changed();
    const state = engine.audio.capabilities.state;
    if (state !== 'running') throw new Error(`audio is ${state}; click Play again to retry.`);
    return engine;
  }

  /** Validates with the engine, unlocks audio and plays one sound on a free voice. */
  async playSound(options: SoundOptions): Promise<void> {
    const engine = await this.ready();
    const sound = engine.audio.createSound(options);
    await this.unlocked();
    this.sound?.stop();
    this.sound = engine.audio.play(sound);
    this.changed();
  }

  /** Validates with the engine, unlocks audio and plays a piece from its start. */
  async playMusic(options: MusicOptions): Promise<void> {
    const engine = await this.ready();
    const music = engine.audio.createMusic(options);
    await this.unlocked();
    engine.audio.playMusic(music);
    this.music = {
      started: performance.now(),
      stepsPerSecond: ((options.stepsPerBeat ?? 4) * options.bpm) / 60,
      length: options.length,
      loop: options.loop ?? true,
    };
    this.changed();
  }

  /** Ends the music only; works at any time, even before unlock. */
  stopMusic(): void {
    const engine = this.engine;
    this.music = null;
    if (engine && engine.state !== 'DISPOSED' && engine.state !== 'FAILED')
      engine.audio.stopMusic();
    this.changed();
  }

  /** Stops every sound and the music; works at any time, even before unlock. */
  stop(): void {
    const engine = this.engine;
    this.sound = null;
    this.music = null;
    // stop() without an instance ends every sound and the music, through the
    // engine's reserved stop path.
    if (engine && engine.state !== 'DISPOSED' && engine.state !== 'FAILED') engine.audio.stop();
    this.changed();
  }

  get musicPlaying(): boolean {
    return this.engine?.audio.musicPlaying ?? false;
  }

  /** 'not started' until the first preview, then the engine's audio state. */
  get state(): string {
    return this.engine ? this.engine.audio.capabilities.state : 'not started';
  }

  /**
   * Approximate playhead in steps: page time since playMusic at the piece's
   * tempo. It ignores output latency and the device's start-up delay.
   */
  position(): number | null {
    const music = this.music;
    if (!music || !this.musicPlaying) return null;
    const steps = ((performance.now() - music.started) / 1000) * music.stepsPerSecond;
    return music.loop ? steps % music.length : Math.min(steps, music.length);
  }
}

// PixelJS AudioWorklet processor. It runs the audio DSP WASM in its own small
// instance, separate from the visual engine. The module is served from the
// package's own origin so it satisfies a `script-src 'self'` policy; the
// controller transfers the WASM bytes, so no fetch happens on the audio thread.

const PROTOCOL_VERSION = 3;
const MAX_BATCH_EVENTS = 64;
const MAX_RENDER_FRAMES = 512;
const VOICES = 4;
const SOUND_NOTES = 64;
const TRACK_NOTES = 512;
const MAX_STEPS = 4096;

const finite = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** [step, length, pitch, volume 0-255, waveform, effect]; the DSP checks again. */
const validNote = (note) =>
  Array.isArray(note) &&
  note.length === 6 &&
  whole(note[0], 0, MAX_STEPS - 1) &&
  whole(note[1], 1, MAX_STEPS) &&
  whole(note[2], 0, 127) &&
  whole(note[3], 0, 255) &&
  whole(note[4], 0, 3) &&
  whole(note[5], 0, 3);

const validInstrument = (instrument) =>
  instrument !== null &&
  typeof instrument === 'object' &&
  finite(instrument.volume, 0, 1) &&
  finite(instrument.attack, 0, 10) &&
  finite(instrument.decay, 0, 10) &&
  finite(instrument.sustain, 0, 1) &&
  finite(instrument.release, 0, 10);

const validTempo = (event) =>
  whole(event.centiBpm, 2000, 40000) && whole(event.stepsPerBeat, 1, 16);

class PixelJSAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = null;
    this.samples = null;
    this.epoch = 0;
    this.port.onmessage = (event) => this.receive(event.data);
  }

  receive(message) {
    if (message === null || typeof message !== 'object') return;
    if (message.type === 'init') {
      void this.initialize(message);
    } else if (message.type === 'stop') {
      // Reserved control path: never subject to batch credits. The
      // confirmation lets the host send its next stop.
      if (!Number.isSafeInteger(message.epoch)) return;
      this.epoch = message.epoch;
      if (this.dsp) this.dsp.pxa_stop();
      this.port.postMessage({ type: 'stopped', epoch: message.epoch });
    } else if (message.type === 'batch') {
      this.applyBatch(message);
    }
  }

  async initialize(message) {
    try {
      if (message.version !== PROTOCOL_VERSION || !(message.bytes instanceof ArrayBuffer))
        throw new Error('Unsupported audio processor initialization message.');
      if (this.dsp) throw new Error('The audio processor is already initialized.');
      if (Number.isSafeInteger(message.epoch)) this.epoch = message.epoch;
      const { instance } = await WebAssembly.instantiate(message.bytes, {});
      const dsp = instance.exports;
      if (typeof dsp.__wasm_call_ctors === 'function') dsp.__wasm_call_ctors();
      dsp.pxa_initialize(sampleRate);
      this.samples = new Float32Array(
        dsp.memory.buffer,
        dsp.pxa_buffer_offset(),
        MAX_RENDER_FRAMES,
      );
      this.dsp = dsp;
      this.port.postMessage({ type: 'ready', version: PROTOCOL_VERSION });
    } catch (error) {
      this.port.postMessage({ type: 'error', message: String(error?.message ?? error) });
    }
  }

  applyBatch(message) {
    const { epoch, sequence, events } = message;
    if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(sequence)) return;
    let accepted = 0;
    // Batches from an older epoch were cancelled by stop: acknowledge without playing.
    if (epoch === this.epoch && this.dsp && Array.isArray(events)) {
      for (const event of events.slice(0, MAX_BATCH_EVENTS)) {
        if (this.applyEvent(event)) accepted += 1;
      }
    }
    this.port.postMessage({ type: 'ack', epoch, sequence, accepted });
  }

  applyEvent(event) {
    if (event === null || typeof event !== 'object') return false;
    if (event.kind === 'music') return this.applyMusic(event);
    if (event.kind === 'music_stop') {
      this.dsp.pxa_music_stop();
      return true;
    }
    const voice = event.voice;
    if (!Number.isInteger(voice) || voice < 0 || voice >= VOICES) return false;
    if (event.kind === 'note_off') {
      this.dsp.pxa_note_off(voice);
      return true;
    }
    if (event.kind === 'sound') return this.applySound(voice, event);
    if (
      event.kind !== 'note_on' ||
      !Number.isInteger(event.waveform) ||
      !finite(event.frequency, Number.MIN_VALUE, 24000) ||
      !finite(event.volume, 0, 1) ||
      !finite(event.attack, 0, 10) ||
      !finite(event.decay, 0, 10) ||
      !finite(event.sustain, 0, 1) ||
      !finite(event.release, 0, 10) ||
      !finite(event.duration, Number.MIN_VALUE, 60) ||
      !whole(event.effect, 0, 3) ||
      (event.effect === 1 && !finite(event.slideTo, Number.MIN_VALUE, 24000))
    )
      return false;
    // The C DSP validates the same ranges again at its own boundary.
    return (
      this.dsp.pxa_note_on_effect(
        voice,
        event.waveform,
        event.frequency,
        event.volume,
        event.attack,
        event.decay,
        event.sustain,
        event.release,
        event.duration,
        event.effect,
        event.effect === 1 ? event.slideTo : 0,
      ) === 1
    );
  }

  applySound(voice, event) {
    const { instrument, notes } = event;
    if (
      !validTempo(event) ||
      !validInstrument(instrument) ||
      !Array.isArray(notes) ||
      notes.length === 0 ||
      notes.length > SOUND_NOTES ||
      !notes.every(validNote)
    )
      return false;
    const dsp = this.dsp;
    if (
      dsp.pxa_sound_begin(
        voice,
        event.centiBpm,
        event.stepsPerBeat,
        instrument.volume,
        instrument.attack,
        instrument.decay,
        instrument.sustain,
        instrument.release,
      ) !== 1
    )
      return false;
    for (const note of notes) if (dsp.pxa_sound_note(voice, ...note) !== 1) return false;
    return dsp.pxa_sound_play(voice) === 1;
  }

  applyMusic(event) {
    const { tracks } = event;
    if (
      !validTempo(event) ||
      !whole(event.length, 1, MAX_STEPS) ||
      typeof event.loop !== 'boolean' ||
      !Array.isArray(tracks) ||
      tracks.length === 0 ||
      tracks.length > VOICES ||
      !tracks.every(
        (track) =>
          track !== null &&
          typeof track === 'object' &&
          whole(track.voice, 0, VOICES - 1) &&
          validInstrument(track.instrument) &&
          Array.isArray(track.notes) &&
          track.notes.length <= TRACK_NOTES &&
          track.notes.every(validNote),
      )
    )
      return false;
    const dsp = this.dsp;
    if (dsp.pxa_music_begin(event.length, event.centiBpm, event.stepsPerBeat, tracks.length) !== 1)
      return false;
    for (const [index, track] of tracks.entries()) {
      const { volume, attack, decay, sustain, release } = track.instrument;
      if (dsp.pxa_music_track(index, track.voice, volume, attack, decay, sustain, release) !== 1)
        return false;
      for (const note of track.notes) if (dsp.pxa_music_note(index, ...note) !== 1) return false;
    }
    return dsp.pxa_music_play(event.loop ? 1 : 0) === 1;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const first = output[0];
    if (!this.dsp) {
      for (const channel of output) channel.fill(0);
      return true;
    }
    try {
      // Render the real block length in bounded chunks; never assume 128.
      for (let offset = 0; offset < first.length; offset += MAX_RENDER_FRAMES) {
        const frames = Math.min(MAX_RENDER_FRAMES, first.length - offset);
        this.dsp.pxa_render(frames);
        first.set(this.samples.subarray(0, frames), offset);
      }
    } catch (error) {
      // A trapped instance is never called again; report once and stay silent.
      this.dsp = null;
      for (const channel of output) channel.fill(0);
      this.port.postMessage({ type: 'error', message: String(error?.message ?? error) });
      return true;
    }
    for (let index = 1; index < output.length; index += 1) output[index].set(first);
    if (this.dsp.pxa_music_ended() === 1)
      this.port.postMessage({ type: 'music_end', epoch: this.epoch });
    return true;
  }
}

registerProcessor('pixeljs-audio-processor', PixelJSAudioProcessor);

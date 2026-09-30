#include "pixeljs/audio.h"
#include <math.h>
#include <string.h>

#define PX_TWO_PI 6.28318530717958647692f
#define PX_VIBRATO_HZ 6.0f
/* 2^(0.5 / 12) - 1: half a semitone. */
#define PX_VIBRATO_DEPTH 0.0293022366f
#define PX_OWNER_NONE 0U
#define PX_OWNER_MUSIC 1U
#define PX_OWNER_EFFECT 2U

static float px_clampf(float value, float min, float max) {
    if (value < min)
        return min;
    if (value > max)
        return max;
    return value;
}

static bool px_in_range(float value, float min, float max) {
    return isfinite(value) && value >= min && value <= max;
}

void px_audio_init(px_audio_dsp *dsp, uint32_t sample_rate) {
    if (dsp == NULL)
        return;
    memset(dsp, 0, sizeof(*dsp));
    if (sample_rate < PX_AUDIO_MIN_SAMPLE_RATE) {
        sample_rate = PX_AUDIO_MIN_SAMPLE_RATE;
    } else if (sample_rate > PX_AUDIO_MAX_SAMPLE_RATE) {
        sample_rate = PX_AUDIO_MAX_SAMPLE_RATE;
    }
    dsp->sample_rate = sample_rate;
    dsp->master_volume = 1.0f;
    dsp->noise_lfsr = 0xACE1u;
}

void px_audio_set_master_volume(px_audio_dsp *dsp, float volume) {
    if (dsp == NULL)
        return;
    dsp->master_volume = isfinite(volume) ? px_clampf(volume, 0.0f, 1.0f) : 0.0f;
}

/* Callers validate seconds first, so the product is finite and below 2^32. */
static uint32_t px_seconds_to_samples(uint32_t sample_rate, float seconds) {
    return (uint32_t)((double)seconds * (double)sample_rate);
}

static uint32_t px_pick_voice(const px_audio_dsp *dsp) {
    for (uint32_t index = 0; index < PX_AUDIO_VOICES; ++index) {
        if (!dsp->voices[index].active) {
            return index;
        }
    }
    uint32_t oldest = 0;
    for (uint32_t index = 1; index < PX_AUDIO_VOICES; ++index) {
        if (dsp->voices[index].elapsed_samples > dsp->voices[oldest].elapsed_samples) {
            oldest = index;
        }
    }
    return oldest;
}

static bool px_valid_instrument(const px_audio_instrument *instrument) {
    return instrument != NULL && px_in_range(instrument->volume, 0.0f, 1.0f) &&
           px_in_range(instrument->sustain, 0.0f, 1.0f) &&
           px_in_range(instrument->attack, 0.0f, PX_AUDIO_MAX_STAGE_SECONDS) &&
           px_in_range(instrument->decay, 0.0f, PX_AUDIO_MAX_STAGE_SECONDS) &&
           px_in_range(instrument->release, 0.0f, PX_AUDIO_MAX_STAGE_SECONDS);
}

static float px_pitch_frequency(uint32_t pitch) {
    return 440.0f * exp2f(((float)pitch - 69.0f) / 12.0f);
}

/* Starts a validated note. Stage lengths are in samples; slide_to is used
 * only by the slide effect. */
static void px_start_voice(px_audio_dsp *dsp, px_audio_voice *voice, uint8_t owner,
                           uint8_t waveform, uint8_t effect, float frequency, float slide_to,
                           float volume, const px_audio_instrument *instrument,
                           uint32_t duration_samples) {
    const float nyquist = (float)(dsp->sample_rate / 2);
    memset(voice, 0, sizeof(*voice));
    voice->active = true;
    voice->owner = owner;
    voice->waveform = waveform;
    voice->effect = effect;
    voice->frequency = px_clampf(frequency, 1.0f, nyquist);
    voice->volume = volume;
    voice->sustain_level = instrument->sustain;
    voice->attack_samples = px_seconds_to_samples(dsp->sample_rate, instrument->attack);
    voice->decay_samples = px_seconds_to_samples(dsp->sample_rate, instrument->decay);
    voice->release_samples = px_seconds_to_samples(dsp->sample_rate, instrument->release);
    voice->duration_samples = duration_samples > 0 ? duration_samples : 1;
    if (effect == PX_EFFECT_SLIDE) {
        /* A constant per-sample ratio glides evenly in pitch. */
        const float target = px_clampf(slide_to, 1.0f, nyquist);
        voice->slide_ratio =
            exp2f(log2f(target / voice->frequency) / (float)voice->duration_samples);
        voice->slide_samples = voice->duration_samples;
    }
    if (voice->attack_samples > 0) {
        voice->env_state = (uint8_t)PX_ENV_ATTACK;
    } else if (voice->decay_samples > 0) {
        voice->env_state = (uint8_t)PX_ENV_DECAY;
        voice->current_gain = 1.0f;
    } else {
        voice->env_state = (uint8_t)PX_ENV_SUSTAIN;
        voice->current_gain = voice->sustain_level;
    }
    voice->stage_start_gain = voice->current_gain;
}

static bool px_valid_note(const px_audio_note *note) {
    return note != NULL && note->waveform <= (uint8_t)PX_WAVE_NOISE &&
           note->effect <= (uint8_t)PX_EFFECT_FADEOUT && isfinite(note->frequency) &&
           note->frequency > 0.0f &&
           (note->effect != (uint8_t)PX_EFFECT_SLIDE ||
            (isfinite(note->slide_to) && note->slide_to > 0.0f)) &&
           px_in_range(note->volume, 0.0f, 1.0f) && px_in_range(note->sustain, 0.0f, 1.0f) &&
           px_in_range(note->attack, 0.0f, PX_AUDIO_MAX_STAGE_SECONDS) &&
           px_in_range(note->decay, 0.0f, PX_AUDIO_MAX_STAGE_SECONDS) &&
           px_in_range(note->release, 0.0f, PX_AUDIO_MAX_STAGE_SECONDS) &&
           px_in_range(note->duration, 0.0f, PX_AUDIO_MAX_DURATION_SECONDS) &&
           note->duration > 0.0f;
}

bool px_audio_play_note(px_audio_dsp *dsp, uint32_t voice_index, const px_audio_note *note) {
    if (dsp == NULL || !px_valid_note(note) ||
        (voice_index != PX_AUDIO_AUTO_VOICE && voice_index >= PX_AUDIO_VOICES)) {
        return false;
    }
    if (voice_index == PX_AUDIO_AUTO_VOICE) {
        voice_index = px_pick_voice(dsp);
    }
    /* A new sound effect replaces any multi-note effect on the voice. */
    dsp->sounds[voice_index].playing = false;
    const px_audio_instrument instrument = {note->volume, note->attack, note->decay,
                                            note->sustain, note->release};
    px_start_voice(dsp, &dsp->voices[voice_index], PX_OWNER_EFFECT, note->waveform, note->effect,
                   note->frequency, note->slide_to, note->volume, &instrument,
                   px_seconds_to_samples(dsp->sample_rate, note->duration));
    return true;
}

bool px_audio_note_on(px_audio_dsp *dsp, uint32_t voice_index, uint8_t waveform,
                      float frequency, float volume,
                      float attack_s, float decay_s, float sustain_level,
                      float release_s, float duration_s) {
    const px_audio_note note = {waveform, (uint8_t)PX_EFFECT_NONE, frequency, frequency, volume,
                                attack_s, decay_s, sustain_level, release_s, duration_s};
    return px_audio_play_note(dsp, voice_index, &note);
}

static void px_begin_release(px_audio_voice *voice) {
    voice->env_state = (uint8_t)PX_ENV_RELEASE;
    voice->stage_samples = 0;
    voice->stage_start_gain = voice->current_gain;
}

/* Ends the sound effect on a voice; a music note there is left alone. */
void px_audio_note_off(px_audio_dsp *dsp, uint32_t voice_index) {
    if (dsp == NULL || voice_index >= PX_AUDIO_VOICES)
        return;
    dsp->sounds[voice_index].playing = false;
    px_audio_voice *voice = &dsp->voices[voice_index];
    if (voice->active && voice->owner != PX_OWNER_MUSIC &&
        voice->env_state != (uint8_t)PX_ENV_RELEASE) {
        px_begin_release(voice);
    }
}

/* 16.16 frames per step for a tempo, rounded to the nearest 1/65536 frame. */
static uint64_t px_frames_per_step(uint32_t sample_rate, uint32_t centi_bpm,
                                   uint32_t steps_per_beat) {
    const uint64_t denominator = (uint64_t)centi_bpm * steps_per_beat;
    return ((uint64_t)sample_rate * 6000U * 65536U + denominator / 2) / denominator;
}

static bool px_valid_tempo(uint32_t centi_bpm, uint32_t steps_per_beat) {
    return centi_bpm >= PX_AUDIO_MIN_CENTI_BPM && centi_bpm <= PX_AUDIO_MAX_CENTI_BPM &&
           steps_per_beat >= 1 && steps_per_beat <= PX_AUDIO_MAX_STEPS_PER_BEAT;
}

static void px_clock_start(px_audio_clock *clock) {
    clock->phase = 0;
    clock->step = 0;
    clock->trigger = true;
}

/* Advances one sample; returns true when the next step begins. */
static bool px_clock_tick(px_audio_clock *clock) {
    clock->phase += 65536U;
    if (clock->phase < clock->frames_per_step) {
        return false;
    }
    clock->phase -= clock->frames_per_step;
    clock->step += 1;
    clock->trigger = true;
    return true;
}

static uint32_t px_step_samples(const px_audio_clock *clock, uint32_t steps) {
    const uint64_t samples = ((uint64_t)steps * clock->frames_per_step + 32768U) >> 16;
    return samples == 0 ? 1U : samples > UINT32_MAX ? UINT32_MAX : (uint32_t)samples;
}

static bool px_valid_step_note(const px_audio_step_note *note) {
    return note != NULL && note->length >= 1 && note->step < PX_AUDIO_MAX_STEPS &&
           note->length <= PX_AUDIO_MAX_STEPS && note->pitch <= PX_AUDIO_MAX_PITCH &&
           note->waveform <= (uint8_t)PX_WAVE_NOISE && note->effect <= (uint8_t)PX_EFFECT_FADEOUT;
}

/* Starts note `index` of a list; a slide heads for the list's next note. */
static void px_trigger_step_note(px_audio_dsp *dsp, uint32_t voice_index, uint8_t owner,
                                 const px_audio_instrument *instrument,
                                 const px_audio_clock *clock, const px_audio_step_note *notes,
                                 uint16_t count, uint16_t index) {
    const px_audio_step_note *note = &notes[index];
    uint8_t effect = note->effect;
    float slide_to = 0.0f;
    if (effect == (uint8_t)PX_EFFECT_SLIDE) {
        if (index + 1U < count) {
            slide_to = px_pitch_frequency(notes[index + 1U].pitch);
        } else {
            effect = (uint8_t)PX_EFFECT_NONE;
        }
    }
    px_start_voice(dsp, &dsp->voices[voice_index], owner, note->waveform, effect,
                   px_pitch_frequency(note->pitch), slide_to,
                   instrument->volume * ((float)note->volume / 255.0f), instrument,
                   px_step_samples(clock, note->length));
}

bool px_audio_sound_begin(px_audio_dsp *dsp, uint32_t voice_index, uint32_t centi_bpm,
                          uint32_t steps_per_beat, const px_audio_instrument *instrument) {
    if (dsp == NULL || voice_index >= PX_AUDIO_VOICES || !px_valid_tempo(centi_bpm, steps_per_beat) ||
        !px_valid_instrument(instrument)) {
        return false;
    }
    px_audio_sound *sound = &dsp->sounds[voice_index];
    memset(sound, 0, sizeof(*sound));
    sound->instrument = *instrument;
    sound->clock.frames_per_step = px_frames_per_step(dsp->sample_rate, centi_bpm, steps_per_beat);
    sound->valid = true;
    return true;
}

bool px_audio_sound_note(px_audio_dsp *dsp, uint32_t voice_index,
                         const px_audio_step_note *note) {
    if (dsp == NULL || voice_index >= PX_AUDIO_VOICES) {
        return false;
    }
    px_audio_sound *sound = &dsp->sounds[voice_index];
    if (!sound->valid || sound->playing || !px_valid_step_note(note) ||
        sound->count >= PX_AUDIO_SOUND_NOTES ||
        (sound->count > 0 && note->step < sound->notes[sound->count - 1U].step)) {
        sound->valid = false;
        return false;
    }
    sound->notes[sound->count++] = *note;
    const uint32_t end = (uint32_t)note->step + note->length;
    if (end > sound->length) {
        sound->length = (uint16_t)(end > PX_AUDIO_MAX_STEPS ? PX_AUDIO_MAX_STEPS : end);
    }
    return true;
}

bool px_audio_sound_play(px_audio_dsp *dsp, uint32_t voice_index) {
    if (dsp == NULL || voice_index >= PX_AUDIO_VOICES) {
        return false;
    }
    px_audio_sound *sound = &dsp->sounds[voice_index];
    if (!sound->valid || sound->count == 0) {
        sound->valid = false;
        return false;
    }
    sound->playing = true;
    sound->cursor = 0;
    px_clock_start(&sound->clock);
    /* The effect owns the voice from now on, even during its rests. */
    px_audio_voice *voice = &dsp->voices[voice_index];
    if (voice->active && voice->owner == PX_OWNER_MUSIC) {
        px_begin_release(voice);
        voice->release_samples = PX_AUDIO_STOP_SAMPLES;
    }
    return true;
}

bool px_audio_music_begin(px_audio_dsp *dsp, uint32_t length_steps, uint32_t centi_bpm,
                          uint32_t steps_per_beat, uint32_t track_count) {
    if (dsp == NULL) {
        return false;
    }
    px_audio_music_stop(dsp);
    px_audio_music *music = &dsp->music;
    memset(music, 0, sizeof(*music));
    if (length_steps == 0 || length_steps > PX_AUDIO_MAX_STEPS ||
        !px_valid_tempo(centi_bpm, steps_per_beat) || track_count == 0 ||
        track_count > PX_AUDIO_VOICES) {
        return false;
    }
    music->length = length_steps;
    music->track_count = track_count;
    music->clock.frames_per_step = px_frames_per_step(dsp->sample_rate, centi_bpm, steps_per_beat);
    for (uint32_t track = 0; track < PX_AUDIO_VOICES; ++track) {
        music->tracks[track].voice = PX_AUDIO_AUTO_VOICE;
    }
    music->valid = true;
    return true;
}

bool px_audio_music_track(px_audio_dsp *dsp, uint32_t track, uint32_t voice_index,
                          const px_audio_instrument *instrument) {
    if (dsp == NULL) {
        return false;
    }
    px_audio_music *music = &dsp->music;
    bool valid = music->valid && !music->playing && track < music->track_count &&
                 voice_index < PX_AUDIO_VOICES && px_valid_instrument(instrument) &&
                 music->tracks[track].voice == PX_AUDIO_AUTO_VOICE;
    for (uint32_t other = 0; valid && other < music->track_count; ++other) {
        valid = music->tracks[other].voice != voice_index;
    }
    if (!valid) {
        music->valid = false;
        return false;
    }
    music->tracks[track].voice = voice_index;
    music->tracks[track].instrument = *instrument;
    return true;
}

bool px_audio_music_note(px_audio_dsp *dsp, uint32_t track, const px_audio_step_note *note) {
    if (dsp == NULL) {
        return false;
    }
    px_audio_music *music = &dsp->music;
    px_audio_track *target = track < music->track_count ? &music->tracks[track] : NULL;
    if (!music->valid || music->playing || target == NULL ||
        target->voice == PX_AUDIO_AUTO_VOICE || !px_valid_step_note(note) ||
        note->step >= music->length || target->count >= PX_AUDIO_TRACK_NOTES ||
        (target->count > 0 && note->step < target->notes[target->count - 1U].step)) {
        music->valid = false;
        return false;
    }
    target->notes[target->count++] = *note;
    return true;
}

bool px_audio_music_play(px_audio_dsp *dsp, bool loop) {
    if (dsp == NULL) {
        return false;
    }
    px_audio_music *music = &dsp->music;
    for (uint32_t track = 0; music->valid && track < music->track_count; ++track) {
        music->valid = music->tracks[track].voice != PX_AUDIO_AUTO_VOICE;
    }
    if (!music->valid || music->playing) {
        return false;
    }
    music->playing = true;
    music->loop = loop;
    music->ended = false;
    for (uint32_t track = 0; track < music->track_count; ++track) {
        music->tracks[track].cursor = 0;
    }
    px_clock_start(&music->clock);
    return true;
}

void px_audio_music_stop(px_audio_dsp *dsp) {
    if (dsp == NULL) {
        return;
    }
    dsp->music.playing = false;
    for (size_t index = 0; index < PX_AUDIO_VOICES; ++index) {
        px_audio_voice *voice = &dsp->voices[index];
        if (voice->active && voice->owner == PX_OWNER_MUSIC &&
            voice->env_state != (uint8_t)PX_ENV_RELEASE) {
            px_begin_release(voice);
        }
    }
}

bool px_audio_music_take_ended(px_audio_dsp *dsp) {
    if (dsp == NULL || !dsp->music.ended) {
        return false;
    }
    dsp->music.ended = false;
    return true;
}

uint32_t px_audio_music_step(const px_audio_dsp *dsp) {
    return dsp != NULL && dsp->music.playing ? dsp->music.clock.step : UINT32_MAX;
}

/* Starts every note due at this sample, then advances the clocks. Music
 * notes wait while a sound effect holds their voice. */
static void px_sequence_sample(px_audio_dsp *dsp) {
    px_audio_music *music = &dsp->music;
    if (music->playing) {
        if (music->clock.trigger) {
            music->clock.trigger = false;
            for (uint32_t index = 0; index < music->track_count; ++index) {
                px_audio_track *track = &music->tracks[index];
                const px_audio_voice *voice = &dsp->voices[track->voice];
                const bool held = dsp->sounds[track->voice].playing ||
                                  (voice->active && voice->owner == PX_OWNER_EFFECT);
                while (track->cursor < track->count &&
                       track->notes[track->cursor].step == music->clock.step) {
                    if (!held) {
                        px_trigger_step_note(dsp, track->voice, PX_OWNER_MUSIC,
                                             &track->instrument, &music->clock, track->notes,
                                             track->count, track->cursor);
                    }
                    track->cursor += 1;
                }
            }
        }
        if (px_clock_tick(&music->clock) && music->clock.step >= music->length) {
            if (music->loop) {
                /* Keep the fractional phase so repeats never drift. */
                music->clock.step = 0;
                for (uint32_t index = 0; index < music->track_count; ++index) {
                    music->tracks[index].cursor = 0;
                }
            } else {
                music->playing = false;
                music->ended = true;
            }
        }
    }
    for (uint32_t index = 0; index < PX_AUDIO_VOICES; ++index) {
        px_audio_sound *sound = &dsp->sounds[index];
        if (!sound->playing) {
            continue;
        }
        if (sound->clock.trigger) {
            sound->clock.trigger = false;
            while (sound->cursor < sound->count &&
                   sound->notes[sound->cursor].step == sound->clock.step) {
                px_trigger_step_note(dsp, index, PX_OWNER_EFFECT, &sound->instrument,
                                     &sound->clock, sound->notes, sound->count, sound->cursor);
                sound->cursor += 1;
            }
        }
        if (px_clock_tick(&sound->clock) && sound->clock.step >= sound->length) {
            sound->playing = false;
        }
    }
}

void px_audio_stop(px_audio_dsp *dsp) {
    if (dsp == NULL)
        return;
    dsp->music.playing = false;
    for (size_t index = 0; index < PX_AUDIO_VOICES; ++index) {
        dsp->sounds[index].playing = false;
    }
    for (size_t index = 0; index < PX_AUDIO_VOICES; ++index) {
        px_audio_voice *voice = &dsp->voices[index];
        if (voice->active) {
            /* A short linear fade from the current gain avoids a click. */
            px_begin_release(voice);
            if (voice->release_samples == 0 || voice->release_samples > PX_AUDIO_STOP_SAMPLES) {
                voice->release_samples = PX_AUDIO_STOP_SAMPLES;
            }
        }
    }
}

static void px_advance_envelope(px_audio_voice *voice) {
    if (voice->elapsed_samples < UINT32_MAX) {
        voice->elapsed_samples += 1;
    }
    voice->stage_samples += 1;
    if (voice->env_state != (uint8_t)PX_ENV_RELEASE &&
        voice->elapsed_samples >= voice->duration_samples) {
        px_begin_release(voice);
    }
    switch (voice->env_state) {
    case PX_ENV_ATTACK:
        if (voice->stage_samples >= voice->attack_samples) {
            voice->current_gain = 1.0f;
            voice->stage_samples = 0;
            voice->env_state =
                voice->decay_samples > 0 ? (uint8_t)PX_ENV_DECAY : (uint8_t)PX_ENV_SUSTAIN;
            if (voice->decay_samples == 0) {
                voice->current_gain = voice->sustain_level;
            }
        } else {
            voice->current_gain = (float)voice->stage_samples / (float)voice->attack_samples;
        }
        break;
    case PX_ENV_DECAY:
        if (voice->stage_samples >= voice->decay_samples) {
            voice->current_gain = voice->sustain_level;
            voice->env_state = (uint8_t)PX_ENV_SUSTAIN;
            voice->stage_samples = 0;
        } else {
            const float progress = (float)voice->stage_samples / (float)voice->decay_samples;
            voice->current_gain = 1.0f + (voice->sustain_level - 1.0f) * progress;
        }
        break;
    case PX_ENV_SUSTAIN:
        voice->current_gain = voice->sustain_level;
        break;
    case PX_ENV_RELEASE:
        if (voice->stage_samples >= voice->release_samples) {
            voice->current_gain = 0.0f;
            voice->active = false;
            voice->owner = PX_OWNER_NONE;
            voice->env_state = (uint8_t)PX_ENV_IDLE;
        } else {
            const float progress = (float)voice->stage_samples / (float)voice->release_samples;
            voice->current_gain = voice->stage_start_gain * (1.0f - progress);
        }
        break;
    default:
        voice->active = false;
        break;
    }
}

static float px_oscillator(px_audio_dsp *dsp, px_audio_voice *voice) {
    float sample = 0.0f;
    switch (voice->waveform) {
    case PX_WAVE_SQUARE:
        sample = voice->phase < 0.5f ? 1.0f : -1.0f;
        break;
    case PX_WAVE_TRIANGLE:
        if (voice->phase < 0.25f) {
            sample = 4.0f * voice->phase;
        } else if (voice->phase < 0.75f) {
            sample = 2.0f - 4.0f * voice->phase;
        } else {
            sample = -4.0f + 4.0f * voice->phase;
        }
        break;
    case PX_WAVE_SINE:
        sample = sinf(voice->phase * PX_TWO_PI);
        break;
    default: {
        /* Original 16-bit Galois LFSR noise shared by all noise voices. */
        uint16_t lfsr = dsp->noise_lfsr;
        const bool feedback = (lfsr & 1u) != 0;
        lfsr = (uint16_t)(lfsr >> 1);
        if (feedback) {
            lfsr = (uint16_t)(lfsr ^ 0xB400u);
        }
        dsp->noise_lfsr = lfsr;
        sample = ((float)lfsr / 32767.5f) - 1.0f;
        return sample;
    }
    }
    float frequency = voice->frequency;
    if (voice->effect == (uint8_t)PX_EFFECT_VIBRATO) {
        frequency *= 1.0f + PX_VIBRATO_DEPTH * sinf(voice->vibrato_phase * PX_TWO_PI);
        voice->vibrato_phase += PX_VIBRATO_HZ / (float)dsp->sample_rate;
        if (voice->vibrato_phase >= 1.0f) {
            voice->vibrato_phase -= 1.0f;
        }
    }
    voice->phase += frequency / (float)dsp->sample_rate;
    if (voice->phase >= 1.0f) {
        voice->phase -= floorf(voice->phase);
    }
    return sample;
}

/* Slide and fade-out act over the gate only. */
static float px_effect_gain(px_audio_voice *voice) {
    if (voice->slide_samples > 0) {
        voice->frequency *= voice->slide_ratio;
        voice->slide_samples -= 1;
    }
    if (voice->effect != (uint8_t)PX_EFFECT_FADEOUT) {
        return 1.0f;
    }
    if (voice->elapsed_samples >= voice->duration_samples) {
        return 0.0f;
    }
    return 1.0f - (float)voice->elapsed_samples / (float)voice->duration_samples;
}

void px_audio_render(px_audio_dsp *dsp, float *output, size_t frames) {
    if (dsp == NULL || output == NULL)
        return;
    for (size_t frame = 0; frame < frames; ++frame) {
        px_sequence_sample(dsp);
        float mix = 0.0f;
        for (size_t index = 0; index < PX_AUDIO_VOICES; ++index) {
            px_audio_voice *voice = &dsp->voices[index];
            if (!voice->active) {
                continue;
            }
            px_advance_envelope(voice);
            if (voice->active && voice->current_gain > 0.0f) {
                const float gain = voice->current_gain * px_effect_gain(voice);
                mix += px_oscillator(dsp, voice) * voice->volume * gain;
            }
        }
        mix *= dsp->master_volume;
        output[frame] = isfinite(mix) ? px_clampf(mix, -1.0f, 1.0f) : 0.0f;
    }
}

void px_audio_render_stereo(px_audio_dsp *dsp, float *left, float *right, size_t frames) {
    if (dsp == NULL || (left == NULL && right == NULL))
        return;
    float *primary = left != NULL ? left : right;
    px_audio_render(dsp, primary, frames);
    if (left != NULL && right != NULL && left != right) {
        memcpy(right, left, frames * sizeof(float));
    }
}

bool px_audio_is_voice_active(const px_audio_dsp *dsp, uint32_t voice_index) {
    if (dsp == NULL || voice_index >= PX_AUDIO_VOICES)
        return false;
    return dsp->voices[voice_index].active;
}

bool px_audio_is_any_voice_active(const px_audio_dsp *dsp) {
    if (dsp == NULL)
        return false;
    for (size_t index = 0; index < PX_AUDIO_VOICES; ++index) {
        if (dsp->voices[index].active)
            return true;
    }
    return false;
}

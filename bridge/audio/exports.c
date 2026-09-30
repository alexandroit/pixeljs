#include "pixeljs/audio.h"
#include "protocol.h"
#include <stdbool.h>
#include <stdint.h>

#define PXA_BUFFER_CAPACITY 512

static px_audio_dsp g_dsp;
static float g_audio_buffer[PXA_BUFFER_CAPACITY];

uint32_t pxa_initialize(uint32_t sample_rate) {
    px_audio_init(&g_dsp, sample_rate);
    return 0;
}

uint32_t pxa_note_on(uint32_t voice, uint32_t wave, float freq, float vol,
                     float attack, float decay, float sustain,
                     float release, float duration) {
    /* Validate before narrowing: 256 must not alias waveform 0. */
    if (wave > PX_WAVE_NOISE) {
        return 0;
    }
    const bool ok = px_audio_note_on(&g_dsp, voice, (uint8_t)wave, freq, vol,
                                     attack, decay, sustain, release, duration);
    return ok ? 1 : 0;
}

uint32_t pxa_note_on_effect(uint32_t voice, uint32_t wave, float freq, float vol, float attack,
                            float decay, float sustain, float release, float duration,
                            uint32_t effect, float slide_to) {
    if (wave > PX_WAVE_NOISE || effect > PX_EFFECT_FADEOUT) {
        return 0;
    }
    const px_audio_note note = {(uint8_t)wave, (uint8_t)effect, freq,    slide_to, vol,
                                attack,        decay,           sustain, release,  duration};
    return px_audio_play_note(&g_dsp, voice, &note) ? 1 : 0;
}

/* Step notes arrive as separate numbers; each is range-checked before it
 * narrows to the packed note fields. */
static bool pxa_step_note(uint32_t step, uint32_t length, uint32_t pitch, uint32_t volume,
                          uint32_t wave, uint32_t effect, px_audio_step_note *out) {
    if (step >= PX_AUDIO_MAX_STEPS || length == 0 || length > PX_AUDIO_MAX_STEPS ||
        pitch > PX_AUDIO_MAX_PITCH || volume > 255 || wave > PX_WAVE_NOISE ||
        effect > PX_EFFECT_FADEOUT) {
        return false;
    }
    *out = (px_audio_step_note){(uint16_t)step, (uint16_t)length, (uint8_t)pitch,
                                (uint8_t)volume, (uint8_t)wave, (uint8_t)effect};
    return true;
}

uint32_t pxa_sound_begin(uint32_t voice, uint32_t centi_bpm, uint32_t steps_per_beat, float volume,
                         float attack, float decay, float sustain, float release) {
    const px_audio_instrument instrument = {volume, attack, decay, sustain, release};
    return px_audio_sound_begin(&g_dsp, voice, centi_bpm, steps_per_beat, &instrument) ? 1 : 0;
}

uint32_t pxa_sound_note(uint32_t voice, uint32_t step, uint32_t length, uint32_t pitch,
                        uint32_t volume, uint32_t wave, uint32_t effect) {
    px_audio_step_note note;
    if (!pxa_step_note(step, length, pitch, volume, wave, effect, &note)) {
        /* Poison the sound so a partial effect never plays. */
        (void)px_audio_sound_note(&g_dsp, voice, NULL);
        return 0;
    }
    return px_audio_sound_note(&g_dsp, voice, &note) ? 1 : 0;
}

uint32_t pxa_sound_play(uint32_t voice) {
    return px_audio_sound_play(&g_dsp, voice) ? 1 : 0;
}

uint32_t pxa_music_begin(uint32_t length, uint32_t centi_bpm, uint32_t steps_per_beat,
                         uint32_t tracks) {
    return px_audio_music_begin(&g_dsp, length, centi_bpm, steps_per_beat, tracks) ? 1 : 0;
}

uint32_t pxa_music_track(uint32_t track, uint32_t voice, float volume, float attack, float decay,
                         float sustain, float release) {
    const px_audio_instrument instrument = {volume, attack, decay, sustain, release};
    return px_audio_music_track(&g_dsp, track, voice, &instrument) ? 1 : 0;
}

uint32_t pxa_music_note(uint32_t track, uint32_t step, uint32_t length, uint32_t pitch,
                        uint32_t volume, uint32_t wave, uint32_t effect) {
    px_audio_step_note note;
    if (!pxa_step_note(step, length, pitch, volume, wave, effect, &note)) {
        (void)px_audio_music_note(&g_dsp, track, NULL);
        return 0;
    }
    return px_audio_music_note(&g_dsp, track, &note) ? 1 : 0;
}

uint32_t pxa_music_play(uint32_t loop) {
    return px_audio_music_play(&g_dsp, loop != 0) ? 1 : 0;
}

uint32_t pxa_music_stop(void) {
    px_audio_music_stop(&g_dsp);
    return 0;
}

uint32_t pxa_music_ended(void) {
    return px_audio_music_take_ended(&g_dsp) ? 1 : 0;
}

uint32_t pxa_music_step(void) {
    return px_audio_music_step(&g_dsp);
}

uint32_t pxa_note_off(uint32_t voice) {
    px_audio_note_off(&g_dsp, voice);
    return 0;
}

uint32_t pxa_stop(void) {
    px_audio_stop(&g_dsp);
    return 0;
}

uint32_t pxa_set_master_volume(float volume) {
    px_audio_set_master_volume(&g_dsp, volume);
    return 0;
}

uint32_t pxa_buffer_offset(void) {
    return (uint32_t)(uintptr_t)g_audio_buffer;
}

uint32_t pxa_render(uint32_t frames) {
    if (frames > PXA_BUFFER_CAPACITY) {
        frames = PXA_BUFFER_CAPACITY;
    }
    px_audio_render(&g_dsp, g_audio_buffer, (size_t)frames);
    return frames;
}

uint32_t pxa_is_active(void) {
    return px_audio_is_any_voice_active(&g_dsp) ? 1 : 0;
}

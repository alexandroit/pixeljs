#ifndef PIXELJS_AUDIO_PROTOCOL_H
#define PIXELJS_AUDIO_PROTOCOL_H

#include <stdint.h>

/* Private scalar-only Audio WASM ABI. */
uint32_t pxa_initialize(uint32_t sample_rate);
uint32_t pxa_note_on(uint32_t voice, uint32_t wave, float freq, float vol,
                     float attack, float decay, float sustain,
                     float release, float duration);
uint32_t pxa_note_on_effect(uint32_t voice, uint32_t wave, float freq, float vol, float attack,
                            float decay, float sustain, float release, float duration,
                            uint32_t effect, float slide_to);
uint32_t pxa_sound_begin(uint32_t voice, uint32_t centi_bpm, uint32_t steps_per_beat, float volume,
                         float attack, float decay, float sustain, float release);
uint32_t pxa_sound_note(uint32_t voice, uint32_t step, uint32_t length, uint32_t pitch,
                        uint32_t volume, uint32_t wave, uint32_t effect);
uint32_t pxa_sound_play(uint32_t voice);
uint32_t pxa_music_begin(uint32_t length, uint32_t centi_bpm, uint32_t steps_per_beat,
                         uint32_t tracks);
uint32_t pxa_music_track(uint32_t track, uint32_t voice, float volume, float attack, float decay,
                         float sustain, float release);
uint32_t pxa_music_note(uint32_t track, uint32_t step, uint32_t length, uint32_t pitch,
                        uint32_t volume, uint32_t wave, uint32_t effect);
uint32_t pxa_music_play(uint32_t loop);
uint32_t pxa_music_stop(void);
/* 1 once after a non-looping piece ends. */
uint32_t pxa_music_ended(void);
/* Current music step, or 0xFFFFFFFF when none plays. */
uint32_t pxa_music_step(void);
uint32_t pxa_note_off(uint32_t voice);
uint32_t pxa_stop(void);
uint32_t pxa_set_master_volume(float volume);
uint32_t pxa_buffer_offset(void);
uint32_t pxa_render(uint32_t frames);
uint32_t pxa_is_active(void);

#endif /* PIXELJS_AUDIO_PROTOCOL_H */

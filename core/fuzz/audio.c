#include "pixeljs/audio.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

/* Drives the audio DSP with an arbitrary sequence of calls. After a u32
 * sample rate, each operation is a selector byte and a u32 (voice, track or
 * count), then its own arguments, always read in order. Floats come from raw bits, so
 * NaN, infinities and huge values reach every validator.
 *
 * Invariants: every rendered sample is finite and within [-1, 1], and no
 * sanitizer reports anything. Work per input is bounded (operations and
 * rendered frames), so each run stays fast. */

typedef struct reader {
    const uint8_t *data;
    size_t size;
    size_t at;
} reader;

static uint32_t read_u32(reader *input) {
    uint32_t value = 0;
    for (size_t index = 0; index < 4; ++index) {
        value |= (uint32_t)(input->at < input->size ? input->data[input->at] : 0) << (index * 8);
        input->at += 1;
    }
    return value;
}

static uint8_t read_u8(reader *input) {
    const uint8_t value = input->at < input->size ? input->data[input->at] : 0;
    input->at += 1;
    return value;
}

static float read_float(reader *input) {
    const uint32_t bits = read_u32(input);
    float value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

static px_audio_instrument read_instrument(reader *input) {
    px_audio_instrument instrument;
    instrument.volume = read_float(input);
    instrument.attack = read_float(input);
    instrument.decay = read_float(input);
    instrument.sustain = read_float(input);
    instrument.release = read_float(input);
    return instrument;
}

static px_audio_step_note read_step_note(reader *input) {
    px_audio_step_note note;
    note.step = (uint16_t)read_u32(input);
    note.length = (uint16_t)read_u32(input);
    note.pitch = read_u8(input);
    note.volume = read_u8(input);
    note.waveform = read_u8(input);
    note.effect = read_u8(input);
    return note;
}

static px_audio_dsp dsp;
static float samples[512];

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
    reader input = {data, size, 0};
    px_audio_init(&dsp, 8000 + read_u32(&input) % 184001);
    size_t rendered = 0;
    for (size_t operation = 0; operation < 4096 && input.at < input.size; ++operation) {
        const uint8_t selector = read_u8(&input) % 14;
        const uint32_t voice = read_u32(&input);
        switch (selector) {
        case 0: {
            px_audio_note note;
            note.waveform = read_u8(&input);
            note.effect = read_u8(&input);
            note.frequency = read_float(&input);
            note.slide_to = read_float(&input);
            note.volume = read_float(&input);
            note.attack = read_float(&input);
            note.decay = read_float(&input);
            note.sustain = read_float(&input);
            note.release = read_float(&input);
            note.duration = read_float(&input);
            (void)px_audio_play_note(&dsp, voice, &note);
            break;
        }
        case 1:
            px_audio_note_off(&dsp, voice);
            break;
        case 2:
            px_audio_stop(&dsp);
            break;
        case 3: {
            const px_audio_instrument instrument = read_instrument(&input);
            const uint32_t centi_bpm = read_u32(&input);
            const uint32_t steps_per_beat = read_u32(&input);
            (void)px_audio_sound_begin(&dsp, voice, centi_bpm, steps_per_beat, &instrument);
            break;
        }
        case 4: {
            const px_audio_step_note note = read_step_note(&input);
            (void)px_audio_sound_note(&dsp, voice, &note);
            break;
        }
        case 5:
            (void)px_audio_sound_play(&dsp, voice);
            break;
        case 6: {
            const uint32_t length = read_u32(&input);
            const uint32_t centi_bpm = read_u32(&input);
            const uint32_t steps_per_beat = read_u32(&input);
            (void)px_audio_music_begin(&dsp, length, centi_bpm, steps_per_beat, voice);
            break;
        }
        case 7: {
            const px_audio_instrument instrument = read_instrument(&input);
            const uint32_t track_voice = read_u32(&input);
            (void)px_audio_music_track(&dsp, voice, track_voice, &instrument);
            break;
        }
        case 8: {
            const px_audio_step_note note = read_step_note(&input);
            (void)px_audio_music_note(&dsp, voice, &note);
            break;
        }
        case 9:
            (void)px_audio_music_play(&dsp, (voice & 1U) != 0);
            break;
        case 10:
            px_audio_music_stop(&dsp);
            (void)px_audio_music_take_ended(&dsp);
            break;
        case 11:
            px_audio_set_master_volume(&dsp, read_float(&input));
            break;
        case 12: {
            const uint8_t waveform = read_u8(&input);
            float values[7];
            for (size_t index = 0; index < 7; ++index) {
                values[index] = read_float(&input);
            }
            (void)px_audio_note_on(&dsp, voice, waveform, values[0], values[1], values[2],
                                   values[3], values[4], values[5], values[6]);
            break;
        }
        default: {
            const size_t frames = 1 + voice % 512;
            if (rendered + frames > 1000000) {
                return 0;
            }
            px_audio_render(&dsp, samples, frames);
            rendered += frames;
            for (size_t index = 0; index < frames; ++index) {
                if (!isfinite(samples[index]) || samples[index] < -1.0f || samples[index] > 1.0f) {
                    abort();
                }
            }
            break;
        }
        }
    }
    return 0;
}

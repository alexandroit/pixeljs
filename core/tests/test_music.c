#include "pixeljs/audio.h"
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Contracts for note effects, multi-note sound effects and music: timing is
 * checked to the sample, effects by measuring the rendered signal. */

#define CHECK(expression)                                                                          \
    do {                                                                                           \
        if (!(expression)) {                                                                       \
            fprintf(stderr, "Music check failed at line %d: %s\n", __LINE__, #expression);         \
            exit(EXIT_FAILURE);                                                                    \
        }                                                                                          \
    } while (0)

static px_audio_dsp dsp;
static float samples[96000];

static const px_audio_instrument plain = {1.0f, 0.0f, 0.0f, 1.0f, 0.0f};

static px_audio_step_note step_note(uint16_t step, uint16_t length, uint8_t pitch, uint8_t effect) {
    const px_audio_step_note note = {step, length, pitch, 255, (uint8_t)PX_WAVE_SINE, effect};
    return note;
}

/* Upward zero crossings between two sample indices: cycles of the signal. */
static uint32_t crossings(size_t first, size_t end) {
    uint32_t count = 0;
    for (size_t index = first + 1; index < end; ++index) {
        count += samples[index - 1] < 0.0f && samples[index] >= 0.0f ? 1U : 0U;
    }
    return count;
}

static float peak(size_t first, size_t end) {
    float value = 0.0f;
    for (size_t index = first; index < end; ++index) {
        value = fabsf(samples[index]) > value ? fabsf(samples[index]) : value;
    }
    return value;
}

static void test_effects(void) {
    px_audio_init(&dsp, 48000);
    /* Slide: 440 Hz to 880 Hz over 0.5 s, even in pitch. */
    px_audio_note note = {(uint8_t)PX_WAVE_SINE, (uint8_t)PX_EFFECT_SLIDE, 440.0f, 880.0f, 1.0f,
                          0.0f, 0.0f, 1.0f, 0.0f, 0.5f};
    CHECK(px_audio_play_note(&dsp, 0, &note));
    px_audio_render(&dsp, samples, 24000);
    const uint32_t early = crossings(0, 2400);
    const uint32_t late = crossings(21600, 24000);
    CHECK(early >= 21 && early <= 24); /* About 456 Hz over 50 ms. */
    CHECK(late >= 41 && late <= 44);   /* About 850 Hz. */
    CHECK(fabsf(dsp.voices[0].frequency - 880.0f) < 2.0f);

    /* Vibrato: the pitch swings about half a semitone around 440 Hz. */
    px_audio_init(&dsp, 48000);
    note = (px_audio_note){(uint8_t)PX_WAVE_SINE, (uint8_t)PX_EFFECT_VIBRATO, 440.0f, 0.0f, 1.0f,
                           0.0f, 0.0f, 1.0f, 0.0f, 1.0f};
    CHECK(px_audio_play_note(&dsp, 0, &note));
    px_audio_render(&dsp, samples, 48000);
    const uint32_t total = crossings(0, 48000);
    CHECK(total >= 438 && total <= 442);
    uint32_t low = UINT32_MAX;
    uint32_t high = 0;
    for (size_t window = 0; window + 4800 <= 48000; window += 800) {
        const uint32_t count = crossings(window, window + 4800); /* 100 ms windows. */
        low = count < low ? count : low;
        high = count > high ? count : high;
    }
    CHECK(high > low && high - low <= 4);

    /* Fade-out: full volume at the start, silent at the end of the gate. */
    px_audio_init(&dsp, 48000);
    note = (px_audio_note){(uint8_t)PX_WAVE_SQUARE, (uint8_t)PX_EFFECT_FADEOUT, 300.0f, 0.0f, 0.8f,
                           0.0f, 0.0f, 1.0f, 0.05f, 0.5f};
    CHECK(px_audio_play_note(&dsp, 1, &note));
    px_audio_render(&dsp, samples, 30000);
    CHECK(peak(0, 480) > 0.75f);
    CHECK(peak(23000, 24000) < 0.05f);
    CHECK(peak(24000, 30000) == 0.0f);

    /* Invalid effects and slides without a target are rejected. */
    note.effect = 4;
    CHECK(!px_audio_play_note(&dsp, 0, &note));
    note.effect = (uint8_t)PX_EFFECT_SLIDE;
    note.slide_to = 0.0f;
    CHECK(!px_audio_play_note(&dsp, 0, &note));
    note.slide_to = NAN;
    CHECK(!px_audio_play_note(&dsp, 0, &note));
}

/* Records the sample at which voice `voice` starts each note. */
static size_t note_starts(uint32_t voice, size_t frames, size_t *starts, size_t capacity) {
    size_t found = 0;
    for (size_t frame = 0; frame < frames; ++frame) {
        px_audio_render(&dsp, samples, 1);
        if (dsp.voices[voice].active && dsp.voices[voice].elapsed_samples == 1 &&
            found < capacity) {
            starts[found++] = frame;
        }
    }
    return found;
}

static void test_music_timing(void) {
    /* 120 BPM, four steps per beat at 48 kHz: exactly 6,000 samples a step. */
    px_audio_init(&dsp, 48000);
    CHECK(px_audio_music_begin(&dsp, 12, 12000, 4, 1));
    CHECK(px_audio_music_track(&dsp, 0, 0, &plain));
    for (uint16_t step = 0; step < 12; step = (uint16_t)(step + 4)) {
        const px_audio_step_note note = step_note(step, 1, 69, (uint8_t)PX_EFFECT_NONE);
        CHECK(px_audio_music_note(&dsp, 0, &note));
    }
    CHECK(px_audio_music_play(&dsp, false));
    size_t starts[8];
    CHECK(note_starts(0, 80000, starts, 8) == 3);
    CHECK(starts[0] == 0 && starts[1] == 24000 && starts[2] == 48000);
    CHECK(px_audio_music_take_ended(&dsp));
    CHECK(!px_audio_music_take_ended(&dsp));
    CHECK(px_audio_music_step(&dsp) == UINT32_MAX);

    /* A fractional tempo never drifts: step k starts at ceil(k * frames). */
    px_audio_init(&dsp, 44100);
    CHECK(px_audio_music_begin(&dsp, 1000, 12345, 3, 1));
    CHECK(px_audio_music_track(&dsp, 0, 2, &plain));
    for (uint16_t step = 0; step < 1000; step = (uint16_t)(step + 10)) {
        const px_audio_step_note note = step_note(step, 1, 60, (uint8_t)PX_EFFECT_NONE);
        CHECK(px_audio_music_note(&dsp, 0, &note));
    }
    CHECK(px_audio_music_play(&dsp, true));
    const uint64_t frames = ((uint64_t)44100 * 6000 * 65536 + (12345 * 3) / 2) / (12345 * 3);
    static size_t many[128];
    const size_t count = note_starts(2, (size_t)((1000 * frames) >> 16) + 10, many, 128);
    CHECK(count >= 100);
    for (size_t index = 0; index < 100; ++index) {
        const uint64_t step = index * 10;
        CHECK(many[index] == (size_t)((step * frames + 65535) >> 16));
        const double exact = (double)step * 44100.0 * 60.0 / (123.45 * 3.0);
        CHECK(fabs((double)many[index] - exact) <= 1.0);
    }
    /* Looping restarts step 0 exactly one piece length later. */
    CHECK(count == 101 && many[100] == (size_t)((1000 * frames + 65535) >> 16));
}

static void test_layers(void) {
    px_audio_init(&dsp, 48000);
    CHECK(px_audio_music_begin(&dsp, 8, 12000, 4, 2));
    CHECK(px_audio_music_track(&dsp, 0, 0, &plain));
    CHECK(px_audio_music_track(&dsp, 1, 3, &plain));
    for (uint16_t step = 0; step < 8; step = (uint16_t)(step + 2)) {
        const px_audio_step_note note = step_note(step, 1, 57, (uint8_t)PX_EFFECT_NONE);
        CHECK(px_audio_music_note(&dsp, 0, &note));
    }
    const px_audio_step_note bass = step_note(0, 8, 33, (uint8_t)PX_EFFECT_NONE);
    CHECK(px_audio_music_note(&dsp, 1, &bass));
    CHECK(px_audio_music_play(&dsp, false));
    px_audio_render(&dsp, samples, 3000);
    CHECK(dsp.voices[0].owner == 1 && dsp.voices[3].owner == 1);
    px_audio_render(&dsp, samples, 4000);
    /* A 0.25 s sound effect takes voice 0 from 7,000 to 19,000. */
    const px_audio_note effect = {(uint8_t)PX_WAVE_SQUARE, (uint8_t)PX_EFFECT_NONE, 1000.0f, 0.0f,
                                  0.5f, 0.0f, 0.0f, 1.0f, 0.0f, 0.25f};
    CHECK(px_audio_play_note(&dsp, 0, &effect));
    px_audio_render(&dsp, samples, 5001); /* Through the step-2 note at 12,000. */
    CHECK(dsp.voices[0].owner == 2 && fabsf(dsp.voices[0].frequency - 1000.0f) < 0.01f);
    /* Stopping an effect never releases a music note elsewhere. */
    px_audio_note_off(&dsp, 3);
    CHECK(dsp.voices[3].active && dsp.voices[3].env_state != PX_ENV_RELEASE);
    px_audio_render(&dsp, samples, 12000); /* The effect ended at 19,000. */
    CHECK(dsp.voices[0].owner == 1 && dsp.voices[0].elapsed_samples == 1);
    CHECK(fabsf(dsp.voices[0].frequency - 220.0f) < 0.01f); /* Music is back at step 4. */

    /* A multi-note effect plays at its own tempo and holds its voice. */
    px_audio_init(&dsp, 48000);
    CHECK(px_audio_sound_begin(&dsp, 2, 24000, 4, &plain)); /* 3,000 samples a step. */
    const uint8_t pitches[3] = {60, 64, 67};
    for (uint16_t index = 0; index < 3; ++index) {
        const px_audio_step_note note = step_note((uint16_t)(index * 2), 2, pitches[index],
                                                  (uint8_t)(index == 0 ? PX_EFFECT_SLIDE
                                                                       : PX_EFFECT_NONE));
        CHECK(px_audio_sound_note(&dsp, 2, &note));
    }
    CHECK(px_audio_sound_play(&dsp, 2));
    size_t starts[4];
    CHECK(note_starts(2, 20000, starts, 4) == 3);
    CHECK(starts[0] == 0 && starts[1] == 6000 && starts[2] == 12000);
    CHECK(!dsp.sounds[2].playing);
    /* The slide on the first note arrived at the second note's pitch. */
    px_audio_init(&dsp, 48000);
    CHECK(px_audio_sound_begin(&dsp, 2, 24000, 4, &plain));
    for (uint16_t index = 0; index < 2; ++index) {
        const px_audio_step_note note = step_note((uint16_t)(index * 2), 2, pitches[index],
                                                  (uint8_t)PX_EFFECT_SLIDE);
        CHECK(px_audio_sound_note(&dsp, 2, &note));
    }
    CHECK(px_audio_sound_play(&dsp, 2));
    px_audio_render(&dsp, samples, 5999);
    CHECK(fabsf(dsp.voices[2].frequency - 329.63f) < 1.0f);
    px_audio_note_off(&dsp, 2);
    CHECK(!dsp.sounds[2].playing && dsp.voices[2].env_state == PX_ENV_RELEASE);
}

static void test_validation_and_stop(void) {
    px_audio_init(&dsp, 48000);
    CHECK(!px_audio_music_begin(&dsp, 0, 12000, 4, 1));
    CHECK(!px_audio_music_begin(&dsp, PX_AUDIO_MAX_STEPS + 1, 12000, 4, 1));
    CHECK(!px_audio_music_begin(&dsp, 16, PX_AUDIO_MIN_CENTI_BPM - 1, 4, 1));
    CHECK(!px_audio_music_begin(&dsp, 16, PX_AUDIO_MAX_CENTI_BPM + 1, 4, 1));
    CHECK(!px_audio_music_begin(&dsp, 16, 12000, 0, 1));
    CHECK(!px_audio_music_begin(&dsp, 16, 12000, PX_AUDIO_MAX_STEPS_PER_BEAT + 1, 1));
    CHECK(!px_audio_music_begin(&dsp, 16, 12000, 4, 0));
    CHECK(!px_audio_music_begin(&dsp, 16, 12000, 4, PX_AUDIO_VOICES + 1));
    CHECK(!px_audio_music_play(&dsp, true));

    /* Two tracks on one voice, an unset track, bad notes: nothing plays. */
    CHECK(px_audio_music_begin(&dsp, 16, 12000, 4, 2));
    CHECK(px_audio_music_track(&dsp, 0, 1, &plain));
    CHECK(!px_audio_music_track(&dsp, 1, 1, &plain));
    CHECK(!px_audio_music_play(&dsp, true));
    CHECK(px_audio_music_begin(&dsp, 16, 12000, 4, 2));
    CHECK(px_audio_music_track(&dsp, 0, 1, &plain));
    CHECK(!px_audio_music_play(&dsp, true));
    const px_audio_step_note bad[] = {
        {0, 0, 60, 255, 0, 0},  /* Zero length. */
        {0, 1, 128, 255, 0, 0}, /* Pitch. */
        {0, 1, 60, 255, 4, 0},  /* Waveform. */
        {0, 1, 60, 255, 0, 4},  /* Effect. */
        {16, 1, 60, 255, 0, 0}, /* Past the end. */
    };
    for (size_t index = 0; index < sizeof(bad) / sizeof(bad[0]); ++index) {
        CHECK(px_audio_music_begin(&dsp, 16, 12000, 4, 1));
        CHECK(px_audio_music_track(&dsp, 0, 0, &plain));
        CHECK(!px_audio_music_note(&dsp, 0, &bad[index]));
        CHECK(!px_audio_music_play(&dsp, true));
    }
    /* Notes must be in step order; a track holds at most 512. */
    CHECK(px_audio_music_begin(&dsp, 16, 12000, 4, 1));
    CHECK(px_audio_music_track(&dsp, 0, 0, &plain));
    px_audio_step_note note = step_note(5, 1, 60, 0);
    CHECK(px_audio_music_note(&dsp, 0, &note));
    note.step = 4;
    CHECK(!px_audio_music_note(&dsp, 0, &note));
    CHECK(!px_audio_music_play(&dsp, true));
    CHECK(px_audio_music_begin(&dsp, 16, 12000, 4, 1));
    CHECK(px_audio_music_track(&dsp, 0, 0, &plain));
    note.step = 3;
    for (size_t index = 0; index < PX_AUDIO_TRACK_NOTES; ++index) {
        CHECK(px_audio_music_note(&dsp, 0, &note));
    }
    CHECK(!px_audio_music_note(&dsp, 0, &note));
    const px_audio_instrument loud = {1.5f, 0.0f, 0.0f, 1.0f, 0.0f};
    CHECK(px_audio_music_begin(&dsp, 16, 12000, 4, 1));
    CHECK(!px_audio_music_track(&dsp, 0, 0, &loud));
    CHECK(!px_audio_sound_begin(&dsp, 0, 12000, 4, &loud));
    CHECK(!px_audio_sound_begin(&dsp, 4, 12000, 4, &plain));
    CHECK(px_audio_sound_begin(&dsp, 0, 12000, 4, &plain));
    CHECK(!px_audio_sound_play(&dsp, 0)); /* Empty. */
    CHECK(px_audio_sound_begin(&dsp, 0, 12000, 4, &plain));
    for (size_t index = 0; index < PX_AUDIO_SOUND_NOTES; ++index) {
        CHECK(px_audio_sound_note(&dsp, 0, &note));
    }
    CHECK(!px_audio_sound_note(&dsp, 0, &note));
    CHECK(!px_audio_sound_play(&dsp, 0));

    /* Stop ends music and sound effects and fades every voice. */
    CHECK(px_audio_music_begin(&dsp, 16, 12000, 4, 1));
    CHECK(px_audio_music_track(&dsp, 0, 0, &plain));
    note = step_note(0, 16, 60, 0);
    CHECK(px_audio_music_note(&dsp, 0, &note));
    CHECK(px_audio_music_play(&dsp, true));
    CHECK(px_audio_sound_begin(&dsp, 1, 12000, 4, &plain));
    CHECK(px_audio_sound_note(&dsp, 1, &note));
    CHECK(px_audio_sound_play(&dsp, 1));
    px_audio_render(&dsp, samples, 256);
    CHECK(px_audio_music_step(&dsp) == 0);
    px_audio_stop(&dsp);
    px_audio_render(&dsp, samples, 256);
    CHECK(!px_audio_is_any_voice_active(&dsp) && !dsp.music.playing && !dsp.sounds[1].playing);
    CHECK(peak(128, 256) == 0.0f);
    /* music_stop releases only music voices. */
    CHECK(px_audio_music_begin(&dsp, 16, 12000, 4, 1));
    CHECK(px_audio_music_track(&dsp, 0, 0, &plain));
    CHECK(px_audio_music_note(&dsp, 0, &note));
    CHECK(px_audio_music_play(&dsp, true));
    const px_audio_note effect = {(uint8_t)PX_WAVE_SQUARE, 0, 500.0f, 0.0f, 1.0f,
                                  0.0f, 0.0f, 1.0f, 0.0f, 1.0f};
    CHECK(px_audio_play_note(&dsp, 1, &effect));
    px_audio_render(&dsp, samples, 64);
    px_audio_music_stop(&dsp);
    CHECK(dsp.voices[0].env_state == PX_ENV_RELEASE);
    CHECK(dsp.voices[1].env_state != PX_ENV_RELEASE);
}

static uint32_t next_random(uint32_t *state) {
    uint32_t value = *state;
    value ^= value << 13;
    value ^= value >> 17;
    value ^= value << 5;
    *state = value;
    return value;
}

/* Random valid pieces and effects at random block sizes: the output stays
 * finite and within [-1, 1]. */
static void test_random_pieces(void) {
    uint32_t seed = UINT32_C(0x7f4a7c15);
    for (size_t piece = 0; piece < 200; ++piece) {
        px_audio_init(&dsp, 8000 + next_random(&seed) % 184001);
        const uint32_t tracks = 1 + next_random(&seed) % PX_AUDIO_VOICES;
        const uint32_t length = 1 + next_random(&seed) % 64;
        CHECK(px_audio_music_begin(&dsp, length, 2000 + next_random(&seed) % 38001,
                                   1 + next_random(&seed) % 16, tracks));
        for (uint32_t track = 0; track < tracks; ++track) {
            const px_audio_instrument instrument = {
                (float)(next_random(&seed) % 101) / 100.0f, (float)(next_random(&seed) % 10) / 100.0f,
                (float)(next_random(&seed) % 10) / 100.0f, (float)(next_random(&seed) % 101) / 100.0f,
                (float)(next_random(&seed) % 10) / 100.0f};
            CHECK(px_audio_music_track(&dsp, track, track, &instrument));
            uint16_t step = 0;
            for (size_t index = 0; index < 32 && step < length; ++index) {
                const px_audio_step_note note = {step,
                                                 (uint16_t)(1 + next_random(&seed) % 8),
                                                 (uint8_t)(next_random(&seed) % 128),
                                                 (uint8_t)next_random(&seed),
                                                 (uint8_t)(next_random(&seed) % 4),
                                                 (uint8_t)(next_random(&seed) % 4)};
                CHECK(px_audio_music_note(&dsp, track, &note));
                step = (uint16_t)(step + next_random(&seed) % 3);
            }
        }
        CHECK(px_audio_music_play(&dsp, (next_random(&seed) & 1U) != 0));
        for (size_t block = 0; block < 40; ++block) {
            if (next_random(&seed) % 8 == 0) {
                const px_audio_note effect = {(uint8_t)(next_random(&seed) % 4),
                                              (uint8_t)(next_random(&seed) % 4),
                                              20.0f + (float)(next_random(&seed) % 8000),
                                              20.0f + (float)(next_random(&seed) % 8000),
                                              1.0f, 0.0f, 0.01f, 0.5f, 0.02f, 0.1f};
                CHECK(px_audio_play_note(&dsp, next_random(&seed) % PX_AUDIO_VOICES, &effect));
            }
            const size_t frames = 1 + next_random(&seed) % 512;
            px_audio_render(&dsp, samples, frames);
            for (size_t index = 0; index < frames; ++index) {
                CHECK(isfinite(samples[index]) && samples[index] >= -1.0f &&
                      samples[index] <= 1.0f);
            }
        }
    }
}

int main(void) {
    test_effects();
    test_music_timing();
    test_layers();
    test_validation_and_stop();
    test_random_pieces();
    puts("PixelJS music: 5 contract groups passed (effects, sample-exact timing, layers, "
         "validation, 200 random pieces).");
    return EXIT_SUCCESS;
}

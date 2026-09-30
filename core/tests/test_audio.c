#include "pixeljs/audio.h"
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(expression)                                                                          \
    do {                                                                                           \
        if (!(expression)) {                                                                       \
            fprintf(stderr, "Audio check failed at line %d: %s\n", __LINE__, #expression);         \
            exit(EXIT_FAILURE);                                                                    \
        }                                                                                          \
    } while (0)

static void test_audio_init_and_bounds(void) {
    px_audio_dsp dsp;
    px_audio_init(&dsp, 44100);
    CHECK(dsp.sample_rate == 44100);
    CHECK(dsp.master_volume == 1.0f);
    CHECK(!px_audio_is_any_voice_active(&dsp));
    for (uint32_t i = 0; i < PX_AUDIO_VOICES; ++i) {
        CHECK(!px_audio_is_voice_active(&dsp, i));
    }

    /* Clamping sample rate */
    px_audio_init(&dsp, 1000);
    CHECK(dsp.sample_rate == PX_AUDIO_MIN_SAMPLE_RATE);
    px_audio_init(&dsp, 500000);
    CHECK(dsp.sample_rate == PX_AUDIO_MAX_SAMPLE_RATE);

    /* Master volume clamping */
    px_audio_set_master_volume(&dsp, 1.5f);
    CHECK(dsp.master_volume == 1.0f);
    px_audio_set_master_volume(&dsp, -0.5f);
    CHECK(dsp.master_volume == 0.0f);
    px_audio_set_master_volume(&dsp, 0.75f);
    CHECK(fabsf(dsp.master_volume - 0.75f) < 1e-5f);
}

static void test_waveforms(void) {
    px_audio_dsp dsp;
    px_audio_init(&dsp, 48000);
    float buffer[128];

    /* Square wave: values should be +1 or -1 */
    CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_SQUARE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    CHECK(px_audio_is_voice_active(&dsp, 0));
    px_audio_render(&dsp, buffer, 128);
    bool has_pos = false;
    bool has_neg = false;
    for (size_t i = 0; i < 128; ++i) {
        CHECK(isfinite(buffer[i]));
        CHECK(buffer[i] >= -1.0f && buffer[i] <= 1.0f);
        if (buffer[i] > 0.5f) has_pos = true;
        if (buffer[i] < -0.5f) has_neg = true;
    }
    CHECK(has_pos && has_neg);
    px_audio_stop(&dsp);
    px_audio_render(&dsp, buffer, 128); /* flush stop ramp */
    CHECK(!px_audio_is_any_voice_active(&dsp));

    /* Sine wave: values must be smooth and within [-1, 1] */
    CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    px_audio_render(&dsp, buffer, 128);
    has_pos = false;
    has_neg = false;
    for (size_t i = 0; i < 128; ++i) {
        CHECK(isfinite(buffer[i]));
        CHECK(buffer[i] >= -1.0f && buffer[i] <= 1.0f);
        if (buffer[i] > 0.5f) has_pos = true;
        if (buffer[i] < -0.5f) has_neg = true;
    }
    CHECK(has_pos && has_neg);
    px_audio_stop(&dsp);
    px_audio_render(&dsp, buffer, 128);

    /* Triangle wave */
    CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_TRIANGLE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    px_audio_render(&dsp, buffer, 128);
    for (size_t i = 0; i < 128; ++i) {
        CHECK(isfinite(buffer[i]));
        CHECK(buffer[i] >= -1.0f && buffer[i] <= 1.0f);
    }
    px_audio_stop(&dsp);
    px_audio_render(&dsp, buffer, 128);

    /* Noise wave: non-constant deterministic pseudo-random */
    CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_NOISE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    px_audio_render(&dsp, buffer, 128);
    bool non_zero = false;
    for (size_t i = 0; i < 128; ++i) {
        CHECK(isfinite(buffer[i]));
        CHECK(buffer[i] >= -1.0f && buffer[i] <= 1.0f);
        if (fabsf(buffer[i]) > 0.01f) non_zero = true;
    }
    CHECK(non_zero);
}

static void test_envelope_lifecycle(void) {
    px_audio_dsp dsp;
    px_audio_init(&dsp, 8000); /* 8000 Hz sample rate */
    float buffer[100];

    /* Note with 10 ms attack (80 samples), 10 ms decay (80 samples), sustain 0.5,
     * 30 ms duration (240 samples), 10 ms release (80 samples) */
    CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 100.0f, 1.0f, 0.01f, 0.01f, 0.5f, 0.01f, 0.03f));

    /* After 80 samples (attack), gain should reach 1.0 and state should be DECAY */
    px_audio_render(&dsp, buffer, 80);
    CHECK(dsp.voices[0].env_state == PX_ENV_DECAY);
    CHECK(dsp.voices[0].current_gain >= 0.95f);

    /* After another 80 samples (decay), gain should reach sustain level ~0.5 */
    px_audio_render(&dsp, buffer, 80);
    CHECK(dsp.voices[0].env_state == PX_ENV_SUSTAIN);
    CHECK(fabsf(dsp.voices[0].current_gain - 0.5f) < 0.05f);

    /* Sustain for 80 more samples -> 240 samples elapsed -> duration reached, transitions to release */
    px_audio_render(&dsp, buffer, 80);
    CHECK(dsp.voices[0].env_state == PX_ENV_RELEASE);

    /* Release for 80 samples -> voice should become inactive */
    px_audio_render(&dsp, buffer, 80);
    CHECK(!dsp.voices[0].active);
    CHECK(dsp.voices[0].env_state == PX_ENV_IDLE);

    /* Further rendering produces complete silence */
    px_audio_render(&dsp, buffer, 80);
    for (size_t i = 0; i < 80; ++i) {
        CHECK(buffer[i] == 0.0f);
    }
}

static void test_voice_allocation_and_stealing(void) {
    px_audio_dsp dsp;
    px_audio_init(&dsp, 44100);

    /* Start 4 distinct voices */
    CHECK(px_audio_note_on(&dsp, PX_AUDIO_AUTO_VOICE, PX_WAVE_SINE, 220.0f, 0.5f, 0.0f, 0.0f, 1.0f, 0.0f, 5.0f));
    CHECK(px_audio_note_on(&dsp, PX_AUDIO_AUTO_VOICE, PX_WAVE_SINE, 330.0f, 0.5f, 0.0f, 0.0f, 1.0f, 0.0f, 5.0f));
    CHECK(px_audio_note_on(&dsp, PX_AUDIO_AUTO_VOICE, PX_WAVE_SINE, 440.0f, 0.5f, 0.0f, 0.0f, 1.0f, 0.0f, 5.0f));
    CHECK(px_audio_note_on(&dsp, PX_AUDIO_AUTO_VOICE, PX_WAVE_SINE, 550.0f, 0.5f, 0.0f, 0.0f, 1.0f, 0.0f, 5.0f));

    for (uint32_t i = 0; i < 4; ++i) {
        CHECK(px_audio_is_voice_active(&dsp, i));
    }

    /* 5th note must steal a voice without error */
    CHECK(px_audio_note_on(&dsp, PX_AUDIO_AUTO_VOICE, PX_WAVE_SINE, 660.0f, 0.5f, 0.0f, 0.0f, 1.0f, 0.0f, 5.0f));
    CHECK(px_audio_is_any_voice_active(&dsp));

    /* Stop all */
    px_audio_stop(&dsp);
    float buffer[128];
    px_audio_render(&dsp, buffer, 128);
    CHECK(!px_audio_is_any_voice_active(&dsp));
}

static void test_stop_ramp_and_silence(void) {
    px_audio_dsp dsp;
    px_audio_init(&dsp, 44100);
    float buffer[128];

    CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_SQUARE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 10.0f));
    px_audio_render(&dsp, buffer, 64);
    CHECK(px_audio_is_voice_active(&dsp, 0));

    px_audio_stop(&dsp);
    CHECK(dsp.voices[0].env_state == PX_ENV_RELEASE);
    CHECK(dsp.voices[0].release_samples == PX_AUDIO_STOP_SAMPLES);
    px_audio_render(&dsp, buffer, 128);
    CHECK(!px_audio_is_any_voice_active(&dsp));
    /* The fade starts at full level and decreases monotonically to silence. */
    CHECK(fabsf(buffer[0]) > 0.9f);
    for (size_t i = 1; i < PX_AUDIO_STOP_SAMPLES; ++i) {
        CHECK(fabsf(buffer[i]) <= fabsf(buffer[i - 1]) + 1e-6f);
    }

    /* After stop, subsequent renders are completely 0.0f */
    px_audio_render(&dsp, buffer, 128);
    for (size_t i = 0; i < 128; ++i) {
        CHECK(buffer[i] == 0.0f);
    }
}

static void test_stop_is_not_revived_by_new_notes(void) {
    px_audio_dsp dsp;
    px_audio_init(&dsp, 48000);
    float buffer[256];
    CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_SQUARE, 220.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 30.0f));
    CHECK(px_audio_note_on(&dsp, 1, PX_WAVE_SQUARE, 330.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 30.0f));
    px_audio_render(&dsp, buffer, 32);
    px_audio_stop(&dsp);
    px_audio_render(&dsp, buffer, 8);
    /* A note started during the fade must not cancel it for other voices. */
    CHECK(px_audio_note_on(&dsp, 2, PX_WAVE_SINE, 440.0f, 0.5f, 0.0f, 0.0f, 1.0f, 0.0f, 30.0f));
    px_audio_render(&dsp, buffer, 256);
    CHECK(!px_audio_is_voice_active(&dsp, 0) && !px_audio_is_voice_active(&dsp, 1));
    CHECK(px_audio_is_voice_active(&dsp, 2));
}

static void test_gate_and_parameter_validation(void) {
    px_audio_dsp dsp;
    px_audio_init(&dsp, 8000);
    float buffer[200];
    /* A 10 ms gate inside a 1 s attack releases from the reached gain. */
    CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 100.0f, 1.0f, 1.0f, 0.0f, 1.0f, 0.01f, 0.01f));
    px_audio_render(&dsp, buffer, 80);
    CHECK(dsp.voices[0].env_state == PX_ENV_RELEASE);
    CHECK(dsp.voices[0].stage_start_gain < 0.02f);
    px_audio_render(&dsp, buffer, 80);
    CHECK(!px_audio_is_voice_active(&dsp, 0));

    /* Invalid numbers and voices are rejected without touching any voice. */
    const float nan = NAN;
    const float infinity = INFINITY;
    CHECK(!px_audio_note_on(&dsp, 4, PX_WAVE_SINE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    CHECK(!px_audio_note_on(&dsp, 0, 4, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, nan, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, -1.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.5f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.0f, infinity, 0.0f, 1.0f, 0.0f, 1.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.0f, 0.0f, 11.0f, 1.0f, 0.0f, 1.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.0f, 0.0f, 0.0f, nan, 0.0f, 1.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, -0.1f, 1.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 61.0f));
    CHECK(!px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, nan));
    CHECK(!px_audio_is_any_voice_active(&dsp));
    /* Non-finite master volume selects silence instead of propagating NaN. */
    px_audio_set_master_volume(&dsp, nan);
    CHECK(dsp.master_volume == 0.0f);
}

static void test_variable_block_sizes_and_rates(void) {
    const uint32_t rates[] = {8000, 22050, 44100, 48000, 96000};
    const size_t block_sizes[] = {1, 7, 16, 64, 128, 256, 513};

    for (size_t r = 0; r < sizeof(rates) / sizeof(rates[0]); ++r) {
        px_audio_dsp dsp;
        px_audio_init(&dsp, rates[r]);
        CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_TRIANGLE, 440.0f, 0.8f, 0.01f, 0.01f, 0.5f, 0.01f, 0.1f));

        for (size_t b = 0; b < sizeof(block_sizes) / sizeof(block_sizes[0]); ++b) {
            float buf[513];
            px_audio_render(&dsp, buf, block_sizes[b]);
            for (size_t i = 0; i < block_sizes[b]; ++i) {
                CHECK(isfinite(buf[i]));
                CHECK(buf[i] >= -1.0f && buf[i] <= 1.0f);
            }
        }
    }
}

static void test_stereo_rendering(void) {
    px_audio_dsp dsp;
    px_audio_init(&dsp, 44100);
    float left[64];
    float right[64];

    CHECK(px_audio_note_on(&dsp, 0, PX_WAVE_SINE, 440.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f));
    px_audio_render_stereo(&dsp, left, right, 64);
    for (size_t i = 0; i < 64; ++i) {
        CHECK(left[i] == right[i]);
        CHECK(isfinite(left[i]));
    }

    /* The same buffer may serve both channels. */
    px_audio_render_stereo(&dsp, left, left, 64);
    for (size_t i = 0; i < 64; ++i) {
        CHECK(isfinite(left[i]));
    }

    /* Graceful handling of null channels */
    px_audio_render_stereo(&dsp, left, NULL, 64);
    px_audio_render_stereo(&dsp, NULL, right, 64);
    px_audio_render_stereo(&dsp, NULL, NULL, 64);
}

int main(void) {
    test_audio_init_and_bounds();
    test_waveforms();
    test_envelope_lifecycle();
    test_voice_allocation_and_stealing();
    test_stop_ramp_and_silence();
    test_stop_is_not_revived_by_new_notes();
    test_gate_and_parameter_validation();
    test_variable_block_sizes_and_rates();
    test_stereo_rendering();
    puts("PixelJS audio DSP: 9 contract groups passed (fixed state, all waveforms, ADSR, gate, "
         "validated parameters).");
    return EXIT_SUCCESS;
}

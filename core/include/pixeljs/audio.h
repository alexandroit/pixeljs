#ifndef PIXELJS_AUDIO_H
#define PIXELJS_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PX_AUDIO_VOICES 4
#define PX_AUDIO_MIN_SAMPLE_RATE 8000
#define PX_AUDIO_MAX_SAMPLE_RATE 192000
#define PX_AUDIO_DEFAULT_SAMPLE_RATE 44100
#define PX_AUDIO_AUTO_VOICE 0xFFFFFFFFU
/* Envelope stages accept 0..10 seconds; a note's gate lasts at most 60 s. */
#define PX_AUDIO_MAX_STAGE_SECONDS 10.0f
#define PX_AUDIO_MAX_DURATION_SECONDS 60.0f
/* Stop fades every sounding voice out over this many samples. */
#define PX_AUDIO_STOP_SAMPLES 64U
/* Music: up to one track per voice, each a sorted list of step notes. */
#define PX_AUDIO_TRACK_NOTES 512U
#define PX_AUDIO_SOUND_NOTES 64U
#define PX_AUDIO_MAX_STEPS 4096U
#define PX_AUDIO_MAX_PITCH 127U
/* Tempo in hundredths of a beat per minute, 20.00 to 400.00. */
#define PX_AUDIO_MIN_CENTI_BPM 2000U
#define PX_AUDIO_MAX_CENTI_BPM 40000U
#define PX_AUDIO_MAX_STEPS_PER_BEAT 16U

typedef enum px_waveform {
    PX_WAVE_SQUARE = 0,
    PX_WAVE_TRIANGLE = 1,
    PX_WAVE_SINE = 2,
    PX_WAVE_NOISE = 3
} px_waveform;

/* Per-note pitch and volume effects. */
typedef enum px_audio_effect {
    PX_EFFECT_NONE = 0,
    PX_EFFECT_SLIDE = 1,   /* Pitch glides to the slide target over the gate. */
    PX_EFFECT_VIBRATO = 2, /* Pitch wobbles half a semitone at 6 Hz. */
    PX_EFFECT_FADEOUT = 3  /* Volume falls linearly to silence over the gate. */
} px_audio_effect;

typedef enum px_envelope_state {
    PX_ENV_IDLE = 0,
    PX_ENV_ATTACK = 1,
    PX_ENV_DECAY = 2,
    PX_ENV_SUSTAIN = 3,
    PX_ENV_RELEASE = 4
} px_envelope_state;

typedef struct px_audio_voice {
    bool active;
    uint8_t waveform;
    uint8_t env_state;
    uint8_t effect;
    /* Who started the current note: 0 none, 1 music, 2 a sound effect. */
    uint8_t owner;
    float frequency;
    float phase;
    float volume;
    float current_gain;
    float sustain_level;
    float slide_ratio;
    uint32_t slide_samples;
    float vibrato_phase;

    /* Sample counters; the gate (duration) ends in any stage before release. */
    uint32_t elapsed_samples;
    uint32_t duration_samples;
    uint32_t attack_samples;
    uint32_t decay_samples;
    uint32_t release_samples;
    uint32_t stage_samples;
    float stage_start_gain;
} px_audio_voice;

/* One note of a sequence: steps are tempo units, pitch is a MIDI note. */
typedef struct px_audio_step_note {
    uint16_t step;
    uint16_t length;
    uint8_t pitch;
    uint8_t volume; /* 0..255 scales the track volume. */
    uint8_t waveform;
    uint8_t effect;
} px_audio_step_note;

typedef struct px_audio_instrument {
    float volume;
    float attack;
    float decay;
    float sustain;
    float release;
} px_audio_instrument;

/* Sample-exact step clock: 16.16 fixed-point frames per step. */
typedef struct px_audio_clock {
    uint64_t frames_per_step;
    uint64_t phase;
    uint32_t step;
    bool trigger; /* The current step's notes start at the next sample. */
} px_audio_clock;

typedef struct px_audio_track {
    px_audio_instrument instrument;
    uint32_t voice;
    uint16_t count;
    uint16_t cursor;
    px_audio_step_note notes[PX_AUDIO_TRACK_NOTES];
} px_audio_track;

/* A multi-note sound effect on one voice. */
typedef struct px_audio_sound {
    px_audio_instrument instrument;
    bool valid;
    bool playing;
    uint16_t count;
    uint16_t cursor;
    uint16_t length;
    px_audio_clock clock;
    px_audio_step_note notes[PX_AUDIO_SOUND_NOTES];
} px_audio_sound;

typedef struct px_audio_music {
    bool valid;
    bool playing;
    bool loop;
    bool ended; /* Set when a non-looping piece finishes; cleared when read. */
    uint32_t track_count;
    uint32_t length;
    px_audio_clock clock;
    px_audio_track tracks[PX_AUDIO_VOICES];
} px_audio_music;

/* Fixed-size state: the DSP never allocates, blocks or calls back. */
typedef struct px_audio_dsp {
    uint32_t sample_rate;
    float master_volume;
    px_audio_voice voices[PX_AUDIO_VOICES];
    uint16_t noise_lfsr;
    px_audio_sound sounds[PX_AUDIO_VOICES];
    px_audio_music music;
} px_audio_dsp;

/* A single note: frequency in Hz; slide_to is the slide target in Hz. */
typedef struct px_audio_note {
    uint8_t waveform;
    uint8_t effect;
    float frequency;
    float slide_to;
    float volume;
    float attack;
    float decay;
    float sustain;
    float release;
    float duration;
} px_audio_note;

/* Initialize DSP state. The sample rate is clamped to the supported range. */
void px_audio_init(px_audio_dsp *dsp, uint32_t sample_rate);

/* Start a note on voice 0..3, or PX_AUDIO_AUTO_VOICE for the first idle voice
 * (stealing the longest-playing one when all are busy). Returns false and
 * changes nothing for an invalid voice, waveform or number: frequency must be
 * positive, volume/sustain within [0, 1], stages within [0, 10] s and the
 * duration within (0, 60] s. */
bool px_audio_note_on(px_audio_dsp *dsp, uint32_t voice_index, uint8_t waveform,
                      float frequency, float volume,
                      float attack_s, float decay_s, float sustain_level,
                      float release_s, float duration_s);

/* As px_audio_note_on, with an effect; a sound effect takes the voice from
 * music until it ends. */
bool px_audio_play_note(px_audio_dsp *dsp, uint32_t voice_index, const px_audio_note *note);

/* Multi-note sound effect on one voice: begin (clears it), add notes in
 * ascending step order, then play. Invalid input leaves nothing playing. */
bool px_audio_sound_begin(px_audio_dsp *dsp, uint32_t voice_index, uint32_t centi_bpm,
                          uint32_t steps_per_beat, const px_audio_instrument *instrument);
bool px_audio_sound_note(px_audio_dsp *dsp, uint32_t voice_index, const px_audio_step_note *note);
bool px_audio_sound_play(px_audio_dsp *dsp, uint32_t voice_index);

/* Music: begin (stops and clears the previous piece), describe each track,
 * add its notes in ascending step order, then play. Tracks use distinct
 * voices. Sound effects on a voice silence its track until they end. */
bool px_audio_music_begin(px_audio_dsp *dsp, uint32_t length_steps, uint32_t centi_bpm,
                          uint32_t steps_per_beat, uint32_t track_count);
bool px_audio_music_track(px_audio_dsp *dsp, uint32_t track, uint32_t voice_index,
                          const px_audio_instrument *instrument);
bool px_audio_music_note(px_audio_dsp *dsp, uint32_t track, const px_audio_step_note *note);
bool px_audio_music_play(px_audio_dsp *dsp, bool loop);
void px_audio_music_stop(px_audio_dsp *dsp);
/* Returns true once after a non-looping piece has played to its end. */
bool px_audio_music_take_ended(px_audio_dsp *dsp);
/* Current step of the playing piece, or UINT32_MAX when none plays. */
uint32_t px_audio_music_step(const px_audio_dsp *dsp);

/* Release a note (transitions an active voice to its release stage). */
void px_audio_note_off(px_audio_dsp *dsp, uint32_t voice_index);

/* Fade every sounding voice out over PX_AUDIO_STOP_SAMPLES and stop music and
 * sound effects. Later notes start independently; they never revive stopped
 * voices. */
void px_audio_stop(px_audio_dsp *dsp);

/* Set master volume [0.0, 1.0]; non-finite values select silence. */
void px_audio_set_master_volume(px_audio_dsp *dsp, float volume);

/* Render mono float audio buffer. Frames can be any size (e.g. 128, 256, etc.).
 * Guarantees all output values are finite and clamped to [-1.0f, +1.0f]. */
void px_audio_render(px_audio_dsp *dsp, float *output, size_t frames);

/* Render the mono mix into one or two channels; right may alias left. */
void px_audio_render_stereo(px_audio_dsp *dsp, float *left, float *right, size_t frames);

/* Check if any or specific voice is active. */
bool px_audio_is_voice_active(const px_audio_dsp *dsp, uint32_t voice_index);
bool px_audio_is_any_voice_active(const px_audio_dsp *dsp);

#endif /* PIXELJS_AUDIO_H */

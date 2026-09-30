// Sound and music editors: exact JSON from edits, project round trips,
// validation, undo, the view-only grid grouping, playback through the real
// AudioWorklet, and exports loaded by an independent engine.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureDownload,
  clickRoll,
  dragRoll,
  openEditor,
  openProjectFile,
  openVerifier,
  publish,
  rollPoint,
  saveProject,
  setField,
  startEditor,
  statusText,
} from './editor-harness.mjs';

let env;
before(async () => {
  env = await startEditor();
});
after(async () => {
  await env?.close();
});

const INSTRUMENT = {
  waveform: 'square',
  volume: 1,
  attack: 0.005,
  decay: 0.01,
  sustain: 0.7,
  release: 0.05,
};
const PALETTE = [
  '#0d111c',
  '#242c42',
  '#474d6f',
  '#79809a',
  '#e7eff6',
  '#fa695d',
  '#f9a75a',
  '#ffdc80',
  '#9fd86b',
  '#38ad87',
  '#32daca',
  '#3f87d4',
  '#795fce',
  '#b676d6',
  '#f0a3c7',
  '#7a5242',
];

/** The editor's documented layout: two-space JSON, scalar-only objects on one line. */
function formatJson(value, indent = '') {
  const scalar = (item) => item === null || typeof item !== 'object';
  if (scalar(value)) return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value))
    return value.length === 0
      ? '[]'
      : `[\n${value.map((item) => inner + formatJson(item, inner)).join(',\n')}\n${indent}]`;
  const entries = Object.entries(value);
  if (entries.every(([, item]) => scalar(item)))
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(', ')} }`;
  return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${formatJson(item, inner)}`).join(',\n')}\n${indent}}`;
}

function audioProject({ sounds = [], music = [] } = {}) {
  return {
    format: 'pixeljs-project',
    version: 1,
    palette: PALETTE,
    sprites: [],
    maps: [],
    sounds,
    music,
  };
}

const zap = {
  name: 'zap',
  waveform: 'triangle',
  frequency: 330,
  volume: 0.5,
  attack: 0.01,
  decay: 0.02,
  sustain: 0.4,
  release: 0.1,
  duration: 0.25,
  effect: 'slide',
  slideTo: 660,
};
const jingle = {
  name: 'jingle',
  ...INSTRUMENT,
  bpm: 150,
  stepsPerBeat: 4,
  notes: [
    { step: 0, length: 2, pitch: 'C5', volume: 1, waveform: 'sine' },
    { step: 4, length: 1, pitch: 'E5', volume: 0.5, effect: 'vibrato' },
    { step: 8, length: 4, pitch: 'C6', volume: 1 },
  ],
};
const theme = {
  name: 'theme',
  bpm: 140,
  stepsPerBeat: 4,
  length: 16,
  loop: false,
  tracks: [
    {
      voice: 0,
      ...INSTRUMENT,
      notes: [
        { step: 0, length: 2, pitch: 'C4', volume: 1 },
        { step: 4, length: 1, pitch: 'E4', volume: 1 },
      ],
    },
    {
      voice: 1,
      ...INSTRUMENT,
      waveform: 'triangle',
      volume: 0.6,
      notes: [{ step: 0, length: 8, pitch: 'C3', volume: 1, effect: 'fadeout' }],
    },
  ],
};

async function openText(page, text) {
  // Cleared first, so a message equal to the previous one is still seen.
  await page.evaluate(() => (document.getElementById('status').textContent = ''));
  await openProjectFile(page, 'audio.pixeljs.json', text);
  await page.waitForFunction(() => document.getElementById('status').textContent !== '');
  return statusText(page);
}

const same = (actual, expected, message) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

test('editing a single-note and a multi-note sound produces the exact expected JSON', async () => {
  const { page, errors } = await openEditor(env);
  await page.click('#tab-sound');
  await setField(page, '#sound-name', 'zap');
  await page.selectOption('#sound-waveform', 'triangle');
  for (const [field, value] of [
    ['frequency', 330],
    ['volume', 0.5],
    ['attack', 0.01],
    ['decay', 0.02],
    ['sustain', 0.4],
    ['release', 0.1],
    ['duration', 0.25],
  ])
    await setField(page, `#sound-${field}`, value);
  await page.selectOption('#sound-effect', 'slide');
  await setField(page, '#sound-slide-to', 660);
  // Out-of-range values are refused and the field restored.
  await setField(page, '#sound-frequency', 30000);
  assert.match(await statusText(page), /up to 24000 Hz/);
  assert.equal(await page.inputValue('#sound-frequency'), '330');

  // A second sound with notes, edited with the mouse and the note fields.
  await page.click('#btn-sound-new');
  await setField(page, '#sound-name', 'jingle');
  await page.selectOption('#sound-mode', 'notes');
  await setField(page, '#sound-bpm', 150);
  await clickRoll(page, 'sound', 4, 76);
  await clickRoll(page, 'sound', 6, 79);
  await dragRoll(page, 'sound', [8, 84], [11, 84]);
  await clickRoll(page, 'sound', 4, 76);
  await setField(page, '#sound-note-volume', 0.5);
  await page.selectOption('#sound-note-effect', 'vibrato');
  await clickRoll(page, 'sound', 0, 72);
  await page.selectOption('#sound-note-waveform', 'sine');
  await page.click('#sound-roll-tools [data-tool="erase"]');
  await clickRoll(page, 'sound', 6, 79);
  const project = await saveProject(page);
  same(project.sounds, [zap, jingle]);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('the piano roll is keyboard operable', async () => {
  const { page, errors } = await openEditor(env);
  await page.click('#tab-sound');
  await page.selectOption('#sound-mode', 'notes');
  await page.focus('#sound-roll');
  // The cursor starts on the first note (C5 at step 0, 2 steps): select it,
  // lengthen it and raise it a semitone.
  await page.keyboard.press('Space');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Alt+ArrowUp');
  // Add a note at step 4 (new notes take the last length, 3).
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  // Step 5 is taken by that note in another pitch: Space selects it, Delete removes it.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('PageDown');
  await page.keyboard.press('Space');
  assert.match(await statusText(page), /Step 5 already plays C5/);
  await page.keyboard.press('Delete');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  const project = await saveProject(page);
  same(project.sounds[0].notes, [
    { step: 0, length: 3, pitch: 'C#5', volume: 1 },
    { step: 6, length: 3, pitch: 'C4', volume: 1 },
  ]);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('editing music produces the exact expected JSON; mute and solo are not saved', async () => {
  const { page, errors } = await openEditor(env);
  await page.click('#tab-music');
  await setField(page, '#music-name', 'theme');
  await setField(page, '#music-bpm', 140);
  await setField(page, '#music-length', 16);
  await page.uncheck('#music-loop');
  // New notes take the last length used, so the single-step note comes first.
  await clickRoll(page, 'music', 4, 64);
  await dragRoll(page, 'music', [0, 60], [1, 60]);
  await page.click('#btn-track-add');
  await page.selectOption('#track-waveform', 'triangle');
  await setField(page, '#track-volume', 0.6);
  await dragRoll(page, 'music', [0, 48], [7, 48]);
  await page.selectOption('#music-note-effect', 'fadeout');
  // Notes cannot start at or after the end of the piece.
  await setField(page, '#music-note-step', 16);
  assert.match(await statusText(page), /before step 16/);
  await page.check('#track-mute');
  await page.check('#track-solo');
  const project = await saveProject(page);
  same(project.music, [theme]);
  // Shortening the piece below a note's start is refused.
  await setField(page, '#music-length', 4);
  assert.match(await statusText(page), /at least 5 steps long/);
  // Two tracks cannot share a voice.
  await page.selectOption('#track-voice', '0');
  assert.match(await statusText(page), /Voice 0 is used by another track/);
  same((await saveProject(page)).music, [theme]);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('changing the grid grouping changes the view and never the data', async () => {
  const { page, errors } = await openEditor(env);
  await page.click('#tab-music');
  await clickRoll(page, 'music', 2, 60);
  await clickRoll(page, 'music', 7, 67);
  const before = await captureDownload(page, () => page.click('#btn-project-save'));
  /** Brightness of the line at a step boundary, in a white-key row near C4. */
  const line = (step) =>
    page.evaluate(
      ({ step }) =>
        new Promise((done) =>
          requestAnimationFrame(() => {
            const canvas = document.getElementById('music-roll');
            const zoom = Number(canvas.dataset.zoom);
            const x = Math.floor(Number(canvas.dataset.originX) + step * zoom);
            const y = Math.floor(Number(canvas.dataset.originY) + (127 - 62) * zoom + zoom / 2);
            const [r, g, b] = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
            done(r + g + b);
          }),
        ),
      { step },
    );
  await rollPoint(page, 'music', 8, 62);
  assert.equal(await page.getAttribute('#music-roll', 'data-grouping'), '8');
  assert.ok((await line(8)) > (await line(6)) + 60, 'with 8, the line at step 8 is strong');
  await page.selectOption('#music-grouping', '6');
  assert.equal(await page.getAttribute('#music-roll', 'data-grouping'), '6');
  assert.ok((await line(6)) > (await line(8)) + 60, 'with 6, the line at step 6 is strong');
  await page.focus('#music-roll');
  await page.keyboard.press('g');
  assert.equal(await page.getAttribute('#music-roll', 'data-grouping'), '8');
  await page.selectOption('#music-grouping', '6');
  const after = await captureDownload(page, () => page.click('#btn-project-save'));
  assert.equal(after.bytes.toString('utf8'), before.bytes.toString('utf8'), 'identical project');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('undo and redo cover note edits', async () => {
  const { page, errors } = await openEditor(env);
  await page.click('#tab-music');
  const notes = async () => (await saveProject(page)).music[0].tracks[0].notes;
  const states = [await notes()];
  await clickRoll(page, 'music', 1, 60);
  states.push(await notes());
  await clickRoll(page, 'music', 4, 64);
  states.push(await notes());
  await dragRoll(page, 'music', [1, 60], [2, 62]);
  states.push(await notes());
  await dragRoll(page, 'music', [4, 64], [6, 64], 0.8);
  states.push(await notes());
  await setField(page, '#music-note-volume', 0.25);
  states.push(await notes());
  // A drag that ends in the note's own cell changes nothing and records nothing.
  const steps = await page.getAttribute('#history-status', 'data-undo');
  await dragRoll(page, 'music', [4, 64], [4, 64]);
  assert.equal(await page.getAttribute('#history-status', 'data-undo'), steps, 'no empty step');
  await page.click('#music-roll-tools [data-tool="erase"]');
  await clickRoll(page, 'music', 2, 62);
  states.push(await notes());
  same(states.at(-1), [{ step: 4, length: 3, pitch: 'E4', volume: 0.25 }]);
  same(states[3], [
    { step: 2, length: 1, pitch: 'D4', volume: 1 },
    { step: 4, length: 1, pitch: 'E4', volume: 1 },
  ]);
  for (let index = states.length - 2; index >= 0; index--) {
    await page.click('#btn-undo');
    same(await notes(), states[index], `undo to state ${index}`);
  }
  await page.click('#btn-redo');
  same(await notes(), states[1], 'redo');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('sound and music entries round-trip exactly through a project file', async () => {
  const { page, errors } = await openEditor(env);
  const project = audioProject({ sounds: [zap, jingle], music: [theme] });
  assert.match(await openText(page, JSON.stringify(project)), /Opened/);
  const saved = await captureDownload(page, () => page.click('#btn-project-save'));
  assert.equal(saved.bytes.toString('utf8'), `${formatJson(project)}\n`);
  // Omitted optional fields take the engine's defaults, written explicitly.
  const short = audioProject({
    sounds: [{ name: 'blip' }, { name: 'tune', notes: [{ step: 3, pitch: 67 }] }],
    music: [{ name: 'loop', bpm: 90, length: 8, tracks: [{ notes: [] }, { notes: [] }] }],
  });
  await openText(page, JSON.stringify(short));
  const filled = await saveProject(page);
  same(filled.sounds, [
    {
      name: 'blip',
      waveform: 'square',
      frequency: 440,
      volume: 1,
      attack: 0.005,
      decay: 0.01,
      sustain: 0.7,
      release: 0.05,
      duration: 0.1,
      effect: 'none',
    },
    {
      name: 'tune',
      ...INSTRUMENT,
      bpm: 120,
      stepsPerBeat: 4,
      notes: [{ step: 3, length: 1, pitch: 'G4', volume: 1 }],
    },
  ]);
  same(filled.music, [
    {
      name: 'loop',
      bpm: 90,
      stepsPerBeat: 4,
      length: 8,
      loop: true,
      tracks: [
        { voice: 0, ...INSTRUMENT, notes: [] },
        { voice: 1, ...INSTRUMENT, notes: [] },
      ],
    },
  ]);
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('malformed sound and music entries are rejected and the open project stays', async () => {
  const { page, errors } = await openEditor(env);
  await openText(page, JSON.stringify(audioProject({ sounds: [zap, jingle], music: [theme] })));
  await page.click('#tab-music');
  await clickRoll(page, 'music', 10, 70);
  const before = await saveProject(page);
  const variants = [];
  const variant = (label, change, pattern) => {
    const project = structuredClone(audioProject({ sounds: [zap, jingle], music: [theme] }));
    change(project);
    variants.push([label, project, pattern]);
  };
  variant('unknown sound field', (p) => (p.sounds[0].pan = 1), /sounds\[0\]: unknown field “pan”/);
  variant('no name', (p) => delete p.sounds[0].name, /sounds\[0\]: missing field “name”/);
  variant('zero frequency', (p) => (p.sounds[0].frequency = 0), /sounds\[0\]\.frequency/);
  variant('high frequency', (p) => (p.sounds[0].frequency = 24001), /sounds\[0\]\.frequency/);
  variant('long duration', (p) => (p.sounds[0].duration = 61), /sounds\[0\]\.duration/);
  variant('loud', (p) => (p.sounds[0].volume = 1.5), /sounds\[0\]\.volume/);
  variant('long attack', (p) => (p.sounds[0].attack = 11), /sounds\[0\]\.attack/);
  variant('saw', (p) => (p.sounds[0].waveform = 'saw'), /sounds\[0\]\.waveform/);
  variant('echo', (p) => (p.sounds[0].effect = 'echo'), /sounds\[0\]\.effect/);
  variant('slide without target', (p) => delete p.sounds[0].slideTo, /needs “slideTo”/);
  variant('target without slide', (p) => (p.sounds[0].effect = 'none'), /slideTo: applies only/);
  variant('tempo on a single note', (p) => (p.sounds[0].bpm = 120), /bpm: applies only/);
  variant(
    'frequency with notes',
    (p) => (p.sounds[1].frequency = 440),
    /frequency: does not apply/,
  );
  variant('no notes', (p) => (p.sounds[1].notes = []), /notes: expected 1–64 entries/);
  variant(
    '65 notes',
    (p) => (p.sounds[1].notes = Array.from({ length: 65 }, (_, step) => ({ step, pitch: 60 }))),
    /notes: expected 1–64 entries/,
  );
  variant('slow', (p) => (p.sounds[1].bpm = 19), /sounds\[1\]\.bpm/);
  variant('fast', (p) => (p.sounds[1].bpm = 401), /sounds\[1\]\.bpm/);
  variant('17 steps per beat', (p) => (p.sounds[1].stepsPerBeat = 17), /stepsPerBeat/);
  variant('step 4096', (p) => (p.sounds[1].notes[0].step = 4096), /notes\[0\]\.step/);
  variant('length 0', (p) => (p.sounds[1].notes[0].length = 0), /notes\[0\]\.length/);
  variant('pitch 128', (p) => (p.sounds[1].notes[0].pitch = 128), /notes\[0\]\.pitch/);
  variant('pitch H4', (p) => (p.sounds[1].notes[0].pitch = 'H4'), /notes\[0\]\.pitch/);
  variant('pitch Cb-1', (p) => (p.sounds[1].notes[0].pitch = 'Cb-1'), /notes\[0\]\.pitch/);
  variant('note field', (p) => (p.sounds[1].notes[0].pan = 0), /unknown field “pan”/);
  variant('duplicate sound', (p) => (p.sounds[1].name = 'ZAP'), /already used/);
  variant(
    '65 sounds',
    (p) => (p.sounds = Array.from({ length: 65 }, (_, i) => ({ ...zap, name: `s${i}` }))),
    /sounds: expected 0–64 entries/,
  );
  variant('no tracks', (p) => (p.music[0].tracks = []), /tracks: expected 1–4 entries/);
  variant(
    'five tracks',
    (p) => (p.music[0].tracks = Array.from({ length: 5 }, () => ({ notes: [] }))),
    /tracks: expected 1–4 entries/,
  );
  variant(
    'shared voice',
    (p) => (p.music[0].tracks[1].voice = 0),
    /voice 0 is used by another track/,
  );
  variant('voice 4', (p) => (p.music[0].tracks[1].voice = 4), /tracks\[1\]\.voice/);
  variant(
    'note past the end',
    (p) => (p.music[0].tracks[0].notes[1].step = 16),
    /notes\[1\]\.step: expected an integer from 0 to 15/,
  );
  variant(
    '513 notes',
    (p) =>
      (p.music[0].tracks[0].notes = Array.from({ length: 513 }, (_, step) => ({
        step: step % 16,
        pitch: 60,
      }))),
    /notes: expected 0–512 entries/,
  );
  variant('long piece', (p) => (p.music[0].length = 4097), /music\[0\]\.length/);
  variant('loop yes', (p) => (p.music[0].loop = 'yes'), /music\[0\]\.loop/);
  variant('no tempo', (p) => delete p.music[0].bpm, /missing field “bpm”/);
  variant(
    '17 pieces',
    (p) => (p.music = Array.from({ length: 17 }, (_, i) => ({ ...theme, name: `m${i}` }))),
    /music: expected 0–16 entries/,
  );
  variant('duplicate piece', (p) => p.music.push({ ...theme, name: 'Theme' }), /already used/);
  for (const [label, project, pattern] of variants) {
    const status = await openText(page, JSON.stringify(project));
    assert.match(status, pattern, label);
    assert.match(status, /The open project is unchanged\.$/, label);
  }
  assert.deepEqual(await saveProject(page), before, 'the open project is intact');
  await page.click('#btn-undo');
  same((await saveProject(page)).music, [theme], 'and so is its history');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('exported sound and music JSON load in an independent engine', async () => {
  const { page, errors } = await openEditor(env);
  await openText(page, JSON.stringify(audioProject({ sounds: [zap, jingle], music: [theme] })));
  await page.click('#tab-export');
  const files = {};
  for (const path of ['assets.json', 'sounds/zap.json', 'sounds/jingle.json', 'music/theme.json']) {
    const file = await captureDownload(page, () => page.click(`[data-download="${path}"]`));
    assert.equal(file.name, path.split('/').pop());
    files[path] = file.bytes;
    await publish(env, `audio/${path}`, file.bytes);
  }
  const manifest = JSON.parse(files['assets.json']);
  assert.deepEqual(manifest.sounds, {
    zap: { src: 'sounds/zap.json' },
    jingle: { src: 'sounds/jingle.json' },
  });
  assert.deepEqual(manifest.music, { theme: { src: 'music/theme.json' } });
  const strip = ({ name: _, ...options }) => options;
  same(JSON.parse(files['sounds/zap.json']), {
    format: 'pixeljs-sound',
    version: 1,
    ...strip(zap),
  });
  same(JSON.parse(files['music/theme.json']), {
    format: 'pixeljs-music',
    version: 1,
    ...strip(theme),
  });
  // The single-sound and single-piece buttons write the same files.
  await page.click('#tab-sound');
  const single = await captureDownload(page, () => page.click('#btn-export-sound'));
  assert.deepEqual(single.bytes, files['sounds/zap.json']);
  await page.click('#tab-music');
  const piece = await captureDownload(page, () => page.click('#btn-export-music'));
  assert.deepEqual(piece.bytes, files['music/theme.json']);

  const verifier = await openVerifier(env);
  const result = await verifier.page.evaluate((request) => window.verify.audio(request), {
    sounds: [
      { src: '/exports/audio/sounds/zap.json', options: strip(zap) },
      { src: '/exports/audio/sounds/jingle.json', options: strip(jingle) },
    ],
    music: [{ src: '/exports/audio/music/theme.json', options: strip(theme) }],
  });
  for (const { loaded, created } of [...result.sounds, ...result.music])
    assert.deepEqual(loaded, created, 'the file and the project data describe the same audio');
  assert.deepEqual(result.sounds[0].loaded, {
    waveform: 'triangle',
    volume: 0.5,
    attack: 0.01,
    decay: 0.02,
    sustain: 0.4,
    release: 0.1,
    frequency: 330,
    duration: 0.25,
    effect: 'slide',
    notes: 0,
  });
  assert.equal(result.sounds[1].loaded.notes, 3);
  assert.deepEqual(result.music[0].loaded, {
    bpm: 140,
    stepsPerBeat: 4,
    length: 16,
    loop: false,
    tracks: 2,
  });
  assert.deepEqual([...errors, ...verifier.errors], []);
  await verifier.page.close();
  await page.context().close();
});

test('playback reaches the real AudioWorklet; a short piece ends by itself; Stop always works', async () => {
  const { page, errors } = await openEditor(env);
  const playing = () => page.getAttribute('#music-transport', 'data-playing');
  // 16 steps at 120 BPM and 16 steps per beat: half a second, not looping.
  const short = { ...theme, name: 'short', bpm: 120, stepsPerBeat: 16 };
  await openText(page, JSON.stringify(audioProject({ sounds: [zap, jingle], music: [short] })));
  await page.click('#tab-music');
  await page.click('#btn-music-play');
  await page.waitForFunction(
    () => document.getElementById('music-transport').dataset.playing === 'true',
  );
  assert.match(await page.textContent('#music-audio-state'), /running/);
  const started = Date.now();
  await page.waitForFunction(
    () => document.getElementById('music-transport').dataset.playing === 'false',
    null,
    { timeout: 5000 },
  );
  assert.ok(Date.now() - started < 5000, 'the audio thread reported the end of the piece');
  assert.equal(await page.textContent('#music-transport'), 'Stopped');

  // A looping piece keeps playing until Stop, even after repeated Play clicks.
  await page.uncheck('#music-loop');
  await page.check('#music-loop');
  for (let press = 0; press < 12; press++) await page.click('#btn-music-play');
  await page.waitForFunction(
    () => document.getElementById('music-transport').dataset.playing === 'true',
  );
  await page.waitForTimeout(900);
  assert.equal(await playing(), 'true', 'a looping piece is still playing');
  await page.click('#btn-music-stop');
  assert.equal(await playing(), 'false');
  await page.waitForTimeout(200);
  assert.equal(await playing(), 'false', 'stopped for good');

  // Sounds preview through the same engine; Escape stops everything.
  await page.click('#tab-sound');
  for (let press = 0; press < 12; press++) await page.click('#btn-sound-play');
  assert.match(await statusText(page), /Playing “zap”/);
  await page.click('#tab-music');
  await page.click('#btn-music-play');
  await page.waitForFunction(
    () => document.getElementById('music-transport').dataset.playing === 'true',
  );
  await page.keyboard.press('Escape');
  assert.equal(await playing(), 'false');
  assert.deepEqual(errors, []);
  await page.context().close();
});

test('the audio editors are named and keyboard reachable', async () => {
  const { page, errors } = await openEditor(env);
  for (const tab of ['sound', 'music']) {
    await page.click(`#tab-${tab}`);
    if (tab === 'sound') await page.selectOption('#sound-mode', 'notes');
    const unnamed = await page.evaluate(() => {
      const name = (element) => {
        const label = element.getAttribute('aria-label');
        if (label) return label;
        const by = element.getAttribute('aria-labelledby');
        if (by)
          return by
            .split(' ')
            .map((id) => document.getElementById(id)?.textContent)
            .join(' ');
        if (element.labels?.length) return element.labels[0].textContent;
        return element.textContent || element.title;
      };
      return Array.from(document.querySelectorAll('button, input, select, canvas[tabindex]'))
        .filter((element) => element.getClientRects().length > 0)
        .filter((element) => !name(element)?.trim())
        .map((element) => element.outerHTML.slice(0, 80));
    });
    assert.deepEqual(unnamed, [], `${tab}: every control has a name`);
    const reached = new Set();
    await page.focus(`#tab-${tab}`);
    for (let press = 0; press < 70; press++) {
      await page.keyboard.press('Tab');
      reached.add(await page.evaluate(() => document.activeElement.id));
    }
    for (const id of [`${tab}-list`, `${tab}-roll`, `btn-${tab}-play`, `${tab}-grouping`])
      assert.ok(reached.has(id), `${id} is reachable with Tab`);
  }
  assert.deepEqual(errors, []);
  await page.context().close();
});

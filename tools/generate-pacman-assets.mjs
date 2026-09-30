import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { DIRECTIONS, MAZE, MAZE_COLUMNS, MAZE_ROWS } from '../examples/javascript/pacman-model.js';

// Writes the example game's original assets: images as PNG, the maze as a
// tilemap, the HUD font, sounds and music as JSON, and the manifest that
// loadAssets() reads. Everything is drawn or composed here; nothing comes
// from another game. `--check` fails when the committed files differ.

const directory = new URL('../examples/javascript/assets/', import.meta.url);
const PALETTE = [
  [13, 17, 28],
  [36, 44, 66],
  [71, 77, 111],
  [121, 128, 154],
  [231, 239, 246],
  [250, 105, 93],
  [249, 167, 90],
  [255, 220, 128],
  [159, 216, 107],
  [56, 173, 135],
  [50, 218, 202],
  [63, 135, 212],
  [121, 95, 206],
  [182, 118, 214],
  [240, 163, 199],
  [122, 82, 66],
];

/** RGBA PNG from palette indices; `transparent` becomes alpha 0. */
function png(width, height, indices, transparent) {
  const chunk = (type, data) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length, 0);
    header.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
    return Buffer.concat([header, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const index = indices[y * width + x];
      const [red, green, blue] = PALETTE[index];
      rows.set([red, green, blue, index === transparent ? 0 : 255], row + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Wall tiles: tile N is a wall whose open sides are the bits of N
// (1 up, 2 right, 4 down, 8 left), each drawn as a highlight edge.
const OPEN = { up: 1, right: 2, down: 4, left: 8 };
function tileset() {
  const width = 16 * 8;
  const pixels = new Uint8Array(width * 8).fill(1);
  for (let tile = 0; tile < 16; tile++) {
    const set = (x, y) => (pixels[y * width + tile * 8 + x] = 11);
    for (let i = 0; i < 8; i++) {
      if (tile & OPEN.up) set(i, 0);
      if (tile & OPEN.down) set(i, 7);
      if (tile & OPEN.left) set(0, i);
      if (tile & OPEN.right) set(7, i);
    }
  }
  return { width, height: 8, pixels };
}

function mazeTiles() {
  const open = (row, column) =>
    row >= 0 && row < MAZE_ROWS && column >= 0 && column < MAZE_COLUMNS
      ? MAZE[row][column] !== '#'
      : false;
  const tiles = [];
  for (let row = 0; row < MAZE_ROWS; row++)
    for (let column = 0; column < MAZE_COLUMNS; column++) {
      if (MAZE[row][column] !== '#') {
        tiles.push(65535);
        continue;
      }
      tiles.push(
        (open(row - 1, column) ? OPEN.up : 0) |
          (open(row, column + 1) ? OPEN.right : 0) |
          (open(row + 1, column) ? OPEN.down : 0) |
          (open(row, column - 1) ? OPEN.left : 0),
      );
    }
  return tiles;
}

/** Four directions (rows) of three mouth frames (columns), 7 × 7 each. */
function playerAtlas() {
  const width = 21;
  const height = 28;
  const pixels = new Uint8Array(width * height);
  const names = Object.keys(DIRECTIONS);
  for (let direction = 0; direction < 4; direction++) {
    const vector = DIRECTIONS[names[direction]];
    for (let frame = 0; frame < 3; frame++)
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 7; x++) {
          const dx = x - 3;
          const dy = y - 3;
          if (dx * dx + dy * dy > 11) continue;
          const forward = dx * vector.x + dy * vector.y;
          const sideways = Math.abs(dx * vector.y - dy * vector.x);
          if (frame > 0 && forward > 0 && sideways <= forward * (frame === 1 ? 0.4 : 0.9)) continue;
          pixels[(direction * 7 + y) * width + frame * 7 + x] = 7;
        }
  }
  return { width, height, pixels };
}

/** Six body colors (four ghosts, frightened, flashing) of two frames. */
function ghostAtlas() {
  const width = 14;
  const height = 42;
  const pixels = new Uint8Array(width * height);
  const colors = [5, 14, 10, 6, 11, 4];
  const rows = ['0011100', '0111110', '1111111', '1111111', '1111111', '1111111'];
  for (let kind = 0; kind < colors.length; kind++)
    for (let frame = 0; frame < 2; frame++) {
      const pattern = [...rows, frame === 0 ? '1101011' : '1011101'];
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 7; x++)
          if (pattern[y][x] === '1') pixels[(kind * 7 + y) * width + frame * 7 + x] = colors[kind];
    }
  return { width, height, pixels };
}

// Original 3 × 5 HUD glyphs; each gets one blank column of spacing.
const GLYPHS = {
  0: '111101101101111',
  1: '010110010010111',
  2: '110001010100111',
  3: '110001010001110',
  4: '101101111001001',
  5: '111100110001110',
  6: '011100111101111',
  7: '111001010010010',
  8: '111101111101111',
  9: '111101111001110',
  A: '010101111101101',
  B: '110101110101110',
  C: '011100100100011',
  D: '110101101101110',
  E: '111100110100111',
  F: '111100110100100',
  G: '011100101101011',
  H: '101101111101101',
  I: '111010010010111',
  J: '001001001101010',
  K: '101101110101101',
  L: '100100100100111',
  M: '101111111101101',
  N: '101111111111101',
  O: '010101101101010',
  P: '110101110100100',
  Q: '010101101111011',
  R: '110101110101101',
  S: '011100010001110',
  T: '111010010010010',
  U: '101101101101111',
  V: '101101101101010',
  W: '101101111111101',
  X: '101101010101101',
  Y: '101101010010010',
  Z: '111001010100111',
  '!': '010010010000010',
  '/': '001001010100100',
  '-': '000000111000000',
};
function font() {
  const glyphs = [];
  for (let code = 32; code <= 90; code++) {
    const pattern = GLYPHS[String.fromCharCode(code)] ?? '000000000000000';
    const rows = [];
    for (let y = 0; y < 5; y++)
      rows.push(
        `${[...pattern.slice(y * 3, y * 3 + 3)].map((bit) => (bit === '1' ? '#' : '.')).join('')}.`,
      );
    glyphs.push(rows);
  }
  return {
    format: 'pixeljs-font',
    version: 1,
    glyphWidth: 4,
    glyphHeight: 5,
    firstChar: 32,
    charCount: glyphs.length,
    fallbackChar: 32,
    glyphs,
  };
}

const note = (options) => ({ format: 'pixeljs-sound', version: 1, ...options });
const SOUNDS = {
  'waka-a': note({
    waveform: 'triangle',
    frequency: 440,
    volume: 0.25,
    attack: 0.005,
    decay: 0.02,
    sustain: 0.1,
    release: 0.02,
    duration: 0.045,
  }),
  'waka-b': note({
    waveform: 'triangle',
    frequency: 520,
    volume: 0.25,
    attack: 0.005,
    decay: 0.02,
    sustain: 0.1,
    release: 0.02,
    duration: 0.045,
  }),
  power: note({
    waveform: 'square',
    frequency: 330,
    effect: 'slide',
    slideTo: 165,
    volume: 0.3,
    attack: 0.01,
    decay: 0.05,
    sustain: 0.6,
    release: 0.08,
    duration: 0.3,
  }),
  ghost: note({
    waveform: 'sine',
    frequency: 440,
    effect: 'slide',
    slideTo: 1320,
    volume: 0.4,
    attack: 0.005,
    decay: 0.03,
    sustain: 0.8,
    release: 0.06,
    duration: 0.2,
  }),
  // Descending steps that each slide into the next, then a fading low note.
  death: note({
    waveform: 'square',
    bpm: 300,
    stepsPerBeat: 4,
    volume: 0.3,
    attack: 0.005,
    decay: 0.02,
    sustain: 0.7,
    release: 0.05,
    notes: [
      { step: 0, length: 2, pitch: 'B5', effect: 'slide' },
      { step: 2, length: 2, pitch: 'G5', effect: 'slide' },
      { step: 4, length: 2, pitch: 'E5', effect: 'slide' },
      { step: 6, length: 2, pitch: 'C5', effect: 'slide' },
      { step: 8, length: 2, pitch: 'A4', effect: 'slide' },
      { step: 10, length: 2, pitch: 'F4', effect: 'slide' },
      { step: 12, length: 6, pitch: 'D4', effect: 'fadeout' },
    ],
  }),
  level: note({
    waveform: 'square',
    bpm: 280,
    stepsPerBeat: 4,
    volume: 0.3,
    attack: 0.005,
    decay: 0.03,
    sustain: 0.6,
    release: 0.08,
    notes: [
      { step: 0, pitch: 'C5' },
      { step: 1, pitch: 'E5' },
      { step: 2, pitch: 'G5' },
      { step: 3, pitch: 'C6', length: 3, effect: 'vibrato' },
      { step: 7, pitch: 'A5' },
      { step: 8, pitch: 'C6', length: 4, effect: 'fadeout' },
    ],
  }),
  start: note({
    waveform: 'triangle',
    bpm: 200,
    stepsPerBeat: 4,
    volume: 0.35,
    attack: 0.005,
    decay: 0.02,
    sustain: 0.7,
    release: 0.05,
    notes: [
      { step: 0, pitch: 'E5', length: 2 },
      { step: 2, pitch: 'G5', length: 2 },
      { step: 4, pitch: 'D5', length: 2 },
      { step: 6, pitch: 'F5', length: 2 },
      { step: 8, pitch: 'C5', length: 2 },
      { step: 10, pitch: 'E5', length: 2 },
      { step: 12, pitch: 'G5', length: 4, effect: 'vibrato' },
    ],
  }),
};

// A two-track loop while the chase runs: a gliding siren over a soft pulse.
const SIREN = {
  format: 'pixeljs-music',
  version: 1,
  bpm: 150,
  stepsPerBeat: 4,
  length: 16,
  loop: true,
  tracks: [
    {
      voice: 2,
      waveform: 'sine',
      volume: 0.18,
      attack: 0.01,
      decay: 0.01,
      sustain: 1,
      release: 0.02,
      notes: [
        { step: 0, length: 8, pitch: 'F5', effect: 'slide' },
        { step: 8, length: 8, pitch: 'B5', effect: 'slide' },
        { step: 15, length: 1, pitch: 'F5' },
      ],
    },
    {
      voice: 3,
      waveform: 'triangle',
      volume: 0.2,
      attack: 0.005,
      decay: 0.05,
      sustain: 0.3,
      release: 0.05,
      notes: [0, 4, 8, 12].map((step) => ({
        step,
        length: 2,
        pitch: step % 8 === 0 ? 'C3' : 'G2',
      })),
    },
  ],
};

// While the ghosts are frightened: quick rising sweeps that replace the siren.
const FRIGHT = {
  format: 'pixeljs-music',
  version: 1,
  bpm: 150,
  stepsPerBeat: 4,
  length: 4,
  loop: true,
  tracks: [
    {
      voice: 2,
      waveform: 'square',
      volume: 0.12,
      attack: 0.005,
      decay: 0.02,
      sustain: 0.8,
      release: 0.02,
      notes: [
        { step: 0, length: 3, pitch: 'D4', effect: 'slide' },
        { step: 3, length: 1, pitch: 'D5' },
      ],
    },
  ],
};

const MANIFEST = {
  format: 'pixeljs-assets',
  version: 1,
  images: {
    tiles: { src: 'tiles.png' },
    player: { src: 'player.png', transparentIndex: 0 },
    ghosts: { src: 'ghosts.png', transparentIndex: 0 },
  },
  tilemaps: { maze: { src: 'maze.json', tileset: 'tiles' } },
  fonts: { arcade: { src: 'arcade-font.json' } },
  sounds: Object.fromEntries(Object.keys(SOUNDS).map((id) => [id, { src: `sounds/${id}.json` }])),
  music: { siren: { src: 'siren.json' }, fright: { src: 'fright.json' } },
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const tiles = tileset();
const player = playerAtlas();
const ghosts = ghostAtlas();
const files = {
  'assets.json': json(MANIFEST),
  'tiles.png': png(tiles.width, tiles.height, tiles.pixels, -1),
  'player.png': png(player.width, player.height, player.pixels, 0),
  'ghosts.png': png(ghosts.width, ghosts.height, ghosts.pixels, 0),
  'maze.json': json({
    cols: MAZE_COLUMNS,
    rows: MAZE_ROWS,
    tileWidth: 8,
    tileHeight: 8,
    tiles: mazeTiles(),
  }),
  'arcade-font.json': json(font()),
  'siren.json': json(SIREN),
  'fright.json': json(FRIGHT),
  ...Object.fromEntries(
    Object.entries(SOUNDS).map(([id, sound]) => [`sounds/${id}.json`, json(sound)]),
  ),
};

const check = process.argv.includes('--check');
await mkdir(new URL('sounds/', directory), { recursive: true });
for (const [name, contents] of Object.entries(files)) {
  const url = new URL(name, directory);
  if (check) {
    const actual = await readFile(url).catch(() => Buffer.alloc(0));
    if (!actual.equals(Buffer.from(contents)))
      throw new Error(`Generated example asset differs: examples/javascript/assets/${name}`);
  } else await writeFile(url, contents);
}
console.log(
  check
    ? 'Example game assets match their generator.'
    : `Example game assets generated (${Object.keys(files).length} files).`,
);

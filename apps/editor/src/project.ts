import { EMPTY_TILE } from '@pixeljs/core';
import {
  MAX_MAPS,
  MAX_MAP_SIDE,
  MAX_NAME_LENGTH,
  MAX_PALETTE_COLORS,
  MAX_PROJECT_BYTES,
  MAX_SPRITES,
  MAX_SPRITE_SIDE,
  MAX_TILE_SIDE,
  MAX_TOTAL_MAP_CELLS,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  formatBytes,
} from './limits.js';
import { DEFAULT_PALETTE, formatHex, parseHex } from './palette.js';
import {
  AUDIO_LIMITS,
  createMusic,
  createSound,
  musicOptions,
  parseMusic,
  parseSound,
  soundOptions,
  type Music,
  type Sound,
} from './audio-model.js';
import { fail, formatJson, has, int, list, record, type Json } from './json.js';

export { ProjectError } from './json.js';

/** An indexed image owned by the editor. `uid` is identity only, never saved. */
export interface Sprite {
  readonly uid: number;
  name: string;
  width: number;
  height: number;
  transparentIndex: number | null;
  pixels: Uint8Array;
}

/** A tile map; `tileset` is a live reference, saved as the sprite's name. */
export interface TileMap {
  readonly uid: number;
  name: string;
  tileset: Sprite;
  tileWidth: number;
  tileHeight: number;
  cols: number;
  rows: number;
  tiles: Uint16Array;
}

export interface Project {
  /** 1–256 opaque colors, packed 0xRRGGBB. */
  palette: number[];
  sprites: Sprite[];
  maps: TileMap[];
  /** Named SoundOptions: single notes and multi-note jingles. */
  sounds: Sound[];
  /** Named MusicOptions: up to four tracks each. */
  music: Music[];
}

let nextUid = 1;

export function createSprite(
  name: string,
  width: number,
  height: number,
  transparentIndex: number | null,
  pixels?: Uint8Array,
): Sprite {
  const data = pixels ?? new Uint8Array(width * height);
  if (!pixels && transparentIndex !== null) data.fill(transparentIndex);
  return { uid: nextUid++, name, width, height, transparentIndex, pixels: data };
}

export function createMap(
  name: string,
  tileset: Sprite,
  tileWidth: number,
  tileHeight: number,
  cols: number,
  rows: number,
  tiles?: Uint16Array,
): TileMap {
  const data = tiles ?? new Uint16Array(cols * rows).fill(EMPTY_TILE);
  return { uid: nextUid++, name, tileset, tileWidth, tileHeight, cols, rows, tiles: data };
}

export function createDefaultProject(): Project {
  const sprite = createSprite('sprite1', 16, 16, 0);
  return {
    palette: [...DEFAULT_PALETTE],
    sprites: [sprite],
    maps: [createMap('map1', sprite, 8, 8, 16, 16)],
    sounds: [createSound('sound1')],
    music: [createMusic('music1')],
  };
}

/** The background index an eraser, cut or move leaves behind. */
export function backgroundIndex(sprite: Sprite): number {
  return sprite.transparentIndex ?? 0;
}

/** Whole tiles in a tileset, numbered left to right, top to bottom (EMPTY_TILE excluded). */
export function tileCount(tileset: Sprite, tileWidth: number, tileHeight: number): number {
  const count = Math.floor(tileset.width / tileWidth) * Math.floor(tileset.height / tileHeight);
  return Math.min(count, EMPTY_TILE);
}

export function tilesPerRow(map: Pick<TileMap, 'tileset' | 'tileWidth'>): number {
  return Math.floor(map.tileset.width / map.tileWidth);
}

/** Highest tile ID placed in the map, or -1 when every cell is empty. */
export function highestTile(map: TileMap): number {
  let highest = -1;
  for (const tile of map.tiles) if (tile !== EMPTY_TILE && tile > highest) highest = tile;
  return highest;
}

/** Highest palette index used by any sprite pixel or transparent index. */
export function highestUsedIndex(project: Project): number {
  let highest = 0;
  for (const sprite of project.sprites) {
    if (sprite.transparentIndex !== null && sprite.transparentIndex > highest)
      highest = sprite.transparentIndex;
    for (const index of sprite.pixels) if (index > highest) highest = index;
  }
  return highest;
}

export function totalMapCells(project: Project, except?: TileMap): number {
  let total = 0;
  for (const map of project.maps) if (map !== except) total += map.cols * map.rows;
  return total;
}

const RESERVED_FILE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Names become file names (`images/<name>.png`) and manifest keys, so they are
 * short, portable and unique ignoring case. Returns an error message or null.
 */
export function nameProblem(name: string, taken: readonly string[]): string | null {
  if (!new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${MAX_NAME_LENGTH - 1}}$`).test(name))
    return `Names use 1–${MAX_NAME_LENGTH} letters, digits, “-” or “_”, starting with a letter or digit.`;
  // Manifest keys may not be __proto__, constructor or prototype.
  if (name in Object.prototype || name === 'prototype' || RESERVED_FILE_NAMES.test(name))
    return `“${name}” is reserved; choose another name.`;
  const lower = name.toLowerCase();
  if (taken.some((other) => other.toLowerCase() === lower))
    return `The name “${name}” is already used (names are compared ignoring case).`;
  return null;
}

/** First free name of the form `<prefix><n>`. */
export function freeName(prefix: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) if (!lower.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

// ---------------------------------------------------------------------------
// Project file: validation before anything replaces the open project.

const HEX_VALUES = new Int8Array(128).fill(-1);
for (let digit = 0; digit < 16; digit++) {
  const text = digit.toString(16);
  HEX_VALUES[text.charCodeAt(0)] = digit;
  HEX_VALUES[text.toUpperCase().charCodeAt(0)] = digit;
}

/** Decodes rows of fixed-width hex cells, checking every value against `limit`. */
function hexRows(
  value: unknown,
  path: string,
  cols: number,
  rows: number,
  digits: number,
  target: Uint8Array | Uint16Array,
  accept: (cell: number) => boolean,
  describe: string,
): void {
  const lines = list(value, path, rows, rows);
  lines.forEach((line, row) => {
    const rowPath = `${path}[${row}]`;
    if (typeof line !== 'string' || line.length !== cols * digits)
      fail(rowPath, `expected a string of ${cols * digits} hex digits.`);
    for (let col = 0; col < cols; col++) {
      let cell = 0;
      for (let digit = 0; digit < digits; digit++) {
        const code = line.charCodeAt(col * digits + digit);
        const nibble = code < 128 ? HEX_VALUES[code]! : -1;
        if (nibble < 0) fail(rowPath, `invalid hex digit at column ${col}.`);
        cell = (cell << 4) | nibble;
      }
      if (!accept(cell)) fail(rowPath, `column ${col} holds ${cell}, ${describe}.`);
      target[row * cols + col] = cell;
    }
  });
}

function encodeRows(cells: Uint8Array | Uint16Array, cols: number, digits: number): string[] {
  const rows: string[] = [];
  for (let start = 0; start < cells.length; start += cols) {
    let line = '';
    for (let col = 0; col < cols; col++)
      line += cells[start + col]!.toString(16).padStart(digits, '0');
    rows.push(line);
  }
  return rows;
}

/**
 * Parses and validates a whole project file. Throws ProjectError with the
 * path of the first problem; returns a new project only when all of it is valid.
 */
export function parseProject(text: string): Project {
  if (text.length > MAX_PROJECT_BYTES)
    fail('', `Project files are limited to ${formatBytes(MAX_PROJECT_BYTES)}.`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    fail('', `The file is not valid JSON (${(error as Error).message}).`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    fail('', 'This file is not a PixelJS project.');
  const top = data as Json;
  if (top['format'] !== PROJECT_FORMAT)
    fail('', `This file is not a PixelJS project (expected "format": "${PROJECT_FORMAT}").`);
  const version = top['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    fail('version', 'expected a positive integer.');
  if (version > PROJECT_VERSION)
    fail(
      '',
      `This project uses format version ${version}, but this editor reads version ${PROJECT_VERSION}. Open it with a newer PixelJS Studio.`,
    );
  record(top, '', ['format', 'version', 'palette', 'sprites', 'maps', 'sounds'], ['music']);

  const palette = list(top['palette'], 'palette', 1, MAX_PALETTE_COLORS).map((entry, index) => {
    const color =
      typeof entry === 'string' && /^#[0-9a-f]{6}$/i.test(entry) ? parseHex(entry) : null;
    if (color === null) fail(`palette[${index}]`, 'expected a color like "#1a2b3c".');
    return color;
  });
  const colors = palette.length;

  const sprites: Sprite[] = [];
  list(top['sprites'], 'sprites', 0, MAX_SPRITES).forEach((entry, index) => {
    const path = `sprites[${index}]`;
    const fields = record(entry, path, ['name', 'width', 'height', 'pixels'], ['transparentIndex']);
    const name = fields['name'];
    if (typeof name !== 'string') fail(`${path}.name`, 'expected a string.');
    const problem = nameProblem(
      name,
      sprites.map((sprite) => sprite.name),
    );
    if (problem) fail(`${path}.name`, problem);
    const width = int(fields['width'], `${path}.width`, 1, MAX_SPRITE_SIDE);
    const height = int(fields['height'], `${path}.height`, 1, MAX_SPRITE_SIDE);
    const transparentIndex = has(fields, 'transparentIndex')
      ? int(fields['transparentIndex'], `${path}.transparentIndex`, 0, colors - 1)
      : null;
    const pixels = new Uint8Array(width * height);
    hexRows(
      fields['pixels'],
      `${path}.pixels`,
      width,
      height,
      2,
      pixels,
      (cell) => cell < colors,
      `but the palette has ${colors} colors`,
    );
    sprites.push(createSprite(name, width, height, transparentIndex, pixels));
  });

  const maps: TileMap[] = [];
  let cells = 0;
  list(top['maps'], 'maps', 0, MAX_MAPS).forEach((entry, index) => {
    const path = `maps[${index}]`;
    const fields = record(entry, path, [
      'name',
      'tileset',
      'tileWidth',
      'tileHeight',
      'cols',
      'rows',
      'tiles',
    ]);
    const name = fields['name'];
    if (typeof name !== 'string') fail(`${path}.name`, 'expected a string.');
    const problem = nameProblem(
      name,
      maps.map((map) => map.name),
    );
    if (problem) fail(`${path}.name`, problem);
    const tileset = sprites.find((sprite) => sprite.name === fields['tileset']);
    if (!tileset) fail(`${path}.tileset`, 'expected the name of a sprite in this project.');
    const tileWidth = int(fields['tileWidth'], `${path}.tileWidth`, 1, MAX_TILE_SIDE);
    const tileHeight = int(fields['tileHeight'], `${path}.tileHeight`, 1, MAX_TILE_SIDE);
    if (tileWidth > tileset.width || tileHeight > tileset.height)
      fail(
        path,
        `the tileset “${tileset.name}” is smaller than one ${tileWidth} × ${tileHeight} tile.`,
      );
    const cols = int(fields['cols'], `${path}.cols`, 1, MAX_MAP_SIDE);
    const rows = int(fields['rows'], `${path}.rows`, 1, MAX_MAP_SIDE);
    cells += cols * rows;
    if (cells > MAX_TOTAL_MAP_CELLS)
      fail(path, `maps may hold at most ${MAX_TOTAL_MAP_CELLS} cells in total.`);
    const tiles = new Uint16Array(cols * rows);
    const count = tileCount(tileset, tileWidth, tileHeight);
    hexRows(
      fields['tiles'],
      `${path}.tiles`,
      cols,
      rows,
      4,
      tiles,
      (cell) => cell < count || cell === EMPTY_TILE,
      `but the tileset has ${count} tiles (ffff marks an empty cell)`,
    );
    maps.push(createMap(name, tileset, tileWidth, tileHeight, cols, rows, tiles));
  });

  const sounds: Sound[] = [];
  list(top['sounds'], 'sounds', 0, AUDIO_LIMITS.sounds).forEach((entry, index) => {
    const path = `sounds[${index}]`;
    const sound = parseSound(entry, path);
    const problem = nameProblem(
      sound.name,
      sounds.map((other) => other.name),
    );
    if (problem) fail(`${path}.name`, problem);
    sounds.push(sound);
  });
  // `music` arrived after the first version 1 files; a missing list is empty.
  const music: Music[] = [];
  const pieces = has(top, 'music') ? top['music'] : [];
  list(pieces, 'music', 0, AUDIO_LIMITS.music).forEach((entry, index) => {
    const path = `music[${index}]`;
    const piece = parseMusic(entry, path);
    const problem = nameProblem(
      piece.name,
      music.map((other) => other.name),
    );
    if (problem) fail(`${path}.name`, problem);
    music.push(piece);
  });
  return { palette, sprites, maps, sounds, music };
}

/** Serializes the project in the version 1 format (see apps/editor/README.md). */
export function serializeProject(project: Project): string {
  return formatJson({
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    palette: project.palette.map(formatHex),
    sprites: project.sprites.map((sprite) => ({
      name: sprite.name,
      width: sprite.width,
      height: sprite.height,
      ...(sprite.transparentIndex === null ? {} : { transparentIndex: sprite.transparentIndex }),
      pixels: encodeRows(sprite.pixels, sprite.width, 2),
    })),
    maps: project.maps.map((map) => ({
      name: map.name,
      tileset: map.tileset.name,
      tileWidth: map.tileWidth,
      tileHeight: map.tileHeight,
      cols: map.cols,
      rows: map.rows,
      tiles: encodeRows(map.tiles, map.cols, 4),
    })),
    sounds: project.sounds.map((sound) => ({ name: sound.name, ...soundOptions(sound) })),
    music: project.music.map((piece) => ({ name: piece.name, ...musicOptions(piece) })),
  });
}

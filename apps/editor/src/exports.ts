import { musicOptions, soundOptions, type Music, type Sound } from './audio-model.js';
import { formatJson } from './json.js';
import { ASSETS_FORMAT, ASSETS_VERSION } from './limits.js';
import { duplicateColors, nearestIndex, paletteRgba } from './palette.js';
import { encodeIndexedPng } from './png.js';
import type { Project, Sprite, TileMap } from './project.js';

/** JSON with a numeric array written one row per line. */
function withRows(
  fields: Array<[string, number]>,
  arrayKey: string,
  values: ArrayLike<number>,
  cols: number,
): string {
  const lines: string[] = [];
  for (let start = 0; start < values.length; start += cols) {
    const row: number[] = [];
    for (let col = 0; col < cols; col++) row.push(values[start + col]!);
    lines.push(`    ${row.join(',')}`);
  }
  const head = fields.map(([key, value]) => `  ${JSON.stringify(key)}: ${value},`).join('\n');
  return `{\n${head}\n  ${JSON.stringify(arrayKey)}: [\n${lines.join(',\n')}\n  ]\n}\n`;
}

/** `{ width, height, transparentIndex?, pixels }`, the JSON image `engine.loadImage` reads. */
export function imageJson(sprite: Sprite): string {
  const fields: Array<[string, number]> = [
    ['width', sprite.width],
    ['height', sprite.height],
  ];
  if (sprite.transparentIndex !== null) fields.push(['transparentIndex', sprite.transparentIndex]);
  return withRows(fields, 'pixels', sprite.pixels, sprite.width);
}

/** `{ cols, rows, tileWidth, tileHeight, tiles }`, the JSON `engine.loadTilemap` reads. */
export function tilemapJson(map: TileMap): string {
  return withRows(
    [
      ['cols', map.cols],
      ['rows', map.rows],
      ['tileWidth', map.tileWidth],
      ['tileHeight', map.tileHeight],
    ],
    'tiles',
    map.tiles,
    map.cols,
  );
}

export function spritePng(sprite: Sprite, palette: readonly number[]): Promise<Blob> {
  return encodeIndexedPng(
    sprite.width,
    sprite.height,
    sprite.pixels,
    palette,
    sprite.transparentIndex,
  );
}

/** The `pixeljs-assets` version 1 manifest listing every sprite PNG and map. */
export function assetsManifest(project: Project): string {
  const images: Record<string, { src: string; transparentIndex?: number }> = {};
  for (const sprite of project.sprites)
    images[sprite.name] = {
      src: `images/${sprite.name}.png`,
      ...(sprite.transparentIndex === null ? {} : { transparentIndex: sprite.transparentIndex }),
    };
  const tilemaps: Record<string, { src: string; tileset: string }> = {};
  for (const map of project.maps)
    tilemaps[map.name] = { src: `maps/${map.name}.json`, tileset: map.tileset.name };
  const sounds: Record<string, { src: string }> = {};
  for (const sound of project.sounds) sounds[sound.name] = { src: `sounds/${sound.name}.json` };
  const music: Record<string, { src: string }> = {};
  for (const piece of project.music) music[piece.name] = { src: `music/${piece.name}.json` };
  return formatJson({
    format: ASSETS_FORMAT,
    version: ASSETS_VERSION,
    images,
    tilemaps,
    sounds,
    music,
  });
}

/** The `pixeljs-sound` version 1 file read by `audio.loadSound`. */
export function soundFile(sound: Sound): string {
  return formatJson({ format: 'pixeljs-sound', version: 1, ...soundOptions(sound) });
}

/** The `pixeljs-music` version 1 file read by `audio.loadMusic`. */
export function musicFile(music: Music): string {
  return formatJson({ format: 'pixeljs-music', version: 1, ...musicOptions(music) });
}

/** The flat opaque RGBA array accepted by `createEngine({ palette })`. */
export function paletteJson(project: Project): string {
  return `${JSON.stringify(paletteRgba(project.palette))}\n`;
}

/**
 * Sprites whose PNG would not load back with the same indices: PNG pixels
 * carry colors, and the engine maps a color that repeats an earlier palette
 * entry to that lower index. Returns the first such color per sprite.
 */
export function ambiguousPngs(
  project: Project,
): Array<{ sprite: Sprite; index: number; loadsAs: number }> {
  const found: Array<{ sprite: Sprite; index: number; loadsAs: number }> = [];
  if (duplicateColors(project.palette).length === 0) return found;
  for (const sprite of project.sprites) {
    const used = new Uint8Array(project.palette.length);
    for (const index of sprite.pixels) used[index] = 1;
    for (let index = 0; index < used.length; index++) {
      if (!used[index] || index === sprite.transparentIndex) continue;
      const loadsAs = nearestIndex(
        project.palette,
        project.palette[index]!,
        sprite.transparentIndex,
      );
      if (loadsAs !== index) {
        found.push({ sprite, index, loadsAs });
        break;
      }
    }
  }
  return found;
}

export interface ExportFile {
  /** Path inside the exported asset folder, e.g. `images/hero.png`. */
  path: string;
  description: string;
  build(): Promise<Blob>;
}

const json = (text: string): Blob => new Blob([text], { type: 'application/json' });
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function exportFiles(project: Project): ExportFile[] {
  const files: ExportFile[] = [
    {
      path: 'assets.json',
      description: `Manifest: ${count(project.sprites.length, 'image')}, ${count(project.maps.length, 'tile map')}, ${count(project.sounds.length, 'sound')}, ${count(project.music.length, 'piece')} of music`,
      build: async () => json(assetsManifest(project)),
    },
    {
      path: 'palette.json',
      description: `${project.palette.length} colors as flat RGBA for createEngine({ palette })`,
      build: async () => json(paletteJson(project)),
    },
  ];
  for (const sprite of project.sprites)
    files.push({
      path: `images/${sprite.name}.png`,
      description: `${sprite.width} × ${sprite.height} indexed PNG${
        sprite.transparentIndex === null ? '' : `, color ${sprite.transparentIndex} transparent`
      }`,
      build: () => spritePng(sprite, project.palette),
    });
  for (const map of project.maps)
    files.push({
      path: `maps/${map.name}.json`,
      description: `${map.cols} × ${map.rows} cells of ${map.tileWidth} × ${map.tileHeight} from “${map.tileset.name}”`,
      build: async () => json(tilemapJson(map)),
    });
  for (const sound of project.sounds)
    files.push({
      path: `sounds/${sound.name}.json`,
      description: sound.multi
        ? `${count(sound.notes.length, 'note')} at ${sound.bpm} BPM, ${sound.instrument.waveform}`
        : `${sound.frequency} Hz ${sound.instrument.waveform}, ${sound.duration} s`,
      build: async () => json(soundFile(sound)),
    });
  for (const piece of project.music)
    files.push({
      path: `music/${piece.name}.json`,
      description: `${count(piece.tracks.length, 'track')}, ${piece.length} steps at ${piece.bpm} BPM${piece.loop ? ', looping' : ''}`,
      build: async () => json(musicFile(piece)),
    });
  return files;
}

/** Starts a download of one file; the browser saves it under its base name. */
export function download(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

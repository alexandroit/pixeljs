import { EMPTY_TILE } from '@pixeljs/core';
import { ENTRY_OVERHEAD, History, type EditTarget, type HistoryEntry } from './history.js';
import {
  MAX_MAPS,
  MAX_MAP_SIDE,
  MAX_PALETTE_COLORS,
  MAX_SPRITES,
  MAX_SPRITE_SIDE,
  MAX_TILE_SIDE,
  MAX_TOTAL_MAP_CELLS,
} from './limits.js';
import { unusedColor } from './palette.js';
import {
  backgroundIndex,
  highestTile,
  highestUsedIndex,
  nameProblem,
  tileCount,
  totalMapCells,
  type Project,
  type Sprite,
  type TileMap,
} from './project.js';
import {
  AUDIO_LIMITS,
  type Instrument,
  type Music,
  type Note,
  type Sound,
  type Track,
} from './audio-model.js';

/**
 * - `project`: the whole project was replaced (new or opened file)
 * - `palette`: colors or color count changed
 * - `sprites` / `maps`: list membership, names, sizes or settings changed
 * - `pixels` / `tiles`: cell data of one sprite / map changed
 * - `sounds` / `music`: the list, a setting or the notes of a sound / piece changed
 * - `active`: the selected sprite, map, sound, piece, color or tile changed
 * - `history`: undo/redo availability or the saved state changed
 */
export type StudioEvent =
  | 'project'
  | 'palette'
  | 'sprites'
  | 'maps'
  | 'pixels'
  | 'tiles'
  | 'sounds'
  | 'music'
  | 'active'
  | 'history';
export type StudioSubject = Sprite | TileMap | Sound | Music | null;
export type StudioListener = (event: StudioEvent, subject: StudioSubject) => void;

type SoundPatch = Partial<
  Pick<
    Sound,
    | 'multi'
    | 'instrument'
    | 'frequency'
    | 'duration'
    | 'effect'
    | 'slideTo'
    | 'bpm'
    | 'stepsPerBeat'
    | 'notes'
  >
>;
type MusicPatch = Partial<Pick<Music, 'bpm' | 'stepsPerBeat' | 'length' | 'loop' | 'tracks'>>;
type TrackPatch = Partial<Pick<Track, 'voice' | 'instrument' | 'notes'>>;

function instrumentProblem(instrument: Instrument): string | null {
  const { volume, attack, decay, sustain, release } = instrument;
  if (!inRange(volume, 0, 1)) return 'Volume is a number from 0 to 1.';
  if (!inRange(sustain, 0, 1)) return 'Sustain is a number from 0 to 1.';
  for (const [name, value] of [
    ['Attack', attack],
    ['Decay', decay],
    ['Release', release],
  ] as const)
    if (!inRange(value, 0, AUDIO_LIMITS.maxStage))
      return `${name} is 0 to ${AUDIO_LIMITS.maxStage} seconds.`;
  return null;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function notesProblem(notes: readonly Note[], limit: number, endStep: number): string | null {
  if (notes.length > limit) return `At most ${limit} notes.`;
  for (const note of notes)
    if (
      !between(note.step, 0, endStep - 1) ||
      !between(note.length, 1, AUDIO_LIMITS.maxSteps) ||
      !between(note.pitch, 0, 127) ||
      !inRange(note.volume, 0, 1)
    )
      return `Notes start at steps 0 to ${endStep - 1}, last 1 to ${AUDIO_LIMITS.maxSteps} steps, use MIDI pitches 0 to 127 and volumes 0 to 1.`;
  return null;
}

/** Rough retained size of a history value: note lists dominate. */
function sizeOf(values: object): number {
  let bytes = 0;
  for (const value of Object.values(values))
    bytes += Array.isArray(value) ? 16 * value.length + 64 : 16;
  return bytes;
}

function between(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Owns the open project, its bounded history and the editors' shared selections. */
export class Studio {
  project: Project;
  readonly history = new History();
  activeSprite: Sprite | null = null;
  activeMap: TileMap | null = null;
  activeSound: Sound | null = null;
  activeMusic: Music | null = null;
  /** Palette index used by drawing tools. */
  color = 7;
  /** Tile ID placed by the map editor. */
  tile = 0;
  private savedTop: HistoryEntry | null = null;
  private readonly listeners: StudioListener[] = [];
  /** Commit in-progress gestures before the history or project changes under them. */
  private readonly interactions: Array<() => void> = [];

  constructor(project: Project) {
    this.project = project;
    this.resetSelections();
  }

  on(listener: StudioListener): void {
    this.listeners.push(listener);
  }

  emit(event: StudioEvent, subject: StudioSubject = null): void {
    for (const listener of this.listeners) listener(event, subject);
  }

  onInteractionFlush(flush: () => void): void {
    this.interactions.push(flush);
  }

  flushInteractions(): void {
    for (const flush of this.interactions) flush();
  }

  get dirty(): boolean {
    return this.history.top !== this.savedTop;
  }

  markSaved(): void {
    this.savedTop = this.history.top;
    this.emit('history');
  }

  replaceProject(project: Project): void {
    this.flushInteractions();
    this.project = project;
    this.history.clear();
    this.savedTop = null;
    this.resetSelections();
    this.emit('project');
    this.emit('history');
  }

  private resetSelections(): void {
    this.activeSprite = this.project.sprites[0] ?? null;
    this.activeMap = this.project.maps[0] ?? null;
    this.activeSound = this.project.sounds[0] ?? null;
    this.activeMusic = this.project.music[0] ?? null;
    this.color = Math.min(7, this.project.palette.length - 1);
    this.tile = 0;
  }

  // -------------------------------------------------------------------------
  // Selection

  selectSprite(sprite: Sprite | null): void {
    if (sprite === this.activeSprite) return;
    this.flushInteractions();
    this.activeSprite = sprite;
    this.emit('active');
  }

  selectMap(map: TileMap | null): void {
    if (map === this.activeMap) return;
    this.flushInteractions();
    this.activeMap = map;
    this.emit('active');
  }

  selectSound(sound: Sound | null): void {
    if (sound === this.activeSound) return;
    this.flushInteractions();
    this.activeSound = sound;
    this.emit('active');
  }

  selectMusic(music: Music | null): void {
    if (music === this.activeMusic) return;
    this.flushInteractions();
    this.activeMusic = music;
    this.emit('active');
  }

  setColor(index: number): void {
    const color = Math.max(0, Math.min(this.project.palette.length - 1, index));
    if (color === this.color) return;
    this.color = color;
    this.emit('active');
  }

  setTile(tile: number): void {
    if (tile === this.tile) return;
    this.tile = tile;
    this.emit('active');
  }

  // -------------------------------------------------------------------------
  // History

  record(entry: HistoryEntry): void {
    this.history.push(entry);
    this.emit('history');
  }

  undo(): HistoryEntry | null {
    this.flushInteractions();
    const entry = this.history.undo();
    if (entry) this.reveal(entry.target);
    this.emit('history');
    return entry;
  }

  redo(): HistoryEntry | null {
    this.flushInteractions();
    const entry = this.history.redo();
    if (entry) this.reveal(entry.target);
    this.emit('history');
    return entry;
  }

  /** Selects what an undone or redone edit changed, so the result is visible. */
  private reveal(target: EditTarget): void {
    if (target.kind === 'sprite' && this.project.sprites.includes(target.sprite))
      this.selectSprite(target.sprite);
    if (target.kind === 'map' && this.project.maps.includes(target.map)) this.selectMap(target.map);
    if (target.kind === 'sound' && this.project.sounds.includes(target.sound))
      this.selectSound(target.sound);
    if (target.kind === 'music' && this.project.music.includes(target.music))
      this.selectMusic(target.music);
  }

  /** Records an edit whose `apply(true)` redoes and `apply(false)` undoes it. */
  private change(
    label: string,
    bytes: number,
    target: EditTarget,
    apply: (forward: boolean) => void,
  ): void {
    apply(true);
    this.record({
      label,
      bytes: bytes + ENTRY_OVERHEAD,
      target,
      undo: () => apply(false),
      redo: () => apply(true),
    });
  }

  // -------------------------------------------------------------------------
  // Palette

  setPaletteColor(index: number, color: number): string | null {
    const palette = this.project.palette;
    if (!between(index, 0, palette.length - 1)) return 'That color does not exist.';
    if (palette[index] === color) return null;
    const next = [...palette];
    next[index] = color;
    this.replacePalette(next, `Change color ${index}`);
    return null;
  }

  /** Grows the palette with new distinct colors or removes unused colors at the end. */
  setPaletteSize(count: number): string | null {
    if (!between(count, 1, MAX_PALETTE_COLORS))
      return `A palette holds 1 to ${MAX_PALETTE_COLORS} colors.`;
    const palette = this.project.palette;
    if (count === palette.length) return null;
    if (count < palette.length) {
      const used = highestUsedIndex(this.project);
      if (used >= count)
        return `Sprites use color ${used}; remove its uses before shrinking the palette to ${count} colors.`;
    }
    const next = palette.slice(0, count);
    while (next.length < count) next.push(unusedColor(next));
    this.replacePalette(next, `Palette size ${count}`);
    return null;
  }

  private replacePalette(next: number[], label: string): void {
    const before = [...this.project.palette];
    this.change(label, (before.length + next.length) * 8, { kind: 'palette' }, (forward) => {
      this.project.palette = [...(forward ? next : before)];
      this.color = Math.min(this.color, this.project.palette.length - 1);
      this.emit('palette');
    });
  }

  // -------------------------------------------------------------------------
  // Sprites

  private mapsUsing(sprite: Sprite): TileMap[] {
    return this.project.maps.filter((map) => map.tileset === sprite);
  }

  addSprite(sprite: Sprite, label = `Add sprite ${sprite.name}`): string | null {
    const sprites = this.project.sprites;
    if (sprites.length >= MAX_SPRITES) return `A project holds at most ${MAX_SPRITES} sprites.`;
    const problem = nameProblem(
      sprite.name,
      sprites.map((other) => other.name),
    );
    if (problem) return problem;
    const index = this.activeSprite ? sprites.indexOf(this.activeSprite) + 1 : sprites.length;
    this.change(label, sprite.pixels.byteLength, { kind: 'sprite', sprite }, (forward) => {
      if (forward) sprites.splice(index, 0, sprite);
      else sprites.splice(sprites.indexOf(sprite), 1);
      this.activeSprite = forward ? sprite : (sprites[Math.min(index, sprites.length - 1)] ?? null);
      this.emit('sprites', sprite);
      this.emit('active');
    });
    return null;
  }

  deleteSprite(sprite: Sprite): string | null {
    const users = this.mapsUsing(sprite);
    if (users.length > 0)
      return `“${sprite.name}” is the tileset of ${users.map((map) => `“${map.name}”`).join(', ')}; change or delete those maps first.`;
    const sprites = this.project.sprites;
    const index = sprites.indexOf(sprite);
    if (index < 0) return null;
    this.change(
      `Delete sprite ${sprite.name}`,
      sprite.pixels.byteLength,
      { kind: 'sprite', sprite },
      (forward) => {
        if (forward) sprites.splice(sprites.indexOf(sprite), 1);
        else sprites.splice(index, 0, sprite);
        this.activeSprite = forward
          ? (sprites[Math.min(index, sprites.length - 1)] ?? null)
          : sprite;
        this.emit('sprites', sprite);
        this.emit('active');
      },
    );
    return null;
  }

  renameSprite(sprite: Sprite, name: string): string | null {
    if (name === sprite.name) return null;
    const problem = nameProblem(
      name,
      this.project.sprites.filter((other) => other !== sprite).map((other) => other.name),
    );
    if (problem) return problem;
    const before = sprite.name;
    this.change(`Rename sprite ${before}`, 0, { kind: 'sprite', sprite }, (forward) => {
      sprite.name = forward ? name : before;
      this.emit('sprites', sprite);
    });
    return null;
  }

  /** Checks that maps using `sprite` as their tileset stay valid at a new size. */
  private tilesetProblem(sprite: Sprite, width: number, height: number): string | null {
    for (const map of this.mapsUsing(sprite)) {
      if (width < map.tileWidth || height < map.tileHeight)
        return `Map “${map.name}” needs whole ${map.tileWidth} × ${map.tileHeight} tiles from “${sprite.name}”.`;
      const highest = highestTile(map);
      if (highest < 0) continue;
      const perRow = Math.floor(sprite.width / map.tileWidth);
      if (Math.floor(width / map.tileWidth) !== perRow)
        return `Map “${map.name}” uses “${sprite.name}” as its tileset: a width of ${width} changes its tiles per row from ${perRow}, which would renumber the placed tiles.`;
      const count = tileCount({ ...sprite, width, height }, map.tileWidth, map.tileHeight);
      if (highest >= count)
        return `Map “${map.name}” places tile ${highest}, which a ${width} × ${height} tileset would not contain.`;
    }
    return null;
  }

  /** Crops or extends from the top-left corner; new pixels take the background index. */
  resizeSprite(sprite: Sprite, width: number, height: number): string | null {
    if (!between(width, 1, MAX_SPRITE_SIDE) || !between(height, 1, MAX_SPRITE_SIDE))
      return `Sprites are 1 to ${MAX_SPRITE_SIDE} pixels wide and high.`;
    if (width === sprite.width && height === sprite.height) return null;
    const pixels = new Uint8Array(width * height).fill(backgroundIndex(sprite));
    for (let y = 0; y < Math.min(height, sprite.height); y++)
      pixels.set(
        sprite.pixels.subarray(y * sprite.width, y * sprite.width + Math.min(width, sprite.width)),
        y * width,
      );
    return this.replaceSpriteImage(
      sprite,
      width,
      height,
      pixels,
      sprite.transparentIndex,
      `Resize ${sprite.name} to ${width} × ${height}`,
    );
  }

  /** Replaces size, pixels and transparency together (resize and PNG import). */
  replaceSpriteImage(
    sprite: Sprite,
    width: number,
    height: number,
    pixels: Uint8Array,
    transparentIndex: number | null,
    label: string,
  ): string | null {
    const problem = this.tilesetProblem(sprite, width, height);
    if (problem) return problem;
    const before = {
      width: sprite.width,
      height: sprite.height,
      pixels: sprite.pixels,
      transparentIndex: sprite.transparentIndex,
    };
    const after = { width, height, pixels, transparentIndex };
    this.change(
      label,
      before.pixels.byteLength + pixels.byteLength,
      { kind: 'sprite', sprite },
      (forward) => {
        const state = forward ? after : before;
        sprite.width = state.width;
        sprite.height = state.height;
        sprite.pixels = state.pixels.slice();
        sprite.transparentIndex = state.transparentIndex;
        this.emit('sprites', sprite);
        this.emit('pixels', sprite);
      },
    );
    return null;
  }

  setTransparentIndex(sprite: Sprite, index: number | null): string | null {
    if (index !== null && !between(index, 0, this.project.palette.length - 1))
      return 'That color does not exist.';
    if (index === sprite.transparentIndex) return null;
    const before = sprite.transparentIndex;
    this.change(`Transparency of ${sprite.name}`, 0, { kind: 'sprite', sprite }, (forward) => {
      sprite.transparentIndex = forward ? index : before;
      this.emit('sprites', sprite);
      this.emit('pixels', sprite);
    });
    return null;
  }

  // -------------------------------------------------------------------------
  // Maps

  addMap(map: TileMap, label = `Add map ${map.name}`): string | null {
    const maps = this.project.maps;
    if (maps.length >= MAX_MAPS) return `A project holds at most ${MAX_MAPS} maps.`;
    const problem = nameProblem(
      map.name,
      maps.map((other) => other.name),
    );
    if (problem) return problem;
    if (totalMapCells(this.project) + map.cols * map.rows > MAX_TOTAL_MAP_CELLS)
      return `Maps may hold at most ${MAX_TOTAL_MAP_CELLS} cells in total.`;
    const index = this.activeMap ? maps.indexOf(this.activeMap) + 1 : maps.length;
    this.change(label, map.tiles.byteLength, { kind: 'map', map }, (forward) => {
      if (forward) maps.splice(index, 0, map);
      else maps.splice(maps.indexOf(map), 1);
      this.activeMap = forward ? map : (maps[Math.min(index, maps.length - 1)] ?? null);
      this.emit('maps', map);
      this.emit('active');
    });
    return null;
  }

  deleteMap(map: TileMap): string | null {
    const maps = this.project.maps;
    const index = maps.indexOf(map);
    if (index < 0) return null;
    this.change(`Delete map ${map.name}`, map.tiles.byteLength, { kind: 'map', map }, (forward) => {
      if (forward) maps.splice(maps.indexOf(map), 1);
      else maps.splice(index, 0, map);
      this.activeMap = forward ? (maps[Math.min(index, maps.length - 1)] ?? null) : map;
      this.emit('maps', map);
      this.emit('active');
    });
    return null;
  }

  renameMap(map: TileMap, name: string): string | null {
    if (name === map.name) return null;
    const problem = nameProblem(
      name,
      this.project.maps.filter((other) => other !== map).map((other) => other.name),
    );
    if (problem) return problem;
    const before = map.name;
    this.change(`Rename map ${before}`, 0, { kind: 'map', map }, (forward) => {
      map.name = forward ? name : before;
      this.emit('maps', map);
    });
    return null;
  }

  /** Crops or extends from the top-left corner; new cells are empty. */
  resizeMap(map: TileMap, cols: number, rows: number): string | null {
    if (!between(cols, 1, MAX_MAP_SIDE) || !between(rows, 1, MAX_MAP_SIDE))
      return `Maps are 1 to ${MAX_MAP_SIDE} cells wide and high.`;
    if (cols === map.cols && rows === map.rows) return null;
    if (totalMapCells(this.project, map) + cols * rows > MAX_TOTAL_MAP_CELLS)
      return `Maps may hold at most ${MAX_TOTAL_MAP_CELLS} cells in total.`;
    const tiles = new Uint16Array(cols * rows).fill(EMPTY_TILE);
    for (let row = 0; row < Math.min(rows, map.rows); row++)
      tiles.set(
        map.tiles.subarray(row * map.cols, row * map.cols + Math.min(cols, map.cols)),
        row * cols,
      );
    const before = { cols: map.cols, rows: map.rows, tiles: map.tiles };
    const after = { cols, rows, tiles };
    this.change(
      `Resize ${map.name} to ${cols} × ${rows}`,
      before.tiles.byteLength + tiles.byteLength,
      { kind: 'map', map },
      (forward) => {
        const state = forward ? after : before;
        map.cols = state.cols;
        map.rows = state.rows;
        map.tiles = state.tiles.slice();
        this.emit('maps', map);
        this.emit('tiles', map);
      },
    );
    return null;
  }

  /** Changes the tileset or tile size; every placed tile must remain a valid ID. */
  configureMap(
    map: TileMap,
    tileset: Sprite,
    tileWidth: number,
    tileHeight: number,
  ): string | null {
    if (!between(tileWidth, 1, MAX_TILE_SIDE) || !between(tileHeight, 1, MAX_TILE_SIDE))
      return `Tiles are 1 to ${MAX_TILE_SIDE} pixels wide and high.`;
    if (tileWidth > tileset.width || tileHeight > tileset.height)
      return `“${tileset.name}” (${tileset.width} × ${tileset.height}) is smaller than one ${tileWidth} × ${tileHeight} tile.`;
    if (tileset === map.tileset && tileWidth === map.tileWidth && tileHeight === map.tileHeight)
      return null;
    const count = tileCount(tileset, tileWidth, tileHeight);
    const highest = highestTile(map);
    if (highest >= count)
      return `The map places tile ${highest}, but that tileset has ${count} tiles of ${tileWidth} × ${tileHeight}.`;
    const before = { tileset: map.tileset, tileWidth: map.tileWidth, tileHeight: map.tileHeight };
    const after = { tileset, tileWidth, tileHeight };
    this.change(`Tileset of ${map.name}`, 0, { kind: 'map', map }, (forward) => {
      Object.assign(map, forward ? after : before);
      this.emit('maps', map);
      this.emit('tiles', map);
    });
    return null;
  }

  // -------------------------------------------------------------------------
  // Sounds and music

  /** Records a change of some fields of `object` as one step. */
  private patch<T extends object>(
    object: T,
    values: Partial<T>,
    label: string,
    target: EditTarget,
    notify: () => void,
  ): void {
    const before: Partial<T> = {};
    for (const key of Object.keys(values) as Array<keyof T>) before[key] = object[key];
    const after = { ...values };
    this.change(label, sizeOf(before) + sizeOf(after), target, (forward) => {
      Object.assign(object, forward ? after : before);
      notify();
    });
  }

  addSound(sound: Sound, label = `Add sound ${sound.name}`): string | null {
    const sounds = this.project.sounds;
    if (sounds.length >= AUDIO_LIMITS.sounds)
      return `A project holds at most ${AUDIO_LIMITS.sounds} sounds.`;
    const problem = nameProblem(
      sound.name,
      sounds.map((other) => other.name),
    );
    if (problem) return problem;
    const index = this.activeSound ? sounds.indexOf(this.activeSound) + 1 : sounds.length;
    this.change(label, sizeOf(sound), { kind: 'sound', sound }, (forward) => {
      if (forward) sounds.splice(index, 0, sound);
      else sounds.splice(sounds.indexOf(sound), 1);
      this.activeSound = forward ? sound : (sounds[Math.min(index, sounds.length - 1)] ?? null);
      this.emit('sounds', sound);
      this.emit('active');
    });
    return null;
  }

  deleteSound(sound: Sound): string | null {
    const sounds = this.project.sounds;
    const index = sounds.indexOf(sound);
    if (index < 0) return null;
    this.change(
      `Delete sound ${sound.name}`,
      sizeOf(sound),
      { kind: 'sound', sound },
      (forward) => {
        if (forward) sounds.splice(sounds.indexOf(sound), 1);
        else sounds.splice(index, 0, sound);
        this.activeSound = forward ? (sounds[Math.min(index, sounds.length - 1)] ?? null) : sound;
        this.emit('sounds', sound);
        this.emit('active');
      },
    );
    return null;
  }

  renameSound(sound: Sound, name: string): string | null {
    if (name === sound.name) return null;
    const problem = nameProblem(
      name,
      this.project.sounds.filter((other) => other !== sound).map((other) => other.name),
    );
    if (problem) return problem;
    this.patch(sound, { name }, `Rename sound ${sound.name}`, { kind: 'sound', sound }, () =>
      this.emit('sounds', sound),
    );
    return null;
  }

  /** Changes sound settings or notes, checked against the engine's ranges. */
  updateSound(sound: Sound, values: SoundPatch, label: string): string | null {
    const next = { ...sound, ...values };
    if (values.instrument) {
      const problem = instrumentProblem(values.instrument);
      if (problem) return problem;
    }
    const hertz = (value: number) => value > 0 && value <= AUDIO_LIMITS.maxFrequency;
    if (!hertz(next.frequency) || !hertz(next.slideTo))
      return `Frequencies are above 0 and up to ${AUDIO_LIMITS.maxFrequency} Hz.`;
    if (!(next.duration > 0 && next.duration <= AUDIO_LIMITS.maxDuration))
      return `The duration is above 0 and up to ${AUDIO_LIMITS.maxDuration} seconds.`;
    if (!inRange(next.bpm, AUDIO_LIMITS.minBpm, AUDIO_LIMITS.maxBpm))
      return `The tempo is ${AUDIO_LIMITS.minBpm} to ${AUDIO_LIMITS.maxBpm} beats per minute.`;
    if (!between(next.stepsPerBeat, 1, AUDIO_LIMITS.maxStepsPerBeat))
      return `Steps per beat are 1 to ${AUDIO_LIMITS.maxStepsPerBeat}.`;
    const notes = notesProblem(next.notes, AUDIO_LIMITS.soundNotes, AUDIO_LIMITS.maxSteps);
    if (notes) return notes;
    if (next.multi && next.notes.length === 0)
      return 'A sound with notes needs at least one note; make it a single note instead.';
    this.patch(sound, values, label, { kind: 'sound', sound }, () => this.emit('sounds', sound));
    return null;
  }

  addMusic(music: Music, label = `Add music ${music.name}`): string | null {
    const pieces = this.project.music;
    if (pieces.length >= AUDIO_LIMITS.music)
      return `A project holds at most ${AUDIO_LIMITS.music} pieces of music.`;
    const problem = nameProblem(
      music.name,
      pieces.map((other) => other.name),
    );
    if (problem) return problem;
    const index = this.activeMusic ? pieces.indexOf(this.activeMusic) + 1 : pieces.length;
    this.change(label, sizeOf(music), { kind: 'music', music }, (forward) => {
      if (forward) pieces.splice(index, 0, music);
      else pieces.splice(pieces.indexOf(music), 1);
      this.activeMusic = forward ? music : (pieces[Math.min(index, pieces.length - 1)] ?? null);
      this.emit('music', music);
      this.emit('active');
    });
    return null;
  }

  deleteMusic(music: Music): string | null {
    const pieces = this.project.music;
    const index = pieces.indexOf(music);
    if (index < 0) return null;
    this.change(
      `Delete music ${music.name}`,
      sizeOf(music),
      { kind: 'music', music },
      (forward) => {
        if (forward) pieces.splice(pieces.indexOf(music), 1);
        else pieces.splice(index, 0, music);
        this.activeMusic = forward ? (pieces[Math.min(index, pieces.length - 1)] ?? null) : music;
        this.emit('music', music);
        this.emit('active');
      },
    );
    return null;
  }

  renameMusic(music: Music, name: string): string | null {
    if (name === music.name) return null;
    const problem = nameProblem(
      name,
      this.project.music.filter((other) => other !== music).map((other) => other.name),
    );
    if (problem) return problem;
    this.patch(music, { name }, `Rename music ${music.name}`, { kind: 'music', music }, () =>
      this.emit('music', music),
    );
    return null;
  }

  /** Changes tempo, length, loop or the track list of a piece. */
  updateMusic(music: Music, values: MusicPatch, label: string): string | null {
    const next = { ...music, ...values };
    if (!inRange(next.bpm, AUDIO_LIMITS.minBpm, AUDIO_LIMITS.maxBpm))
      return `The tempo is ${AUDIO_LIMITS.minBpm} to ${AUDIO_LIMITS.maxBpm} beats per minute.`;
    if (!between(next.stepsPerBeat, 1, AUDIO_LIMITS.maxStepsPerBeat))
      return `Steps per beat are 1 to ${AUDIO_LIMITS.maxStepsPerBeat}.`;
    if (!between(next.length, 1, AUDIO_LIMITS.maxSteps))
      return `A piece is 1 to ${AUDIO_LIMITS.maxSteps} steps long.`;
    if (next.tracks.length < 1 || next.tracks.length > AUDIO_LIMITS.tracks)
      return `A piece has 1 to ${AUDIO_LIMITS.tracks} tracks.`;
    const last = Math.max(
      -1,
      ...next.tracks.flatMap((track) => track.notes.map((note) => note.step)),
    );
    if (last >= next.length)
      return `A note starts at step ${last}: the piece must be at least ${last + 1} steps long.`;
    this.patch(music, values, label, { kind: 'music', music }, () => this.emit('music', music));
    return null;
  }

  /** Changes a track's voice, instrument or notes. */
  updateTrack(music: Music, track: Track, values: TrackPatch, label: string): string | null {
    if (values.voice !== undefined) {
      if (!between(values.voice, 0, AUDIO_LIMITS.voices - 1)) return 'Voices are 0 to 3.';
      const other = music.tracks.find((item) => item !== track && item.voice === values.voice);
      if (other) return `Voice ${values.voice} is used by another track.`;
    }
    if (values.instrument) {
      const problem = instrumentProblem(values.instrument);
      if (problem) return problem;
    }
    if (values.notes) {
      const problem = notesProblem(values.notes, AUDIO_LIMITS.trackNotes, music.length);
      if (problem) return problem;
    }
    this.patch(track, values, label, { kind: 'music', music }, () => this.emit('music', music));
    return null;
  }
}

/**
 * Collects changes to one sprite's pixels or one map's tiles during a gesture
 * and records them as a single delta entry: positions plus old and new values.
 */
export class CellEdit {
  private readonly touched: Uint8Array;
  private readonly positions: number[] = [];
  private readonly before: number[] = [];
  /** The cell array being edited; a resize or undo replacing it makes the edit stale. */
  private readonly initial: Uint8Array | Uint16Array;

  constructor(
    private readonly studio: Studio,
    readonly target: { kind: 'sprite'; sprite: Sprite } | { kind: 'map'; map: TileMap },
  ) {
    this.initial = this.cells();
    this.touched = new Uint8Array(this.initial.length);
  }

  private cells(): Uint8Array | Uint16Array {
    return this.target.kind === 'sprite' ? this.target.sprite.pixels : this.target.map.tiles;
  }

  private get stale(): boolean {
    return this.cells() !== this.initial;
  }

  private notify(): void {
    if (this.target.kind === 'sprite') this.studio.emit('pixels', this.target.sprite);
    else this.studio.emit('tiles', this.target.map);
  }

  get width(): number {
    return this.target.kind === 'sprite' ? this.target.sprite.width : this.target.map.cols;
  }

  get height(): number {
    return this.target.kind === 'sprite' ? this.target.sprite.height : this.target.map.rows;
  }

  /** Writes one cell; coordinates outside the target are ignored (clipped). */
  set(x: number, y: number, value: number): void {
    if (this.stale || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const position = y * this.width + x;
    const cells = this.initial;
    if (!this.touched[position]) {
      this.touched[position] = 1;
      this.positions.push(position);
      this.before.push(cells[position]!);
    }
    cells[position] = value;
  }

  /** Emits one change notification after a batch of `set` calls. */
  flush(): void {
    if (this.positions.length > 0) this.notify();
  }

  /** Restores every touched cell and records nothing. */
  cancel(): void {
    if (this.stale) return;
    this.positions.forEach((position, index) => (this.initial[position] = this.before[index]!));
    this.flush();
  }

  /** Records the net change as one history entry; returns the number of changed cells. */
  commit(label: string): number {
    if (this.stale) return 0;
    const cells = this.initial;
    const kept: number[] = [];
    this.positions.forEach((position, index) => {
      if (cells[position] !== this.before[index]) kept.push(index);
    });
    this.flush();
    if (kept.length === 0) return 0;
    const wide = this.target.kind === 'map';
    const positions = new Uint16Array(kept.length);
    const before = wide ? new Uint16Array(kept.length) : new Uint8Array(kept.length);
    const after = wide ? new Uint16Array(kept.length) : new Uint8Array(kept.length);
    kept.forEach((index, slot) => {
      const position = this.positions[index]!;
      positions[slot] = position;
      before[slot] = this.before[index]!;
      after[slot] = cells[position]!;
    });
    const write = (values: Uint8Array | Uint16Array): void => {
      const target = this.cells();
      positions.forEach((position, slot) => (target[position] = values[slot]!));
      this.notify();
    };
    this.studio.record({
      label,
      bytes: positions.byteLength + before.byteLength + after.byteLength + ENTRY_OVERHEAD,
      target: this.target,
      undo: () => write(before),
      redo: () => write(after),
    });
    return kept.length;
  }
}

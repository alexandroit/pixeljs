export type EngineState = 'READY' | 'RUNNING' | 'PAUSED' | 'DISPOSING' | 'DISPOSED' | 'FAILED';
export type RendererKind = 'webgl2' | 'canvas2d';
/**
 * How the canvas is displayed. The backing store always stays at the
 * logical size; only the CSS box changes.
 *
 * - `'manual'` (default): the page sizes the canvas with CSS. Pointer input
 *   follows the canvas's computed `object-fit` (`fill`, `contain`, `cover`,
 *   `none`, `scale-down`) and a two-value length/percentage `object-position`
 *   (anything else counts as centered), inside its border and padding.
 * - `'fit'`: the engine sets the canvas CSS `width`/`height` to the largest
 *   size with the framebuffer's aspect ratio that fits the content box of the
 *   canvas's parent element, in whole device pixels, and sets
 *   `image-rendering: pixelated`. The canvas's own border and padding are
 *   subtracted (with either `box-sizing`); its margins are not. The parent
 *   needs a definite size (its size must not depend on the canvas); centering
 *   is up to the page, for example `display: grid; place-items: center` on
 *   the parent.
 * - `'integer'`: like `'fit'`, with the largest whole number k of device
 *   pixels per logical pixel (CSS size = k × logical size /
 *   devicePixelRatio); when not even k = 1 fits, it falls back to `'fit'`.
 *
 * Fitting follows parent resizes (ResizeObserver) and devicePixelRatio
 * changes, and happens again on `resize()`. A canvas without a parent keeps
 * its size until it is attached. `dispose()` restores the original inline
 * styles. Stylesheet `!important` rules on width/height override the engine.
 */
export type ScalingMode = 'manual' | 'fit' | 'integer';
export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Logical framebuffer width in pixels, 1–1024. Default 256. */
  width?: number;
  /** Logical framebuffer height in pixels, 1–1024. Default 144. */
  height?: number;
  /** Fixed update rate, 1–240 Hz. Default 60. */
  updateHz?: number;
  renderer?: 'auto' | RendererKind;
  /** Display sizing of the canvas. Default `'manual'`. */
  scaling?: ScalingMode;
  /**
   * Initial palette: 1–256 opaque RGBA entries, flattened (`[r, g, b, 255, ...]`).
   * The number of entries is fixed for the engine's lifetime. Default: the
   * original 16-color PixelJS palette.
   */
  palette?: ArrayLike<number>;
  wasmUrl?: string | URL;
  audioWasmUrl?: string | URL;
  /** Same-origin URL of the packaged `internal/audio/processor.js` module. */
  audioWorkletUrl?: string | URL;
  signal?: AbortSignal;
  /** Receives callback, validation and optional audio errors. */
  onError?: (error: Error) => void;
}
export interface GameCallbacks {
  /** Synchronous, fixed-step update. dt is in seconds. */
  update(dt: number): void;
  /** Synchronous drawing phase. Resource creation/release is not allowed here. */
  draw(): void;
}
declare const imageBrand: unique symbol;
export interface ImageResource {
  readonly [imageBrand]: true;
  readonly width: number;
  readonly height: number;
}
declare const tilemapBrand: unique symbol;
export interface TilemapResource {
  readonly [tilemapBrand]: true;
  readonly cols: number;
  readonly rows: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly tileset: ImageResource;
}
declare const fontBrand: unique symbol;
export interface FontResource {
  readonly [fontBrand]: true;
  readonly glyphWidth: number;
  readonly glyphHeight: number;
  readonly firstChar: number;
  readonly charCount: number;
  readonly fallbackChar: number;
}
declare const soundBrand: unique symbol;
declare const musicBrand: unique symbol;
export type SoundWaveform = 'square' | 'triangle' | 'sine' | 'noise';
/**
 * `slide` glides the pitch to the next note of the same sound or track
 * (or to `slideTo` for a single-note sound) over the note's length;
 * `vibrato` wobbles it by half a semitone at 6 Hz; `fadeout` fades the
 * volume to silence over the note's length.
 */
export type SoundEffect = 'none' | 'slide' | 'vibrato' | 'fadeout';
/** One note of a multi-note sound or a music track, timed in steps. */
export interface NoteOptions {
  /** Start step, counted from 0. */
  step: number;
  /** Length in steps, 1–4096. Default 1. */
  length?: number;
  /** MIDI note 0–127 or a name such as 'C4', 'F#3' or 'Bb5' (C4 = 60, A4 = 440 Hz). */
  pitch: number | string;
  /** 0–1, scaling the sound's or track's volume. Default 1. */
  volume?: number;
  /** Default: the sound's or track's waveform. */
  waveform?: SoundWaveform;
  effect?: SoundEffect;
}
/** Synthesized note. Times are in seconds; volume and sustain are 0–1. */
export interface SoundOptions {
  waveform?: SoundWaveform | undefined;
  /** Hz, greater than 0 and at most 24000. Default 440. */
  frequency?: number | undefined;
  /** Default 1. */
  volume?: number | undefined;
  /** 0–10 s. Default 0.005. */
  attack?: number | undefined;
  /** 0–10 s. Default 0.01. */
  decay?: number | undefined;
  /** Default 0.7. */
  sustain?: number | undefined;
  /** 0–10 s. Default 0.05. */
  release?: number | undefined;
  /** Gate length before release, greater than 0 and at most 60 s. Default 0.1. */
  duration?: number | undefined;
  /** Single-note sounds only. Default 'none'. */
  effect?: SoundEffect | undefined;
  /** Target frequency in Hz for the 'slide' effect of a single-note sound. */
  slideTo?: number | undefined;
  /**
   * A multi-note sound (a jingle): up to 64 notes played on one voice at
   * `bpm`. `frequency`, `duration`, `effect` and `slideTo` then do not apply;
   * waveform, volume and the envelope apply to every note.
   */
  notes?: readonly NoteOptions[] | undefined;
  /** Tempo of a multi-note sound, 20–400 beats per minute. Default 120. */
  bpm?: number | undefined;
  /** Steps per beat of a multi-note sound, 1–16. Default 4. */
  stepsPerBeat?: number | undefined;
}
export interface SoundResource {
  readonly [soundBrand]: true;
  readonly waveform: SoundWaveform;
  readonly frequency: number;
  readonly volume: number;
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
  readonly duration: number;
  readonly effect: SoundEffect;
  /** Number of notes of a multi-note sound; 0 for a single note. */
  readonly notes: number;
}
/** A music track: one voice, one instrument, notes in steps. */
export interface TrackOptions {
  /** Voice 0–3; tracks use distinct voices. Default: the track's index. */
  voice?: number;
  waveform?: SoundWaveform;
  volume?: number;
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  /** At most 512 notes, each starting before the piece's length. */
  notes: readonly NoteOptions[];
}
export interface MusicOptions {
  /** Beats per minute, 20–400. */
  bpm: number;
  /** Steps per beat, 1–16. Default 4. */
  stepsPerBeat?: number;
  /** Length of the piece in steps, 1–4096. */
  length: number;
  /** Default true. */
  loop?: boolean;
  /** One to four tracks. */
  tracks: readonly TrackOptions[];
}
export interface MusicResource {
  readonly [musicBrand]: true;
  readonly bpm: number;
  readonly stepsPerBeat: number;
  readonly length: number;
  readonly loop: boolean;
  readonly tracks: number;
}
export interface SoundInstance {
  readonly voice: number;
  /**
   * Releases this note only; a later note on the same voice is unaffected.
   * Works while the game is paused. The instance of a dropped note does nothing.
   */
  stop(): void;
}
export type AudioState =
  'uninitialized' | 'running' | 'suspended' | 'blocked' | 'failed' | 'disposed';
export interface AudioCapabilities {
  readonly supported: boolean;
  readonly state: AudioState;
}
/**
 * Optional four-voice synthesizer running in an AudioWorklet. Nothing is
 * downloaded or created until unlock() is called from a user gesture. Audio
 * failures are reported through onError and never pause the game.
 */
export interface AudioSystem {
  readonly capabilities: AudioCapabilities;
  unlock(): Promise<void>;
  /**
   * Plays a note. While audio is not running (before unlock, blocked,
   * suspended, paused or failed) the note is dropped, never replayed later.
   */
  play(sound?: SoundOptions | SoundResource, voice?: number): SoundInstance;
  /** Stops one instance, or every sound when called without an argument. */
  stop(instance?: SoundInstance): void;
  /** Output volume 0–1. */
  setVolume(volume: number): void;
  createSound(options: SoundOptions): SoundResource;
  /** Loads a JSON sound description of at most 64 KiB. */
  loadSound(src: string, options?: { signal?: AbortSignal }): Promise<SoundResource>;
  /**
   * Validates a piece of music. Its steps run on the audio clock, to the
   * sample, independently of frames; up to 4 tracks of 512 notes.
   */
  createMusic(options: MusicOptions): MusicResource;
  /** Loads music JSON (`{ "format": "pixeljs-music", "version": 1, ... }`) of at most 256 KiB. */
  loadMusic(src: string, options?: { signal?: AbortSignal }): Promise<MusicResource>;
  /**
   * Plays a piece from its start, replacing the current one. Called before
   * unlock() or while paused, it starts once audio runs. A sound played on
   * a voice silences that voice's track until the sound ends.
   */
  playMusic(music: MusicResource, options?: { loop?: boolean }): void;
  stopMusic(): void;
  /** True from playMusic until stopMusic, stop() or a non-looping piece's end. */
  readonly musicPlaying: boolean;
}
export type Resource =
  ImageResource | TilemapResource | FontResource | SoundResource | MusicResource;
export interface ImageOptions {
  width: number;
  height: number;
  /** Copied before returning. Values must be indices in the engine palette. */
  pixels: Uint8Array;
  transparentIndex?: number;
}
export interface TilemapOptions {
  cols: number;
  rows: number;
  /** Tile size in pixels, 1–256. The tileset must hold at least one whole tile. */
  tileWidth: number;
  tileHeight: number;
  /** Retained while the map exists: releasing it first fails with RESOURCE_IN_USE. */
  tileset: ImageResource;
  /**
   * Row-major tile IDs. Tiles are numbered left to right, top to bottom
   * across the tileset's whole tiles. `EMPTY_TILE` (65535) leaves a cell empty.
   */
  tiles: ArrayLike<number>;
}
export interface TilemapDrawOptions {
  startCol?: number;
  startRow?: number;
  cols?: number;
  rows?: number;
}
export interface FontOptions {
  /** Glyph size in pixels, 1–64. */
  glyphWidth: number;
  glyphHeight: number;
  /** First UTF-16 code unit covered. Default 32 (space). */
  firstChar?: number;
  /** Number of consecutive glyphs, 1–256. Default 96. */
  charCount?: number;
  /**
   * Character drawn for code units outside the font; it must be one of the
   * font's characters. Default `?` when covered, otherwise `firstChar`.
   */
  fallbackChar?: number;
  /**
   * 1-bit glyphs in order. Each row is padded to whole bytes and the most
   * significant bit is the leftmost pixel: `charCount * glyphHeight *
   * ceil(glyphWidth / 8)` bytes.
   */
  bitmap: Uint8Array;
}
export interface TextOptions {
  font?: FontResource;
  background?: number;
}
export interface SpriteOptions {
  sourceX?: number;
  sourceY?: number;
  width?: number;
  height?: number;
  flipX?: boolean;
  flipY?: boolean;
  /**
   * Degrees, clockwise on screen, about the sprite's center (any finite
   * angle; resolution 1/4096 turn). Default 0.
   */
  rotation?: number;
  /**
   * Size factor about the sprite's center, 1/16 to 64 (resolution 1/65536).
   * Default 1. A rotated or scaled sprite needs its source rectangle inside
   * the image and samples the nearest source pixel, with integer arithmetic
   * only, so every browser draws the same pixels.
   */
  scale?: number;
}
/** Drawing commands, valid only inside draw(). Coordinates are integer pixels. */
export interface Graphics {
  clear(color: number): void;
  pixel(x: number, y: number, color: number): void;
  line(x0: number, y0: number, x1: number, y1: number, color: number): void;
  rect(x: number, y: number, width: number, height: number, color: number): void;
  rectb(x: number, y: number, width: number, height: number, color: number): void;
  circle(x: number, y: number, radius: number, color: number): void;
  circleFill(x: number, y: number, radius: number, color: number): void;
  /**
   * Ellipse inscribed in the box (x, y, width, height), sizes 0–16384: a
   * pixel belongs to it when its center lies inside. The outline is the
   * set of those pixels with a neighbour outside, so it matches the fill.
   */
  ellipse(x: number, y: number, width: number, height: number, color: number): void;
  ellipseFill(x: number, y: number, width: number, height: number, color: number): void;
  /** The three edges, drawn as exact lines. Takes two of the 4,096 records per frame. */
  triangle(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
  ): void;
  /**
   * Every pixel whose center lies inside or on the triangle, plus its edges,
   * so a fill covers the outline drawn with the same vertices.
   */
  triangleFill(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
  ): void;
  /**
   * Flood-fills the 4-connected area of (x, y)'s current color inside the
   * clip, as drawn so far in this frame. Costs up to ten work units per clip
   * pixel, so a batch holds about one full-screen fill at 1024 × 1024.
   */
  fill(x: number, y: number, color: number): void;
  /**
   * From here to the end of the frame (or resetRemap), drawing that would
   * write palette index `from` writes `to` instead: fills, lines, text and
   * every sprite and tile pixel. Transparency is decided before remapping.
   */
  remap(from: number, to: number): void;
  resetRemap(): void;
  glyph(
    x: number,
    y: number,
    charCode: number,
    color: number,
    font?: FontResource,
    background?: number,
  ): void;
  /** Draws UTF-16 code units; `\n` starts a new line and `\r` is ignored. */
  text(x: number, y: number, text: string, color: number, options?: TextOptions): void;
  sprite(image: ImageResource, x: number, y: number, options?: SpriteOptions): void;
  tilemap(map: TilemapResource, x: number, y: number, options?: TilemapDrawOptions): void;
  /**
   * Changes one palette entry (0–255 channels, opaque) together with this
   * frame: the color applies only if the whole frame is accepted, and it
   * affects every pixel with that index when presented.
   */
  setPaletteColor(index: number, red: number, green: number, blue: number): void;
  setCamera(x: number, y: number): void;
  setClip(x: number, y: number, width: number, height: number): void;
  resetClip(): void;
}
/** Other or unknown pointing devices are reported as `'mouse'`. */
export type PointerType = 'mouse' | 'pen' | 'touch';
/** A frozen view of one pointer. */
export interface PointerSnapshot {
  /**
   * Assigned by the engine when a contact starts and stable until it ends; a
   * new press gets a new id. 0 for a primary pointer holding no contact.
   */
  readonly id: number;
  readonly type: PointerType;
  /** Integer logical pixels, clamped to the framebuffer. */
  readonly x: number;
  readonly y: number;
  /**
   * Held buttons: 1 primary, 2 secondary, 4 middle (other buttons are not
   * reported). Touch and pen contacts report at least 1. A released
   * snapshot keeps the buttons held just before the contact ended.
   */
  readonly buttons: number;
  readonly down: boolean;
  /** The contact went down since the previous tick. */
  readonly pressed: boolean;
  /** The contact ended since the previous tick (up, cancel or lost capture). */
  readonly released: boolean;
}
/** Wheel movement in lines since the previous tick; positive is right/down. */
export interface WheelSnapshot {
  readonly x: number;
  readonly y: number;
}
/** Standard-mapping buttons, in order of standard indices 0–16. */
export type GamepadButton =
  | 'A'
  | 'B'
  | 'X'
  | 'Y'
  | 'LB'
  | 'RB'
  | 'LT'
  | 'RT'
  | 'Back'
  | 'Start'
  | 'LS'
  | 'RS'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Home';
/** Standard-mapping stick axes, indices 0–3; right and down are positive. */
export type GamepadAxis = 'leftX' | 'leftY' | 'rightX' | 'rightY';
/** A frozen view of one connected gamepad in the latest tick. */
export interface GamepadSnapshot {
  /** 0–3. */
  readonly index: number;
  /** The browser's device description, at most 128 characters. */
  readonly id: string;
  /**
   * With `'unknown'` the browser does not know the layout: buttons and axes
   * are the device's first 17 and 4, and their names are only positions.
   */
  readonly mapping: 'standard' | 'unknown';
  /** 17 entries in `GamepadButton` order. Standard triggers count as pressed above 0.5. */
  readonly buttons: readonly boolean[];
  /**
   * 4 entries in `GamepadAxis` order: 0 within the 0.15 dead zone, then
   * rescaled so the rest of the travel still spans [-1, 1].
   */
  readonly axes: readonly number[];
}
/**
 * Input sampled once per logical tick. Browser events accumulate between
 * ticks; reading never consumes an edge, catch-up ticks do not repeat one,
 * and a press and release between two ticks report both edges with `down`
 * false. Window blur, a hidden document (or a Capacitor/Cordova `pause`
 * document event), pause/resume and `start()` reset held keys, pointers,
 * wheel and gamepad edges; `resize()` drops held pointers. Nothing stays
 * stuck down.
 */
export interface Input {
  /** Whether a key (`KeyboardEvent.code`) is held. Keys need canvas focus. */
  isDown(code: string): boolean;
  wasPressed(code: string): boolean;
  wasReleased(code: string): boolean;
  /**
   * The primary pointer (the mouse, the first touch or the pen): its held
   * contact, else where it last was, so a hovering mouse keeps updating
   * `x`/`y`. Position, buttons and `down` are current; `pressed`/`released`
   * belong to the latest tick. A new frozen object on every read.
   */
  readonly pointer: PointerSnapshot;
  /**
   * Every pointer down in the latest tick or released during it, in order of
   * first contact: a new frozen array each tick. At most 10 contacts are
   * tracked (released ones count until their tick); further contacts are
   * ignored and counted in `getStats().inputOverflows`. A contact that
   * starts in a letterbox margin (or on the canvas border/padding) is
   * ignored; a captured drag that leaves the image is clamped to its edge.
   * The context menu is suppressed only for presses on the canvas.
   */
  readonly pointers: readonly PointerSnapshot[];
  /**
   * Wheel movement accumulated since the previous tick, in lines (16 pixels
   * per line; a page is height / 8 lines, at least one), clamped to ±100 per
   * axis. It is recorded whenever the pointer is over the canvas; page
   * scrolling is prevented only while the canvas has focus.
   */
  readonly wheel: WheelSnapshot;
  /**
   * Connected gamepads with indices 0–3, polled once per tick (a new frozen
   * array each tick; empty without the Gamepad API). Edges compare two
   * consecutive polls, so a press shorter than one tick is not seen, and a
   * pad reports no edges in the first tick it appears in or after a reset.
   */
  readonly gamepads: readonly GamepadSnapshot[];
  /**
   * `button` must be a `GamepadButton` (otherwise `ARGUMENT`); `pad` is 0–3
   * (default 0, otherwise `RANGE`). A missing pad reads as not pressed.
   */
  isButtonDown(button: GamepadButton, pad?: number): boolean;
  wasButtonPressed(button: GamepadButton, pad?: number): boolean;
  wasButtonReleased(button: GamepadButton, pad?: number): boolean;
  /** A stick axis in [-1, 1] after the dead zone; 0 for a missing pad. */
  axis(name: GamepadAxis, pad?: number): number;
}
export interface EngineStats {
  readonly frames: number;
  readonly updates: number;
  readonly droppedUpdates: number;
  readonly commands: number;
  /** Key events lost to a full queue plus pointer contacts beyond the limit of 10. */
  readonly inputOverflows: number;
  /** Bytes currently allocated by the C core; not total browser memory. */
  readonly coreBytes: number;
  readonly coreAllocations: number;
  readonly renderer: RendererKind;
}
export interface LoadImageOptions {
  /** Palette index for pixels with alpha below 128. Opaque pixels map to the nearest palette color. */
  transparentIndex?: number;
  signal?: AbortSignal;
}
/** Size in pixels of the block that graphics.text() draws. */
export interface TextSize {
  readonly width: number;
  readonly height: number;
}
/** Manifest sections; also the argument of {@link AssetBundle.ids}. */
export type AssetKind = 'images' | 'tilemaps' | 'fonts' | 'sounds' | 'music' | 'data';
/**
 * A `pixeljs-assets` manifest, version 1, with at most 1,024 entries. Ids
 * match `/^[A-Za-z0-9_.-]{1,64}$/` except `__proto__`, `constructor` and
 * `prototype`, and are unique within a section (duplicate JSON keys are
 * errors). Each
 * `src` is a relative path of 1–512 characters (no scheme, leading `/`,
 * `.`, `..` or empty segment, `\`, `?`, `#`, `%`, `:` or control character)
 * resolved against the manifest file, or against `document.baseURI` for an
 * object, and never outside that directory. Unknown keys anywhere are
 * `ASSET_DATA` errors.
 */
export interface AssetManifest {
  format: 'pixeljs-assets';
  version: 1;
  /** PNG or JSON images, as loadImage; `transparentIndex` must be in the palette. */
  images?: Record<string, { src: string; transparentIndex?: number }>;
  /** Tilemap JSON, as loadTilemap; `tileset` is the id of an image in this manifest. */
  tilemaps?: Record<string, { src: string; tileset: string }>;
  /** `pixeljs-font` files, as loadFont. */
  fonts?: Record<string, { src: string }>;
  /** JSON sound descriptions, as audio.loadSound. */
  sounds?: Record<string, { src: string }>;
  /** `pixeljs-music` files, as audio.loadMusic. */
  music?: Record<string, { src: string }>;
  /** Any JSON: at most 1 MiB per entry and 16 MiB for all data entries together. */
  data?: Record<string, { src: string }>;
}
export interface LoadAssetsOptions {
  signal?: AbortSignal;
  /** Called after each entry has loaded. If it throws, the load fails with that error. */
  onProgress?: (loaded: number, total: number) => void;
}
/**
 * Resources loaded together by loadAssets. They are ordinary engine
 * resources and may also be released one by one.
 */
export interface AssetBundle {
  /** Getters throw ARGUMENT for an unknown id and STATE after release(). */
  image(id: string): ImageResource;
  tilemap(id: string): TilemapResource;
  font(id: string): FontResource;
  sound(id: string): SoundResource;
  music(id: string): MusicResource;
  /** Parsed JSON of a data entry: untrusted data for the game to validate. */
  data<T = unknown>(id: string): T;
  /**
   * The ids of one section in the order JavaScript enumerates its keys:
   * integer-like ids first, ascending, then the others in manifest order.
   * Entries of one load phase start in the same order.
   */
  ids(kind: AssetKind): readonly string[];
  /**
   * Releases every resource, tilemaps before their tilesets, and ends the
   * bundle: getters then throw STATE and further calls do nothing. Only
   * between callbacks (STATE otherwise, releasing nothing). If a resource
   * cannot be released, for example a tileset still used by a tilemap created
   * outside the bundle, the others are still released, that one stays valid
   * for engine.release() and the first error is thrown.
   */
  release(): void;
}
export interface CaptureOptions {
  /** Integer nearest-neighbor upscaling, 1–8. Default 1. */
  scale?: number;
}
export interface RecordingOptions {
  /** Seconds kept, 1–60; older frames are dropped. Default 10. */
  maxSeconds?: number;
  /** Integer nearest-neighbor upscaling applied when encoding, 1–4. Default 1. */
  scale?: number;
}
export interface Engine {
  readonly width: number;
  readonly height: number;
  readonly state: EngineState;
  readonly graphics: Graphics;
  readonly input: Input;
  readonly audio: AudioSystem;
  readonly capabilities: Readonly<{ renderer: RendererKind; audio: boolean; workers: false }>;
  start(callbacks: GameCallbacks): void;
  pause(): void;
  resume(): void;
  /** Blocks use immediately. Cleanup waits for the current callback to return. */
  dispose(): Promise<void>;
  /** Synchronous bounded upload. Only permitted between callbacks. */
  createImage(options: ImageOptions): ImageResource;
  createTilemap(options: TilemapOptions): TilemapResource;
  createFont(options: FontOptions): FontResource;
  release(resource: Resource): void;
  /**
   * Replaces the framebuffer (cleared to index 0). Resources stay valid and
   * held pointers are dropped. With `'fit'`/`'integer'` scaling the canvas
   * is fitted again, even when the size is unchanged.
   */
  resize(width: number, height: number): void;
  /**
   * Replaces every palette color. `colors` holds the same number of opaque
   * RGBA entries the engine was created with.
   */
  setPalette(colors: ArrayLike<number>): void;
  /**
   * Loads a PNG (or other browser-decodable image, at most 16 MiB and
   * 1024 × 1024 pixels) and maps it to the palette, or a JSON image
   * `{ width, height, pixels, transparentIndex? }` of at most 4 MiB.
   */
  loadImage(src: string, options?: LoadImageOptions): Promise<ImageResource>;
  /** Loads at most 1 MiB of JSON. The result is untrusted data. */
  loadJson<T = unknown>(src: string, options?: { signal?: AbortSignal }): Promise<T>;
  /** Loads `{ cols, rows, tileWidth, tileHeight, tiles }` JSON for a tileset. */
  loadTilemap(
    src: string,
    options: { tileset: ImageResource; signal?: AbortSignal },
  ): Promise<TilemapResource>;
  getStats(): EngineStats;
  /**
   * Palette index at (x, y) in the last submitted frame. During draw() this
   * is still the previous frame: this frame's commands run after draw().
   */
  readPixel(x: number, y: number): number;
  /**
   * Loads a font file of at most 1 MiB: `{ "format": "pixeljs-font",
   * "version": 1, "glyphWidth": 1–64, "glyphHeight": 1–64, "firstChar"?,
   * "charCount"?, "fallbackChar"? }` (as createFont) plus exactly one of
   * `"bitmap"`, base64 of the createFont bitmap, or `"glyphs"`, charCount
   * arrays of glyphHeight strings of glyphWidth `#` (on) and `.` (off)
   * characters. Invalid files (unknown or duplicate keys, a newer version)
   * reject with ASSET_DATA, larger ones with CAPACITY, request failures with
   * ASSET_LOAD; ABORTED and STATE as for loadImage.
   */
  loadFont(src: string, options?: { signal?: AbortSignal }): Promise<FontResource>;
  /**
   * The size graphics.text() would draw: glyph width per code unit (8 for
   * the built-in font), glyph height per line; `\r` is ignored and the
   * empty string measures 0 × 0. Allowed in any phase until disposal
   * (STATE); a non-string is ARGUMENT and a foreign or released font HANDLE.
   */
  measureText(text: string, font?: FontResource): TextSize;
  /**
   * Loads every entry of a manifest (a URL of at most 1 MiB of JSON, or an
   * object), at most 4 at a time: images and data first, then fonts,
   * sounds and music, then tilemaps once their tilesets exist. The manifest is validated first: ASSET_DATA for its
   * structure (unknown sections included), CAPACITY above 1 MiB or 1,024
   * entries, ASSET_LOAD when it cannot be fetched and ARGUMENT for a
   * manifest that is neither a string nor an object. All or nothing: on
   * any failure the pending loads are cancelled, every resource already
   * created is released and the promise rejects with that entry's error
   * code (the original error as `cause`), the error thrown by `onProgress`,
   * ABORTED when `signal` aborts, or STATE when the engine is disposed.
   */
  loadAssets(manifest: string | AssetManifest, options?: LoadAssetsOptions): Promise<AssetBundle>;
  /**
   * PNG of the last presented frame at its logical size times `scale`, in the
   * colors it was presented with, whatever the renderer. The frame is copied
   * during the call, so later frames never change the result. Rejects with
   * STATE before the first presented frame (and after resize() until the
   * next one), while another capture is pending, or when the engine is
   * disposed before the PNG is ready; RANGE for another scale.
   */
  capture(options?: CaptureOptions): Promise<Blob>;
  /**
   * Starts copying presented frames: at most 50 per second, the last
   * `maxSeconds` and at most 64 MiB of frame data. Nothing is copied while
   * not recording or while paused; resize() discards frames of the old size.
   * Recording time follows the update clock: a pause, hidden tab or stall
   * between two frames counts at most 0.25 s, so it cannot freeze the GIF.
   * Throws STATE while recording or while the previous recording is encoding,
   * and RANGE for options out of range.
   */
  startRecording(options?: RecordingOptions): void;
  /**
   * Stops recording and encodes a looping GIF in slices that keep the page
   * responsive. Rejects with STATE when not recording, when no frame was
   * recorded or when the engine is disposed first, and with CAPACITY if the
   * GIF would exceed 256 MiB or memory ran out while copying frames.
   */
  stopRecording(): Promise<Blob>;
  /** True between startRecording() and stopRecording(). */
  readonly recording: boolean;
}

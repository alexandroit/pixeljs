import { flag, integer, PixelJSError, record } from './errors.js';
import type {
  AssetBundle,
  AssetKind,
  AssetManifest,
  AudioSystem,
  CaptureOptions,
  Engine,
  EngineOptions,
  EngineState,
  EngineStats,
  FontOptions,
  FontResource,
  GameCallbacks,
  Graphics,
  ImageOptions,
  ImageResource,
  Input,
  LoadAssetsOptions,
  LoadImageOptions,
  RecordingOptions,
  Resource as EngineResource,
  SoundInstance,
  MusicOptions,
  MusicResource,
  SoundOptions,
  SoundResource,
  SpriteOptions,
  TextOptions,
  TextSize,
  TilemapDrawOptions,
  TilemapOptions,
  TilemapResource,
} from './types.js';
import { inputFacade, WebInput } from '../host/web/input.js';
import { createRenderer, type Renderer } from '../host/web/renderer.js';
import { scalingMode } from '../host/web/viewport.js';
import { linkedSignal, loadBundle, type EntryLoader } from '../internal/assets/bundle.js';
import { parseFontFile, textSize } from '../internal/assets/font-format.js';
import { parseStrictJson } from '../internal/assets/json.js';
import { MANIFEST_LIMITS, parseManifest } from '../internal/assets/manifest.js';
import { AudioController } from '../internal/audio/controller.js';
import { FrameCapture } from '../internal/capture/service.js';
import { CommandWriter } from '../internal/commands.js';
import {
  assetUrl,
  checkSignal,
  fetchLimited,
  parseJson,
  throwIfAborted,
} from '../internal/fetch.js';
import { decodeImage } from '../internal/image-decoder.js';
import { FLAGS, OPCODE, PROTOCOL } from '../internal/protocol.js';
import { loadWasm, type WasmAdapter } from '../internal/wasm/adapter.js';

type Phase = 'IDLE' | 'UPDATE' | 'BUILD_DRAW' | 'SUBMIT' | 'PRESENT';
type PauseReason = 'manual' | 'hidden' | 'context-lost' | 'callback-error';
type ResourceKind = 'image' | 'tilemap' | 'font' | 'sound' | 'music';
interface Resource {
  kind: ResourceKind;
  handle: number;
  released: boolean;
}
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const coord = (value: unknown, name: string): number => integer(value, name, INT32_MIN, INT32_MAX);
const extent = (value: unknown, name: string): number => integer(value, name, 0, INT32_MAX);
const ellipseExtent = (value: unknown, name: string): number =>
  integer(value, name, 0, PROTOCOL.maxEllipseDimension);

/** Degrees (clockwise on screen) to 1/4096 turns; any finite angle is accepted. */
function angleUnits(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new PixelJSError('RANGE', 'rotation must be a finite number of degrees.');
  const units = Math.round((value / 360) * PROTOCOL.angleUnits) % PROTOCOL.angleUnits;
  return units < 0 ? units + PROTOCOL.angleUnits : units;
}

/** Scale factor to 1/65536 units, 1/16 to 64. */
function scaleUnits(value: unknown): number {
  const min = PROTOCOL.minScale / 65536;
  const max = PROTOCOL.maxScale / 65536;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new PixelJSError('RANGE', `scale must be a number between ${min} and ${max}.`);
  return Math.min(PROTOCOL.maxScale, Math.max(PROTOCOL.minScale, Math.round(value * 65536)));
}
/** Asset byte limits; decoded images are further limited to 1024 × 1024 pixels. */
const LIMITS = Object.freeze({
  imageFile: 16 * 1024 * 1024,
  jsonImage: 4 * 1024 * 1024,
  json: 1024 * 1024,
});

/** Validates a flattened opaque RGBA palette of 1–256 entries (or exactly `count`). */
function paletteBytes(colors: unknown, count?: number): Uint8Array {
  const length =
    typeof colors === 'object' && colors !== null
      ? (colors as ArrayLike<unknown>).length
      : undefined;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 4 ||
    length > PROTOCOL.maxPaletteColors * 4 ||
    length % 4 !== 0 ||
    (count !== undefined && length !== count * 4)
  )
    throw new PixelJSError(
      'ARGUMENT',
      count === undefined
        ? 'The palette must contain 1 to 256 RGBA entries (a length that is a multiple of 4).'
        : `The palette must contain exactly ${count} RGBA entries, the size chosen at creation.`,
    );
  const source = colors as ArrayLike<unknown>;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = integer(source[index], `palette[${index}]`, 0, 255);
    if (index % 4 === 3 && bytes[index] !== 255)
      throw new PixelJSError('RANGE', `palette[${index}] must be 255: palette colors are opaque.`);
  }
  return bytes;
}

/** Internal controller is never returned. The public facade cannot reveal the adapter. */
class Controller {
  state: EngineState = 'READY';
  private phase: Phase = 'IDLE';
  private callbacks: GameCallbacks | null = null;
  private readonly pauses = new Set<PauseReason>();
  private raf: number | null = null;
  private lastTime: number | null = null;
  private accumulator = 0;
  private frames = 0;
  private updates = 0;
  private droppedUpdates = 0;
  private commands = 0;
  private finalAllocations = 0;
  private disposal: Promise<void> | null = null;
  private resolveDisposal: (() => void) | null = null;
  private rejectDisposal: ((error: unknown) => void) | null = null;
  private notifying = false;
  private failed = false;
  private readonly resources = new WeakMap<object, Resource>();
  private readonly writer: CommandWriter;
  private readonly webInput: WebInput;
  readonly input: Input;
  readonly graphics: Graphics;
  readonly audioController: AudioController;
  readonly audio: AudioSystem;
  private readonly window: Window;
  private readonly step: number;
  readonly paletteCount: number;
  width: number;
  height: number;
  private epoch = 0;
  /** Aborted by disposal, so that multi-request loads stop at once. */
  private readonly lifetime = new AbortController();
  private readonly snapshots: FrameCapture;
  // Capacitor and Cordova shells report the app going to the background with
  // `pause`/`resume` document events; Android WebView keeps the page visible.
  private shellPaused = false;
  private readonly visibility = (event?: Event): void => {
    if (event?.type === 'pause') this.shellPaused = true;
    else if (event?.type === 'resume') this.shellPaused = false;
    this.setPause('hidden', this.canvas.ownerDocument.hidden || this.shellPaused);
  };
  private readonly contextLost = (event: Event): void => {
    event.preventDefault();
    this.setPause('context-lost', true);
  };
  private readonly contextRestored = (): void => {
    if (!this.usable() || !this.pauses.has('context-lost')) return;
    try {
      this.renderer.restore();
      this.setPause('context-lost', false);
    } catch (error) {
      this.fail(error, true);
    }
  };

  constructor(
    private readonly core: WasmAdapter,
    private readonly renderer: Renderer,
    private readonly canvas: HTMLCanvasElement,
    width: number,
    height: number,
    updateHz: number,
    options: EngineOptions,
    private readonly onError?: (error: Error) => void,
  ) {
    const view = canvas.ownerDocument.defaultView;
    if (!view)
      throw new PixelJSError(
        'UNSUPPORTED',
        'The canvas must belong to an active browser document.',
      );
    this.window = view;
    this.width = width;
    this.height = height;
    this.paletteCount = core.paletteCount;
    this.step = 1 / updateHz;
    this.writer = new CommandWriter(core);
    this.webInput = new WebInput(canvas, width, height, options.scaling);
    // Optional audio reports failures without pausing the visual game.
    const audio = new AudioController(options, (error) => this.notify(error));
    this.audioController = audio;
    this.audio = Object.freeze({
      get capabilities() {
        return audio.capabilities;
      },
      unlock: () => audio.unlock(),
      play: (sound?: SoundOptions | SoundResource, voice?: number) => {
        this.active();
        if (sound !== undefined && typeof sound === 'object' && sound !== null) {
          const entry = this.resources.get(sound);
          if (entry && (entry.kind !== 'sound' || entry.released))
            throw new PixelJSError('HANDLE', 'Expected a sound that has not been released.');
        }
        return audio.play(sound, voice);
      },
      stop: (instance?: SoundInstance) => {
        this.active();
        audio.stop(instance);
      },
      setVolume: (volume: number) => {
        this.active();
        audio.setVolume(volume);
      },
      createSound: (soundOptions: SoundOptions) => {
        this.idle();
        return this.track(audio.createSound(soundOptions), 'sound', 0);
      },
      loadSound: async (src: string, loadOptions?: { signal?: AbortSignal }) => {
        this.active();
        const epoch = this.epoch;
        const sound = await audio.loadSound(src, loadOptions);
        this.current(epoch);
        return this.track(sound, 'sound', 0);
      },
      createMusic: (musicOptions: MusicOptions) => {
        this.idle();
        return this.track(audio.createMusic(musicOptions), 'music', 0);
      },
      loadMusic: async (src: string, loadOptions?: { signal?: AbortSignal }) => {
        this.active();
        const epoch = this.epoch;
        const music = await audio.loadMusic(src, loadOptions);
        this.current(epoch);
        return this.track(music, 'music', 0);
      },
      playMusic: (music: MusicResource, playOptions?: { loop?: boolean }) => {
        this.active();
        const entry =
          typeof music === 'object' && music !== null ? this.resources.get(music) : undefined;
        if (!entry || entry.kind !== 'music' || entry.released)
          throw new PixelJSError(
            'HANDLE',
            'Expected music created by this engine and not released.',
          );
        audio.playMusic(music, playOptions);
      },
      stopMusic: () => {
        this.active();
        audio.stopMusic();
      },
      get musicPlaying() {
        return audio.musicPlaying;
      },
    });
    this.input = inputFacade(this.webInput, () => this.active());
    this.graphics = this.makeGraphics();
    this.snapshots = new FrameCapture({
      paletteCount: this.paletteCount,
      width: () => this.width,
      height: () => this.height,
      paletteRevision: () => core.paletteRevision,
      copyFrame: (target) => core.copyFrame(target),
      copyPalette: () => core.copyPalette(),
    });
    for (const type of ['visibilitychange', 'pause', 'resume'])
      canvas.ownerDocument.addEventListener(type, this.visibility);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.addEventListener('webglcontextrestored', this.contextRestored);
    if (canvas.ownerDocument.hidden) {
      this.pauses.add('hidden');
      this.audioController.onPause('hidden');
    }
  }
  private usable(): boolean {
    return this.state !== 'DISPOSING' && this.state !== 'DISPOSED' && this.state !== 'FAILED';
  }
  private active(): void {
    if (!this.usable()) throw new PixelJSError('STATE', `Engine is ${this.state.toLowerCase()}.`);
  }
  /** After an await: the engine must still be the one that started the load. */
  private current(epoch: number, signal?: AbortSignal): void {
    if (this.epoch !== epoch || !this.usable())
      throw new PixelJSError('STATE', 'The engine was disposed while loading.');
    throwIfAborted(signal);
  }
  private idle(): void {
    this.active();
    if (this.phase !== 'IDLE')
      throw new PixelJSError(
        'STATE',
        'Resource and loop changes must happen outside update/draw callbacks.',
      );
  }
  private drawing(): void {
    this.active();
    if (this.phase !== 'BUILD_DRAW')
      throw new PixelJSError('STATE', 'Graphics commands are only allowed inside draw().');
  }
  color(value: unknown): number {
    return integer(value, 'color', 0, this.paletteCount - 1);
  }
  private track<T extends object>(value: T, kind: ResourceKind, handle: number): T {
    this.resources.set(value, { kind, handle, released: false });
    return value;
  }
  private resource(value: unknown, kind: ResourceKind): Resource {
    const entry =
      typeof value === 'object' && value !== null ? this.resources.get(value) : undefined;
    if (!entry || entry.kind !== kind)
      throw new PixelJSError('HANDLE', `Expected a ${kind} created by this engine.`);
    if (entry.released) throw new PixelJSError('HANDLE', `The ${kind} was released.`);
    return entry;
  }
  private upload(kind: number, bytes: Uint8Array): number {
    try {
      this.idle();
      return this.core.upload(kind, bytes);
    } catch (error) {
      this.trap(error);
      throw error;
    }
  }
  private makeGraphics(): Graphics {
    return Object.freeze({
      clear: (index: number): void => {
        this.drawing();
        this.writer.write(OPCODE.CLEAR, 0, this.color(index));
      },
      pixel: (x: number, y: number, index: number): void => {
        this.drawing();
        this.writer.write(OPCODE.PIXEL, 0, coord(x, 'x'), coord(y, 'y'), this.color(index));
      },
      line: (x0: number, y0: number, x1: number, y1: number, index: number): void => {
        this.drawing();
        this.writer.write(
          OPCODE.LINE,
          0,
          coord(x0, 'x0'),
          coord(y0, 'y0'),
          coord(x1, 'x1'),
          coord(y1, 'y1'),
          this.color(index),
        );
      },
      rect: (x: number, y: number, width: number, height: number, index: number): void => {
        this.drawing();
        this.writer.write(
          OPCODE.RECT,
          0,
          coord(x, 'x'),
          coord(y, 'y'),
          extent(width, 'width'),
          extent(height, 'height'),
          this.color(index),
        );
      },
      rectb: (x: number, y: number, width: number, height: number, index: number): void => {
        this.drawing();
        this.writer.write(
          OPCODE.RECTB,
          0,
          coord(x, 'x'),
          coord(y, 'y'),
          extent(width, 'width'),
          extent(height, 'height'),
          this.color(index),
        );
      },
      circle: (x: number, y: number, radius: number, index: number): void => {
        this.drawing();
        this.writer.write(
          OPCODE.CIRCLE,
          0,
          coord(x, 'x'),
          coord(y, 'y'),
          extent(radius, 'radius'),
          this.color(index),
        );
      },
      circleFill: (x: number, y: number, radius: number, index: number): void => {
        this.drawing();
        this.writer.write(
          OPCODE.CIRCLE_FILL,
          0,
          coord(x, 'x'),
          coord(y, 'y'),
          extent(radius, 'radius'),
          this.color(index),
        );
      },
      glyph: (
        x: number,
        y: number,
        charCode: number,
        col: number,
        font?: FontResource,
        background?: number,
      ): void => {
        this.drawing();
        const handle = font === undefined ? 0 : this.resource(font, 'font').handle;
        const bg = background === undefined ? -1 : this.color(background);
        this.writer.write(
          OPCODE.GLYPH,
          handle,
          coord(x, 'x'),
          coord(y, 'y'),
          integer(charCode, 'charCode', 0, PROTOCOL.maxCharCode),
          this.color(col),
          bg,
        );
      },
      text: (
        x: number,
        y: number,
        content: string,
        col: number,
        options: TextOptions = {},
      ): void => {
        this.drawing();
        record(options, 'text options');
        const { font, background } = options as TextOptions;
        if (typeof content !== 'string')
          throw new PixelJSError('ARGUMENT', 'text must be a string.');
        const fg = this.color(col);
        const bg = background === undefined ? -1 : this.color(background);
        let handle = 0;
        let advance = 8;
        let lineHeight = 8;
        if (font !== undefined) {
          handle = this.resource(font, 'font').handle;
          advance = font.glyphWidth;
          lineHeight = font.glyphHeight;
        }
        const startX = coord(x, 'x');
        let penX = startX;
        let penY = coord(y, 'y');
        this.drawing();
        for (let i = 0; i < content.length; i++) {
          const code = content.charCodeAt(i);
          if (code === 10) {
            penY += lineHeight;
            penX = startX;
          } else if (code !== 13) {
            // Glyphs past the int32 coordinate range could never be visible.
            if (penX <= INT32_MAX && penY <= INT32_MAX)
              this.writer.write(OPCODE.GLYPH, handle, penX, penY, code, fg, bg);
            penX += advance;
          }
        }
      },
      sprite: (image: ImageResource, x: number, y: number, options: SpriteOptions = {}): void => {
        this.drawing();
        record(options, 'sprite options');
        const resource = this.resource(image, 'image');
        const {
          flipX,
          flipY,
          sourceX = 0,
          sourceY = 0,
          width = image.width,
          height = image.height,
          rotation = 0,
          scale = 1,
        } = options;
        const flags =
          (flag(flipX, 'flipX') ? FLAGS.FLIP_X : 0) | (flag(flipY, 'flipY') ? FLAGS.FLIP_Y : 0);
        const sx = coord(sourceX, 'sourceX');
        const sy = coord(sourceY, 'sourceY');
        const w = extent(width, 'width');
        const h = extent(height, 'height');
        const dx = coord(x, 'x');
        const dy = coord(y, 'y');
        const turn = angleUnits(rotation);
        const factor = scaleUnits(scale);
        this.drawing();
        if (turn === 0 && factor === 65536) {
          this.writer.write(OPCODE.BLIT, resource.handle, dx, dy, sx, sy, w, h, flags);
          return;
        }
        // Rotated or scaled sprites read a source rectangle inside the image.
        if (sx < 0 || sy < 0 || sx + w > image.width || sy + h > image.height)
          throw new PixelJSError(
            'RANGE',
            'A rotated or scaled sprite needs a source rectangle inside the image.',
          );
        this.writer.writeWithParams(
          OPCODE.BLIT_TRANSFORM,
          resource.handle,
          [dx, dy, sx, sy, w, h],
          flags,
          [turn, factor, 0, 0, 0, 0],
        );
      },
      ellipse: (x: number, y: number, width: number, height: number, index: number): void => {
        this.drawing();
        this.writer.write(
          OPCODE.ELLIPSE,
          0,
          coord(x, 'x'),
          coord(y, 'y'),
          ellipseExtent(width, 'width'),
          ellipseExtent(height, 'height'),
          this.color(index),
        );
      },
      ellipseFill: (x: number, y: number, width: number, height: number, index: number): void => {
        this.drawing();
        this.writer.write(
          OPCODE.ELLIPSE_FILL,
          0,
          coord(x, 'x'),
          coord(y, 'y'),
          ellipseExtent(width, 'width'),
          ellipseExtent(height, 'height'),
          this.color(index),
        );
      },
      triangle: (
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        index: number,
      ): void => {
        this.drawing();
        this.writer.writeWithParams(
          OPCODE.TRIANGLE,
          0,
          [
            coord(x0, 'x0'),
            coord(y0, 'y0'),
            coord(x1, 'x1'),
            coord(y1, 'y1'),
            coord(x2, 'x2'),
            coord(y2, 'y2'),
          ],
          0,
          [this.color(index), 0, 0, 0, 0, 0],
        );
      },
      triangleFill: (
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        index: number,
      ): void => {
        this.drawing();
        this.writer.writeWithParams(
          OPCODE.TRIANGLE_FILL,
          0,
          [
            coord(x0, 'x0'),
            coord(y0, 'y0'),
            coord(x1, 'x1'),
            coord(y1, 'y1'),
            coord(x2, 'x2'),
            coord(y2, 'y2'),
          ],
          0,
          [this.color(index), 0, 0, 0, 0, 0],
        );
      },
      fill: (x: number, y: number, index: number): void => {
        this.drawing();
        this.writer.write(OPCODE.FILL, 0, coord(x, 'x'), coord(y, 'y'), this.color(index));
      },
      remap: (from: number, to: number): void => {
        this.drawing();
        this.writer.write(OPCODE.SET_REMAP, 0, this.color(from), this.color(to));
      },
      resetRemap: (): void => {
        this.drawing();
        this.writer.write(OPCODE.RESET_REMAP);
      },
      tilemap: (
        map: TilemapResource,
        x: number,
        y: number,
        options: TilemapDrawOptions = {},
      ): void => {
        this.drawing();
        record(options, 'tilemap options');
        const resource = this.resource(map, 'tilemap');
        const startCol = options.startCol !== undefined ? extent(options.startCol, 'startCol') : 0;
        const startRow = options.startRow !== undefined ? extent(options.startRow, 'startRow') : 0;
        const cols = options.cols !== undefined ? extent(options.cols, 'cols') : map.cols;
        const rows = options.rows !== undefined ? extent(options.rows, 'rows') : map.rows;
        this.drawing();
        this.writer.write(
          OPCODE.TILEMAP,
          resource.handle,
          coord(x, 'x'),
          coord(y, 'y'),
          startCol,
          startRow,
          cols,
          rows,
        );
      },
      setPaletteColor: (index: number, red: number, green: number, blue: number): void => {
        this.drawing();
        this.writer.write(
          OPCODE.SET_PALETTE,
          0,
          this.color(index),
          integer(red, 'red', 0, 255),
          integer(green, 'green', 0, 255),
          integer(blue, 'blue', 0, 255),
        );
      },
      setCamera: (x: number, y: number): void => {
        this.drawing();
        this.writer.write(OPCODE.SET_CAMERA, 0, coord(x, 'x'), coord(y, 'y'));
      },
      setClip: (x: number, y: number, width: number, height: number): void => {
        this.drawing();
        this.writer.write(
          OPCODE.SET_CLIP,
          0,
          coord(x, 'x'),
          coord(y, 'y'),
          extent(width, 'width'),
          extent(height, 'height'),
        );
      },
      resetClip: (): void => {
        this.drawing();
        this.writer.write(OPCODE.RESET_CLIP);
      },
    });
  }
  createImage(options: ImageOptions): ImageResource {
    this.idle();
    record(options, 'image options');
    const { width: rawWidth, height: rawHeight, pixels, transparentIndex } = options;
    this.idle();
    const width = integer(rawWidth, 'image width', 1, PROTOCOL.maxDimension);
    const height = integer(rawHeight, 'image height', 1, PROTOCOL.maxDimension);
    const count = width * height;
    if (count > PROTOCOL.maxImagePixels)
      throw new PixelJSError('RANGE', `Images are limited to ${PROTOCOL.maxImagePixels} pixels.`);
    if (!(pixels instanceof Uint8Array) || pixels.length !== count)
      throw new PixelJSError(
        'ARGUMENT',
        'Image pixels must be a Uint8Array with exactly width * height indices.',
      );
    for (const index of pixels) this.color(index);
    const transparent =
      transparentIndex === undefined ? PROTOCOL.noTransparency : this.color(transparentIndex);
    const bytes = new Uint8Array(PROTOCOL.headerBytes + count);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x4d495850, true);
    view.setUint32(4, PROTOCOL.imageVersion, true);
    view.setUint32(8, width, true);
    view.setUint32(12, height, true);
    view.setUint32(16, transparent, true);
    view.setUint32(20, bytes.length, true);
    bytes.set(pixels, PROTOCOL.headerBytes);
    const handle = this.upload(PROTOCOL.imageKind, bytes);
    return this.track(Object.freeze({ width, height }) as ImageResource, 'image', handle);
  }
  createTilemap(options: TilemapOptions): TilemapResource {
    this.idle();
    record(options, 'tilemap options');
    const {
      cols: rawCols,
      rows: rawRows,
      tileWidth: rawTW,
      tileHeight: rawTH,
      tileset,
      tiles,
    } = options;
    this.idle();
    const cols = integer(rawCols, 'cols', 1, PROTOCOL.maxDimension);
    const rows = integer(rawRows, 'rows', 1, PROTOCOL.maxDimension);
    const tileWidth = integer(rawTW, 'tileWidth', 1, PROTOCOL.maxTileDimension);
    const tileHeight = integer(rawTH, 'tileHeight', 1, PROTOCOL.maxTileDimension);
    const tilesetResource = this.resource(tileset, 'image');
    const count = cols * rows;
    if (count > PROTOCOL.maxImagePixels)
      throw new PixelJSError('RANGE', `Tilemaps are limited to ${PROTOCOL.maxImagePixels} cells.`);
    const tilesPerRow = Math.floor(tileset.width / tileWidth);
    const tileCount = tilesPerRow * Math.floor(tileset.height / tileHeight);
    if (tileCount === 0) throw new PixelJSError('RANGE', 'The tileset is smaller than one tile.');
    if (typeof tiles !== 'object' || tiles === null || tiles.length !== count)
      throw new PixelJSError(
        'ARGUMENT',
        `Tilemap tiles must have exactly cols * rows (${count}) entries.`,
      );
    const totalBytes = PROTOCOL.headerBytes + count * 2;
    const bytes = new Uint8Array(totalBytes);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x4d545850, true);
    view.setUint32(4, PROTOCOL.tilemapVersion, true);
    view.setUint32(8, cols, true);
    view.setUint32(12, rows, true);
    view.setUint32(16, tileWidth, true);
    view.setUint32(20, tileHeight, true);
    view.setUint32(24, tilesetResource.handle, true);
    view.setUint32(28, totalBytes, true);
    for (let i = 0; i < count; i++) {
      const tile = integer(tiles[i], `tiles[${i}]`, 0, PROTOCOL.emptyTile);
      if (tile !== PROTOCOL.emptyTile && tile >= tileCount)
        throw new PixelJSError(
          'RANGE',
          `tiles[${i}] must be below ${tileCount} (the tileset's tile count) or EMPTY_TILE.`,
        );
      view.setUint16(PROTOCOL.headerBytes + i * 2, tile, true);
    }
    const handle = this.upload(PROTOCOL.tilemapKind, bytes);
    const map = Object.freeze({ cols, rows, tileWidth, tileHeight, tileset }) as TilemapResource;
    return this.track(map, 'tilemap', handle);
  }
  createFont(options: FontOptions): FontResource {
    this.idle();
    record(options, 'font options');
    const {
      glyphWidth: rawGW,
      glyphHeight: rawGH,
      firstChar: rawFC = 32,
      charCount: rawCC = 96,
      fallbackChar: rawFB,
      bitmap,
    } = options;
    this.idle();
    const glyphWidth = integer(rawGW, 'glyphWidth', 1, PROTOCOL.maxGlyphDimension);
    const glyphHeight = integer(rawGH, 'glyphHeight', 1, PROTOCOL.maxGlyphDimension);
    const firstChar = integer(rawFC, 'firstChar', 0, PROTOCOL.maxCharCode);
    const charCount = integer(
      rawCC,
      'charCount',
      1,
      Math.min(PROTOCOL.maxGlyphs, PROTOCOL.maxCharCode - firstChar + 1),
    );
    const lastChar = firstChar + charCount - 1;
    const fallbackChar =
      rawFB === undefined
        ? firstChar <= 63 && 63 <= lastChar
          ? 63
          : firstChar
        : integer(rawFB, 'fallbackChar', firstChar, lastChar);
    const bytesPerGlyph = glyphHeight * Math.ceil(glyphWidth / 8);
    const expectedBytes = charCount * bytesPerGlyph;
    if (!(bitmap instanceof Uint8Array) || bitmap.byteLength !== expectedBytes)
      throw new PixelJSError(
        'ARGUMENT',
        `Font bitmap must have exactly charCount * glyphHeight * ceil(glyphWidth / 8) (${expectedBytes}) bytes.`,
      );
    const totalBytes = PROTOCOL.headerBytes + expectedBytes;
    const bytes = new Uint8Array(totalBytes);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x4e465850, true);
    view.setUint32(4, PROTOCOL.fontVersion, true);
    view.setUint32(8, glyphWidth, true);
    view.setUint32(12, glyphHeight, true);
    view.setUint32(16, firstChar, true);
    view.setUint32(20, charCount, true);
    view.setUint32(24, fallbackChar, true);
    view.setUint32(28, totalBytes, true);
    bytes.set(bitmap, PROTOCOL.headerBytes);
    const handle = this.upload(PROTOCOL.fontKind, bytes);
    const font = Object.freeze({ glyphWidth, glyphHeight, firstChar, charCount, fallbackChar });
    return this.track(font as FontResource, 'font', handle);
  }
  release(resource: EngineResource): void {
    this.idle();
    if (typeof resource !== 'object' || resource === null)
      throw new PixelJSError('HANDLE', 'Expected a resource created by this engine.');
    const entry = this.resources.get(resource);
    if (!entry) throw new PixelJSError('HANDLE', 'Resource belongs to another engine.');
    if (entry.released) return;
    try {
      if (entry.handle !== 0) this.core.release(entry.handle);
      entry.released = true;
      if (entry.kind === 'sound' || entry.kind === 'music')
        this.audioController.markReleased(resource);
    } catch (error) {
      this.trap(error);
      throw error;
    }
  }
  resize(width: number, height: number): void {
    this.idle();
    const w = integer(width, 'width', 1, PROTOCOL.maxDimension);
    const h = integer(height, 'height', 1, PROTOCOL.maxDimension);
    if (w === this.width && h === this.height) {
      this.webInput.refit();
      return;
    }
    try {
      this.core.resize(w, h);
    } catch (error) {
      // The core keeps its previous framebuffer; nothing else changed yet.
      this.trap(error);
      throw error;
    }
    this.snapshots.frameReplaced();
    try {
      this.width = w;
      this.height = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.renderer.resize(w, h);
      this.webInput.resize(w, h);
    } catch (error) {
      // Core and presentation sizes now disagree: the engine cannot continue.
      this.fail(error, true);
      throw error;
    }
  }
  setPalette(colors: ArrayLike<number>): void {
    this.idle();
    const bytes = paletteBytes(colors, this.paletteCount);
    try {
      this.idle();
      this.snapshots.paletteChanging();
      this.core.setPalette(bytes);
    } catch (error) {
      this.trap(error);
      throw error;
    }
  }
  async loadImage(src: string, options: LoadImageOptions = {}): Promise<ImageResource> {
    this.active();
    record(options, 'loadImage options');
    const url = assetUrl(src, 'src');
    const signal = checkSignal(options.signal);
    const transparentIndex =
      options.transparentIndex === undefined ? undefined : this.color(options.transparentIndex);
    const epoch = this.epoch;
    const { bytes, contentType } = await fetchLimited(url, {
      limit: LIMITS.imageFile,
      code: 'ASSET_LOAD',
      signal,
    });
    this.current(epoch, signal);
    if (contentType.includes('json') || url.pathname.endsWith('.json')) {
      if (bytes.byteLength > LIMITS.jsonImage)
        throw new PixelJSError('CAPACITY', 'JSON images are limited to 4 MiB.');
      return this.jsonImage(parseJson(bytes, 'ASSET_DATA'), transparentIndex);
    }
    const decoded = await decodeImage(bytes, {
      palette: this.core.palette,
      paletteCount: this.paletteCount,
      transparentIndex,
      document: this.canvas.ownerDocument,
      // Decoding is the slow part: skip pixel reading and palette mapping
      // once the load is cancelled or the engine is disposed.
      check: () => this.current(epoch, signal),
    });
    this.current(epoch, signal);
    const image: ImageOptions = {
      width: decoded.width,
      height: decoded.height,
      pixels: decoded.pixels,
    };
    if (transparentIndex !== undefined) image.transparentIndex = transparentIndex;
    return this.createImage(image);
  }
  private jsonImage(data: unknown, transparentOverride: number | undefined): ImageResource {
    record(data, 'image JSON');
    const width = integer(data['width'], 'image width', 1, PROTOCOL.maxDimension);
    const height = integer(data['height'], 'image height', 1, PROTOCOL.maxDimension);
    const source = data['pixels'];
    if (!Array.isArray(source) || source.length !== width * height)
      throw new PixelJSError('ASSET_DATA', 'Image JSON pixels must list width * height indices.');
    // Validate every value before narrowing: 256 must never become index 0.
    const pixels = Uint8Array.from(source, (value, index) =>
      integer(value, `pixels[${index}]`, 0, this.paletteCount - 1),
    );
    const image: ImageOptions = { width, height, pixels };
    const transparent = data['transparentIndex'] ?? transparentOverride;
    if (transparent !== undefined) image.transparentIndex = this.color(transparent);
    return this.createImage(image);
  }
  async loadJson<T = unknown>(src: string, options: { signal?: AbortSignal } = {}): Promise<T> {
    this.active();
    record(options, 'loadJson options');
    const url = assetUrl(src, 'src');
    const signal = checkSignal(options.signal);
    const epoch = this.epoch;
    const { bytes } = await fetchLimited(url, { limit: LIMITS.json, code: 'ASSET_LOAD', signal });
    this.current(epoch, signal);
    return parseJson(bytes, 'ASSET_DATA') as T;
  }
  async loadTilemap(
    src: string,
    options: { tileset: ImageResource; signal?: AbortSignal },
  ): Promise<TilemapResource> {
    this.active();
    record(options, 'loadTilemap options');
    const { tileset, signal } = options;
    this.resource(tileset, 'image');
    const epoch = this.epoch;
    const data = await this.loadJson(src, signal === undefined ? {} : { signal });
    this.current(epoch, signal);
    record(data, 'tilemap JSON');
    return this.createTilemap({
      cols: data['cols'] as number,
      rows: data['rows'] as number,
      tileWidth: data['tileWidth'] as number,
      tileHeight: data['tileHeight'] as number,
      tileset,
      tiles: data['tiles'] as ArrayLike<number>,
    });
  }
  async loadFont(src: string, options: { signal?: AbortSignal } = {}): Promise<FontResource> {
    this.active();
    record(options, 'loadFont options');
    const url = assetUrl(src, 'src');
    const signal = checkSignal(options.signal);
    const epoch = this.epoch;
    const { bytes } = await fetchLimited(url, { limit: LIMITS.json, code: 'ASSET_LOAD', signal });
    this.current(epoch, signal);
    return this.createFont(parseFontFile(parseStrictJson(bytes, 'The font file')));
  }
  measureText(content: string, font?: FontResource): TextSize {
    this.active();
    if (typeof content !== 'string') throw new PixelJSError('ARGUMENT', 'text must be a string.');
    if (font === undefined) return Object.freeze(textSize(content, 8, 8));
    this.resource(font, 'font');
    return Object.freeze(textSize(content, font.glyphWidth, font.glyphHeight));
  }
  async loadAssets(
    manifest: string | AssetManifest,
    options: LoadAssetsOptions = {},
  ): Promise<AssetBundle> {
    this.active();
    if (typeof manifest !== 'string' && (typeof manifest !== 'object' || manifest === null))
      throw new PixelJSError('ARGUMENT', 'manifest must be a URL string or a manifest object.');
    record(options, 'loadAssets options');
    const signal = checkSignal(options.signal);
    const onProgress = options.onProgress as unknown;
    if (onProgress !== undefined && typeof onProgress !== 'function')
      throw new PixelJSError('ARGUMENT', 'onProgress must be a function.');
    const epoch = this.epoch;
    let data: unknown = manifest;
    let base: URL;
    if (typeof manifest === 'string') {
      // Disposal cancels the manifest request too, not only the entries.
      const linked = linkedSignal([signal, this.lifetime.signal]);
      try {
        const response = await fetchLimited(assetUrl(manifest, 'manifest'), {
          limit: MANIFEST_LIMITS.bytes,
          code: 'ASSET_LOAD',
          signal: linked.signal,
        });
        this.current(epoch, signal);
        data = parseStrictJson(response.bytes, 'The asset manifest');
        // Entries resolve against the manifest's final URL, after redirects.
        base = response.url;
      } catch (error) {
        this.current(epoch, signal);
        throw error;
      } finally {
        linked.detach();
      }
    } else {
      this.current(epoch, signal);
      base = assetUrl('./', 'manifest base');
    }
    const parsed = parseManifest(data, base, this.paletteCount);
    return loadBundle(
      parsed,
      {
        loaders: this.assetLoaders(epoch),
        release: (value) => this.release(value as EngineResource),
        check: () => this.current(epoch, signal),
        idle: () => this.idle(),
        lifetime: this.lifetime.signal,
      },
      { signal, onProgress: onProgress as LoadAssetsOptions['onProgress'] },
    );
  }
  /** One loader per manifest section; each checks cancellation after every await. */
  private assetLoaders(epoch: number): Record<AssetKind, EntryLoader> {
    let dataBytes = 0;
    return {
      images: (entry, signal) =>
        this.loadImage(
          entry.url.href,
          entry.transparentIndex === undefined
            ? { signal }
            : { signal, transparentIndex: entry.transparentIndex },
        ),
      tilemaps: (entry, signal, tileset) =>
        this.loadTilemap(entry.url.href, { tileset: tileset as ImageResource, signal }),
      fonts: (entry, signal) => this.loadFont(entry.url.href, { signal }),
      sounds: (entry, signal) => this.audio.loadSound(entry.url.href, { signal }),
      music: (entry, signal) => this.audio.loadMusic(entry.url.href, { signal }),
      data: async (entry, signal) => {
        const { bytes } = await fetchLimited(entry.url, {
          limit: LIMITS.json,
          code: 'ASSET_LOAD',
          signal,
        });
        this.current(epoch, signal);
        dataBytes += bytes.byteLength;
        if (dataBytes > MANIFEST_LIMITS.dataBytes)
          throw new PixelJSError('CAPACITY', 'The data entries of a bundle are limited to 16 MiB.');
        return parseJson(bytes, 'ASSET_DATA');
      },
    };
  }
  async capture(options?: CaptureOptions): Promise<Blob> {
    this.active();
    return this.snapshots.capture(options);
  }
  startRecording(options?: RecordingOptions): void {
    this.active();
    this.snapshots.startRecording(options);
  }
  async stopRecording(): Promise<Blob> {
    this.active();
    return this.snapshots.stopRecording();
  }
  get recording(): boolean {
    return this.usable() && this.snapshots.recording;
  }
  start(callbacks: GameCallbacks): void {
    this.idle();
    record(callbacks, 'callbacks');
    const { update, draw } = callbacks;
    this.idle();
    if (typeof update !== 'function' || typeof draw !== 'function')
      throw new PixelJSError('ARGUMENT', 'start() requires synchronous update and draw functions.');
    if (this.state === 'RUNNING') return;
    this.idle();
    this.callbacks = { update, draw };
    // start() also ends a manual pause, so audio must hear about it too.
    if (this.pauses.delete('manual')) this.audioController.onResume('manual');
    this.pauses.delete('callback-error');
    this.syncState();
  }
  pause(): void {
    this.active();
    this.setPause('manual', true);
  }
  resume(): void {
    this.active();
    this.setPause('manual', false);
  }
  private setPause(reason: PauseReason, enabled: boolean): void {
    if (!this.usable()) return;
    if (this.pauses.has(reason) === enabled) return;
    if (enabled) {
      this.pauses.add(reason);
      if (reason === 'manual' || reason === 'hidden') this.audioController.onPause(reason);
    } else {
      this.pauses.delete(reason);
      if (reason === 'manual' || reason === 'hidden') this.audioController.onResume(reason);
    }
    this.syncState();
  }
  private syncState(): void {
    if (!this.usable()) return;
    if (this.raf !== null) {
      this.window.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.lastTime = null;
    this.accumulator = 0;
    this.webInput.reset();
    this.state = this.callbacks === null ? 'READY' : this.pauses.size > 0 ? 'PAUSED' : 'RUNNING';
    if (this.state === 'RUNNING' && this.phase === 'IDLE') this.schedule();
  }
  private schedule(): void {
    if (this.state === 'RUNNING' && this.raf === null)
      this.raf = this.window.requestAnimationFrame(this.frame);
  }
  private invoke(callback: () => unknown): void {
    const result = callback();
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    ) {
      Promise.resolve(result).catch(() => {
        /* Observe eventual rejection without hiding the contract error. */
      });
      throw new PixelJSError(
        'ASYNC_CALLBACK',
        'update() and draw() must be synchronous; a Promise/thenable was returned.',
      );
    }
  }
  private readonly frame = (time: number): void => {
    this.raf = null;
    if (this.state !== 'RUNNING' || !this.callbacks || this.phase !== 'IDLE') return;
    const callbacks = this.callbacks;
    try {
      if (this.lastTime !== null)
        this.accumulator += Math.min(0.25, Math.max(0, (time - this.lastTime) / 1000));
      this.lastTime = time;
      let steps = 0;
      while (this.accumulator >= this.step && steps < 5 && this.state === 'RUNNING') {
        this.phase = 'UPDATE';
        this.webInput.tick();
        this.invoke(() => callbacks.update(this.step));
        this.updates++;
        steps++;
        this.accumulator -= this.step;
      }
      if (this.accumulator >= this.step) {
        this.droppedUpdates += Math.floor(this.accumulator / this.step);
        this.accumulator %= this.step;
      }
      if (this.state !== 'RUNNING') return;
      this.phase = 'BUILD_DRAW';
      this.writer.begin(this.frames);
      this.invoke(() => callbacks.draw());
      if (this.state !== 'RUNNING') return;
      this.phase = 'SUBMIT';
      this.writer.submit();
      this.phase = 'PRESENT';
      this.renderer.present();
      this.frames++;
      this.commands = this.writer.count;
      this.snapshots.framePresented(time);
    } catch (error) {
      if (this.usable())
        this.fail(error, error instanceof WebAssembly.RuntimeError || this.phase === 'PRESENT');
    } finally {
      this.finishFrame();
    }
  };
  private finishFrame(): void {
    this.phase = 'IDLE';
    if (this.disposal && this.state !== 'DISPOSED') this.cleanup();
    else this.schedule();
  }
  private trap(error: unknown): void {
    if (error instanceof WebAssembly.RuntimeError) this.fail(error, true);
  }
  private fail(value: unknown, terminal: boolean): void {
    const error = value instanceof Error ? value : new PixelJSError('CALLBACK', String(value));
    if (terminal) {
      this.failed = true;
      this.state = 'FAILED';
      if (value instanceof WebAssembly.RuntimeError) this.core.abandon();
      if (this.raf !== null) {
        this.window.cancelAnimationFrame(this.raf);
        this.raf = null;
      }
      // Cleanup is deferred until control has left any active callback/core operation.
      queueMicrotask(() => {
        if (this.state === 'FAILED') this.releaseOwned();
      });
    } else this.setPause('callback-error', true);
    this.notify(error);
  }
  /** Reports asynchronously; a failing handler never triggers another report. */
  private notify(error: Error): void {
    queueMicrotask(() => {
      if (this.notifying) return;
      this.notifying = true;
      try {
        if (this.onError) {
          const result: unknown = this.onError(error);
          if (result && typeof result === 'object' && 'then' in result)
            Promise.resolve(result).catch(() => {});
        } else console.error('[PixelJS]', error);
      } catch (notificationError) {
        console.error('[PixelJS] onError callback failed.', notificationError);
      } finally {
        this.notifying = false;
      }
    });
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposal = new Promise<void>((resolve, reject) => {
      this.resolveDisposal = resolve;
      this.rejectDisposal = reject;
    });
    this.state = this.failed ? 'FAILED' : 'DISPOSING';
    if (this.raf !== null) {
      this.window.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.phase === 'IDLE') this.cleanup();
    return this.disposal;
  }
  private releaseOwned(): void {
    this.callbacks = null;
    this.snapshots.dispose();
    this.lifetime.abort();
    for (const type of ['visibilitychange', 'pause', 'resume'])
      this.canvas.ownerDocument.removeEventListener(type, this.visibility);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    this.webInput.dispose();
    void this.audioController.dispose();
    try {
      this.renderer.dispose();
    } finally {
      try {
        this.finalAllocations = this.core.allocations;
      } catch {
        /* Already destroyed after terminal failure. */
      }
      this.core.destroy();
    }
  }
  private cleanup(): void {
    try {
      this.epoch++;
      this.releaseOwned();
      this.state = this.failed ? 'FAILED' : 'DISPOSED';
      this.resolveDisposal?.();
    } catch (error) {
      this.state = 'FAILED';
      this.rejectDisposal?.(error);
    }
    this.resolveDisposal = null;
    this.rejectDisposal = null;
  }
  /** Palette index of a pixel of the last submitted frame. */
  readPixel(x: number, y: number): number {
    this.active();
    const column = integer(x, 'x', 0, this.width - 1);
    const row = integer(y, 'y', 0, this.height - 1);
    return this.core.indexed[row * this.width + column] ?? 0;
  }
  getStats(): EngineStats {
    return Object.freeze({
      frames: this.frames,
      updates: this.updates,
      droppedUpdates: this.droppedUpdates,
      commands: this.commands,
      inputOverflows: this.webInput.overflows,
      coreBytes: this.usable() ? this.core.bytes : 0,
      coreAllocations: this.usable() ? this.core.allocations : this.finalAllocations,
      renderer: this.renderer.kind,
    });
  }
}

export async function createEngine(options: EngineOptions): Promise<Engine> {
  record(options, 'engine options');
  const {
    canvas,
    width: rawWidth,
    height: rawHeight,
    updateHz: rawUpdateHz,
    renderer: rawRenderer,
    scaling: rawScaling,
    palette,
    wasmUrl,
    audioWasmUrl,
    audioWorkletUrl,
    signal,
    onError,
  } = options;
  const view = canvas?.ownerDocument?.defaultView;
  if (!view || !(canvas instanceof view.HTMLCanvasElement))
    throw new PixelJSError(
      'UNSUPPORTED',
      'createEngine() requires an HTML canvas in an active browser document. Importing PixelJS does not require a DOM.',
    );
  const width = integer(rawWidth ?? 256, 'width', 1, PROTOCOL.maxDimension);
  const height = integer(rawHeight ?? 144, 'height', 1, PROTOCOL.maxDimension);
  const updateHz = integer(rawUpdateHz ?? 60, 'updateHz', 1, 240);
  const kind = rawRenderer ?? 'auto';
  if (!['auto', 'webgl2', 'canvas2d'].includes(kind))
    throw new PixelJSError('ARGUMENT', 'renderer must be auto, webgl2 or canvas2d.');
  const scaling = scalingMode(rawScaling, view);
  if (onError !== undefined && typeof onError !== 'function')
    throw new PixelJSError('ARGUMENT', 'onError must be a function.');
  for (const [name, value] of [
    ['wasmUrl', wasmUrl],
    ['audioWasmUrl', audioWasmUrl],
    ['audioWorkletUrl', audioWorkletUrl],
  ] as const) {
    if (value !== undefined && typeof value !== 'string' && !(value instanceof URL))
      throw new PixelJSError('ARGUMENT', `${name} must be a URL or string.`);
  }
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new PixelJSError('ARGUMENT', 'signal must be an AbortSignal.');
  const colors = palette === undefined ? undefined : paletteBytes(palette);
  const core = await loadWasm(width, height, wasmUrl, signal, colors);
  let renderer: Renderer | undefined;
  try {
    const activeRenderer = createRenderer(canvas, core, kind, width, height);
    renderer = activeRenderer;
    const audioOptions: EngineOptions = { canvas, scaling };
    if (audioWasmUrl !== undefined) audioOptions.audioWasmUrl = audioWasmUrl;
    if (audioWorkletUrl !== undefined) audioOptions.audioWorkletUrl = audioWorkletUrl;
    const controller = new Controller(
      core,
      activeRenderer,
      canvas,
      width,
      height,
      updateHz,
      audioOptions,
      onError,
    );
    return Object.freeze({
      get width() {
        return controller.width;
      },
      get height() {
        return controller.height;
      },
      get state() {
        return controller.state;
      },
      graphics: controller.graphics,
      input: controller.input,
      get audio() {
        return controller.audio;
      },
      get capabilities() {
        return Object.freeze({
          renderer: activeRenderer.kind,
          audio: controller.audioController.capabilities.supported,
          workers: false as const,
        });
      },
      start: (callbacks: GameCallbacks) => controller.start(callbacks),
      pause: () => controller.pause(),
      resume: () => controller.resume(),
      dispose: () => controller.dispose(),
      createImage: (image: ImageOptions) => controller.createImage(image),
      createTilemap: (tilemap: TilemapOptions) => controller.createTilemap(tilemap),
      createFont: (font: FontOptions) => controller.createFont(font),
      release: (resource: EngineResource) => controller.release(resource),
      resize: (w: number, h: number) => controller.resize(w, h),
      setPalette: (colors: ArrayLike<number>) => controller.setPalette(colors),
      loadImage: (src: string, opts?: LoadImageOptions) => controller.loadImage(src, opts),
      loadJson: <T = unknown>(src: string, opts?: { signal?: AbortSignal }) =>
        controller.loadJson<T>(src, opts),
      loadTilemap: (src: string, opts: { tileset: ImageResource; signal?: AbortSignal }) =>
        controller.loadTilemap(src, opts),
      getStats: () => controller.getStats(),
      readPixel: (x: number, y: number) => controller.readPixel(x, y),
      loadFont: (src: string, opts?: { signal?: AbortSignal }) => controller.loadFont(src, opts),
      measureText: (text: string, font?: FontResource) => controller.measureText(text, font),
      loadAssets: (manifest: string | AssetManifest, opts?: LoadAssetsOptions) =>
        controller.loadAssets(manifest, opts),
      capture: (opts?: CaptureOptions) => controller.capture(opts),
      startRecording: (opts?: RecordingOptions) => controller.startRecording(opts),
      stopRecording: () => controller.stopRecording(),
      get recording() {
        return controller.recording;
      },
    });
  } catch (error) {
    renderer?.dispose();
    core.destroy();
    throw error;
  }
}

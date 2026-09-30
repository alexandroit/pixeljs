import {
  createEngine,
  type Engine,
  type ImageOptions,
  type ImageResource,
  type TilemapResource,
} from '@pixeljs/core';
import { frameScheduler } from './dom.js';
import { paletteRgba } from './palette.js';
import type { Sprite } from './project.js';
import type { Studio } from './studio.js';

export type PreviewMode = 'sprite' | 'map' | 'off';

/** Logical size of the map preview: a typical 256 × 144 game screen. */
export const MAP_PREVIEW_WIDTH = 256;
export const MAP_PREVIEW_HEIGHT = 144;

/** Layout of the sprite preview: the sprite at 1:1, then tiled 2 × 2 to show seams. */
export function spritePreviewLayout(sprite: { width: number; height: number }): {
  width: number;
  height: number;
  single: [number, number];
  tiled: [number, number];
} {
  return {
    width: 3 * sprite.width + 16,
    height: 2 * sprite.height + 8,
    single: [4, 4],
    tiled: [sprite.width + 12, 4],
  };
}

function imageOptions(sprite: Sprite): ImageOptions {
  const options: ImageOptions = {
    width: sprite.width,
    height: sprite.height,
    pixels: sprite.pixels,
  };
  if (sprite.transparentIndex !== null) options.transparentIndex = sprite.transparentIndex;
  return options;
}

/**
 * One running PixelJS engine renders the preview of whichever editor is
 * visible; its canvas moves between the two preview slots. Resources are
 * replaced only between frames (from events and animation frames, never from
 * draw()). The engine is recreated when the palette size changes, because an
 * engine's color count is fixed at creation.
 */
export class Preview {
  private engine: Engine | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** Palette size of the engine requested last; creation is asynchronous. */
  private requestedColors = 0;
  private generation = 0;
  private mode: PreviewMode = 'off';
  private image: ImageResource | null = null;
  private tileset: ImageResource | null = null;
  private map: TilemapResource | null = null;
  private spriteDirty = true;
  private mapDirty = true;
  private paletteDirty = false;
  private camera = { x: 0, y: 0 };
  /** Palette index shown behind transparent pixels and empty cells. */
  private background = 0;
  private readonly schedule = frameScheduler(() => this.sync());

  constructor(
    private readonly studio: Studio,
    private readonly slots: Record<'sprite' | 'map', HTMLElement>,
    private readonly onProblem: (message: string) => void,
  ) {
    studio.on((event, subject) => {
      const map = studio.activeMap;
      if (event === 'project' || event === 'palette') {
        this.background = Math.min(this.background, studio.project.palette.length - 1);
        this.paletteDirty = true;
        this.spriteDirty = true;
        this.mapDirty = true;
      } else if (event === 'active' || event === 'sprites' || event === 'maps') {
        this.spriteDirty = true;
        this.mapDirty = true;
      } else if (event === 'pixels') {
        if (subject === studio.activeSprite) this.spriteDirty = true;
        if (map && subject === map.tileset) this.mapDirty = true;
      } else if (event === 'tiles' && subject === map) this.mapDirty = true;
      else return;
      this.schedule();
    });
  }

  setMode(mode: PreviewMode): void {
    this.mode = mode;
    if (mode !== 'off' && this.canvas) this.slots[mode].append(this.canvas);
    this.spriteDirty = true;
    this.mapDirty = true;
    this.schedule();
  }

  /** Top-left map pixel shown by the map preview. Read by draw(). */
  setCamera(x: number, y: number): void {
    this.camera = { x, y };
  }

  setBackground(index: number): void {
    this.background = index;
  }

  private async create(colors: number): Promise<void> {
    const generation = ++this.generation;
    const previous = this.engine;
    this.engine = null;
    this.image = this.tileset = this.map = null;
    if (previous) void previous.dispose();
    const canvas = document.createElement('canvas');
    canvas.className = 'runtime-preview';
    canvas.id = 'preview-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Live preview rendered by the PixelJS engine');
    let engine: Engine;
    try {
      engine = await createEngine({
        canvas,
        width: 16,
        height: 16,
        palette: paletteRgba(this.studio.project.palette.slice(0, colors)),
        onError: (error) => this.onProblem(`Preview: ${error.message}`),
      });
    } catch (error) {
      if (generation === this.generation)
        this.onProblem(`The live preview is unavailable: ${(error as Error).message}`);
      return;
    }
    if (generation !== this.generation) {
      void engine.dispose();
      return;
    }
    this.canvas?.remove();
    this.canvas = canvas;
    this.engine = engine;
    if (this.mode !== 'off') this.slots[this.mode].append(canvas);
    engine.start({ update() {}, draw: () => this.draw(engine) });
    this.paletteDirty = true;
    this.spriteDirty = true;
    this.mapDirty = true;
    this.sync();
  }

  /** Runs inside draw(): only draws resources that were published between frames. */
  private draw(engine: Engine): void {
    const g = engine.graphics;
    g.clear(this.background);
    if (this.mode === 'sprite' && this.image) {
      const image = this.image;
      const layout = spritePreviewLayout(image);
      g.sprite(image, ...layout.single);
      const [x, y] = layout.tiled;
      for (let row = 0; row < 2; row++)
        for (let col = 0; col < 2; col++)
          g.sprite(image, x + col * image.width, y + row * image.height);
    } else if (this.mode === 'map' && this.map) {
      g.tilemap(this.map, -this.camera.x, -this.camera.y);
    }
  }

  /** Publishes changed data to the engine; always runs outside engine callbacks. */
  private sync(): void {
    if (this.mode === 'off') {
      if (this.engine?.state === 'RUNNING') this.engine.pause();
      return;
    }
    const colors = this.studio.project.palette.length;
    if (colors !== this.requestedColors) {
      this.requestedColors = colors;
      void this.create(colors);
      return;
    }
    const engine = this.engine;
    if (!engine || engine.state === 'FAILED' || engine.state === 'DISPOSED') return;
    try {
      if (engine.state === 'PAUSED') engine.resume();
      if (this.paletteDirty) {
        engine.setPalette(paletteRgba(this.studio.project.palette));
        this.paletteDirty = false;
      }
      if (this.mode === 'sprite' && this.spriteDirty) this.syncSprite(engine);
      if (this.mode === 'map' && this.mapDirty) this.syncMap(engine);
    } catch (error) {
      this.onProblem(`Preview: ${(error as Error).message}`);
    }
  }

  private syncSprite(engine: Engine): void {
    this.spriteDirty = false;
    const sprite = this.studio.activeSprite;
    const next = sprite ? engine.createImage(imageOptions(sprite)) : null;
    if (this.image) engine.release(this.image);
    this.image = next;
    const layout = spritePreviewLayout(sprite ?? { width: 16, height: 16 });
    this.resize(engine, layout.width, layout.height);
  }

  private syncMap(engine: Engine): void {
    this.mapDirty = false;
    const map = this.studio.activeMap;
    let tileset: ImageResource | null = null;
    let resource: TilemapResource | null = null;
    if (map) {
      tileset = engine.createImage(imageOptions(map.tileset));
      resource = engine.createTilemap({
        cols: map.cols,
        rows: map.rows,
        tileWidth: map.tileWidth,
        tileHeight: map.tileHeight,
        tileset,
        tiles: map.tiles,
      });
    }
    // A map retains its tileset, so the old map is released first.
    if (this.map) engine.release(this.map);
    if (this.tileset) engine.release(this.tileset);
    this.map = resource;
    this.tileset = tileset;
    this.resize(engine, MAP_PREVIEW_WIDTH, MAP_PREVIEW_HEIGHT);
  }

  /** Resizes the framebuffer and displays it at the largest whole scale that fits. */
  private resize(engine: Engine, width: number, height: number): void {
    if (engine.width !== width || engine.height !== height) engine.resize(width, height);
    const canvas = this.canvas;
    if (!canvas || this.mode === 'off') return;
    const room = this.slots[this.mode].clientWidth || 256;
    const scale = Math.max(1, Math.min(8, Math.floor(room / width)));
    canvas.style.width = width * scale <= room ? `${width * scale}px` : '100%';
    canvas.style.height = width * scale <= room ? `${height * scale}px` : 'auto';
  }
}

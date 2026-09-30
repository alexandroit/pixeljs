import { EMPTY_TILE } from '@pixeljs/core';
import { byId, fillSelect, intValue, report, type Status } from './dom.js';
import { download, spritePng, tilemapJson } from './exports.js';
import { MAP_ZOOMS } from './limits.js';
import { paletteWords } from './palette.js';
import { MAP_PREVIEW_HEIGHT, MAP_PREVIEW_WIDTH, type Preview } from './preview.js';
import { createMap, freeName, tileCount, tilesPerRow, type TileMap } from './project.js';
import { lineCells, rectCells, spanRect, type Rect } from './raster.js';
import { CellEdit, type Studio } from './studio.js';
import { TilePicker } from './tile-picker.js';
import { PixelView, type ViewSource } from './pixel-view.js';

export type MapTool = 'place' | 'erase' | 'rect' | 'pick';

const TOOL_NAMES: Record<MapTool, string> = {
  place: 'Place tiles',
  erase: 'Erase tiles',
  rect: 'Fill rectangle',
  pick: 'Pick tile',
};
const TOOL_KEYS: Record<string, MapTool> = { p: 'place', e: 'erase', r: 'rect', i: 'pick' };

interface Cell {
  x: number;
  y: number;
}

type Gesture =
  | { kind: 'paint'; edit: CellEdit; last: Cell; value: number; label: string }
  | { kind: 'rect'; start: Cell; end: Cell };

/**
 * Tile map editor: place, erase, rectangle fill and pick on a zoomable,
 * scrollable view. The PixelJS preview shows a 256 × 144 camera at the
 * view's scroll position, outlined in the view.
 */
export class MapPanel {
  tool: MapTool = 'place';
  cursor: Cell = { x: 0, y: 0 };
  anchor: Cell | null = null;
  readonly view: PixelView;
  readonly picker: TilePicker;
  private gesture: Gesture | null = null;
  /** Tiles shown instead of the map's while a rectangle is previewed. */
  private display: Uint16Array | null = null;
  private hover: Cell | null = null;
  private grid = true;
  private words: Uint32Array = new Uint32Array(0);
  private shownMap: TileMap | null = null;
  private readonly canvas = byId('map-canvas', HTMLCanvasElement);
  private readonly zoomSelect = byId('map-zoom', HTMLSelectElement);
  private readonly zooms = new Map<number, number>();

  constructor(
    private readonly studio: Studio,
    private readonly status: Status,
    private readonly cursorStatus: HTMLElement,
    private readonly preview: Preview,
  ) {
    const panel = this;
    const source: ViewSource = {
      get width() {
        const map = panel.map;
        return map ? map.cols * map.tileWidth : 1;
      },
      get height() {
        const map = panel.map;
        return map ? map.rows * map.tileHeight : 1;
      },
      paint: (out, rect) => this.paint(out, rect),
      overlay: (context, view) => this.overlay(context, view),
    };
    this.view = new PixelView(
      byId('map-viewport', HTMLDivElement),
      this.canvas,
      byId('map-sizer', HTMLDivElement),
      source,
    );
    this.words = paletteWords(studio.project.palette);
    this.picker = new TilePicker(studio);
    fillSelect(
      this.zoomSelect,
      MAP_ZOOMS.map((zoom) => ({ value: String(zoom), label: `${zoom}×` })),
      String(this.view.zoom),
    );
    this.bindControls();
    this.bindCanvas();
    // Pending gestures commit, and keyboard start corners are dropped, before
    // the history or the selection changes under them.
    studio.onInteractionFlush(() => {
      this.finishGesture();
      this.anchor = null;
      this.display = null;
    });
    studio.on((event, subject) => {
      const map = this.map;
      if (event === 'palette' || event === 'project')
        this.words = paletteWords(studio.project.palette);
      if (['project', 'active', 'maps', 'sprites', 'palette'].includes(event)) this.syncMap();
      if (event === 'history') return;
      if (event === 'tiles' && subject !== map) return;
      if (event === 'pixels' && (!map || subject !== map.tileset)) return;
      this.view.invalidate();
    });
    this.syncMap();
  }

  get map(): TileMap | null {
    return this.studio.activeMap;
  }

  // -------------------------------------------------------------------------
  // Controls

  private bindControls(): void {
    const list = byId('map-list', HTMLSelectElement);
    list.addEventListener('change', () => {
      const map = this.studio.project.maps.find((item) => String(item.uid) === list.value);
      this.studio.selectMap(map ?? null);
    });
    byId('btn-map-new', HTMLButtonElement).addEventListener('click', () => this.newMap());
    byId('btn-map-duplicate', HTMLButtonElement).addEventListener('click', () => this.duplicate());
    byId('btn-map-delete', HTMLButtonElement).addEventListener('click', () => {
      const map = this.map;
      if (map) report(this.status, this.studio.deleteMap(map), `Deleted map “${map.name}”.`);
    });
    const name = byId('map-name', HTMLInputElement);
    name.addEventListener('change', () => {
      const map = this.map;
      if (map && !report(this.status, this.studio.renameMap(map, name.value.trim())))
        name.value = map.name;
    });
    const cols = byId('map-cols', HTMLInputElement);
    const rows = byId('map-rows', HTMLInputElement);
    const resize = (): void => {
      const map = this.map;
      if (!map) return;
      const problem = this.studio.resizeMap(map, intValue(cols), intValue(rows));
      if (
        !report(this.status, problem, `Resized “${map.name}” to ${map.cols} × ${map.rows} cells.`)
      ) {
        cols.value = String(map.cols);
        rows.value = String(map.rows);
      }
    };
    byId('btn-map-resize', HTMLButtonElement).addEventListener('click', resize);
    const tileset = byId('map-tileset', HTMLSelectElement);
    const tileWidth = byId('map-tile-width', HTMLInputElement);
    const tileHeight = byId('map-tile-height', HTMLInputElement);
    const configure = (): void => {
      const map = this.map;
      const sprite = this.studio.project.sprites.find((item) => String(item.uid) === tileset.value);
      if (!map || !sprite) return;
      const problem = this.studio.configureMap(
        map,
        sprite,
        intValue(tileWidth),
        intValue(tileHeight),
      );
      if (
        !report(
          this.status,
          problem,
          `“${map.name}” uses ${map.tileWidth} × ${map.tileHeight} tiles of “${sprite.name}”.`,
        )
      )
        this.syncMap();
    };
    byId('btn-map-tileset', HTMLButtonElement).addEventListener('click', configure);
    for (const input of [cols, rows, tileWidth, tileHeight])
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        if (input === cols || input === rows) resize();
        else configure();
      });
    for (const button of this.toolButtons())
      button.addEventListener('click', () => this.setTool(button.dataset['tool'] as MapTool));
    this.zoomSelect.addEventListener('change', () => this.setZoom(Number(this.zoomSelect.value)));
    const grid = byId('map-grid', HTMLInputElement);
    grid.addEventListener('change', () => {
      this.grid = grid.checked;
      this.view.invalidate();
    });
    byId('btn-export-map', HTMLButtonElement).addEventListener('click', () => {
      const map = this.map;
      if (!map) return;
      download(`${map.name}.json`, new Blob([tilemapJson(map)], { type: 'application/json' }));
      this.status.info(`Exported ${map.name}.json (tile map for engine.loadTilemap).`);
    });
    byId('btn-export-tileset', HTMLButtonElement).addEventListener('click', () => {
      const map = this.map;
      if (!map) return;
      void spritePng(map.tileset, this.studio.project.palette).then((blob) => {
        download(`${map.tileset.name}.png`, blob);
        this.status.info(`Exported ${map.tileset.name}.png (the tileset of “${map.name}”).`);
      });
    });
  }

  private toolButtons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('#map-tools [data-tool]'));
  }

  setTool(tool: MapTool): void {
    this.finishGesture();
    this.tool = tool;
    this.anchor = null;
    this.display = null;
    for (const button of this.toolButtons())
      button.setAttribute('aria-pressed', String(button.dataset['tool'] === tool));
    this.view.invalidate();
  }

  setZoom(zoom: number): void {
    const level = MAP_ZOOMS.includes(zoom) ? zoom : this.view.zoom;
    this.zoomSelect.value = String(level);
    if (this.map) this.zooms.set(this.map.uid, level);
    this.view.setZoom(level);
  }

  /** Uses the zoom chosen for this map, or fits it once the view has a size. */
  private applyZoom(): void {
    const map = this.map;
    if (!map || this.view.scroller.clientWidth === 0) return;
    const zoom = this.zooms.get(map.uid) ?? this.view.fitZoom(MAP_ZOOMS);
    this.zooms.set(map.uid, zoom);
    this.zoomSelect.value = String(zoom);
    this.view.setZoom(zoom);
  }

  /** Called when the tab becomes visible. */
  onShow(): void {
    this.applyZoom();
    this.view.invalidate();
  }

  stepZoom(direction: 1 | -1): void {
    const index = MAP_ZOOMS.indexOf(this.view.zoom) + direction;
    this.setZoom(MAP_ZOOMS[Math.max(0, Math.min(MAP_ZOOMS.length - 1, index))]!);
  }

  private syncMap(): void {
    const map = this.map;
    const project = this.studio.project;
    fillSelect(
      byId('map-list', HTMLSelectElement),
      project.maps.map((item) => ({
        value: String(item.uid),
        label: `${item.name} (${item.cols} × ${item.rows})`,
      })),
      map ? String(map.uid) : '',
    );
    const tileset = byId('map-tileset', HTMLSelectElement);
    fillSelect(
      tileset,
      project.sprites.map((sprite) => ({
        value: String(sprite.uid),
        label: `${sprite.name} (${sprite.width} × ${sprite.height})`,
      })),
      map ? String(map.tileset.uid) : '',
    );
    const values: Array<[string, string]> = [
      ['map-name', map?.name ?? ''],
      ['map-cols', String(map?.cols ?? '')],
      ['map-rows', String(map?.rows ?? '')],
      ['map-tile-width', String(map?.tileWidth ?? '')],
      ['map-tile-height', String(map?.tileHeight ?? '')],
    ];
    for (const [id, value] of values) {
      const input = byId(id, HTMLInputElement);
      if (document.activeElement !== input) input.value = value;
      input.disabled = !map;
    }
    tileset.disabled = !map;
    const info = byId('map-tileset-info', HTMLParagraphElement);
    if (map) {
      const perRow = tilesPerRow(map);
      const rows = Math.floor(map.tileset.height / map.tileHeight);
      const spareX = map.tileset.width - perRow * map.tileWidth;
      const spareY = map.tileset.height - rows * map.tileHeight;
      const spare =
        spareX || spareY
          ? ` Pixels beyond whole tiles (${spareX} right, ${spareY} bottom) are unused.`
          : '';
      info.textContent = `${perRow} × ${rows} = ${tileCount(map.tileset, map.tileWidth, map.tileHeight)} tiles.${spare}`;
    } else
      info.textContent = project.sprites.length
        ? 'No map yet: add one.'
        : 'Add a sprite first: maps use a sprite as their tileset.';
    const switched = map !== this.shownMap;
    if (switched || (map && this.display && this.display.length !== map.tiles.length)) {
      this.finishGesture();
      this.shownMap = map;
      this.anchor = null;
      this.display = null;
      if (switched) {
        this.cursor = { x: 0, y: 0 };
        this.applyZoom();
      }
    }
    if (map) {
      this.cursor.x = Math.min(this.cursor.x, map.cols - 1);
      this.cursor.y = Math.min(this.cursor.y, map.rows - 1);
    }
    this.canvas.setAttribute(
      'aria-label',
      map ? `Map ${map.name}, ${map.cols} by ${map.rows} cells` : 'No map selected',
    );
    this.picker.render();
  }

  private newMap(): void {
    const project = this.studio.project;
    const tileset = this.map?.tileset ?? this.studio.activeSprite ?? project.sprites[0];
    if (!tileset) {
      this.status.error('Add a sprite first: maps use a sprite as their tileset.');
      return;
    }
    const tileWidth = this.map?.tileWidth ?? Math.min(8, tileset.width);
    const tileHeight = this.map?.tileHeight ?? Math.min(8, tileset.height);
    const map = createMap(
      freeName(
        'map',
        project.maps.map((item) => item.name),
      ),
      tileset,
      Math.min(tileWidth, tileset.width),
      Math.min(tileHeight, tileset.height),
      16,
      16,
    );
    report(this.status, this.studio.addMap(map), `Added map “${map.name}”.`);
  }

  private duplicate(): void {
    const current = this.map;
    if (!current) return;
    const names = this.studio.project.maps.map((item) => item.name);
    const map = createMap(
      freeName(`${current.name.slice(0, 24)}-copy`, names),
      current.tileset,
      current.tileWidth,
      current.tileHeight,
      current.cols,
      current.rows,
      current.tiles.slice(),
    );
    report(
      this.status,
      this.studio.addMap(map, `Duplicate ${current.name}`),
      `Duplicated “${current.name}” as “${map.name}”.`,
    );
  }

  // -------------------------------------------------------------------------
  // Rendering

  private paint(out: Uint32Array, rect: Rect): void {
    const map = this.map;
    if (!map) return;
    const tiles = this.display ?? map.tiles;
    const { tileset, tileWidth, tileHeight, cols } = map;
    const count = tileCount(tileset, tileWidth, tileHeight);
    const perRow = tilesPerRow(map);
    const words = this.words;
    const transparent = tileset.transparentIndex;
    for (let row = 0; row < rect.height; row++) {
      const y = rect.y + row;
      const cellRow = Math.floor(y / tileHeight) * cols;
      const inTileY = y % tileHeight;
      for (let col = 0; col < rect.width; col++) {
        const x = rect.x + col;
        const tile = tiles[cellRow + Math.floor(x / tileWidth)]!;
        let word = 0;
        if (tile !== EMPTY_TILE && tile < count) {
          const sx = (tile % perRow) * tileWidth + (x % tileWidth);
          const sy = Math.floor(tile / perRow) * tileHeight + inTileY;
          const index = tileset.pixels[sy * tileset.width + sx]!;
          if (index !== transparent) word = words[index] ?? 0;
        }
        out[row * rect.width + col] = word;
      }
    }
  }

  private cellRect(cell: Cell, width = 1, height = 1): Rect {
    const map = this.map!;
    return {
      x: cell.x * map.tileWidth,
      y: cell.y * map.tileHeight,
      width: width * map.tileWidth,
      height: height * map.tileHeight,
    };
  }

  private overlay(context: CanvasRenderingContext2D, view: PixelView): void {
    const map = this.map;
    if (!map) return;
    const origin = view.scrollOrigin();
    this.preview.setCamera(origin.x, origin.y);
    if (this.grid && Math.min(map.tileWidth, map.tileHeight) * view.zoom >= 4)
      view.grid(context, map.tileWidth, map.tileHeight, 'rgba(210, 214, 235, 0.45)');
    view.outline(
      context,
      { ...origin, width: MAP_PREVIEW_WIDTH, height: MAP_PREVIEW_HEIGHT },
      'rgba(0, 229, 255, 0.8)',
      [6, 4],
    );
    const gesture = this.gesture;
    if (gesture?.kind === 'rect') {
      const span = spanRect(gesture.start.x, gesture.start.y, gesture.end.x, gesture.end.y);
      view.outline(context, this.cellRect(span, span.width, span.height), '#ffffff', [4, 4]);
    }
    if (this.hover && !gesture)
      view.outline(context, this.cellRect(this.hover), 'rgba(255,255,255,0.8)');
    if (this.anchor) view.outline(context, this.cellRect(this.anchor), '#00e5ff');
    if (document.activeElement === this.canvas)
      view.outline(context, this.cellRect(this.cursor), '#ffcc00', [], -0.5);
  }

  // -------------------------------------------------------------------------
  // Input

  private toCell(clientX: number, clientY: number): Cell {
    const map = this.map!;
    const point = this.view.toContent(clientX, clientY);
    return { x: Math.floor(point.x / map.tileWidth), y: Math.floor(point.y / map.tileHeight) };
  }

  private inside(cell: Cell): boolean {
    const map = this.map;
    return !!map && cell.x >= 0 && cell.y >= 0 && cell.x < map.cols && cell.y < map.rows;
  }

  private bindCanvas(): void {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !this.map) return;
      canvas.setPointerCapture(event.pointerId);
      const cell = this.toCell(event.clientX, event.clientY);
      if (this.inside(cell)) this.cursor = cell;
      this.anchor = null;
      this.begin(cell, event.altKey);
      this.view.invalidate();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!this.map) return;
      const cell = this.toCell(event.clientX, event.clientY);
      this.hover = this.inside(cell) ? cell : null;
      this.showCursor(this.hover);
      if (this.gesture) this.drag(cell);
      this.view.invalidate();
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!this.gesture || !this.map) return;
      this.drag(this.toCell(event.clientX, event.clientY));
      this.finishGesture();
    });
    canvas.addEventListener('pointercancel', () => this.cancelGesture());
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.view.invalidate();
    });
    canvas.addEventListener('focus', () => this.view.invalidate());
    canvas.addEventListener('blur', () => this.view.invalidate());
    canvas.addEventListener('keydown', (event) => this.onCanvasKey(event));
  }

  private showCursor(cell: Cell | null): void {
    const map = this.map;
    if (!cell || !map) {
      this.cursorStatus.textContent = '';
      return;
    }
    const tile = map.tiles[cell.y * map.cols + cell.x]!;
    this.cursorStatus.textContent = `column ${cell.x}, row ${cell.y} · ${tile === EMPTY_TILE ? 'empty' : `tile ${tile}`}`;
  }

  private onCanvasKey(event: KeyboardEvent): void {
    const map = this.map;
    if (!map || event.ctrlKey || event.metaKey || event.altKey) return;
    const steps: Record<string, Cell> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const step = steps[event.key];
    if (step) {
      event.preventDefault();
      this.cursor = {
        x: Math.max(0, Math.min(map.cols - 1, this.cursor.x + step.x)),
        y: Math.max(0, Math.min(map.rows - 1, this.cursor.y + step.y)),
      };
      const rect = this.cellRect(this.cursor);
      this.view.reveal(rect.x, rect.y, rect.width, rect.height);
      this.showCursor(this.cursor);
      if (this.anchor) this.display = this.rectTiles(this.anchor, this.cursor);
      this.view.invalidate();
      return;
    }
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (this.tool !== 'rect') {
      this.begin(this.cursor, false);
      this.finishGesture();
    } else if (!this.anchor) {
      this.anchor = { ...this.cursor };
      this.display = this.rectTiles(this.anchor, this.cursor);
      this.status.info(
        `Rectangle starts at column ${this.cursor.x}, row ${this.cursor.y}: move and press Space again.`,
      );
    } else {
      const start = this.anchor;
      this.anchor = null;
      this.display = null;
      this.commitRect(start, this.cursor);
    }
    this.view.invalidate();
  }

  escape(): boolean {
    if (this.gesture) {
      this.cancelGesture();
      return true;
    }
    if (!this.anchor) return false;
    this.anchor = null;
    this.display = null;
    this.view.invalidate();
    return true;
  }

  private begin(cell: Cell, pick: boolean): void {
    const map = this.map;
    if (!map) return;
    if (pick || this.tool === 'pick') {
      if (this.inside(cell)) this.pick(cell);
      return;
    }
    if (this.tool === 'rect') {
      this.gesture = { kind: 'rect', start: cell, end: cell };
      this.display = this.rectTiles(cell, cell);
      return;
    }
    const value = this.tool === 'place' ? this.studio.tile : EMPTY_TILE;
    const edit = new CellEdit(this.studio, { kind: 'map', map });
    edit.set(cell.x, cell.y, value);
    edit.flush();
    this.gesture = { kind: 'paint', edit, last: cell, value, label: TOOL_NAMES[this.tool] };
  }

  private drag(cell: Cell): void {
    const gesture = this.gesture;
    if (gesture?.kind === 'paint') {
      lineCells(gesture.last.x, gesture.last.y, cell.x, cell.y, (x, y) =>
        gesture.edit.set(x, y, gesture.value),
      );
      gesture.edit.flush();
      gesture.last = cell;
    } else if (gesture?.kind === 'rect') {
      gesture.end = cell;
      this.display = this.rectTiles(gesture.start, cell);
    }
  }

  finishGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    this.display = null;
    if (gesture.kind === 'paint') gesture.edit.commit(gesture.label);
    else this.commitRect(gesture.start, gesture.end);
    this.view.invalidate();
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    this.display = null;
    if (gesture?.kind === 'paint') gesture.edit.cancel();
    this.view.invalidate();
  }

  private pick(cell: Cell): void {
    const map = this.map!;
    const tile = map.tiles[cell.y * map.cols + cell.x]!;
    if (tile === EMPTY_TILE) {
      this.status.info('That cell is empty.');
      return;
    }
    this.picker.choose(tile);
    this.status.info(`Picked tile ${tile}.`);
  }

  private rectTiles(start: Cell, end: Cell): Uint16Array | null {
    const map = this.map;
    if (!map) return null;
    const tiles = map.tiles.slice();
    rectCells(spanRect(start.x, start.y, end.x, end.y), true, (x, y) => {
      if (x >= 0 && y >= 0 && x < map.cols && y < map.rows)
        tiles[y * map.cols + x] = this.studio.tile;
    });
    return tiles;
  }

  private commitRect(start: Cell, end: Cell): void {
    const map = this.map;
    if (!map) return;
    const edit = new CellEdit(this.studio, { kind: 'map', map });
    rectCells(spanRect(start.x, start.y, end.x, end.y), true, (x, y) =>
      edit.set(x, y, this.studio.tile),
    );
    edit.commit(TOOL_NAMES.rect);
  }

  shortcut(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    const key = event.key.toLowerCase();
    const tool = TOOL_KEYS[key];
    if (tool) this.setTool(tool);
    else if (key === 'g') {
      const grid = byId('map-grid', HTMLInputElement);
      grid.checked = !grid.checked;
      this.grid = grid.checked;
      this.view.invalidate();
    } else if (key === '+' || key === '=') this.stepZoom(1);
    else if (key === '-' || key === '_') this.stepZoom(-1);
    else if (key === '[') this.picker.choose(this.studio.tile - 1);
    else if (key === ']') this.picker.choose(this.studio.tile + 1);
    else if (key === 'escape') return this.escape();
    else return false;
    return true;
  }
}

import { byId, fillSelect, intValue, report, type Status } from './dom.js';
import { baseName, download, imageJson, spritePng } from './exports.js';
import { SPRITE_ZOOMS } from './limits.js';
import { formatHex, paletteWords } from './palette.js';
import { PixelView, type ViewSource } from './pixel-view.js';
import { backgroundIndex, createSprite, freeName, type Sprite } from './project.js';
import {
  clipRect,
  containsCell,
  copyBlock,
  flipBlock,
  floodRegion,
  lineCells,
  rectCells,
  spanRect,
  type Rect,
} from './raster.js';
import { CellEdit, type Studio } from './studio.js';

export type SpriteTool =
  'pen' | 'eraser' | 'fill' | 'line' | 'rect' | 'rect-fill' | 'eyedropper' | 'select';

const TOOL_NAMES: Record<SpriteTool, string> = {
  pen: 'Pen',
  eraser: 'Eraser',
  fill: 'Fill',
  line: 'Line',
  rect: 'Rectangle',
  'rect-fill': 'Filled rectangle',
  eyedropper: 'Eyedropper',
  select: 'Select',
};

/** Tool shortcuts; Shift+R selects the filled rectangle. */
const TOOL_KEYS: Record<string, SpriteTool> = {
  p: 'pen',
  e: 'eraser',
  f: 'fill',
  l: 'line',
  r: 'rect',
  i: 'eyedropper',
  s: 'select',
};

interface Point {
  x: number;
  y: number;
}

/** Copied pixels plus where they came from, so a paste can return there. */
interface Clipboard extends Rect {
  pixels: Uint8Array;
}

type Gesture =
  | { kind: 'paint'; edit: CellEdit; last: Point; value: number; label: string }
  | { kind: 'shape'; tool: SpriteTool; start: Point; end: Point }
  | { kind: 'select'; start: Point; end: Point; moved: boolean }
  | { kind: 'move'; start: Point; end: Point };

function twoPoint(tool: SpriteTool): boolean {
  return tool === 'line' || tool === 'rect' || tool === 'rect-fill' || tool === 'select';
}

/**
 * Sprite editor: tools, rectangular selection and clipboard, flips, zoom and
 * grid. Every change goes through CellEdit or Studio, so it is one bounded
 * undo step.
 */
export class SpritePanel {
  tool: SpriteTool = 'pen';
  selection: Rect | null = null;
  clipboard: Clipboard | null = null;
  cursor: Point = { x: 0, y: 0 };
  /** First corner of a keyboard line, rectangle or selection. */
  anchor: Point | null = null;
  readonly view: PixelView;
  private gesture: Gesture | null = null;
  /** Pixels shown instead of the sprite's while a shape or move is previewed. */
  private display: Uint8Array | null = null;
  private hover: Point | null = null;
  private grid = true;
  private words: Uint32Array = new Uint32Array(0);
  private readonly zooms = new Map<number, number>();
  private shownSprite: Sprite | null = null;
  private readonly canvas = byId('sprite-canvas', HTMLCanvasElement);
  private readonly zoomSelect = byId('sprite-zoom', HTMLSelectElement);

  constructor(
    private readonly studio: Studio,
    private readonly status: Status,
    private readonly cursorStatus: HTMLElement,
    private readonly importPng: (file: File) => void,
  ) {
    const panel = this;
    const source: ViewSource = {
      get width() {
        return panel.sprite?.width ?? 1;
      },
      get height() {
        return panel.sprite?.height ?? 1;
      },
      paint: (out, rect) => this.paint(out, rect),
      overlay: (context, view) => this.overlay(context, view),
    };
    this.view = new PixelView(
      byId('sprite-viewport', HTMLDivElement),
      this.canvas,
      byId('sprite-sizer', HTMLDivElement),
      source,
    );
    this.words = paletteWords(studio.project.palette);
    fillSelect(
      this.zoomSelect,
      SPRITE_ZOOMS.map((zoom) => ({ value: String(zoom), label: `${zoom}×` })),
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
      if (event === 'palette' || event === 'project')
        this.words = paletteWords(studio.project.palette);
      if (event === 'project' || event === 'active' || event === 'sprites') this.syncSprite();
      if (event === 'pixels' && subject !== this.sprite) return;
      if (event === 'history') return;
      this.view.invalidate();
    });
    this.syncSprite();
  }

  get sprite(): Sprite | null {
    return this.studio.activeSprite;
  }

  // -------------------------------------------------------------------------
  // Controls

  private bindControls(): void {
    const list = byId('sprite-list', HTMLSelectElement);
    list.addEventListener('change', () => {
      const sprite = this.studio.project.sprites.find((item) => String(item.uid) === list.value);
      this.studio.selectSprite(sprite ?? null);
    });
    byId('btn-sprite-new', HTMLButtonElement).addEventListener('click', () => this.newSprite());
    byId('btn-sprite-duplicate', HTMLButtonElement).addEventListener('click', () =>
      this.duplicate(),
    );
    byId('btn-sprite-delete', HTMLButtonElement).addEventListener('click', () => {
      const sprite = this.sprite;
      if (sprite)
        report(this.status, this.studio.deleteSprite(sprite), `Deleted sprite “${sprite.name}”.`);
    });
    const name = byId('sprite-name', HTMLInputElement);
    name.addEventListener('change', () => {
      const sprite = this.sprite;
      if (!sprite) return;
      if (!report(this.status, this.studio.renameSprite(sprite, name.value.trim())))
        name.value = sprite.name;
    });
    const width = byId('sprite-width', HTMLInputElement);
    const height = byId('sprite-height', HTMLInputElement);
    const resize = (): void => {
      const sprite = this.sprite;
      if (!sprite) return;
      const problem = this.studio.resizeSprite(sprite, intValue(width), intValue(height));
      if (
        !report(
          this.status,
          problem,
          `Resized “${sprite.name}” to ${sprite.width} × ${sprite.height}.`,
        )
      ) {
        width.value = String(sprite.width);
        height.value = String(sprite.height);
      }
    };
    byId('btn-sprite-resize', HTMLButtonElement).addEventListener('click', resize);
    for (const input of [width, height])
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') resize();
      });
    const transparent = byId('sprite-transparent', HTMLSelectElement);
    transparent.addEventListener('change', () => {
      const sprite = this.sprite;
      if (!sprite) return;
      const index = transparent.value === 'none' ? null : Number(transparent.value);
      report(this.status, this.studio.setTransparentIndex(sprite, index));
    });
    const file = byId('file-png', HTMLInputElement);
    byId('btn-import-png', HTMLButtonElement).addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (chosen) this.importPng(chosen);
    });
    byId('btn-export-png', HTMLButtonElement).addEventListener(
      'click',
      () => void this.exportPng(),
    );
    byId('btn-export-json', HTMLButtonElement).addEventListener('click', () => {
      const sprite = this.sprite;
      if (!sprite) return;
      download(`${sprite.name}.json`, new Blob([imageJson(sprite)], { type: 'application/json' }));
      this.status.info(`Exported ${sprite.name}.json (JSON image for engine.loadImage).`);
    });
    for (const button of this.toolButtons())
      button.addEventListener('click', () => this.setTool(button.dataset['tool'] as SpriteTool));
    const actions: Record<string, () => void> = {
      'btn-select-all': () => this.selectAll(),
      'btn-deselect': () => this.deselect(),
      'btn-copy': () => this.copy(),
      'btn-cut': () => this.cut(),
      'btn-paste': () => this.paste(),
      'btn-delete-selection': () => this.clearSelection(),
      'btn-flip-h': () => this.flip(true),
      'btn-flip-v': () => this.flip(false),
      'btn-nudge-left': () => this.moveSelection(-1, 0),
      'btn-nudge-right': () => this.moveSelection(1, 0),
      'btn-nudge-up': () => this.moveSelection(0, -1),
      'btn-nudge-down': () => this.moveSelection(0, 1),
    };
    for (const [id, action] of Object.entries(actions))
      byId(id, HTMLButtonElement).addEventListener('click', action);
    this.zoomSelect.addEventListener('change', () => this.setZoom(Number(this.zoomSelect.value)));
    const grid = byId('sprite-grid', HTMLInputElement);
    grid.addEventListener('change', () => {
      this.grid = grid.checked;
      this.view.invalidate();
    });
  }

  private toolButtons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('#sprite-tools [data-tool]'));
  }

  setTool(tool: SpriteTool): void {
    this.finishGesture();
    this.tool = tool;
    this.anchor = null;
    this.display = null;
    for (const button of this.toolButtons())
      button.setAttribute('aria-pressed', String(button.dataset['tool'] === tool));
    this.view.invalidate();
  }

  setZoom(zoom: number): void {
    const level = SPRITE_ZOOMS.includes(zoom) ? zoom : this.view.zoom;
    this.zoomSelect.value = String(level);
    if (this.sprite) this.zooms.set(this.sprite.uid, level);
    this.view.setZoom(level);
  }

  stepZoom(direction: 1 | -1): void {
    const index = SPRITE_ZOOMS.indexOf(this.view.zoom) + direction;
    const zoom = SPRITE_ZOOMS[Math.max(0, Math.min(SPRITE_ZOOMS.length - 1, index))]!;
    this.setZoom(zoom);
  }

  toggleGrid(): void {
    const grid = byId('sprite-grid', HTMLInputElement);
    grid.checked = !grid.checked;
    this.grid = grid.checked;
    this.view.invalidate();
  }

  /** Refreshes the sprite list and property fields after list or selection changes. */
  private syncSprite(): void {
    const sprite = this.sprite;
    const project = this.studio.project;
    fillSelect(
      byId('sprite-list', HTMLSelectElement),
      project.sprites.map((item) => ({
        value: String(item.uid),
        label: `${item.name} (${item.width} × ${item.height})`,
      })),
      sprite ? String(sprite.uid) : '',
    );
    const transparent = byId('sprite-transparent', HTMLSelectElement);
    fillSelect(
      transparent,
      [
        { value: 'none', label: 'None (all pixels opaque)' },
        ...project.palette.map((color, index) => ({
          value: String(index),
          label: `Color ${index} (${formatHex(color)})`,
        })),
      ],
      sprite?.transparentIndex == null ? 'none' : String(sprite.transparentIndex),
    );
    const fields = ['sprite-name', 'sprite-width', 'sprite-height'].map((id) =>
      byId(id, HTMLInputElement),
    );
    const [name, width, height] = fields as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    if (document.activeElement !== name) name.value = sprite?.name ?? '';
    if (document.activeElement !== width) width.value = String(sprite?.width ?? '');
    if (document.activeElement !== height) height.value = String(sprite?.height ?? '');
    for (const control of [...fields, transparent]) control.disabled = !sprite;
    if (sprite !== this.shownSprite) {
      this.finishGesture();
      this.shownSprite = sprite;
      this.selection = null;
      this.anchor = null;
      this.display = null;
      this.cursor = { x: 0, y: 0 };
      this.applyZoom();
    } else if (sprite) {
      if (this.selection) this.selection = clipRect(this.selection, sprite.width, sprite.height);
      if (this.display && this.display.length !== sprite.pixels.length) {
        this.anchor = null;
        this.display = null;
      }
    }
    if (sprite) {
      this.cursor.x = Math.min(this.cursor.x, sprite.width - 1);
      this.cursor.y = Math.min(this.cursor.y, sprite.height - 1);
    }
    this.canvas.setAttribute(
      'aria-label',
      sprite
        ? `Sprite ${sprite.name}, ${sprite.width} by ${sprite.height} pixels`
        : 'No sprite selected',
    );
  }

  /** Uses the zoom chosen for this sprite, or fits it once the view has a size. */
  private applyZoom(): void {
    const sprite = this.sprite;
    if (!sprite || this.view.scroller.clientWidth === 0) return;
    const zoom = this.zooms.get(sprite.uid) ?? this.view.fitZoom(SPRITE_ZOOMS);
    this.zooms.set(sprite.uid, zoom);
    this.zoomSelect.value = String(zoom);
    this.view.setZoom(zoom);
  }

  /** Called when the tab becomes visible. */
  onShow(): void {
    this.applyZoom();
    this.view.invalidate();
  }

  private newSprite(): void {
    const current = this.sprite;
    const project = this.studio.project;
    const sprite = createSprite(
      freeName(
        'sprite',
        project.sprites.map((item) => item.name),
      ),
      current?.width ?? 16,
      current?.height ?? 16,
      current ? current.transparentIndex : 0,
    );
    report(this.status, this.studio.addSprite(sprite), `Added sprite “${sprite.name}”.`);
  }

  private duplicate(): void {
    const current = this.sprite;
    if (!current) return;
    const names = this.studio.project.sprites.map((item) => item.name);
    const sprite = createSprite(
      freeName(`${current.name.slice(0, 24)}-copy`, names),
      current.width,
      current.height,
      current.transparentIndex,
      current.pixels.slice(),
    );
    report(
      this.status,
      this.studio.addSprite(sprite, `Duplicate ${current.name}`),
      `Duplicated “${current.name}” as “${sprite.name}”.`,
    );
  }

  private async exportPng(): Promise<void> {
    const sprite = this.sprite;
    if (!sprite) return;
    const path = `images/${sprite.name}.png`;
    download(baseName(path), await spritePng(sprite, this.studio.project.palette));
    this.status.info(
      `Exported ${baseName(path)} (${sprite.width} × ${sprite.height} indexed PNG).`,
    );
  }

  // -------------------------------------------------------------------------
  // Rendering

  private paint(out: Uint32Array, rect: Rect): void {
    const sprite = this.sprite;
    if (!sprite) return;
    const pixels = this.display ?? sprite.pixels;
    const transparent = sprite.transparentIndex;
    const words = this.words;
    for (let row = 0; row < rect.height; row++) {
      const from = (rect.y + row) * sprite.width + rect.x;
      const to = row * rect.width;
      for (let col = 0; col < rect.width; col++) {
        const index = pixels[from + col]!;
        out[to + col] = index === transparent ? 0 : (words[index] ?? 0);
      }
    }
  }

  private overlay(context: CanvasRenderingContext2D, view: PixelView): void {
    const sprite = this.sprite;
    if (!sprite) return;
    if (this.grid && view.zoom >= 4) view.grid(context, 1, 1, 'rgba(128, 134, 160, 0.4)');
    if (this.grid && view.zoom >= 2 && sprite.width > 8)
      view.grid(context, 8, 8, 'rgba(210, 214, 235, 0.6)');
    const selection = this.previewSelection();
    if (selection) {
      view.outline(context, selection, '#000000');
      view.outline(context, selection, '#ffffff', [4, 4]);
    }
    if (this.hover && !this.gesture)
      view.outline(context, { ...this.hover, width: 1, height: 1 }, 'rgba(255,255,255,0.7)');
    if (this.anchor) view.outline(context, { ...this.anchor, width: 1, height: 1 }, '#00e5ff');
    if (document.activeElement === this.canvas)
      view.outline(context, { ...this.cursor, width: 1, height: 1 }, '#ffcc00', [], -0.5);
  }

  /** The selection as it will be after the current gesture or keyboard anchor. */
  private previewSelection(): Rect | null {
    const sprite = this.sprite;
    if (!sprite) return null;
    const gesture = this.gesture;
    if (gesture?.kind === 'select')
      return spanRect(gesture.start.x, gesture.start.y, gesture.end.x, gesture.end.y);
    if (gesture?.kind === 'move' && this.selection)
      return {
        ...this.selection,
        x: this.selection.x + gesture.end.x - gesture.start.x,
        y: this.selection.y + gesture.end.y - gesture.start.y,
      };
    if (this.anchor && this.tool === 'select')
      return spanRect(this.anchor.x, this.anchor.y, this.cursor.x, this.cursor.y);
    return this.selection;
  }

  // -------------------------------------------------------------------------
  // Pointer and keyboard input

  private clamp(point: Point): Point {
    const sprite = this.sprite;
    if (!sprite) return point;
    return {
      x: Math.max(0, Math.min(sprite.width - 1, point.x)),
      y: Math.max(0, Math.min(sprite.height - 1, point.y)),
    };
  }

  private inside(point: Point): boolean {
    const sprite = this.sprite;
    return (
      !!sprite && point.x >= 0 && point.y >= 0 && point.x < sprite.width && point.y < sprite.height
    );
  }

  private bindCanvas(): void {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !this.sprite) return;
      canvas.setPointerCapture(event.pointerId);
      const point = this.view.toContent(event.clientX, event.clientY);
      if (this.inside(point)) this.cursor = point;
      this.anchor = null;
      this.begin(point, event.altKey);
      this.view.invalidate();
    });
    canvas.addEventListener('pointermove', (event) => {
      const point = this.view.toContent(event.clientX, event.clientY);
      this.hover = this.inside(point) ? point : null;
      this.showCursor(this.hover);
      if (this.gesture) this.drag(point);
      this.view.invalidate();
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!this.gesture) return;
      this.drag(this.view.toContent(event.clientX, event.clientY));
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

  private showCursor(point: Point | null): void {
    const sprite = this.sprite;
    if (!point || !sprite) {
      this.cursorStatus.textContent = '';
      return;
    }
    const index = sprite.pixels[point.y * sprite.width + point.x]!;
    const transparent = index === sprite.transparentIndex ? ', transparent' : '';
    this.cursorStatus.textContent = `x ${point.x}, y ${point.y} · color ${index}${transparent}`;
  }

  private onCanvasKey(event: KeyboardEvent): void {
    const sprite = this.sprite;
    if (!sprite || event.ctrlKey || event.metaKey) return;
    const steps: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const step = steps[event.key];
    if (step) {
      event.preventDefault();
      if (event.altKey) this.moveSelection(step.x, step.y);
      else {
        this.cursor = this.clamp({ x: this.cursor.x + step.x, y: this.cursor.y + step.y });
        this.view.reveal(this.cursor.x, this.cursor.y);
        this.showCursor(this.cursor);
        this.updateAnchorPreview();
      }
      this.view.invalidate();
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.applyAtCursor();
      this.view.invalidate();
    }
  }

  /** Keyboard equivalent of a click: two-point tools take two presses. */
  private applyAtCursor(): void {
    const point = this.cursor;
    if (!twoPoint(this.tool)) {
      this.begin(point, false);
      this.finishGesture();
      return;
    }
    if (!this.anchor) {
      this.anchor = { ...point };
      this.status.info(
        `${TOOL_NAMES[this.tool]} starts at ${point.x}, ${point.y}: move the cursor and press Space again.`,
      );
      this.updateAnchorPreview();
      return;
    }
    const start = this.anchor;
    this.anchor = null;
    this.display = null;
    if (this.tool === 'select') this.selection = spanRect(start.x, start.y, point.x, point.y);
    else this.commitShape(this.tool, start, point);
  }

  private updateAnchorPreview(): void {
    if (this.anchor && this.tool !== 'select')
      this.display = this.shapePixels(this.tool, this.anchor, this.cursor);
  }

  /** Cancels a keyboard anchor or, failing that, the selection. */
  escape(): boolean {
    if (this.gesture) {
      this.cancelGesture();
      return true;
    }
    if (this.anchor) {
      this.anchor = null;
      this.display = null;
      this.view.invalidate();
      return true;
    }
    if (this.selection) {
      this.deselect();
      return true;
    }
    return false;
  }

  private begin(point: Point, pick: boolean): void {
    const sprite = this.sprite;
    if (!sprite) return;
    if (pick || this.tool === 'eyedropper') {
      if (this.inside(point)) this.pick(point);
      return;
    }
    switch (this.tool) {
      case 'pen':
      case 'eraser': {
        const value = this.tool === 'pen' ? this.studio.color : backgroundIndex(sprite);
        const edit = new CellEdit(this.studio, { kind: 'sprite', sprite });
        edit.set(point.x, point.y, value);
        edit.flush();
        const label = this.tool === 'pen' ? 'Pen' : 'Eraser';
        this.gesture = { kind: 'paint', edit, last: point, value, label };
        return;
      }
      case 'fill':
        if (this.inside(point)) this.fill(point);
        return;
      case 'select':
        if (this.selection && containsCell(this.selection, point.x, point.y))
          this.gesture = { kind: 'move', start: point, end: point };
        else {
          const start = this.clamp(point);
          this.gesture = { kind: 'select', start, end: start, moved: false };
        }
        return;
      default:
        this.gesture = { kind: 'shape', tool: this.tool, start: point, end: point };
        this.display = this.shapePixels(this.tool, point, point);
    }
  }

  private drag(point: Point): void {
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === 'paint') {
      lineCells(gesture.last.x, gesture.last.y, point.x, point.y, (x, y) =>
        gesture.edit.set(x, y, gesture.value),
      );
      gesture.edit.flush();
      gesture.last = point;
    } else if (gesture.kind === 'shape') {
      gesture.end = point;
      this.display = this.shapePixels(gesture.tool, gesture.start, point);
    } else if (gesture.kind === 'select') {
      const end = this.clamp(point);
      gesture.moved ||= end.x !== gesture.start.x || end.y !== gesture.start.y;
      gesture.end = end;
    } else {
      gesture.end = point;
      this.display = this.movedPixels(point.x - gesture.start.x, point.y - gesture.start.y);
    }
  }

  /** Commits the gesture in progress, as a pointer release would. */
  finishGesture(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    this.display = null;
    if (gesture.kind === 'paint') gesture.edit.commit(gesture.label);
    else if (gesture.kind === 'shape') this.commitShape(gesture.tool, gesture.start, gesture.end);
    else if (gesture.kind === 'select')
      this.selection = gesture.moved
        ? spanRect(gesture.start.x, gesture.start.y, gesture.end.x, gesture.end.y)
        : null;
    else this.moveSelection(gesture.end.x - gesture.start.x, gesture.end.y - gesture.start.y);
    this.view.invalidate();
  }

  private cancelGesture(): void {
    const gesture = this.gesture;
    this.gesture = null;
    this.display = null;
    if (gesture?.kind === 'paint') gesture.edit.cancel();
    this.view.invalidate();
  }

  // -------------------------------------------------------------------------
  // Operations

  private pick(point: Point): void {
    const sprite = this.sprite;
    if (!sprite) return;
    const index = sprite.pixels[point.y * sprite.width + point.x]!;
    this.studio.setColor(index);
    this.status.info(`Picked color ${index} (${formatHex(this.studio.project.palette[index]!)}).`);
  }

  private fill(point: Point): void {
    const sprite = this.sprite;
    if (!sprite) return;
    const edit = new CellEdit(this.studio, { kind: 'sprite', sprite });
    const color = this.studio.color;
    for (const position of floodRegion(
      sprite.pixels,
      sprite.width,
      sprite.height,
      point.x,
      point.y,
    ))
      edit.set(position % sprite.width, Math.floor(position / sprite.width), color);
    edit.commit('Fill');
  }

  private shapeCells(
    tool: SpriteTool,
    start: Point,
    end: Point,
    visit: (x: number, y: number) => void,
  ): void {
    if (tool === 'line') lineCells(start.x, start.y, end.x, end.y, visit);
    else rectCells(spanRect(start.x, start.y, end.x, end.y), tool === 'rect-fill', visit);
  }

  private shapePixels(tool: SpriteTool, start: Point, end: Point): Uint8Array | null {
    const sprite = this.sprite;
    if (!sprite) return null;
    const pixels = sprite.pixels.slice();
    const color = this.studio.color;
    this.shapeCells(tool, start, end, (x, y) => {
      if (x >= 0 && y >= 0 && x < sprite.width && y < sprite.height)
        pixels[y * sprite.width + x] = color;
    });
    return pixels;
  }

  private commitShape(tool: SpriteTool, start: Point, end: Point): void {
    const sprite = this.sprite;
    if (!sprite) return;
    const edit = new CellEdit(this.studio, { kind: 'sprite', sprite });
    const color = this.studio.color;
    this.shapeCells(tool, start, end, (x, y) => edit.set(x, y, color));
    edit.commit(TOOL_NAMES[tool]);
  }

  selectAll(): void {
    const sprite = this.sprite;
    if (!sprite) return;
    this.selection = { x: 0, y: 0, width: sprite.width, height: sprite.height };
    this.view.invalidate();
  }

  deselect(): void {
    this.selection = null;
    this.view.invalidate();
  }

  copy(): boolean {
    const sprite = this.sprite;
    const selection = this.selection;
    if (!sprite || !selection) {
      this.status.error('Select an area first (Select tool or Ctrl+A).');
      return false;
    }
    this.clipboard = { ...selection, pixels: copyBlock(sprite.pixels, sprite.width, selection) };
    this.status.info(`Copied ${selection.width} × ${selection.height} pixels.`);
    return true;
  }

  cut(): void {
    if (this.copy()) this.clearSelection('Cut');
  }

  /** Fills the selection with the background index (transparent index, or 0). */
  clearSelection(label = 'Delete selection'): void {
    const sprite = this.sprite;
    const selection = this.selection;
    if (!sprite || !selection) return;
    const edit = new CellEdit(this.studio, { kind: 'sprite', sprite });
    rectCells(selection, true, (x, y) => edit.set(x, y, backgroundIndex(sprite)));
    edit.commit(label);
  }

  /**
   * Writes the clipboard at the selection's top-left corner, or where it was
   * copied from (the top-left corner if that lies outside this sprite). The
   * block is copied as is, transparent pixels included, from the separate
   * clipboard buffer, so pasting over the copied area never reads pixels it
   * has already written. The pasted area becomes the selection.
   */
  paste(): void {
    const sprite = this.sprite;
    const clip = this.clipboard;
    if (!sprite) return;
    if (!clip) {
      this.status.error('The clipboard is empty: copy a selection first.');
      return;
    }
    const colors = this.studio.project.palette.length;
    const missing = clip.pixels.find((index) => index >= colors);
    if (missing !== undefined) {
      this.status.error(`The clipboard uses color ${missing}, which the palette no longer has.`);
      return;
    }
    let x = this.selection?.x ?? clip.x;
    let y = this.selection?.y ?? clip.y;
    if (x >= sprite.width || y >= sprite.height) x = y = 0;
    const edit = new CellEdit(this.studio, { kind: 'sprite', sprite });
    this.writeBlock(edit, clip.pixels, clip.width, clip.height, x, y);
    edit.commit('Paste');
    this.selection = clipRect(
      { x, y, width: clip.width, height: clip.height },
      sprite.width,
      sprite.height,
    );
    this.view.invalidate();
  }

  private writeBlock(
    edit: CellEdit,
    block: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
  ): void {
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width; col++) edit.set(x + col, y + row, block[row * width + col]!);
  }

  /**
   * Moves the selected pixels: the block is lifted into a separate buffer, its
   * old area takes the background index, then the block is written at the
   * offset. Overlapping moves are therefore exact; pixels pushed past the
   * sprite edge are cut off, and the selection follows the clipped block.
   */
  moveSelection(dx: number, dy: number): void {
    const sprite = this.sprite;
    const selection = this.selection;
    if (!sprite || !selection || (dx === 0 && dy === 0)) return;
    const block = copyBlock(sprite.pixels, sprite.width, selection);
    const edit = new CellEdit(this.studio, { kind: 'sprite', sprite });
    rectCells(selection, true, (x, y) => edit.set(x, y, backgroundIndex(sprite)));
    this.writeBlock(
      edit,
      block,
      selection.width,
      selection.height,
      selection.x + dx,
      selection.y + dy,
    );
    edit.commit('Move selection');
    this.selection = clipRect(
      { ...selection, x: selection.x + dx, y: selection.y + dy },
      sprite.width,
      sprite.height,
    );
    this.view.invalidate();
  }

  /** The sprite as it would look after moving the selection by (dx, dy). */
  private movedPixels(dx: number, dy: number): Uint8Array | null {
    const sprite = this.sprite;
    const selection = this.selection;
    if (!sprite || !selection) return null;
    const pixels = sprite.pixels.slice();
    const block = copyBlock(sprite.pixels, sprite.width, selection);
    rectCells(selection, true, (x, y) => (pixels[y * sprite.width + x] = backgroundIndex(sprite)));
    for (let row = 0; row < selection.height; row++)
      for (let col = 0; col < selection.width; col++) {
        const x = selection.x + dx + col;
        const y = selection.y + dy + row;
        if (x >= 0 && y >= 0 && x < sprite.width && y < sprite.height)
          pixels[y * sprite.width + x] = block[row * selection.width + col]!;
      }
    return pixels;
  }

  /** Mirrors the selection, or the whole sprite when nothing is selected. */
  flip(horizontal: boolean): void {
    const sprite = this.sprite;
    if (!sprite) return;
    const area = this.selection ?? { x: 0, y: 0, width: sprite.width, height: sprite.height };
    const block = flipBlock(
      copyBlock(sprite.pixels, sprite.width, area),
      area.width,
      area.height,
      horizontal,
    );
    const edit = new CellEdit(this.studio, { kind: 'sprite', sprite });
    this.writeBlock(edit, block, area.width, area.height, area.x, area.y);
    edit.commit(horizontal ? 'Flip horizontal' : 'Flip vertical');
  }

  /** Single-key and Ctrl/Cmd shortcuts while this tab is active and nobody types. */
  shortcut(event: KeyboardEvent): boolean {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (mod && !event.altKey) {
      const lower = key.toLowerCase();
      if (lower === 'c') this.copy();
      else if (lower === 'x') this.cut();
      else if (lower === 'v') this.paste();
      else if (lower === 'a') this.selectAll();
      else return false;
      return true;
    }
    if (mod || event.altKey) return false;
    const lower = key.toLowerCase();
    const tool = event.shiftKey && lower === 'r' ? 'rect-fill' : TOOL_KEYS[lower];
    if (tool) this.setTool(tool);
    else if (lower === 'g') this.toggleGrid();
    else if (lower === 'h') this.flip(true);
    else if (lower === 'v') this.flip(false);
    else if (key === '+' || key === '=') this.stepZoom(1);
    else if (key === '-' || key === '_') this.stepZoom(-1);
    else if ((key === 'Delete' || key === 'Backspace') && this.selection) this.clearSelection();
    else if (key === 'Escape') return this.escape();
    else if (key === '[') this.studio.setColor(this.studio.color - 1);
    else if (key === ']') this.studio.setColor(this.studio.color + 1);
    else return false;
    return true;
  }
}

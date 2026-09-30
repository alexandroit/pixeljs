import type { Rect } from './raster.js';

/** What a PixelView shows: content pixels plus editor overlays. */
export interface ViewSource {
  /** Content size in pixels (a sprite's pixels or a map's pixels). */
  readonly width: number;
  readonly height: number;
  /** Writes one RGBA word per content pixel of `rect` into `out`; 0 is transparent. */
  paint(out: Uint32Array, rect: Rect): void;
  /** Draws grid, selection and cursors in canvas CSS pixels. */
  overlay(context: CanvasRenderingContext2D, view: PixelView): void;
}

function checkerPattern(context: CanvasRenderingContext2D): CanvasPattern | string {
  const tile = document.createElement('canvas');
  tile.width = 16;
  tile.height = 16;
  const tileContext = tile.getContext('2d');
  if (!tileContext) return '#2a2c3a';
  tileContext.fillStyle = '#2a2c3a';
  tileContext.fillRect(0, 0, 16, 16);
  tileContext.fillStyle = '#3a3d4f';
  tileContext.fillRect(0, 0, 8, 8);
  tileContext.fillRect(8, 8, 8, 8);
  return context.createPattern(tile, 'repeat') ?? '#2a2c3a';
}

/**
 * A zoomable, scrollable view of pixel content. The canvas only covers the
 * visible viewport (it is sticky inside the scroller), so zoom 32 on a
 * 256 × 256 sprite or a large map never allocates a huge canvas. Content
 * smaller than the viewport is centered. `data-origin-x/y` and `data-zoom`
 * on the canvas describe the current mapping for tests and tooling.
 */
export class PixelView {
  zoom = 8;
  /** Canvas CSS position of content pixel (0, 0). */
  originX = 0;
  originY = 0;
  /** Canvas size in CSS pixels. */
  width = 0;
  height = 0;
  private readonly scratch = document.createElement('canvas');
  private pattern: CanvasPattern | string | null = null;
  private pending = false;

  constructor(
    readonly scroller: HTMLElement,
    readonly canvas: HTMLCanvasElement,
    private readonly sizer: HTMLElement,
    private readonly source: ViewSource,
  ) {
    scroller.addEventListener('scroll', () => this.invalidate());
    new ResizeObserver(() => this.invalidate()).observe(scroller);
  }

  invalidate(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  /** Content pixel under a client (viewport) position; may lie outside the content. */
  toContent(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    return {
      x: Math.floor((clientX - box.left - this.originX) / this.zoom),
      y: Math.floor((clientY - box.top - this.originY) / this.zoom),
    };
  }

  /** Changes the zoom, keeping the content point at the viewport center in place. */
  setZoom(zoom: number): void {
    if (zoom === this.zoom) return;
    const centerX = (this.scroller.clientWidth / 2 - this.originX) / this.zoom;
    const centerY = (this.scroller.clientHeight / 2 - this.originY) / this.zoom;
    this.zoom = zoom;
    this.layout();
    this.scroller.scrollLeft = centerX * zoom - this.scroller.clientWidth / 2;
    this.scroller.scrollTop = centerY * zoom - this.scroller.clientHeight / 2;
    this.render();
  }

  /** Largest zoom from `levels` that shows the whole content, at least the smallest level. */
  fitZoom(levels: readonly number[]): number {
    const width = this.scroller.clientWidth - 16;
    const height = this.scroller.clientHeight - 16;
    let best = levels[0]!;
    if (width <= 0 || height <= 0) return levels.includes(8) ? 8 : best;
    for (const level of levels)
      if (this.source.width * level <= width && this.source.height * level <= height) best = level;
    return best;
  }

  /** Scrolls the minimum distance that makes a content rectangle visible. */
  reveal(x: number, y: number, width = 1, height = 1): void {
    const left = x * this.zoom;
    const top = y * this.zoom;
    const right = (x + width) * this.zoom;
    const bottom = (y + height) * this.zoom;
    const scroller = this.scroller;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + scroller.clientWidth)
      scroller.scrollLeft = right - scroller.clientWidth;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight)
      scroller.scrollTop = bottom - scroller.clientHeight;
  }

  /** Visible content rectangle, clipped to the content. */
  visibleRect(): Rect {
    const x0 = Math.max(0, Math.floor(-this.originX / this.zoom));
    const y0 = Math.max(0, Math.floor(-this.originY / this.zoom));
    const x1 = Math.min(this.source.width, Math.ceil((this.width - this.originX) / this.zoom));
    const y1 = Math.min(this.source.height, Math.ceil((this.height - this.originY) / this.zoom));
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }

  /** Content pixel shown at the viewport's top-left corner. */
  scrollOrigin(): { x: number; y: number } {
    return {
      x: Math.max(0, Math.floor(-this.originX / this.zoom)),
      y: Math.max(0, Math.floor(-this.originY / this.zoom)),
    };
  }

  private layout(): void {
    const contentWidth = this.source.width * this.zoom;
    const contentHeight = this.source.height * this.zoom;
    this.width = this.scroller.clientWidth;
    this.height = this.scroller.clientHeight;
    this.sizer.style.width = `${contentWidth}px`;
    this.sizer.style.height = `${contentHeight}px`;
    this.sizer.style.marginTop = `${-this.height}px`;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  render(): void {
    this.layout();
    const { width, height, zoom } = this;
    const ratio = window.devicePixelRatio || 1;
    const backingWidth = Math.max(1, Math.round(width * ratio));
    const backingHeight = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    const context = this.canvas.getContext('2d');
    if (!context || width === 0 || height === 0) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, width, height);
    const contentWidth = this.source.width * zoom;
    const contentHeight = this.source.height * zoom;
    this.originX =
      contentWidth <= width ? Math.floor((width - contentWidth) / 2) : -this.scroller.scrollLeft;
    this.originY =
      contentHeight <= height ? Math.floor((height - contentHeight) / 2) : -this.scroller.scrollTop;
    const rect = this.visibleRect();
    if (rect.width > 0 && rect.height > 0) {
      const left = this.originX + rect.x * zoom;
      const top = this.originY + rect.y * zoom;
      this.pattern ??= checkerPattern(context);
      context.fillStyle = this.pattern;
      context.fillRect(left, top, rect.width * zoom, rect.height * zoom);
      const image = new ImageData(rect.width, rect.height);
      this.source.paint(new Uint32Array(image.data.buffer), rect);
      this.scratch.width = rect.width;
      this.scratch.height = rect.height;
      this.scratch.getContext('2d')?.putImageData(image, 0, 0);
      context.drawImage(this.scratch, left, top, rect.width * zoom, rect.height * zoom);
    }
    this.source.overlay(context, this);
    this.canvas.dataset['originX'] = String(this.originX);
    this.canvas.dataset['originY'] = String(this.originY);
    this.canvas.dataset['zoom'] = String(zoom);
  }

  /** Strokes a content rectangle's outline, aligned to device pixels. */
  outline(
    context: CanvasRenderingContext2D,
    rect: Rect,
    color: string,
    dash: number[] = [],
    inset = 0.5,
  ): void {
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.setLineDash(dash);
    context.strokeRect(
      this.originX + rect.x * this.zoom + inset,
      this.originY + rect.y * this.zoom + inset,
      rect.width * this.zoom - 2 * inset,
      rect.height * this.zoom - 2 * inset,
    );
    context.restore();
  }

  /** Draws grid lines every `stepX` × `stepY` content pixels over the visible area. */
  grid(context: CanvasRenderingContext2D, stepX: number, stepY: number, color: string): void {
    const rect = this.visibleRect();
    if (rect.width === 0 || rect.height === 0) return;
    const { zoom, originX, originY } = this;
    const top = originY + rect.y * zoom;
    const bottom = originY + (rect.y + rect.height) * zoom;
    const left = originX + rect.x * zoom;
    const right = originX + (rect.x + rect.width) * zoom;
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.beginPath();
    for (let x = Math.ceil(rect.x / stepX) * stepX; x <= rect.x + rect.width; x += stepX) {
      const px = originX + x * zoom + 0.5;
      context.moveTo(px, top);
      context.lineTo(px, bottom);
    }
    for (let y = Math.ceil(rect.y / stepY) * stepY; y <= rect.y + rect.height; y += stepY) {
      const py = originY + y * zoom + 0.5;
      context.moveTo(left, py);
      context.lineTo(right, py);
    }
    context.stroke();
    context.restore();
  }
}

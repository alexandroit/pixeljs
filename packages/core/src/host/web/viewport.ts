import { PixelJSError } from '../../api/errors.js';
import type { ScalingMode } from '../../api/types.js';
import type { InlineStyles } from './styles.js';

export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Rect extends Size {
  readonly left: number;
  readonly top: number;
}
/** A client point in logical pixels, clamped to the framebuffer. */
export interface MappedPoint {
  readonly x: number;
  readonly y: number;
  /** Inside the canvas box but not on the image: letterbox margin, border or padding. */
  readonly margin: boolean;
}
interface Offset {
  readonly fraction: number;
  readonly pixels: number;
}

// Absorbs floating-point error such as 2.9999999 device pixels per logical pixel.
const EPSILON = 1e-6;
const CENTER: Offset = { fraction: 0.5, pixels: 0 };
const finite = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);
const px = (value: string): number => Number.parseFloat(value) || 0;
const clamp = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;

/** Validates `EngineOptions.scaling`. Fitting needs ResizeObserver. */
export function scalingMode(
  value: unknown,
  view: { readonly ResizeObserver?: unknown },
): ScalingMode {
  if (value === undefined || value === 'manual') return 'manual';
  if (value !== 'fit' && value !== 'integer')
    throw new PixelJSError('ARGUMENT', "scaling must be 'manual', 'fit' or 'integer'.");
  if (typeof view.ResizeObserver !== 'function')
    throw new PixelJSError('UNSUPPORTED', `scaling '${value}' requires ResizeObserver.`);
  return value;
}

/**
 * CSS size of a canvas showing `logical` pixels inside `available` CSS pixels
 * at `ratio` device pixels per CSS pixel, keeping the aspect ratio. 'integer'
 * uses the largest whole number of device pixels per logical pixel and falls
 * back to 'fit' below one; 'fit' rounds down to whole device pixels.
 */
export function fittedSize(
  mode: 'fit' | 'integer',
  available: Size,
  logical: Size,
  ratio: number,
): Size {
  const dpr = finite(ratio) || 1;
  const scale = Math.min(
    (finite(available.width) * dpr) / logical.width,
    (finite(available.height) * dpr) / logical.height,
  );
  if (mode === 'integer') {
    const whole = Math.floor(scale + EPSILON);
    if (whole >= 1)
      return { width: (whole * logical.width) / dpr, height: (whole * logical.height) / dpr };
  }
  return {
    width: Math.floor(logical.width * scale + EPSILON) / dpr,
    height: Math.floor(logical.height * scale + EPSILON) / dpr,
  };
}

/** Parses a computed two-value `object-position` of lengths/percentages; otherwise center. */
function objectPosition(value: string): readonly [Offset, Offset] {
  const tokens = value.trim().split(/\s+/);
  if (tokens.length !== 2) return [CENTER, CENTER];
  const parse = (token: string): Offset | null => {
    const match = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|px)$/i.exec(token);
    const amount = match ? Number(match[1]) : NaN;
    if (!match || !Number.isFinite(amount)) return null;
    return match[2] === '%'
      ? { fraction: amount / 100, pixels: 0 }
      : { fraction: 0, pixels: amount };
  };
  const x = parse(tokens[0]!);
  const y = parse(tokens[1]!);
  return x && y ? [x, y] : [CENTER, CENTER];
}

/**
 * Where a replaced element draws a `width` × `height` image inside its
 * content `box` for a computed `object-fit` and `object-position`. `scaleX`
 * and `scaleY` convert CSS pixels to client pixels under CSS transforms.
 */
export function placeContent(
  box: Rect,
  width: number,
  height: number,
  fit: string,
  position: string,
  scaleX = 1,
  scaleY = 1,
): Rect {
  let drawnWidth = box.width;
  let drawnHeight = box.height;
  const contain = Math.min(box.width / width, box.height / height);
  if (fit === 'contain' || fit === 'cover') {
    const scale = fit === 'contain' ? contain : Math.max(box.width / width, box.height / height);
    drawnWidth = width * scale;
    drawnHeight = height * scale;
  } else if (fit === 'none' || fit === 'scale-down') {
    const shrink = fit === 'scale-down' && contain < Math.min(scaleX, scaleY);
    drawnWidth = width * (shrink ? contain : scaleX);
    drawnHeight = height * (shrink ? contain : scaleY);
  }
  const [x, y] = objectPosition(position);
  return {
    left: box.left + (box.width - drawnWidth) * x.fraction + x.pixels * scaleX,
    top: box.top + (box.height - drawnHeight) * y.fraction + y.pixels * scaleY,
    width: drawnWidth,
    height: drawnHeight,
  };
}

/**
 * Maps a client point onto the `width` × `height` framebuffer drawn in
 * `image`. Points on the canvas but outside the visible image (the image
 * clipped to the content box) are margins.
 */
export function mapPoint(
  clientX: number,
  clientY: number,
  border: Rect,
  content: Rect,
  image: Rect,
  width: number,
  height: number,
): MappedPoint {
  const inside = (x: number, y: number, left: number, top: number, right: number, bottom: number) =>
    x >= left && x <= right && y >= top && y <= bottom;
  const onCanvas = inside(
    clientX,
    clientY,
    border.left,
    border.top,
    border.left + border.width,
    border.top + border.height,
  );
  const onImage = inside(
    clientX,
    clientY,
    Math.max(content.left, image.left),
    Math.max(content.top, image.top),
    Math.min(content.left + content.width, image.left + image.width),
    Math.min(content.top + content.height, image.top + image.height),
  );
  return {
    x: clamp(Math.floor(((clientX - image.left) * width) / image.width), width - 1),
    y: clamp(Math.floor(((clientY - image.top) * height) / image.height), height - 1),
    margin: onCanvas && !onImage,
  };
}

/** Content box of an element in CSS pixels, excluding padding, borders and scrollbars. */
function contentBox(element: Element, view: Window): Size {
  const style = view.getComputedStyle(element);
  return {
    width: Math.max(0, element.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
    height: Math.max(0, element.clientHeight - px(style.paddingTop) - px(style.paddingBottom)),
  };
}

/** Border plus padding on each side, in CSS pixels. */
function frame(
  style: CSSStyleDeclaration,
): Rect & { readonly right: number; readonly bottom: number } {
  const left = px(style.borderLeftWidth) + px(style.paddingLeft);
  const top = px(style.borderTopWidth) + px(style.paddingTop);
  const right = px(style.borderRightWidth) + px(style.paddingRight);
  const bottom = px(style.borderBottomWidth) + px(style.paddingBottom);
  return { left, top, right, bottom, width: left + right, height: top + bottom };
}

/**
 * Sizes the canvas CSS box in 'fit'/'integer' scaling and maps client points
 * to logical pixels through the region that actually shows the framebuffer.
 * The backing store stays at the logical size.
 */
export class Viewport {
  private readonly view: Window & typeof globalThis;
  private readonly computed: CSSStyleDeclaration;
  private observer: ResizeObserver | null = null;
  private parent: Element | null = null;
  // Exact content box last reported for `parent`, preferred to a rounded measurement.
  private parentSize: Size | null = null;
  private media: MediaQueryList | null = null;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private width: number,
    private height: number,
    private readonly mode: ScalingMode,
    private readonly styles: InlineStyles,
  ) {
    this.view = canvas.ownerDocument.defaultView!;
    this.computed = this.view.getComputedStyle(canvas);
    if (mode === 'manual') return;
    // Observing the canvas too notices when it is attached, moved or given another border.
    this.observer = new this.view.ResizeObserver((entries) => this.observed(entries));
    this.observer.observe(canvas, { box: 'border-box' });
    this.watchRatio();
    styles.set('image-rendering', 'pixelated');
    this.fit();
  }
  map(clientX: number, clientY: number): MappedPoint | null {
    const canvas = this.canvas;
    const border = canvas.getBoundingClientRect();
    if (!(border.width > 0 && border.height > 0)) return null;
    const style = this.computed;
    // offsetWidth/offsetHeight are untransformed, so their ratio is the CSS transform scale.
    const scaleX = canvas.offsetWidth > 0 ? border.width / canvas.offsetWidth : 1;
    const scaleY = canvas.offsetHeight > 0 ? border.height / canvas.offsetHeight : 1;
    const edges = frame(style);
    const content: Rect = {
      left: border.left + edges.left * scaleX,
      top: border.top + edges.top * scaleY,
      width: border.width - edges.width * scaleX,
      height: border.height - edges.height * scaleY,
    };
    if (!(content.width > 0 && content.height > 0)) return null;
    const image = placeContent(
      content,
      this.width,
      this.height,
      style.objectFit,
      style.objectPosition,
      scaleX,
      scaleY,
    );
    return mapPoint(clientX, clientY, border, content, image, this.width, this.height);
  }
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.fit();
  }
  /**
   * Sizes the canvas so its border box fits its parent's content box (margins
   * are left to the page); no-op in 'manual' scaling or without a parent.
   */
  fit(): void {
    if (this.mode === 'manual' || this.disposed) return;
    const parent = this.canvas.parentElement;
    if (parent !== this.parent) {
      if (this.parent) this.observer?.unobserve(this.parent);
      this.parent = parent;
      this.parentSize = null;
      if (parent) this.observer?.observe(parent);
    }
    if (!parent) return;
    const space = this.parentSize ?? contentBox(parent, this.view);
    const edges = frame(this.computed);
    const size = fittedSize(
      this.mode,
      { width: space.width - edges.width, height: space.height - edges.height },
      { width: this.width, height: this.height },
      this.view.devicePixelRatio,
    );
    // The fitted size is the content box, where the image is drawn.
    const outer = this.computed.boxSizing === 'border-box';
    this.styles.set('width', `${size.width + (outer ? edges.width : 0)}px`);
    this.styles.set('height', `${size.height + (outer ? edges.height : 0)}px`);
  }
  private observed(entries: ResizeObserverEntry[]): void {
    if (this.disposed) return;
    for (const entry of entries)
      if (entry.target === this.parent && entry.target === this.canvas.parentElement)
        this.parentSize = { width: entry.contentRect.width, height: entry.contentRect.height };
    this.fit();
  }
  /** Device-pixel-ratio changes (zoom, another monitor) change the integer scale. */
  private watchRatio(): void {
    this.media?.removeEventListener('change', this.ratioChanged);
    this.media =
      typeof this.view.matchMedia === 'function'
        ? this.view.matchMedia(`(resolution: ${this.view.devicePixelRatio}dppx)`)
        : null;
    this.media?.addEventListener('change', this.ratioChanged);
  }
  private readonly ratioChanged = (): void => {
    if (this.disposed) return;
    this.watchRatio();
    this.fit();
  };
  /** Stops observing; the owner restores the styles. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.media?.removeEventListener('change', this.ratioChanged);
    this.media = null;
    this.parent = null;
  }
}

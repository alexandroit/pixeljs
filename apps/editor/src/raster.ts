/** Pure pixel algorithms shared by the sprite and map editors. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * All-octant Bresenham walk from (x0, y0) to (x1, y1), identical to the
 * engine's `graphics.line`, so an edited line matches a drawn one pixel for pixel.
 */
export function lineCells(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (x: number, y: number) => void,
): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1;
  const stepY = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  let x = x0;
  let y = y0;
  for (let remaining = Math.max(dx, -dy); ; remaining--) {
    visit(x, y);
    if (remaining === 0) return;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += stepX;
    }
    if (doubled <= dx) {
      error += dx;
      y += stepY;
    }
  }
}

/** The rectangle spanned by two corner cells, both included. */
export function spanRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, width: Math.abs(x1 - x0) + 1, height: Math.abs(y1 - y0) + 1 };
}

/** Visits a rectangle's cells: its one-pixel border, or every cell when filled. */
export function rectCells(
  rect: Rect,
  filled: boolean,
  visit: (x: number, y: number) => void,
): void {
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  for (let y = rect.y; y <= bottom; y++)
    for (let x = rect.x; x <= right; x++)
      if (filled || y === rect.y || y === bottom || x === rect.x || x === right) visit(x, y);
}

/** Clips a rectangle to a width × height area; null when nothing remains. */
export function clipRect(rect: Rect, width: number, height: number): Rect | null {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(width, rect.x + rect.width);
  const bottom = Math.min(height, rect.y + rect.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function containsCell(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

/**
 * Positions (y * width + x) of the 4-connected region around (x, y) whose
 * cells equal the starting cell. Iterative with a bounded stack.
 */
export function floodRegion(
  cells: Uint8Array | Uint16Array,
  width: number,
  height: number,
  x: number,
  y: number,
): Int32Array {
  const start = y * width + x;
  const target = cells[start]!;
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const region = new Int32Array(width * height);
  let top = 0;
  let found = 0;
  stack[top++] = start;
  seen[start] = 1;
  const visit = (next: number): void => {
    if (!seen[next] && cells[next] === target) {
      seen[next] = 1;
      stack[top++] = next;
    }
  };
  while (top > 0) {
    const position = stack[--top]!;
    region[found++] = position;
    const px = position % width;
    if (px > 0) visit(position - 1);
    if (px < width - 1) visit(position + 1);
    if (position >= width) visit(position - width);
    if (position < width * (height - 1)) visit(position + width);
  }
  return region.slice(0, found);
}

/** Copies a rectangle (already clipped to the source) into a new buffer. */
export function copyBlock(pixels: Uint8Array, width: number, rect: Rect): Uint8Array {
  const block = new Uint8Array(rect.width * rect.height);
  for (let row = 0; row < rect.height; row++) {
    const from = (rect.y + row) * width + rect.x;
    block.set(pixels.subarray(from, from + rect.width), row * rect.width);
  }
  return block;
}

/** A mirrored copy of a block: horizontally (rows reversed) or vertically. */
export function flipBlock(
  block: Uint8Array,
  width: number,
  height: number,
  horizontal: boolean,
): Uint8Array {
  const out = new Uint8Array(block.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = horizontal ? y * width + (width - 1 - x) : (height - 1 - y) * width + x;
      out[y * width + x] = block[from]!;
    }
  return out;
}

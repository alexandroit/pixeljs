/**
 * The engine's default 16-color palette (see core/src/context/context.c).
 * The editor test compares this copy with pixels rendered by a real engine.
 */
export const DEFAULT_PALETTE: readonly number[] = [
  0x0d111c, 0x242c42, 0x474d6f, 0x79809a, 0xe7eff6, 0xfa695d, 0xf9a75a, 0xffdc80, 0x9fd86b,
  0x38ad87, 0x32daca, 0x3f87d4, 0x795fce, 0xb676d6, 0xf0a3c7, 0x7a5242,
];

/** Colors are packed 0xRRGGBB integers; palettes are always opaque. */
export function formatHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Accepts `#rrggbb` or `rrggbb` (any case); returns null for anything else. */
export function parseHex(text: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  return match ? Number.parseInt(match[1]!, 16) : null;
}

/** Flattened opaque RGBA entries, as `createEngine({ palette })` and `setPalette` take them. */
export function paletteRgba(palette: readonly number[]): number[] {
  const rgba: number[] = [];
  for (const color of palette) rgba.push((color >> 16) & 255, (color >> 8) & 255, color & 255, 255);
  return rgba;
}

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** One 32-bit value per color in the byte order of `ImageData` (R, G, B, A). */
export function paletteWords(palette: readonly number[]): Uint32Array {
  const words = new Uint32Array(palette.length);
  palette.forEach((color, index) => {
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    words[index] = littleEndian
      ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
  });
  return words;
}

/** Pairs of indices with identical colors, lower index first. */
export function duplicateColors(palette: readonly number[]): Array<[number, number]> {
  const first = new Map<number, number>();
  const pairs: Array<[number, number]> = [];
  palette.forEach((color, index) => {
    const earlier = first.get(color);
    if (earlier === undefined) first.set(color, index);
    else pairs.push([earlier, index]);
  });
  return pairs;
}

/** A deterministic color that is not yet in the palette, for new palette entries. */
export function unusedColor(palette: readonly number[]): number {
  const used = new Set(palette);
  const levels = [0x00, 0x33, 0x66, 0x99, 0xcc, 0xff];
  for (const r of levels)
    for (const g of levels)
      for (const b of levels) {
        const color = (r << 16) | (g << 8) | b;
        if (!used.has(color)) return color;
      }
  for (let color = 0; color <= 0xffffff; color++) if (!used.has(color)) return color;
  return 0;
}

export interface Quantized {
  pixels: Uint8Array;
  /** 1 where the result differs from the source pixel (color or alpha). */
  changedMask: Uint8Array;
  changed: number;
  /** Opaque pixels whose RGB was replaced by a different palette color. */
  colorChanged: number;
  /** Pixels whose alpha was neither 0 (kept transparent) nor 255 (kept opaque). */
  alphaChanged: number;
}

/**
 * The same deterministic mapping as the engine's PNG loader: alpha below 128
 * becomes the transparent index (when there is one), every other pixel takes
 * the palette color with the smallest squared RGB distance, lowest index on
 * ties, never the transparent index unless the palette has a single color.
 */
export function quantize(
  rgba: Uint8ClampedArray,
  palette: readonly number[],
  transparentIndex: number | null,
): Quantized {
  const count = rgba.length >> 2;
  const pixels = new Uint8Array(count);
  const changedMask = new Uint8Array(count);
  const cache = new Map<number, number>();
  let colorChanged = 0;
  let alphaChanged = 0;
  let changed = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    const at = pixel * 4;
    const alpha = rgba[at + 3]!;
    if (transparentIndex !== null && alpha < 128) {
      pixels[pixel] = transparentIndex;
      if (alpha !== 0) {
        alphaChanged++;
        changed++;
        changedMask[pixel] = 1;
      }
      continue;
    }
    const key = (rgba[at]! << 16) | (rgba[at + 1]! << 8) | rgba[at + 2]!;
    let best = cache.get(key);
    if (best === undefined) {
      best = nearestIndex(palette, key, transparentIndex);
      if (cache.size < 65536) cache.set(key, best);
    }
    pixels[pixel] = best;
    const recolored = palette[best] !== key;
    const realpha = alpha !== 255;
    if (recolored) colorChanged++;
    if (realpha) alphaChanged++;
    if (recolored || realpha) {
      changed++;
      changedMask[pixel] = 1;
    }
  }
  return { pixels, changedMask, changed, colorChanged, alphaChanged };
}

/** Nearest palette index by squared RGB distance; lowest index wins ties. */
export function nearestIndex(
  palette: readonly number[],
  color: number,
  transparentIndex: number | null,
): number {
  const red = (color >> 16) & 255;
  const green = (color >> 8) & 255;
  const blue = color & 255;
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < palette.length; index++) {
    if (index === transparentIndex && palette.length > 1) continue;
    const entry = palette[index]!;
    const dr = red - ((entry >> 16) & 255);
    const dg = green - ((entry >> 8) & 255);
    const db = blue - (entry & 255);
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

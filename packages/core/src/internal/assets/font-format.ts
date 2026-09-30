import { PixelJSError } from '../../api/errors.js';
import type { FontOptions } from '../../api/types.js';
import { PROTOCOL } from '../protocol.js';
import { quote } from './json.js';

export const FONT_FORMAT = 'pixeljs-font';
export const FONT_VERSION = 1;
const FONT_KEYS: ReadonlySet<string> = new Set([
  'format',
  'version',
  'glyphWidth',
  'glyphHeight',
  'firstChar',
  'charCount',
  'fallbackChar',
  'bitmap',
  'glyphs',
]);
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Int8Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index++) BASE64_VALUES[BASE64.charCodeAt(index)] = index;

function invalid(problem: string): never {
  throw new PixelJSError('ASSET_DATA', `Invalid PixelJS font: ${problem}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own property only: inherited values never count as data. */
export function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function whole(
  data: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  const value = Object.hasOwn(data, key) ? own(data, key) : fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    invalid(`${key} must be an integer between ${min} and ${max}.`);
  return value;
}

/**
 * Strict standard base64 (RFC 4648 section 4): no whitespace, required
 * padding and zero unused bits. Returns null when `text` is not canonical.
 */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  const digit = (index: number): number => {
    const code = text.charCodeAt(index);
    return code < 128 ? (BASE64_VALUES[code] ?? -1) : -1;
  };
  let out = 0;
  for (let index = 0; index < text.length; index += 4) {
    const last = index + 4 === text.length;
    const a = digit(index);
    const b = digit(index + 1);
    const c = last && padding === 2 ? 0 : digit(index + 2);
    const d = last && padding > 0 ? 0 : digit(index + 3);
    if ((a | b | c | d) < 0) return null;
    const group = (a << 18) | (b << 12) | (c << 6) | d;
    if (last && padding > 0 && (group & (padding === 2 ? 0xffff : 0xff)) !== 0) return null;
    bytes[out++] = group >>> 16;
    if (out < bytes.length) bytes[out++] = (group >>> 8) & 0xff;
    if (out < bytes.length) bytes[out++] = group & 0xff;
  }
  return bytes;
}

function glyphBitmap(
  glyphs: unknown,
  charCount: number,
  glyphWidth: number,
  glyphHeight: number,
): Uint8Array {
  if (!Array.isArray(glyphs) || glyphs.length !== charCount)
    invalid(`glyphs must be an array of exactly charCount (${charCount}) glyphs.`);
  const rowBytes = Math.ceil(glyphWidth / 8);
  const bitmap = new Uint8Array(charCount * glyphHeight * rowBytes);
  for (let glyph = 0; glyph < charCount; glyph++) {
    const rows: unknown = glyphs[glyph];
    if (!Array.isArray(rows) || rows.length !== glyphHeight)
      invalid(`glyphs[${glyph}] must be an array of exactly glyphHeight (${glyphHeight}) rows.`);
    for (let y = 0; y < glyphHeight; y++) {
      const row: unknown = rows[y];
      if (typeof row !== 'string' || row.length !== glyphWidth)
        invalid(
          `glyphs[${glyph}][${y}] must be a string of exactly glyphWidth (${glyphWidth}) characters.`,
        );
      const offset = (glyph * glyphHeight + y) * rowBytes;
      for (let x = 0; x < glyphWidth; x++) {
        const pixel = row.charCodeAt(x);
        const at = offset + (x >> 3);
        if (pixel === 0x23) bitmap[at] = (bitmap[at] ?? 0) | (0x80 >> (x & 7));
        else if (pixel !== 0x2e)
          invalid(`glyphs[${glyph}][${y}] may only contain "#" (on) and "." (off).`);
      }
    }
  }
  return bitmap;
}

/**
 * Validates a `pixeljs-font` document (already parsed JSON) and returns the
 * equivalent createFont options. Every problem is an `ASSET_DATA` error.
 */
export function parseFontFile(data: unknown): FontOptions {
  if (!isRecord(data)) invalid('the file must contain a JSON object.');
  for (const key of Object.keys(data))
    if (!FONT_KEYS.has(key)) invalid(`unknown key ${quote(key)}.`);
  if (own(data, 'format') !== FONT_FORMAT) invalid(`format must be "${FONT_FORMAT}".`);
  const version = own(data, 'version');
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > FONT_VERSION)
    throw new PixelJSError(
      'ASSET_DATA',
      `PixelJS font version ${version} is newer than this version of PixelJS supports (${FONT_VERSION}). Update @pixeljs/core to load it.`,
    );
  if (version !== FONT_VERSION) invalid(`version must be ${FONT_VERSION}.`);
  const glyphWidth = whole(data, 'glyphWidth', 1, PROTOCOL.maxGlyphDimension);
  const glyphHeight = whole(data, 'glyphHeight', 1, PROTOCOL.maxGlyphDimension);
  const firstChar = whole(data, 'firstChar', 0, PROTOCOL.maxCharCode, 32);
  const charCount = whole(
    data,
    'charCount',
    1,
    Math.min(PROTOCOL.maxGlyphs, PROTOCOL.maxCharCode - firstChar + 1),
    96,
  );
  const lastChar = firstChar + charCount - 1;
  const hasBitmap = Object.hasOwn(data, 'bitmap');
  if (hasBitmap === Object.hasOwn(data, 'glyphs'))
    invalid('exactly one of "bitmap" and "glyphs" is required.');
  const expected = charCount * glyphHeight * Math.ceil(glyphWidth / 8);
  let bitmap: Uint8Array;
  if (hasBitmap) {
    const text = own(data, 'bitmap');
    // Checking the encoded length first bounds the work spent on bad input.
    if (typeof text !== 'string' || text.length !== Math.ceil(expected / 3) * 4)
      invalid(
        `bitmap must be base64 of exactly charCount * glyphHeight * ceil(glyphWidth / 8) (${expected}) bytes.`,
      );
    const decoded = decodeBase64(text);
    if (decoded === null || decoded.length !== expected) invalid('bitmap is not valid base64.');
    bitmap = decoded;
  } else bitmap = glyphBitmap(own(data, 'glyphs'), charCount, glyphWidth, glyphHeight);
  const font: FontOptions = { glyphWidth, glyphHeight, firstChar, charCount, bitmap };
  if (Object.hasOwn(data, 'fallbackChar'))
    font.fallbackChar = whole(data, 'fallbackChar', firstChar, lastChar);
  return font;
}

/**
 * Size of the block that graphics.text() lays out: every code unit except
 * `\n` and `\r` advances by one glyph, `\n` starts a line of glyph height and
 * `\r` is ignored. Text without any other code unit measures 0 × 0.
 */
export function textSize(
  text: string,
  advance: number,
  lineHeight: number,
): { width: number; height: number } {
  let lines = 1;
  let column = 0;
  let widest = 0;
  let empty = true;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) continue;
    empty = false;
    if (code === 10) {
      lines++;
      column = 0;
    } else if (++column > widest) widest = column;
  }
  return empty ? { width: 0, height: 0 } : { width: widest * advance, height: lines * lineHeight };
}

import { PixelJSError } from '../../api/errors.js';
import type { AssetKind } from '../../api/types.js';
import { isRecord, own } from './font-format.js';
import { quote } from './json.js';

export const MANIFEST_FORMAT = 'pixeljs-assets';
export const MANIFEST_VERSION = 1;
export const MANIFEST_LIMITS = Object.freeze({
  /** Manifest file size. */
  bytes: 1024 * 1024,
  entries: 1024,
  srcLength: 512,
  /** All data entries of one bundle together; each is also limited to 1 MiB. */
  dataBytes: 16 * 1024 * 1024,
  concurrency: 4,
});

interface KindSpec {
  /** Load order: an entry waits for the kinds of lower phases it depends on. */
  readonly phase: number;
  /** Keys allowed besides `src`. */
  readonly fields: readonly ('transparentIndex' | 'tileset')[];
  /** Whether loading creates an engine resource that must be released. */
  readonly resource: boolean;
}

/**
 * Manifest sections. Supporting another kind takes one line here (plus its
 * loader in the engine).
 */
export const ASSET_KINDS: Readonly<Record<AssetKind, KindSpec>> = Object.freeze({
  images: { phase: 0, fields: ['transparentIndex'], resource: true },
  data: { phase: 0, fields: [], resource: false },
  fonts: { phase: 1, fields: [], resource: true },
  sounds: { phase: 1, fields: [], resource: true },
  music: { phase: 1, fields: [], resource: true },
  tilemaps: { phase: 2, fields: ['tileset'], resource: true },
});
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
/** Never valid as keys, whatever the schema says. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
/** Characters the URL parser would strip or reinterpret, and URL syntax. */
const UNSAFE_PATH = /[\u0000-\u001f\u007f\\?#%:]/;

export interface ManifestEntry {
  readonly kind: AssetKind;
  readonly id: string;
  readonly url: URL;
  readonly phase: number;
  readonly transparentIndex?: number;
  readonly tileset?: string;
}
export interface Manifest {
  /** In manifest order. */
  readonly entries: readonly ManifestEntry[];
  readonly ids: Readonly<Record<AssetKind, readonly string[]>>;
}

function invalid(problem: string): never {
  throw new PixelJSError('ASSET_DATA', `Invalid asset manifest: ${problem}`);
}

function isKind(key: string): key is AssetKind {
  return Object.hasOwn(ASSET_KINDS, key);
}

/** Own enumerable keys of a JSON-like object; rejects keys that could reach a prototype. */
function keys(value: Record<string, unknown>, where: string): string[] {
  const names = Object.keys(value);
  for (const name of names)
    if (FORBIDDEN.has(name)) invalid(`${where} has the forbidden key ${quote(name)}.`);
  return names;
}

/**
 * Checks that `src` is a plain relative path that cannot leave the manifest's
 * directory once resolved, and resolves it against `directory`.
 */
export function assetPath(src: unknown, directory: URL, where: string): URL {
  if (typeof src !== 'string' || src.length === 0 || src.length > MANIFEST_LIMITS.srcLength)
    invalid(`${where}.src must be a string of 1 to ${MANIFEST_LIMITS.srcLength} characters.`);
  if (UNSAFE_PATH.test(src))
    invalid(
      `${where}.src must not contain control characters, "\\", "?", "#", "%" or ":" (got ${quote(src)}).`,
    );
  if (src.startsWith('/') || src.startsWith(' ') || src.endsWith(' '))
    invalid(`${where}.src must be a relative path (got ${quote(src)}).`);
  for (const segment of src.split('/'))
    if (segment === '' || segment === '.' || segment === '..')
      invalid(`${where}.src must not contain empty, "." or ".." segments (got ${quote(src)}).`);
  let url: URL;
  try {
    url = new URL(src, directory);
  } catch (error) {
    throw new PixelJSError('ASSET_DATA', `${where}.src is not a valid path.`, { cause: error });
  }
  // Defense in depth: whatever the rules above miss must still stay inside.
  if (url.origin !== directory.origin || !url.href.startsWith(directory.href))
    invalid(`${where}.src leaves the manifest directory (got ${quote(src)}).`);
  return url;
}

function entry(
  kind: AssetKind,
  id: string,
  value: unknown,
  directory: URL,
  paletteCount: number,
): ManifestEntry {
  const where = `${kind}.${id}`;
  if (!isRecord(value)) invalid(`${where} must be an object.`);
  const spec = ASSET_KINDS[kind];
  for (const key of keys(value, where))
    if (key !== 'src' && !(spec.fields as readonly string[]).includes(key))
      invalid(`${where} has the unknown key ${quote(key)}.`);
  if (!Object.hasOwn(value, 'src')) invalid(`${where} needs a "src".`);
  const result: {
    kind: AssetKind;
    id: string;
    url: URL;
    phase: number;
    transparentIndex?: number;
    tileset?: string;
  } = { kind, id, url: assetPath(own(value, 'src'), directory, where), phase: spec.phase };
  if (Object.hasOwn(value, 'transparentIndex')) {
    const index = own(value, 'transparentIndex');
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= paletteCount
    )
      invalid(`${where}.transparentIndex must be an integer between 0 and ${paletteCount - 1}.`);
    result.transparentIndex = index;
  }
  if (spec.fields.includes('tileset')) {
    const tileset = own(value, 'tileset');
    if (typeof tileset !== 'string' || !ID.test(tileset))
      invalid(`${where}.tileset must be the id of an image in this manifest.`);
    result.tileset = tileset;
  }
  return result;
}

/**
 * Validates a manifest (parsed JSON or a caller object) completely before
 * anything is loaded. `base` is the manifest URL, or the document base URL
 * for an object. Structural problems (unknown sections included) are
 * ASSET_DATA and too many entries CAPACITY.
 */
export function parseManifest(data: unknown, base: URL, paletteCount: number): Manifest {
  if (!isRecord(data)) invalid('it must be a JSON object.');
  const sections = keys(data, 'The manifest');
  if (own(data, 'format') !== MANIFEST_FORMAT) invalid(`format must be "${MANIFEST_FORMAT}".`);
  const version = own(data, 'version');
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > MANIFEST_VERSION)
    throw new PixelJSError(
      'ASSET_DATA',
      `Asset manifest version ${version} is newer than this version of PixelJS supports (${MANIFEST_VERSION}). Update @pixeljs/core to load it.`,
    );
  if (version !== MANIFEST_VERSION) invalid(`version must be ${MANIFEST_VERSION}.`);
  let directory: URL;
  try {
    directory = new URL('./', base);
  } catch (error) {
    throw new PixelJSError('ASSET_DATA', `Cannot resolve asset paths against ${base.href}.`, {
      cause: error,
    });
  }
  const found: Array<[AssetKind, Record<string, unknown>]> = [];
  let total = 0;
  for (const section of sections) {
    if (section === 'format' || section === 'version') continue;
    if (!isKind(section)) invalid(`unknown key ${quote(section)}.`);
    const value = own(data, section);
    if (!isRecord(value)) invalid(`"${section}" must be an object of entries.`);
    // Counted before any entry is inspected, so huge sections fail fast.
    total += Object.keys(value).length;
    if (total > MANIFEST_LIMITS.entries)
      throw new PixelJSError(
        'CAPACITY',
        `Asset manifests are limited to ${MANIFEST_LIMITS.entries} entries.`,
      );
    found.push([section, value]);
  }
  const ids = Object.fromEntries(
    Object.keys(ASSET_KINDS).map((kind): [string, string[]] => [kind, []]),
  ) as unknown as Record<AssetKind, string[]>;
  const entries: ManifestEntry[] = [];
  for (const [kind, section] of found) {
    for (const id of keys(section, `"${kind}"`)) {
      if (!ID.test(id)) invalid(`${kind} id ${quote(id)} must match /^[A-Za-z0-9_.-]{1,64}$/.`);
      ids[kind].push(id);
      entries.push(entry(kind, id, own(section, id), directory, paletteCount));
    }
  }
  const images = new Set(ids.images);
  for (const item of entries)
    if (item.tileset !== undefined && !images.has(item.tileset))
      invalid(
        `${item.kind}.${item.id}.tileset refers to the missing image ${quote(item.tileset)}.`,
      );
  for (const list of Object.values(ids)) Object.freeze(list);
  return Object.freeze({ entries: Object.freeze(entries), ids: Object.freeze(ids) });
}

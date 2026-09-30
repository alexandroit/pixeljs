import { PixelJSError } from '../../api/errors.js';
import type {
  AssetBundle,
  AssetKind,
  FontResource,
  ImageResource,
  MusicResource,
  SoundResource,
  TilemapResource,
} from '../../api/types.js';
import { quote } from './json.js';
import { ASSET_KINDS, MANIFEST_LIMITS, type Manifest, type ManifestEntry } from './manifest.js';

/** Loads one entry. `tileset` is the loaded image a tilemap entry refers to. */
export type EntryLoader = (
  entry: ManifestEntry,
  signal: AbortSignal,
  tileset: unknown,
) => Promise<unknown>;

export interface BundleHost {
  readonly loaders: Readonly<Record<AssetKind, EntryLoader>>;
  /** Releases a value returned by a loader of a resource kind. */
  release(value: unknown): void;
  /** Throws STATE after disposal or ABORTED after the caller's signal. */
  check(): void;
  /** Throws unless resources may be released now. */
  idle(): void;
  /** Aborts when the engine is disposed. */
  readonly lifetime: AbortSignal;
}

export interface BundleOptions {
  signal?: AbortSignal | undefined;
  onProgress?: ((loaded: number, total: number) => void) | undefined;
  concurrency?: number | undefined;
}

interface Loaded {
  readonly entry: ManifestEntry;
  readonly value: unknown;
}

/** Releases dependents first: kinds of later phases load after what they use. */
function releaseAll(loaded: readonly Loaded[], host: BundleHost): { error: unknown } | undefined {
  let failure: { error: unknown } | undefined;
  const order = loaded
    .filter(({ entry }) => ASSET_KINDS[entry.kind].resource)
    .sort((a, b) => b.entry.phase - a.entry.phase);
  for (const { value } of order) {
    try {
      host.release(value);
    } catch (error) {
      failure ??= { error };
    }
  }
  return failure;
}

/** A signal aborted by the first of `signals` to abort; call `detach` when done. */
export function linkedSignal(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  detach(): void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  for (const signal of signals) {
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort);
  }
  return {
    signal: controller.signal,
    detach: () => {
      for (const signal of signals) signal?.removeEventListener('abort', abort);
    },
  };
}

/** Keeps the failing entry's code and names the entry; cancellation passes through. */
function entryError(entry: ManifestEntry, error: unknown): unknown {
  if (error instanceof PixelJSError && (error.code === 'ABORTED' || error.code === 'STATE'))
    return error;
  const code = error instanceof PixelJSError ? error.code : 'ASSET_LOAD';
  const reason = error instanceof Error ? error.message : String(error);
  return new PixelJSError(code, `Asset ${entry.kind}.${entry.id} failed: ${reason}`, {
    cause: error,
  });
}

function createBundle(
  manifest: Manifest,
  loaded: readonly Loaded[],
  host: BundleHost,
): AssetBundle {
  const values = new Map<AssetKind, Map<string, unknown>>();
  for (const kind of Object.keys(ASSET_KINDS) as AssetKind[]) values.set(kind, new Map());
  for (const { entry, value } of loaded) values.get(entry.kind)?.set(entry.id, value);
  let released = false;
  const alive = (): void => {
    if (released) throw new PixelJSError('STATE', 'The asset bundle was released.');
  };
  const get = (kind: AssetKind, id: unknown, name: string): unknown => {
    alive();
    if (typeof id !== 'string')
      throw new PixelJSError('ARGUMENT', 'The asset id must be a string.');
    const map = values.get(kind);
    if (!map?.has(id))
      throw new PixelJSError('ARGUMENT', `The bundle has no ${name} ${quote(id)}.`);
    return map.get(id);
  };
  return Object.freeze({
    image: (id: string) => get('images', id, 'image') as ImageResource,
    tilemap: (id: string) => get('tilemaps', id, 'tilemap') as TilemapResource,
    font: (id: string) => get('fonts', id, 'font') as FontResource,
    sound: (id: string) => get('sounds', id, 'sound') as SoundResource,
    music: (id: string) => get('music', id, 'music') as MusicResource,
    data: <T = unknown>(id: string) => get('data', id, 'data entry') as T,
    ids: (kind: AssetKind): readonly string[] => {
      alive();
      if (typeof kind !== 'string' || !Object.hasOwn(ASSET_KINDS, kind))
        throw new PixelJSError(
          'ARGUMENT',
          `kind must be one of ${Object.keys(ASSET_KINDS).join(', ')}.`,
        );
      return manifest.ids[kind];
    },
    release: (): void => {
      if (released) return;
      host.idle();
      // Final even if one release fails: that resource stays valid for engine.release().
      released = true;
      const failure = releaseAll(loaded, host);
      if (failure) throw failure.error;
    },
  });
}

/**
 * Loads a validated manifest with bounded concurrency. Resolves only when
 * every entry succeeded; otherwise the pending loads are cancelled, every
 * resource already created is released and the first error is the rejection.
 */
export function loadBundle(
  manifest: Manifest,
  host: BundleHost,
  options: BundleOptions = {},
): Promise<AssetBundle> {
  const { signal, onProgress } = options;
  const concurrency = options.concurrency ?? MANIFEST_LIMITS.concurrency;
  return new Promise<AssetBundle>((resolve, reject) => {
    // Stable: manifest order within a phase.
    const queue = [...manifest.entries].sort((a, b) => a.phase - b.phase);
    const total = queue.length;
    const internal = new AbortController();
    const loaded: Loaded[] = [];
    const images = new Map<string, unknown>();
    let active = 0;
    let done = 0;
    let failure: { error: unknown } | undefined;
    let settled = false;

    const aborted = (): void =>
      fail(new PixelJSError('ABORTED', 'The operation was cancelled.', { cause: signal?.reason }));
    const disposed = (): void =>
      fail(new PixelJSError('STATE', 'The engine was disposed while loading.'));
    signal?.addEventListener('abort', aborted);
    host.lifetime.addEventListener('abort', disposed);

    function fail(error: unknown): void {
      if (failure) return;
      failure = { error };
      internal.abort(error);
      pump();
    }

    function settle(): void {
      settled = true;
      signal?.removeEventListener('abort', aborted);
      host.lifetime.removeEventListener('abort', disposed);
    }

    function start(entry: ManifestEntry): void {
      active++;
      const tileset = entry.tileset === undefined ? undefined : images.get(entry.tileset);
      let work: Promise<unknown>;
      try {
        work = host.loaders[entry.kind](entry, internal.signal, tileset);
      } catch (error) {
        work = Promise.reject(error);
      }
      work.then(
        (value) => {
          active--;
          // Recorded even after a failure, so that rollback releases it.
          loaded.push({ entry, value });
          if (!failure) {
            if (entry.kind === 'images') images.set(entry.id, value);
            done++;
            try {
              host.check();
              const result: unknown = onProgress?.(done, total);
              // The callback is synchronous; a returned promise is only observed.
              if (result instanceof Promise) result.catch(() => undefined);
            } catch (error) {
              fail(error);
            }
          }
          pump();
        },
        (error: unknown) => {
          active--;
          fail(entryError(entry, error));
          pump();
        },
      );
    }

    function pump(): void {
      if (settled) return;
      if (failure) {
        // Pending loads observe the abort; wait for them so nothing they
        // create is left behind.
        if (active > 0) return;
        settle();
        releaseAll(loaded, host);
        reject(failure.error);
        return;
      }
      while (active < concurrency) {
        const next = queue.findIndex(
          (entry) => entry.tileset === undefined || images.has(entry.tileset),
        );
        if (next < 0) break;
        start(queue.splice(next, 1)[0]!);
      }
      if (active > 0) return;
      if (queue.length > 0) {
        fail(new PixelJSError('ASSET_DATA', 'A tilemap refers to a tileset that did not load.'));
        return;
      }
      try {
        host.check();
      } catch (error) {
        fail(error);
        return;
      }
      settle();
      resolve(createBundle(manifest, loaded, host));
    }

    if (host.lifetime.aborted) disposed();
    else if (signal?.aborted) aborted();
    else pump();
  });
}

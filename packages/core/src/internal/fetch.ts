import { PixelJSError } from '../api/errors.js';

/** Resolves a caller-supplied asset reference against the document, not the package. */
export function assetUrl(source: unknown, name: string): URL {
  if (
    !(source instanceof URL) &&
    (typeof source !== 'string' || source.trim().length === 0 || source.length > 4096)
  ) {
    throw new PixelJSError('ARGUMENT', `${name} must be a URL or a non-empty string.`);
  }
  const base = typeof document === 'undefined' ? undefined : document.baseURI;
  try {
    return new URL(source, base);
  } catch (error) {
    throw new PixelJSError('ARGUMENT', `${name} is not a valid URL.`, { cause: error });
  }
}

export function checkSignal(signal: unknown): AbortSignal | undefined {
  if (signal === undefined) return undefined;
  if (typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal))
    throw new PixelJSError('ARGUMENT', 'signal must be an AbortSignal.');
  return signal;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new PixelJSError('ABORTED', 'The operation was cancelled.', { cause: signal.reason });
}

export interface LimitedRequest {
  /** Maximum body bytes actually read, independent of Content-Length. */
  limit: number;
  /** Error code for network and HTTP failures. */
  code: string;
  signal?: AbortSignal | undefined;
  /** Checked before the body is read, so a wrong response fails fast. */
  expectType?: { mime: string; code: string; message: string } | undefined;
}

/**
 * Fetches a resource and reads at most `limit` bytes of its body. `url` is
 * the final URL after redirects, against which relative references resolve.
 */
export async function fetchLimited(
  url: URL,
  request: LimitedRequest,
): Promise<{ bytes: Uint8Array; contentType: string; url: URL }> {
  const { limit, code, signal, expectType } = request;
  throwIfAborted(signal);
  const init: RequestInit = { credentials: 'same-origin' };
  if (signal) init.signal = signal;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throwIfAborted(signal);
    throw new PixelJSError(code, `Request for ${url.pathname} failed.`, { cause: error });
  }
  const discard = (): Promise<void> =>
    response.body?.cancel().catch(() => undefined) ?? Promise.resolve();
  if (!response.ok) {
    await discard();
    throw new PixelJSError(code, `Request failed (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  let final = url;
  try {
    if (response.url) final = new URL(response.url);
  } catch {
    /* Keep the requested URL. */
  }
  if (expectType && contentType !== expectType.mime) {
    await discard();
    throw new PixelJSError(expectType.code, expectType.message);
  }
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    await discard();
    throw new PixelJSError('CAPACITY', `The response exceeds the ${limit}-byte limit.`);
  }
  if (!response.body) return { bytes: new Uint8Array(0), contentType, url: final };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > limit - size) {
        await reader.cancel().catch(() => undefined);
        throw new PixelJSError('CAPACITY', `The response exceeds the ${limit}-byte limit.`);
      }
      chunks.push(result.value);
      size += result.value.byteLength;
    }
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof PixelJSError) throw error;
    throw new PixelJSError(code, `Reading ${url.pathname} failed.`, { cause: error });
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType, url: final };
}

/** Parses bounded UTF-8 JSON. The result is untrusted data for the caller's schema. */
export function parseJson(bytes: Uint8Array, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new PixelJSError(code, 'The response is not valid UTF-8 JSON.', { cause: error });
  }
}

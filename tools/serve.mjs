import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { productionPolicy } from './csp.mjs';
const root = await realpath(process.env.PIXELJS_SERVE_ROOT ?? '.');
const port = Number(process.env.PORT ?? 4174);
// PIXELJS_SERVE_CSP=production applies the exact policy of the production
// Nginx configuration, so tests exercise what visitors' browsers enforce.
const policy =
  process.env.PIXELJS_SERVE_CSP === 'production' ? await productionPolicy() : undefined;
// PIXELJS_SERVE_CACHE=production answers like the production Nginx site:
// `Cache-Control: no-cache, no-transform` with an Nginx-style ETag and
// Last-Modified, and 304 for a matching If-None-Match, so warm-cache
// benchmarks see what a returning visitor gets. The default, no-store,
// keeps tests from ever reusing a stale file.
const productionCache = process.env.PIXELJS_SERVE_CACHE === 'production';
// PIXELJS_SERVE_LOG=1 prints one JSON line per response for byte accounting.
const log = process.env.PIXELJS_SERVE_LOG === '1';
// PIXELJS_SERVE_ISOLATE=1 adds COOP/COEP (cross-origin isolation) for
// benchmarks that need finer timers; production sends neither header.
const isolation =
  process.env.PIXELJS_SERVE_ISOLATE === '1'
    ? {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      }
    : {};
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.tgz': 'application/gzip',
};
function finish(response, path, status, headers, body) {
  response.writeHead(status, headers);
  response.end(body);
  if (log)
    console.log(JSON.stringify({ path, status, bytes: body?.length ?? 0, time: Date.now() }));
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    let file = await realpath(path);
    if (file !== root && !file.startsWith(root + sep)) {
      finish(response, url.pathname, 403, {});
      return;
    }
    if ((await stat(file)).isDirectory()) file = await realpath(resolve(file, 'index.html'));
    if (!file.startsWith(root + sep)) {
      finish(response, url.pathname, 403, {});
      return;
    }
    const info = await stat(file);
    const etag = `"${Math.floor(info.mtimeMs / 1000).toString(16)}-${info.size.toString(16)}"`;
    const headers = {
      'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': productionCache ? 'no-cache, no-transform' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(policy ? { 'Content-Security-Policy': policy } : {}),
      ...(productionCache ? { ETag: etag, 'Last-Modified': info.mtime.toUTCString() } : {}),
      ...isolation,
    };
    if (productionCache && request.headers['if-none-match'] === etag) {
      finish(response, url.pathname, 304, headers);
      return;
    }
    finish(response, url.pathname, 200, headers, await readFile(file));
  } catch {
    finish(response, url.pathname, 404, { 'Content-Type': 'text/plain' }, Buffer.from('Not found'));
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`PixelJS server http://127.0.0.1:${server.address().port}`),
);

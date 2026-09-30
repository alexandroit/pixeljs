import { readFile } from 'node:fs/promises';

/** The Content-Security-Policy served in production, read from the Nginx site configuration. */
export async function productionPolicy() {
  const config = await readFile(new URL('../infra/nginx/pixeljs.conf', import.meta.url), 'utf8');
  const policy = config.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1];
  if (!policy) throw new Error('The production CSP was not found in infra/nginx/pixeljs.conf.');
  return policy;
}

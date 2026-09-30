import { readdir, readFile } from 'node:fs/promises';
import { run } from './run.mjs';
async function visit(dir, callback) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await visit(path, callback);
    else await callback(path);
  }
}
await visit('tools', async (path) => {
  if (path.endsWith('.mjs')) run(process.execPath, ['--check', path]);
});
for (const path of [
  'packages/core/src/internal/audio/processor.js',
  'packages/create/bin/create-pixeljs.js',
  'packages/create/src/cli.js',
  'packages/create/src/index.js',
])
  run(process.execPath, ['--check', path]);
for (const directory of ['core/src', 'bridge/wasm', 'bridge/audio'])
  await visit(directory, async (path) => {
    if (!/\.[ch]$/.test(path)) return;
    const text = await readFile(path, 'utf8');
    if (/\b(gets|strcpy|strcat|sprintf|alloca|system|popen)\s*\(/.test(text))
      throw new Error(`Forbidden C function in ${path}`);
  });
await visit('packages/core/src', async (path) => {
  if (!/\.(ts|js)$/.test(path)) return;
  const text = await readFile(path, 'utf8');
  if (/\beval\s*\(|new\s+Function\s*\(/.test(text))
    throw new Error(`Dynamic string execution in ${path}`);
});
console.log(
  'Source syntax and bounded-runtime policy checks passed. Native warnings are enforced by CMake.',
);

import { copyFile, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { run, npm } from './run.mjs';
run(process.execPath, ['tools/generate-protocol.mjs', '--check']);
// Start from an empty dist so renamed or deleted modules can never be packed.
await rm('packages/core/dist', { recursive: true, force: true });
run(npm, ['run', 'build:ts']);
// The AudioWorklet module is plain JavaScript loaded by URL, not bundled.
await copyFile(
  'packages/core/src/internal/audio/processor.js',
  'packages/core/dist/internal/audio/processor.js',
);
run(process.execPath, ['tools/build-wasm.mjs']);
const hashes = {};
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await scan(path);
    else
      hashes[path.replace('packages/core/', '')] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
}
await scan('packages/core/dist');
const pkg = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
await mkdir('artifacts', { recursive: true });
await writeFile(
  'artifacts/build-manifest.json',
  JSON.stringify({ package: pkg.name, version: pkg.version, files: hashes }, null, 2) + '\n',
);
console.log('Build manifest: artifacts/build-manifest.json');

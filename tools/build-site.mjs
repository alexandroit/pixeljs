import { build } from 'vite';
import { copyFile, cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { run, npm } from './run.mjs';
const out = resolve('apps/site/dist');
for (const [root, target] of [
  ['apps/site', out],
  ['examples/javascript', `${out}/examples/javascript`],
  ['examples/typescript', `${out}/examples/typescript`],
  ['apps/mobile-smoke', `${out}/mobile-smoke`],
  ['apps/editor', `${out}/editor`],
]) {
  await build({
    configFile: false,
    root: resolve(root),
    base: './',
    // Bundled files go to build/, apart from the game's own assets/ files.
    build: {
      outDir: target,
      assetsDir: 'build',
      emptyOutDir: true,
      assetsInlineLimit: 0,
      target: 'es2022',
    },
  });
}
for (const [from, to] of [
  ['examples/javascript/game.js', 'examples/javascript/game.js'],
  ['examples/javascript/game.d.ts', 'examples/javascript/game.d.ts'],
  ['examples/javascript/pacman-model.js', 'examples/javascript/pacman-model.js'],
  ['examples/javascript/pacman-model.d.ts', 'examples/javascript/pacman-model.d.ts'],
  ['examples/javascript/controls.js', 'examples/javascript/controls.js'],
  ['examples/javascript/controls.d.ts', 'examples/javascript/controls.d.ts'],
  ['examples/javascript/main.js', 'examples/javascript/main.js'],
  ['examples/typescript/main.ts', 'examples/typescript/main.ts'],
])
  await copyFile(from, `${out}/${to}`);
// The example game loads these files at run time through its manifest.
await cp('examples/javascript/assets', `${out}/examples/javascript/assets`, { recursive: true });
// The package archives that test:package installs and whose digests CI
// records for publication.
await mkdir('artifacts', { recursive: true });
for (const workspace of ['@pixeljs/core', '@pixeljs/create']) {
  run(npm, [
    'pack',
    '--workspace',
    workspace,
    '--pack-destination',
    resolve('artifacts'),
    '--ignore-scripts',
  ]);
}
// The site links to the npm packages; it never serves an archive.
const pkg = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
const files = {};
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await scan(path);
    else
      files[path.slice(out.length + 1)] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
  }
}
await scan(out);
await writeFile(
  'artifacts/site-manifest.json',
  JSON.stringify({ version: pkg.version, files }, null, 2) + '\n',
);
console.log(`Site ready: ${out}`);

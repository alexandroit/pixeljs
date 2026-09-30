import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { run } from './run.mjs';
for (const file of [
  'examples/javascript/game.js',
  'examples/javascript/pacman-model.js',
  'examples/javascript/controls.js',
  'examples/javascript/main.js',
  'examples/typescript/main.ts',
]) {
  assert.equal(
    await readFile(`apps/site/dist/${file}`, 'utf8'),
    await readFile(file, 'utf8'),
    `Site source panel must match actual ${file}`,
  );
}
run(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '--ignoreConfig',
  '--noEmit',
  '--strict',
  '--noUncheckedIndexedAccess',
  '--exactOptionalPropertyTypes',
  '--target',
  'ES2022',
  '--module',
  'ESNext',
  '--moduleResolution',
  'Bundler',
  '--lib',
  'ES2022,DOM',
  '--skipLibCheck',
  'apps/site/src/main.ts',
  'apps/editor/src/main.ts',
  'apps/mobile-smoke/src/main.ts',
  'examples/typescript/main.ts',
]);
const source = await readFile('apps/site/src/main.ts', 'utf8');
assert(source.includes('../../../examples/javascript/game.js'));
assert(!source.includes('readText('), 'Code copying must never read the clipboard.');
const html = await readFile('apps/site/dist/index.html', 'utf8');
assert(html.includes('lang="en"'));
assert(
  !/<script(?![^>]*src=)[^>]*>[^<\s]/.test(html),
  'Deployment must not need inline executable scripts.',
);

// Every relative Markdown link must resolve to a file and, when it names a
// heading, to an existing GitHub-style anchor.
const skipped = new Set([
  'node_modules',
  '.git',
  'build',
  'artifacts',
  'dist',
  'test-results',
  'playwright-report',
]);
async function markdownFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}
function anchors(markdown) {
  const seen = new Map();
  const result = new Set();
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const base = heading[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}
const broken = [];
let checked = 0;
for (const file of await markdownFiles('.')) {
  const markdown = await readFile(file, 'utf8');
  for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|\/)/.test(target)) continue;
    const [pathPart, anchor] = target.split('#');
    const resolved = pathPart ? join(dirname(file), decodeURIComponent(pathPart)) : file;
    checked += 1;
    try {
      const info = await stat(resolved);
      if (anchor && info.isFile() && resolved.endsWith('.md')) {
        if (!anchors(await readFile(resolved, 'utf8')).has(anchor))
          broken.push(`${file}: missing anchor ${target}`);
      }
    } catch {
      broken.push(`${file}: missing ${relative('.', resolved)}`);
    }
  }
}
assert.deepEqual(broken, [], `Broken Markdown links:\n${broken.join('\n')}`);

console.log(
  `PASS: real JS/TS source panels, strict typed examples, English entry, external scripts and ${checked} Markdown links.`,
);

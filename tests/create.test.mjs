import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  createProject,
  validateDestination,
  normalizeTemplate,
  sanitizeProjectName,
} from '../packages/create/src/index.js';
import { runCli } from '../packages/create/src/cli.js';

test('template normalization and project name sanitization', () => {
  assert.equal(normalizeTemplate('ts'), 'typescript');
  assert.equal(normalizeTemplate('typescript'), 'typescript');
  assert.equal(normalizeTemplate('TYPESCRIPT'), 'typescript');
  assert.equal(normalizeTemplate('js'), 'javascript');
  assert.equal(normalizeTemplate('javascript'), 'javascript');
  assert.equal(normalizeTemplate('JS'), 'javascript');
  assert.throws(() => normalizeTemplate('python'), /Invalid template/);
  assert.throws(() => normalizeTemplate(''), /Invalid template/);

  assert.equal(sanitizeProjectName('my-cool-game'), 'my-cool-game');
  assert.equal(sanitizeProjectName('My Game 123!'), 'my-game-123');
  assert.equal(sanitizeProjectName('---game---'), 'game');
  assert.equal(sanitizeProjectName(''), 'pixeljs-app');
  assert.equal(sanitizeProjectName('.hidden_game'), 'hidden_game');
  assert.equal(sanitizeProjectName('x'.repeat(300)).length, 214);
});

test('forced scaffolding never writes through symbolic links inside the destination', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pixeljs-link-test-'));
  try {
    const target = join(tempDir, 'game');
    const outside = join(tempDir, 'outside');
    await mkdir(target);
    await mkdir(outside);
    await symlink(join(outside, 'stolen.html'), join(target, 'index.html'));
    await assert.rejects(
      createProject({ targetDir: target, template: 'javascript', force: true }),
      /symbolic link/,
    );
    await assert.rejects(readFile(join(outside, 'stolen.html')), { code: 'ENOENT' });
    await rm(join(target, 'index.html'));
    await symlink(outside, join(target, 'src'));
    await assert.rejects(
      createProject({ targetDir: target, template: 'javascript', force: true }),
      /symbolic link/,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('destination validation rejects unsafe paths and preserves non-empty dirs', async () => {
  await assert.rejects(async () => validateDestination('test\0bad'), /null byte/);
  await assert.rejects(async () => validateDestination('/'), /root directory/);

  const tempDir = await mkdtemp(join(tmpdir(), 'pixeljs-dest-test-'));
  try {
    // Valid clean path
    const valid = await validateDestination(join(tempDir, 'new-project'));
    assert.ok(valid.endsWith('new-project'));

    // Existing non-empty directory without force
    const nonEmpty = join(tempDir, 'existing');
    await mkdir(nonEmpty);
    await writeFile(join(nonEmpty, 'file.txt'), 'hello');

    await assert.rejects(async () => validateDestination(nonEmpty, false), /not empty/);

    // With force = true, non-empty directory is accepted
    const forced = await validateDestination(nonEmpty, true);
    assert.equal(forced, nonEmpty);

    // Existing file (not a directory) is rejected
    const fileTarget = join(tempDir, 'file.txt');
    await writeFile(fileTarget, 'data');
    await assert.rejects(async () => validateDestination(fileTarget, false), /not a directory/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a directory named like "..game" is inside the working directory and still checked', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pixeljs-dots-test-'));
  const outside = await mkdtemp(join(tmpdir(), 'pixeljs-outside-'));
  const previous = process.cwd();
  try {
    process.chdir(workspace);
    await symlink(outside, join(workspace, '..escape'), 'dir');
    await assert.rejects(validateDestination('..escape/game'), /symbolic link/);
    await mkdir(join(workspace, '..plain'));
    assert.equal(await validateDestination('..plain/game'), join(process.cwd(), '..plain', 'game'));
  } finally {
    process.chdir(previous);
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('scaffolding javascript project creates complete working files', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pixeljs-js-test-'));
  const target = join(tempDir, 'my-js-game');
  try {
    const result = await createProject({
      targetDir: target,
      template: 'javascript',
    });

    assert.equal(result.template, 'javascript');
    assert.equal(result.projectName, 'my-js-game');

    const files = await readdir(target, { recursive: true });
    assert.ok(files.includes('package.json'));
    assert.ok(files.includes('index.html'));
    assert.ok(files.includes('vite.config.js'));
    assert.ok(files.includes('.gitignore'));
    assert.ok(files.includes('README.md'));
    assert.ok(files.some((f) => f.includes('main.js')));

    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-js-game');
    // Starters depend on the runtime version released together with the tool.
    const core = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
    const tool = JSON.parse(await readFile('packages/create/package.json', 'utf8'));
    assert.equal(tool.version, core.version);
    assert.equal(pkg.dependencies['@pixeljs/core'], `^${core.version}`);
    assert.equal(
      await readFile(join(target, '.gitignore'), 'utf8'),
      'node_modules\ndist\n.DS_Store\n',
    );
    assert.ok(!files.includes('_gitignore'));

    const html = await readFile(join(target, 'index.html'), 'utf8');
    assert.ok(html.includes('my-js-game — PixelJS'));
    assert.ok(html.includes('<canvas id="game"'));
    assert.ok(html.includes('src="/src/main.js"'));

    const mainJs = await readFile(join(target, 'src', 'main.js'), 'utf8');
    assert.ok(mainJs.includes("import { createEngine } from '@pixeljs/core'"));
    assert.ok(mainJs.includes('engine.audio.createSound'));
    assert.ok(mainJs.includes('engine.audio.unlock()'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('scaffolding typescript project creates strict typed files', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pixeljs-ts-test-'));
  const target = join(tempDir, 'my-ts-game');
  try {
    const result = await createProject({
      targetDir: target,
      template: 'typescript',
    });

    assert.equal(result.template, 'typescript');
    assert.equal(result.projectName, 'my-ts-game');

    const files = await readdir(target, { recursive: true });
    assert.ok(files.includes('package.json'));
    assert.ok(files.includes('tsconfig.json'));
    assert.ok(files.includes('index.html'));
    assert.ok(files.includes('vite.config.js'));
    assert.ok(files.includes('.gitignore'));
    assert.ok(files.includes('README.md'));
    assert.ok(files.some((f) => f.includes('main.ts')));

    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-ts-game');
    assert.ok(pkg.devDependencies['typescript']);

    const tsconfig = JSON.parse(await readFile(join(target, 'tsconfig.json'), 'utf8'));
    assert.equal(tsconfig.compilerOptions.strict, true);

    const mainTs = await readFile(join(target, 'src', 'main.ts'), 'utf8');
    assert.ok(mainTs.includes("import { createEngine, type SoundResource } from '@pixeljs/core'"));
    assert.ok(mainTs.includes('interface Player'));

    // Verify TypeScript type checks main.ts cleanly against @pixeljs/core declarations
    const repoRoot = resolve('.');
    await mkdir(join(target, 'node_modules/@pixeljs'), { recursive: true });
    await symlink(
      join(repoRoot, 'packages/core'),
      join(target, 'node_modules/@pixeljs/core'),
      'dir',
    );
    await new Promise((res, rej) => {
      const child = spawn(
        process.execPath,
        [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', join(target, 'tsconfig.json')],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (out += d.toString()));
      child.on('close', (code) =>
        code === 0 ? res(out) : rej(new Error(`tsc verification failed (code ${code}): ${out}`)),
      );
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('cli binary executes correctly for help, version and scaffolding', async () => {
  const binPath = resolve('packages/create/bin/create-pixeljs.js');

  // Test --help
  const helpOut = await new Promise((res, rej) => {
    const child = spawn(process.execPath, [binPath, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`Exit code ${code}`))));
  });
  assert.ok(helpOut.includes('Usage: create-pixeljs'));
  assert.ok(helpOut.includes('--template'));

  // Test --version
  const versionOut = await new Promise((res, rej) => {
    const child = spawn(process.execPath, [binPath, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`Exit code ${code}`))));
  });
  assert.ok(versionOut.includes('@pixeljs/create v0.0.3'));

  // Test binary scaffold in temp dir
  const tempDir = await mkdtemp(join(tmpdir(), 'pixeljs-cli-test-'));
  const projectDir = join(tempDir, 'cli-game');
  try {
    const runOut = await new Promise((res, rej) => {
      const child = spawn(process.execPath, [binPath, projectDir, '--template', 'typescript'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`Exit code ${code}`))));
    });
    assert.ok(runOut.includes('Success! Created cli-game'));
    const files = await readdir(projectDir);
    assert.ok(files.includes('package.json'));
    assert.ok(files.includes('tsconfig.json'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

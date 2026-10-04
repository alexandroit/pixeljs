import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import {
  TEMPLATES,
  createProject,
  validateDestination,
  normalizeTemplate,
  sanitizeProjectName,
} from '../packages/create/src/index.js';
import { runCli } from '../packages/create/src/cli.js';
import { LEVELS } from '../packages/create/templates/portal/src/world.js';

test('template normalization and project name sanitization', () => {
  assert.equal(normalizeTemplate('ts'), 'typescript');
  assert.equal(normalizeTemplate('typescript'), 'typescript');
  assert.equal(normalizeTemplate('TYPESCRIPT'), 'typescript');
  assert.equal(normalizeTemplate('js'), 'javascript');
  assert.equal(normalizeTemplate('javascript'), 'javascript');
  assert.equal(normalizeTemplate('JS'), 'javascript');
  assert.equal(normalizeTemplate('portal'), 'portal');
  assert.equal(normalizeTemplate('Board'), 'board');
  assert.deepEqual(Object.keys(TEMPLATES), ['typescript', 'javascript', 'portal', 'board']);
  assert.throws(() => normalizeTemplate('python'), /Invalid template/);
  assert.throws(() => normalizeTemplate(''), /Invalid template/);
  for (const name of ['constructor', '__proto__', 'toString'])
    assert.throws(() => normalizeTemplate(name), /Available templates: typescript, javascript/);

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
  assert.ok(versionOut.includes('@pixeljs/create v0.0.5'));

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

// Games on the portal run in a sandbox: no network requests and no browser storage.
const OUTSIDE_SANDBOX =
  /\b(localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket)\b|document\.cookie|\bfetch\s*\(/;

test('the portal and board starters are ready for the PixelJS portal', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pixeljs-portal-starters-'));
  const core = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
  try {
    for (const template of ['portal', 'board']) {
      const target = join(tempDir, `my-${template}-game`);
      const result = await createProject({ targetDir: target, template });
      assert.equal(result.template, template);
      const files = (await readdir(target, { recursive: true })).map((file) =>
        file.split(sep).join('/'),
      );
      for (const file of [
        'package.json',
        'index.html',
        'vite.config.js',
        '.gitignore',
        'README.md',
        'public/pixeljs.json',
        'src/main.js',
        'src/style.css',
      ])
        assert.ok(files.includes(file), `the ${template} starter has ${file}`);
      assert.ok(!files.includes('_gitignore'));

      const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
      assert.equal(pkg.name, `my-${template}-game`);
      assert.equal(pkg.dependencies['@pixeljs/core'], `^${core.version}`);
      const readme = await readFile(join(target, 'README.md'), 'utf8');
      assert.ok(readme.startsWith(`# my-${template}-game\n`));
      assert.ok(readme.includes('npm run build') && readme.includes('PixelJS studio'));
      assert.ok(readme.includes('https://pixeljs.com/developers/tutorial/'));
      assert.ok(
        (await readFile(join(target, 'index.html'), 'utf8')).includes('src="/src/main.js"'),
      );
      // Relative URLs: the portal serves the build from its own folder.
      assert.match(await readFile(join(target, 'vite.config.js'), 'utf8'), /base: '\.\/'/);

      const main = await readFile(join(target, 'src/main.js'), 'utf8');
      assert.ok(
        main.includes("import { attachEngine, connectPortal } from '@pixeljs/core/portal'"),
      );
      for (const file of files.filter((name) => name.endsWith('.js'))) {
        const source = await readFile(join(target, file), 'utf8');
        assert.doesNotMatch(source, OUTSIDE_SANDBOX, `${template}/${file} fits the portal sandbox`);
        assert.ok(!source.includes('{{'), `${template}/${file} has no placeholder left`);
      }

      const manifest = JSON.parse(await readFile(join(target, 'public/pixeljs.json'), 'utf8'));
      assert.equal(manifest.manifest_version, 2);
      assert.equal(manifest.min_age, 0);
      // The game asks for exactly the capabilities its manifest declares.
      const requested = /capabilities: \[([^\]]*)\]/.exec(main)[1];
      assert.deepEqual(
        [...requested.matchAll(/'([^']+)'/g)].map((match) => match[1]),
        manifest.capabilities,
      );
      if (template === 'portal') {
        assert.deepEqual(manifest.capabilities, [
          'pause',
          'mute',
          'levels',
          'scores',
          'achievements',
          'save',
          'level-select',
        ]);
        assert.deepEqual(
          manifest.levels.map((level) => level.id),
          LEVELS.map((level) => level.id),
        );
        assert.deepEqual(
          manifest.levels.map((level) => level.par_time_ms),
          LEVELS.map((level) => level.par),
        );
        const boards = Object.fromEntries(manifest.leaderboards.map((board) => [board.id, board]));
        assert.deepEqual(Object.keys(boards), ['level-score', 'fastest', 'total']);
        assert.equal(boards['level-score'].scope, 'level');
        assert.equal(boards.fastest.sort, 'asc');
        assert.equal(boards.total.source, 'sum_levels');
        assert.equal(boards.total.of, 'level-score');
        assert.equal(boards.total.default, true);
        assert.equal(manifest.achievements.length, 2);
        assert.ok(manifest.achievements.every((achievement) => achievement.rule));
        assert.ok(manifest.save.slots >= 1);
      } else {
        for (const file of [
          'src/rules.js',
          'src/board.js',
          'src/modes/solo.js',
          'src/modes/local.js',
          'src/modes/online.js',
        ])
          assert.ok(files.includes(file), `the board starter has ${file}`);
        assert.deepEqual(manifest.capabilities, ['pause', 'mute', 'multiplayer']);
        assert.deepEqual(manifest.play_modes, ['solo', 'local', 'online']);
        assert.equal(manifest.local_players, 2);
        assert.deepEqual(manifest.multiplayer, {
          min_players: 2,
          max_players: 2,
          modes: [{ id: 'versus', name: 'Versus' }],
          quick_match: true,
          private_rooms: true,
          join_in_progress: false,
          max_message_bytes: 1024,
          max_messages_per_second: 10,
        });
        const online = await readFile(join(target, 'src/modes/online.js'), 'utf8');
        assert.match(online, /const MODE = 'versus';/);
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('the portal and board starters build with Vite against the core', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pixeljs-portal-builds-'));
  const repoRoot = resolve('.');
  try {
    for (const template of ['portal', 'board']) {
      const target = join(tempDir, template);
      await createProject({ targetDir: target, template });
      await mkdir(join(target, 'node_modules/@pixeljs'), { recursive: true });
      await symlink(
        join(repoRoot, 'packages/core'),
        join(target, 'node_modules/@pixeljs/core'),
        'dir',
      );
      await symlink(join(repoRoot, 'node_modules/vite'), join(target, 'node_modules/vite'), 'dir');
      await build({ root: target, logLevel: 'error' });
      const dist = join(target, 'dist');
      const built = (await readdir(dist, { recursive: true })).map((file) =>
        file.split(sep).join('/'),
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(dist, 'pixeljs.json'), 'utf8')),
        JSON.parse(await readFile(join(target, 'public/pixeljs.json'), 'utf8')),
        'pixeljs.json is at the root of the build',
      );
      assert.ok(built.some((file) => file.endsWith('.wasm')));
      // The audio worklet stays a file of its own: the portal runs no inlined scripts.
      assert.ok(built.some((file) => /\/processor-[^/]*\.js$/.test(file)));
      const html = await readFile(join(dist, 'index.html'), 'utf8');
      assert.doesNotMatch(html, /(src|href)="\//, 'the build uses relative URLs');
      assert.match(html, /src="\.\/assets\/[^"]+\.js"/);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('the cli creates the portal starters and keeps typescript as the non-interactive default', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pixeljs-cli-portal-'));
  const binPath = resolve('packages/create/bin/create-pixeljs.js');
  const runBin = (args) =>
    new Promise((res, rej) => {
      // No terminal on stdin: the cli never waits for an answer.
      const child = spawn(process.execPath, [binPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d.toString()));
      child.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`Exit code ${code}`))));
    });
  try {
    const help = await runBin(['--help']);
    for (const [name, description] of Object.entries(TEMPLATES)) {
      assert.ok(help.includes(name) && help.includes(description), `--help lists ${name}`);
    }
    const board = await runBin([join(tempDir, 'board-game'), '--template', 'board']);
    assert.ok(board.includes('(board)'));
    assert.ok(board.includes('https://pixeljs.com/developers'));
    assert.ok((await readdir(join(tempDir, 'board-game/src/modes'))).includes('online.js'));
    const plain = await runBin([join(tempDir, 'default-game')]);
    assert.ok(plain.includes('(typescript)'));
    assert.ok(!plain.includes('https://pixeljs.com/developers'));
    assert.ok((await readdir(join(tempDir, 'default-game'))).includes('tsconfig.json'));

    const lines = [];
    t.mock.method(console, 'log', (line) => lines.push(String(line)));
    await runCli([join(tempDir, 'portal-game'), '--template=portal']);
    assert.ok(lines.join('\n').includes('Success! Created portal-game'));
    assert.ok((await readdir(join(tempDir, 'portal-game/public'))).includes('pixeljs.json'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

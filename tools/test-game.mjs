import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

await access('apps/site/dist/index.html');
const server = spawn(process.execPath, ['tools/serve.mjs'], {
  env: { ...process.env, PORT: '0', PIXELJS_SERVE_ROOT: 'apps/site/dist' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const closed = new Promise((resolve) => server.once('close', resolve));
try {
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('The game test server did not start.')),
      10_000,
    );
    const stop = () => clearTimeout(timer);
    server.once('error', (error) => {
      stop();
      reject(error);
    });
    server.once('exit', (code) => {
      stop();
      reject(new Error(`The game test server exited with code ${code}.`));
    });
    server.stdout.on('data', (bytes) => {
      output = (output + bytes.toString()).slice(-1024);
      const match = output.match(/PixelJS server (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        stop();
        resolve(match[1]);
      }
    });
  });
  const check = spawn(process.execPath, ['tests/pacman-browser.mjs', url], { stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => {
    check.once('error', reject);
    check.once('close', resolve);
  });
  if (result !== 0) throw new Error(`Pac-Man browser verification failed with code ${result}.`);
} finally {
  server.kill('SIGTERM');
  await closed;
}

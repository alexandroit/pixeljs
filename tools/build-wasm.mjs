import { mkdir, copyFile } from 'node:fs/promises';
import { run } from './run.mjs';
run(process.env.EMCMAKE ?? 'emcmake', [
  process.env.CMAKE ?? 'cmake',
  '-S',
  '.',
  '-B',
  'build/wasm',
  '-G',
  'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
]);
run(process.env.CMAKE ?? 'cmake', ['--build', 'build/wasm', '--parallel', '4']);
await mkdir('packages/core/dist/internal/wasm', { recursive: true });
// Preserve the Emscripten companion name internally; the loader supplies wasmBinary explicitly.
await copyFile('build/wasm/wasm/engine.mjs', 'packages/core/dist/internal/wasm/engine.mjs');
await copyFile('build/wasm/wasm/engine.wasm', 'packages/core/dist/internal/wasm/engine.wasm');
await copyFile('build/wasm/wasm/audio.mjs', 'packages/core/dist/internal/wasm/audio.mjs');
await copyFile('build/wasm/wasm/audio.wasm', 'packages/core/dist/internal/wasm/audio.wasm');
console.log('Built real C17/WASM engine and audio runtime artifacts.');

import { run } from './run.mjs';
const cmake = process.env.CMAKE ?? 'cmake';
const ctest = process.env.CTEST ?? 'ctest';
for (const preset of ['native', 'safety']) {
  run(cmake, ['--preset', preset]);
  run(cmake, ['--build', '--preset', preset, '--parallel', '4']);
  run(ctest, ['--preset', preset]);
}

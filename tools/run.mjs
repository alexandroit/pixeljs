import { spawnSync } from 'node:child_process';
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error)
    throw new Error(
      `Cannot run ${command}: ${result.error.message}. See CONTRIBUTING.md for the build prerequisites.`,
    );
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
}
export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

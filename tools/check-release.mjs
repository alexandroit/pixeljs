// Fails when publication metadata disagrees. Usage: node tools/check-release.mjs [vX.Y.Z]
import { readdir, readFile } from 'node:fs/promises';

const REPOSITORY = 'git+https://github.com/alexandroit/pixeljs.git';
const read = (path) => readFile(path, 'utf8');
const problems = [];
const expect = (condition, message) => {
  if (!condition) problems.push(message);
};

const license = await read('LICENSE');
expect(license.startsWith('MIT License'), 'LICENSE must contain the MIT License text.');
const packages = {
  core: JSON.parse(await read('packages/core/package.json')),
  create: JSON.parse(await read('packages/create/package.json')),
};
const { version } = packages.core;
expect(/^\d+\.\d+\.\d+$/.test(version), `Unsupported version format: ${version}.`);
for (const [directory, manifest] of Object.entries(packages)) {
  const where = `packages/${directory}`;
  expect(manifest.version === version, `${where} must share version ${version}.`);
  expect(manifest.license === 'MIT', `${where} must declare the MIT license.`);
  expect(manifest.private !== true, `${where} must not be private to be published.`);
  expect(manifest.publishConfig?.access === 'public', `${where} must publish with public access.`);
  expect(
    manifest.repository?.url === REPOSITORY && manifest.repository?.directory === where,
    `${where} repository metadata must match ${REPOSITORY} (required for npm provenance).`,
  );
  expect(manifest.files?.includes('LICENSE'), `${where} must ship its LICENSE.`);
  expect(!manifest.dependencies, `${where} must not add runtime dependencies.`);
  expect(
    !manifest.scripts?.install && !manifest.scripts?.postinstall && !manifest.scripts?.preinstall,
    `${where} must not run install scripts.`,
  );
  expect(
    (await read(`${where}/LICENSE`)) === license,
    `${where}/LICENSE must equal the root LICENSE.`,
  );
}
const portal = packages.core.exports?.['./portal'];
expect(
  portal?.types === './dist/portal.d.ts' && portal?.import === './dist/portal.js',
  'packages/core must export ./portal from dist/portal.js with its declarations.',
);
const index = await read('packages/core/src/index.ts');
expect(
  index.includes(`export const version = '${version}';`),
  'packages/core/src/index.ts must export the package version.',
);
const templates = await readdir('packages/create/templates');
for (const template of ['javascript', 'typescript', 'portal', 'board'])
  expect(templates.includes(template), `The ${template} starter is missing.`);
for (const template of templates) {
  const manifest = JSON.parse(await read(`packages/create/templates/${template}/package.json`));
  expect(
    manifest.dependencies?.['@pixeljs/core'] === '{{PIXELJS_CORE_VERSION}}',
    `The ${template} starter must depend on the core released with @pixeljs/create.`,
  );
}
expect(
  (await read('CHANGELOG.md')).includes(`## ${version}`),
  `CHANGELOG.md needs a "## ${version}" section with the release notes.`,
);
const tag = process.argv[2];
if (tag !== undefined)
  expect(tag === `v${version}`, `Tag ${tag} does not match version v${version}.`);

if (problems.length > 0) {
  for (const problem of problems) console.error(`release check: ${problem}`);
  process.exit(1);
}
console.log(`Release metadata is consistent for ${version}${tag ? ` (${tag})` : ''}.`);

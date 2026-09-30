import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject } from './index.js';

export async function runCli(argv = process.argv.slice(2)) {
  const args = [...argv];
  let targetDir = '';
  let template = 'typescript';
  let force = false;
  let showHelp = false;
  let showVersion = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (arg === '--version' || arg === '-v') {
      showVersion = true;
    } else if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--template' || arg === '-t') {
      if (i + 1 >= args.length) {
        throw new Error('Option --template requires an argument.');
      }
      template = args[++i];
    } else if (arg.startsWith('--template=')) {
      template = arg.slice('--template='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!targetDir) {
      targetDir = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (showHelp) {
    console.log(`
Usage: create-pixeljs [target-directory] [options]

Scaffold a new PixelJS game project.

Options:
  -t, --template <name>   Template to use (typescript, javascript) [default: typescript]
  -f, --force             Overwrite existing files in target directory
  -v, --version           Display version number
  -h, --help              Display this help message

Examples:
  npm create @pixeljs@latest my-game
  npm create @pixeljs@latest my-game -- --template javascript
  npx @pixeljs/create my-game --force
`);
    return;
  }

  if (showVersion) {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    console.log(`@pixeljs/create v${pkg.version}`);
    return;
  }

  if (!targetDir) {
    targetDir = 'pixeljs-app';
  }

  console.log(`Scaffolding PixelJS project in ${targetDir} (${template})...`);
  const result = await createProject({ targetDir, template, force });
  const directory = relative(process.cwd(), result.destination) || '.';
  console.log(`
Success! Created ${result.projectName} at ${result.destination}

Next steps:

  cd ${JSON.stringify(directory)}
  npm install
  npm run dev

Happy game making with PixelJS!
`);
}

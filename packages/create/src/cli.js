import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { TEMPLATES, createProject, normalizeTemplate } from './index.js';

const DEFAULT_TEMPLATE = 'typescript';
const PORTAL_TEMPLATES = new Set(['portal', 'board']);

function templateList() {
  const width = Math.max(...Object.keys(TEMPLATES).map((name) => name.length));
  return Object.entries(TEMPLATES).map(([name, description]) => {
    const marker = name === DEFAULT_TEMPLATE ? ' (default)' : '';
    return `${name.padEnd(width)}   ${description}${marker}`;
  });
}

/** Asks for a template in an interactive terminal; Enter keeps the default. */
async function askTemplate() {
  const names = Object.keys(TEMPLATES);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Which starter would you like?\n');
    templateList().forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
    for (;;) {
      const question = `\nTemplate (1-${names.length}, Enter for ${DEFAULT_TEMPLATE}): `;
      const answer = (await prompt.question(question)).trim().toLowerCase();
      if (answer === '') return DEFAULT_TEMPLATE;
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= names.length) return names[index - 1];
      try {
        return normalizeTemplate(answer);
      } catch {
        console.log(`Choose a number from 1 to ${names.length} or a template name.`);
      }
    }
  } finally {
    prompt.close();
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = [...argv];
  let targetDir = '';
  let template = '';
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
  -t, --template <name>   Template to use (see below). Without it, an interactive
                          terminal asks; otherwise ${DEFAULT_TEMPLATE} is used
  -f, --force             Overwrite existing files in target directory
  -v, --version           Display version number
  -h, --help              Display this help message

Templates:
${templateList()
  .map((line) => `  ${line}`)
  .join('\n')}

Examples:
  npm create @pixeljs@latest my-game
  npm create @pixeljs@latest my-game -- --template javascript
  npm create @pixeljs@latest my-game -- --template portal
  npm create @pixeljs@latest my-game -- --template board
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
  if (!template) {
    template = process.stdin.isTTY && process.stdout.isTTY ? await askTemplate() : DEFAULT_TEMPLATE;
  }

  console.log(`Scaffolding PixelJS project in ${targetDir} (${template})...`);
  const result = await createProject({ targetDir, template, force });
  const directory = relative(process.cwd(), result.destination) || '.';
  const publish = PORTAL_TEMPLATES.has(result.template)
    ? `
To publish it on PixelJS: npm run build, zip the contents of dist/ and upload
the archive in the PixelJS studio. Guide: https://pixeljs.com/developers
`
    : '';
  console.log(`
Success! Created ${result.projectName} at ${result.destination}

Next steps:

  cd ${JSON.stringify(directory)}
  npm install
  npm run dev
${publish}
Happy game making with PixelJS!
`);
}

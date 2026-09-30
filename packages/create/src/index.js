import { mkdir, readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, basename, join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_TEMPLATES = {
  ts: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  javascript: 'javascript',
};

// npm strips files named .gitignore from published packages, so templates
// store them under these names and scaffolding restores the dot files.
const RENAMED_FILES = { _gitignore: '.gitignore' };

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Validates and normalizes the target directory, preventing path traversal
 * and unexpected symlink escapes.
 */
export async function validateDestination(targetDir, force = false) {
  if (typeof targetDir !== 'string' || targetDir.trim().length === 0) {
    throw new Error('Target directory must be a non-empty string.');
  }
  if (targetDir.includes('\0')) {
    throw new Error('Invalid target path: null byte detected.');
  }

  const destination = resolve(process.cwd(), targetDir);
  if (destination === resolve('/')) {
    throw new Error('Cannot create project in root directory.');
  }

  // Inside the working directory, no path component may be a symbolic link;
  // elsewhere the destination itself may not be one.
  const rel = relative(process.cwd(), destination);
  // A name such as "..game" is inside the working directory; only ".." itself
  // or a leading "../" leaves it.
  const insideCwd = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const components = insideCwd ? rel.split(sep).filter(Boolean) : [];
  let current = process.cwd();
  for (const part of components) {
    current = join(current, part);
    const stat = await lstatOrNull(current);
    if (stat?.isSymbolicLink()) {
      throw new Error(`Target path component is an unauthorized symbolic link: ${current}`);
    }
  }

  const stat = await lstatOrNull(destination);
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new Error(`Target destination is an unauthorized symbolic link: ${destination}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${destination}`);
    }
    const entries = await readdir(destination);
    if (entries.length > 0 && !force) {
      throw new Error(
        `Target directory "${targetDir}" is not empty (${entries.length} items found). Use --force to proceed.`,
      );
    }
  }

  return destination;
}

/**
 * Normalizes template alias to canonical template name.
 */
export function normalizeTemplate(template) {
  const normalized = SUPPORTED_TEMPLATES[String(template || '').toLowerCase()];
  if (!normalized) {
    throw new Error(
      `Invalid template: "${template}". Available templates: typescript, javascript.`,
    );
  }
  return normalized;
}

/**
 * Derives a valid npm package name from the target directory basename.
 */
export function sanitizeProjectName(dirName) {
  return (
    dirName
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^[-_]+|-+$/g, '')
      .slice(0, 214) || 'pixeljs-app'
  );
}

async function packageVersion() {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')).version;
}

/**
 * Copies one template directory. Existing symbolic links are never written
 * through, and existing files are only replaced when force is set.
 */
async function copyTemplate(sourceDir, targetDir, replacements, force) {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, RENAMED_FILES[entry.name] ?? entry.name);
    const existing = await lstatOrNull(target);
    if (existing?.isSymbolicLink()) {
      throw new Error(`Refusing to write through the symbolic link ${target}.`);
    }
    if (entry.isDirectory()) {
      if (existing && !existing.isDirectory()) {
        throw new Error(`Refusing to replace the file ${target} with a directory.`);
      }
      await mkdir(target, { recursive: true });
      await copyTemplate(source, target, replacements, force);
    } else if (entry.isFile()) {
      let content = await readFile(source, 'utf8');
      for (const [placeholder, value] of Object.entries(replacements)) {
        content = content.replaceAll(placeholder, value);
      }
      // 'wx' fails instead of following a link created after the check above.
      await writeFile(target, content, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
    }
  }
}

/**
 * Scaffolds a new PixelJS project into targetDir.
 */
export async function createProject(options = {}) {
  const targetDir = options.targetDir || 'pixeljs-app';
  const force = Boolean(options.force);
  const templateName = normalizeTemplate(options.template || 'typescript');
  const destination = await validateDestination(targetDir, force);
  const projectName = sanitizeProjectName(basename(destination));

  const templatesRoot = fileURLToPath(new URL('../templates', import.meta.url));
  await mkdir(destination, { recursive: true });
  await copyTemplate(
    join(templatesRoot, templateName),
    destination,
    {
      '{{PROJECT_NAME}}': projectName,
      // Starters depend on the runtime released together with this tool.
      '{{PIXELJS_CORE_VERSION}}': `^${await packageVersion()}`,
    },
    force,
  );

  return {
    destination,
    template: templateName,
    projectName,
  };
}

import { byId, frameScheduler, type Status } from './dom.js';
import { ambiguousPngs, baseName, download, exportFiles } from './exports.js';
import { DEFAULT_PALETTE } from './palette.js';
import type { Project } from './project.js';
import type { Studio } from './studio.js';

const RESERVED = new Set(
  (
    'await break case catch class const continue debugger default delete do else enum export ' +
    'extends false finally for function if import in instanceof interface let new null package ' +
    'private protected public return static super switch this throw true try typeof var void ' +
    'while with yield engine palette canvas createEngine'
  ).split(' '),
);

/** Valid, distinct JavaScript names for asset names (`lookup` returns an earlier one). */
function identifiers(): (name: string, kind: string, lookup?: boolean) => string {
  const used = new Set<string>();
  const given = new Map<string, string>();
  return (name, kind, lookup = false) => {
    const key = `${kind}:${name}`;
    const known = given.get(key);
    if (known) return known;
    let id = name.replace(/[-_]+([A-Za-z0-9])/g, (_, next: string) => next.toUpperCase());
    if (/^[0-9]/.test(id) || RESERVED.has(id))
      id = `${kind}${id.charAt(0).toUpperCase()}${id.slice(1)}`;
    let candidate = id;
    for (let n = 2; used.has(candidate); n++)
      candidate = n === 2 ? `${id}${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : `${id}${n}`;
    if (!lookup) used.add(candidate);
    given.set(key, candidate);
    return candidate;
  };
}

/** Example loading code for the exported files, generated from the project. */
function loaderCode(project: Project): string {
  const isDefault =
    project.palette.length === DEFAULT_PALETTE.length &&
    project.palette.every((color, index) => color === DEFAULT_PALETTE[index]);
  const lines = [
    "import { createEngine } from '@pixeljs/core';",
    '',
    isDefault
      ? '// The project uses the default palette, so no palette option is needed.'
      : "const palette = await (await fetch('palette.json')).json();",
    `const engine = await createEngine({ canvas${isDefault ? '' : ', palette'} });`,
  ];
  lines.push(
    '// Every file listed in assets.json, all or nothing.',
    "const assets = await engine.loadAssets('assets.json');",
  );
  const name = identifiers();
  for (const sprite of project.sprites)
    lines.push(`const ${name(sprite.name, 'image')} = assets.image('${sprite.name}');`);
  for (const map of project.maps)
    lines.push(`const ${name(map.name, 'map')} = assets.tilemap('${map.name}');`);
  for (const sound of project.sounds)
    lines.push(`const ${name(sound.name, 'sound')} = assets.sound('${sound.name}');`);
  for (const piece of project.music)
    lines.push(`const ${name(piece.name, 'music')} = assets.music('${piece.name}');`);
  if (project.music.length > 0)
    lines.push(
      `engine.audio.playMusic(${name(project.music[0]!.name, 'music', true)}); // Starts once audio.unlock() runs from a click.`,
    );
  return lines.join('\n');
}

/**
 * Lists every web asset with its own download button: the manifest, the
 * palette, one indexed PNG per sprite and one JSON file per map.
 */
export class ExportPanel {
  private readonly schedule = frameScheduler(() => this.render());
  /** The list is rebuilt only while the tab is visible. */
  private visible = false;
  private stale = true;

  constructor(
    private readonly studio: Studio,
    private readonly status: Status,
  ) {
    studio.on((event) => {
      if (event === 'history' || event === 'active') return;
      this.stale = true;
      if (this.visible) this.schedule();
    });
    byId('export-files', HTMLTableSectionElement).addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-download]');
      if (button) void this.download(button.dataset['download']!);
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.stale) this.render();
  }

  private async download(path: string): Promise<void> {
    const file = exportFiles(this.studio.project).find((item) => item.path === path);
    if (!file) return;
    download(baseName(path), await file.build());
    const folder = path.includes('/')
      ? ` into the ${path.slice(0, path.indexOf('/'))}/ folder`
      : '';
    this.status.info(`Downloaded ${baseName(path)}: place it${folder} next to assets.json.`);
  }

  render(): void {
    this.stale = false;
    const project = this.studio.project;
    const body = byId('export-files', HTMLTableSectionElement);
    body.replaceChildren(
      ...exportFiles(project).map((file) => {
        const row = document.createElement('tr');
        const path = document.createElement('td');
        const code = document.createElement('code');
        code.textContent = file.path;
        path.append(code);
        const description = document.createElement('td');
        description.textContent = file.description;
        const action = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.dataset['download'] = file.path;
        button.textContent = 'Download';
        button.setAttribute('aria-label', `Download ${file.path}`);
        action.append(button);
        row.append(path, description, action);
        return row;
      }),
    );
    byId('export-code', HTMLElement).textContent = loaderCode(project);
    const warning = byId('export-warning', HTMLParagraphElement);
    const ambiguous = ambiguousPngs(project);
    warning.hidden = ambiguous.length === 0;
    warning.textContent = ambiguous
      .map(
        ({ sprite, index, loadsAs }) =>
          `images/${sprite.name}.png uses color ${index}, which repeats color ${loadsAs}: those pixels will load as ${loadsAs}. Change one of the colors, or use the sprite's JSON image.`,
      )
      .join(' ');
  }
}

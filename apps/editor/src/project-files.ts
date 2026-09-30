import { byId, type Status } from './dom.js';
import { download } from './exports.js';
import { MAX_PROJECT_BYTES, formatBytes } from './limits.js';
import { createDefaultProject, parseProject, serializeProject, ProjectError } from './project.js';
import type { Studio } from './studio.js';

/**
 * New, open and save. An opened file is validated completely before it
 * replaces the open project; on any failure the open project is untouched.
 * Discarding unsaved changes asks for confirmation in an inline bar.
 */
export class ProjectFiles {
  private fileName = 'project.pixeljs.json';
  private readonly input = byId('file-project', HTMLInputElement);
  private readonly bar = byId('confirm-bar', HTMLDivElement);
  private pending: (() => void) | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(
    private readonly studio: Studio,
    private readonly status: Status,
  ) {
    byId('btn-project-new', HTMLButtonElement).addEventListener('click', () => this.newProject());
    byId('btn-project-open', HTMLButtonElement).addEventListener('click', () => this.open());
    byId('btn-project-save', HTMLButtonElement).addEventListener('click', () => this.save());
    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0];
      this.input.value = '';
      if (file) void this.load(file);
    });
    byId('btn-confirm-yes', HTMLButtonElement).addEventListener('click', () => {
      const action = this.pending;
      this.hideConfirm();
      action?.();
    });
    byId('btn-confirm-no', HTMLButtonElement).addEventListener('click', () => this.hideConfirm());
    this.bar.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hideConfirm();
    });
  }

  private confirm(message: string, action: () => void): void {
    if (!this.studio.dirty) {
      action();
      return;
    }
    this.pending = action;
    this.returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    byId('confirm-text', HTMLSpanElement).textContent = message;
    this.bar.hidden = false;
    byId('btn-confirm-no', HTMLButtonElement).focus();
  }

  private hideConfirm(): void {
    this.pending = null;
    this.bar.hidden = true;
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  newProject(): void {
    this.confirm('The open project has unsaved changes. Start a new project anyway?', () => {
      this.studio.replaceProject(createDefaultProject());
      this.fileName = 'project.pixeljs.json';
      this.status.info('Started a new project with the default 16-color palette.');
    });
  }

  open(): void {
    this.confirm('The open project has unsaved changes. Open another project anyway?', () =>
      this.input.click(),
    );
  }

  /** Validates the whole file first; the open project changes only on success. */
  async load(file: File): Promise<void> {
    if (file.size > MAX_PROJECT_BYTES) {
      this.status.error(
        `Could not open ${file.name}: project files are limited to ${formatBytes(MAX_PROJECT_BYTES)} (this one is ${formatBytes(file.size)}). The open project is unchanged.`,
      );
      return;
    }
    try {
      const project = parseProject(await file.text());
      this.studio.replaceProject(project);
      this.fileName = file.name;
      const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
      this.status.info(
        `Opened ${file.name}: ${count(project.palette.length, 'color')}, ${count(project.sprites.length, 'sprite')}, ${count(project.maps.length, 'map')}, ${count(project.sounds.length, 'sound')}, ${count(project.music.length, 'piece')} of music.`,
      );
    } catch (error) {
      const reason = error instanceof ProjectError ? error.message : String(error);
      this.status.error(`Could not open ${file.name}: ${reason} The open project is unchanged.`);
    }
  }

  save(): void {
    const text = serializeProject(this.studio.project);
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_PROJECT_BYTES) {
      this.status.error(
        `The project needs ${formatBytes(bytes)}, above the ${formatBytes(MAX_PROJECT_BYTES)} file limit; remove sprites or maps before saving.`,
      );
      return;
    }
    download(this.fileName, new Blob([text], { type: 'application/json' }));
    this.studio.markSaved();
    this.status.info(`Saved ${this.fileName} (${formatBytes(bytes)}).`);
  }
}

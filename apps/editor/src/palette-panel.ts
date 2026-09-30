import { byId, intValue, report, type Status } from './dom.js';
import { duplicateColors, formatHex, parseHex } from './palette.js';
import type { Studio } from './studio.js';

/**
 * Palette swatches (a radio group with arrow-key navigation), hex editing of
 * the selected color, the color count, and a warning for repeated colors.
 */
export class PalettePanel {
  private readonly grid = byId('palette-grid', HTMLDivElement);
  private readonly hex = byId('palette-hex', HTMLInputElement);
  private readonly picker = byId('palette-picker', HTMLInputElement);
  private readonly size = byId('palette-size', HTMLInputElement);

  constructor(
    private readonly studio: Studio,
    private readonly status: Status,
  ) {
    studio.on((event) => {
      if (event !== 'history' && event !== 'pixels' && event !== 'tiles') this.render();
    });
    this.grid.addEventListener('click', (event) => {
      const swatch = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-index]');
      if (swatch) studio.setColor(Number(swatch.dataset['index']));
    });
    this.grid.addEventListener('keydown', (event) => this.onKey(event));
    const apply = (): void => {
      const color = parseHex(this.hex.value);
      if (color === null) {
        this.hex.setAttribute('aria-invalid', 'true');
        status.error(`“${this.hex.value}” is not a color: use six hex digits such as #3f87d4.`);
        return;
      }
      this.hex.removeAttribute('aria-invalid');
      const index = studio.color;
      report(
        status,
        studio.setPaletteColor(index, color),
        `Color ${index} is now ${formatHex(color)}.`,
      );
    };
    byId('btn-palette-apply', HTMLButtonElement).addEventListener('click', apply);
    this.hex.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') apply();
    });
    this.picker.addEventListener('change', () => {
      this.hex.value = this.picker.value;
      apply();
    });
    const resize = (): void => {
      const count = intValue(this.size);
      if (!report(status, studio.setPaletteSize(count), `The palette now has ${count} colors.`))
        this.size.value = String(studio.project.palette.length);
    };
    byId('btn-palette-size', HTMLButtonElement).addEventListener('click', resize);
    this.size.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') resize();
    });
    this.render();
  }

  private columns(): number {
    return this.studio.project.palette.length > 64 ? 16 : 8;
  }

  private onKey(event: KeyboardEvent): void {
    const count = this.studio.project.palette.length;
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -this.columns(),
      ArrowDown: this.columns(),
    };
    let next: number;
    if (event.key in moves) next = this.studio.color + moves[event.key]!;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    event.preventDefault();
    this.studio.setColor(Math.max(0, Math.min(count - 1, next)));
    this.grid.querySelector<HTMLButtonElement>(`[data-index="${this.studio.color}"]`)?.focus();
  }

  render(): void {
    const { palette } = this.studio.project;
    const selected = this.studio.color;
    const transparent = this.studio.activeSprite?.transparentIndex ?? null;
    const spriteName = this.studio.activeSprite?.name ?? '';
    this.grid.classList.toggle('dense', this.columns() === 16);
    while (this.grid.children.length > palette.length) this.grid.lastElementChild?.remove();
    while (this.grid.children.length < palette.length) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.setAttribute('role', 'radio');
      swatch.dataset['index'] = String(this.grid.children.length);
      this.grid.append(swatch);
    }
    const hadFocus = this.grid.contains(document.activeElement);
    palette.forEach((color, index) => {
      const swatch = this.grid.children[index] as HTMLButtonElement;
      const hex = formatHex(color);
      swatch.style.backgroundColor = hex;
      swatch.setAttribute('aria-checked', String(index === selected));
      swatch.tabIndex = index === selected ? 0 : -1;
      swatch.classList.toggle('transparent', index === transparent);
      const note = index === transparent ? `, transparent in ${spriteName}` : '';
      swatch.setAttribute('aria-label', `Color ${index}, ${hex}${note}`);
      swatch.title = `${index}: ${hex}${note}`;
    });
    if (hadFocus) this.grid.querySelector<HTMLButtonElement>(`[data-index="${selected}"]`)?.focus();
    const current = palette[selected] ?? 0;
    byId('palette-index', HTMLSpanElement).textContent = String(selected);
    if (document.activeElement !== this.hex) this.hex.value = formatHex(current);
    this.hex.removeAttribute('aria-invalid');
    this.picker.value = formatHex(current);
    if (document.activeElement !== this.size) this.size.value = String(palette.length);
    const warning = byId('palette-warning', HTMLParagraphElement);
    const duplicates = duplicateColors(palette);
    warning.hidden = duplicates.length === 0;
    warning.textContent = duplicates.length
      ? `Repeated colors: ${duplicates
          .slice(0, 4)
          .map(([a, b]) => `${a} = ${b}`)
          .join(
            ', ',
          )}${duplicates.length > 4 ? ', …' : ''}. A PNG stores colors, so pixels of the higher index load back as the lower one; JSON images keep indices.`
      : '';
  }
}

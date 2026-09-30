import { byId, fillSelect, intValue, report, type Status } from './dom.js';
import { MAX_SPRITE_SIDE } from './limits.js';
import { formatHex, quantize, type Quantized } from './palette.js';
import { decodePng, type DecodedImage } from './png.js';
import { createSprite, nameProblem } from './project.js';
import type { Rect } from './raster.js';
import type { Studio } from './studio.js';

/** A valid, unused sprite name derived from a file name. */
function nameFromFile(fileName: string, taken: readonly string[]): string {
  const stem = fileName.replace(/\.[^.]*$/, '');
  const base =
    stem
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 28) || 'image';
  if (!nameProblem(base, taken)) return base;
  for (let n = 2; ; n++) if (!nameProblem(`${base}-${n}`, taken)) return `${base}-${n}`;
}

function crop(image: DecodedImage, rect: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const from = ((rect.y + row) * image.width + rect.x) * 4;
    out.set(image.rgba.subarray(from, from + rect.width * 4), row * rect.width * 4);
  }
  return out;
}

function drawScaled(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
): void {
  const scale = Math.max(1, Math.min(16, Math.floor(192 / Math.max(width, height))));
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext('2d');
  if (!context) return;
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  scratch
    .getContext('2d')
    ?.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(scratch, 0, 0, canvas.width, canvas.height);
}

/**
 * PNG import review: the file is decoded and bounded first, then mapped to
 * the project palette with the engine's deterministic rule. The dialog shows
 * the source, the result, highlighted changes and exact counts before the
 * user adds it as a sprite or replaces the current one. Nothing in the
 * project changes until then; the PNG file itself is never modified.
 */
export class ImportDialog {
  private readonly dialog = byId('import-dialog', HTMLDialogElement);
  private readonly transparent = byId('import-transparent', HTMLSelectElement);
  private readonly fields = ['import-x', 'import-y', 'import-width', 'import-height'].map((id) =>
    byId(id, HTMLInputElement),
  ) as [HTMLInputElement, HTMLInputElement, HTMLInputElement, HTMLInputElement];
  private readonly summary = byId('import-summary', HTMLParagraphElement);
  private image: DecodedImage | null = null;
  private fileName = '';
  private region: Rect | null = null;
  private result: Quantized | null = null;

  constructor(
    private readonly studio: Studio,
    private readonly status: Status,
  ) {
    for (const input of this.fields) input.addEventListener('change', () => this.compute());
    this.transparent.addEventListener('change', () => this.compute());
    byId('import-highlight', HTMLInputElement).addEventListener('change', () => this.drawResult());
    byId('btn-import-add', HTMLButtonElement).addEventListener('click', () => this.add());
    byId('btn-import-replace', HTMLButtonElement).addEventListener('click', () => this.replace());
    byId('btn-import-cancel', HTMLButtonElement).addEventListener('click', () => this.close());
    this.dialog.addEventListener('close', () => {
      this.image = null;
      this.result = null;
    });
  }

  async open(file: File): Promise<void> {
    let image: DecodedImage;
    try {
      image = await decodePng(file);
    } catch (error) {
      this.status.error(`Could not import ${file.name}: ${(error as Error).message}`);
      return;
    }
    this.image = image;
    this.fileName = file.name;
    const palette = this.studio.project.palette;
    let hasTransparency = false;
    for (let at = 3; at < image.rgba.length && !hasTransparency; at += 4)
      hasTransparency = image.rgba[at]! < 128;
    const current = this.studio.activeSprite?.transparentIndex ?? null;
    const preferred = current ?? (hasTransparency ? 0 : null);
    fillSelect(
      this.transparent,
      [
        { value: 'none', label: 'None: alpha is ignored' },
        ...palette.map((color, index) => ({
          value: String(index),
          label: `Color ${index} (${formatHex(color)}) for alpha below 128`,
        })),
      ],
      preferred === null ? 'none' : String(preferred),
    );
    const [x, y, width, height] = this.fields;
    x.value = y.value = '0';
    x.max = String(image.width - 1);
    y.max = String(image.height - 1);
    width.value = String(Math.min(image.width, MAX_SPRITE_SIDE));
    height.value = String(Math.min(image.height, MAX_SPRITE_SIDE));
    width.max = height.max = String(MAX_SPRITE_SIDE);
    byId('import-source', HTMLParagraphElement).textContent =
      `${file.name}: ${image.width} × ${image.height} pixels.` +
      (image.width > MAX_SPRITE_SIDE || image.height > MAX_SPRITE_SIDE
        ? ` Sprites are at most ${MAX_SPRITE_SIDE} × ${MAX_SPRITE_SIDE}: choose the region to import.`
        : '');
    this.compute();
    if (!this.dialog.open) this.dialog.showModal();
  }

  private readRegion(): Rect | string {
    const image = this.image!;
    const [x, y, width, height] = this.fields.map(intValue) as [number, number, number, number];
    if ([x, y, width, height].some(Number.isNaN)) return 'Enter whole numbers for the region.';
    if (width < 1 || height < 1 || width > MAX_SPRITE_SIDE || height > MAX_SPRITE_SIDE)
      return `The region must be 1 to ${MAX_SPRITE_SIDE} pixels wide and high.`;
    if (x < 0 || y < 0 || x + width > image.width || y + height > image.height)
      return `The region must lie inside the ${image.width} × ${image.height} image.`;
    return { x, y, width, height };
  }

  private transparentIndex(): number | null {
    return this.transparent.value === 'none' ? null : Number(this.transparent.value);
  }

  private compute(): void {
    const image = this.image;
    if (!image) return;
    const region = this.readRegion();
    const buttons = [
      byId('btn-import-add', HTMLButtonElement),
      byId('btn-import-replace', HTMLButtonElement),
    ];
    if (typeof region === 'string') {
      this.region = null;
      this.result = null;
      this.summary.textContent = region;
      this.summary.dataset['kind'] = 'error';
      for (const button of buttons) button.disabled = true;
      return;
    }
    this.region = region;
    const rgba = crop(image, region);
    const result = quantize(rgba, this.studio.project.palette, this.transparentIndex());
    this.result = result;
    const total = region.width * region.height;
    this.summary.dataset['kind'] = 'info';
    this.summary.dataset['total'] = String(total);
    this.summary.dataset['changed'] = String(result.changed);
    this.summary.dataset['colorChanged'] = String(result.colorChanged);
    this.summary.dataset['alphaChanged'] = String(result.alphaChanged);
    this.summary.textContent =
      `${region.width} × ${region.height} = ${total} pixels: ${total - result.changed} kept exactly, ` +
      `${result.changed} changed (${result.colorChanged} recolored to the nearest palette color, ` +
      `${result.alphaChanged} with partial or ignored alpha).`;
    for (const button of buttons) button.disabled = false;
    drawScaled(byId('import-original', HTMLCanvasElement), region.width, region.height, rgba);
    this.drawResult();
  }

  private drawResult(): void {
    const result = this.result;
    const region = this.region;
    if (!result || !region) return;
    const palette = this.studio.project.palette;
    const transparent = this.transparentIndex();
    const out = new Uint8ClampedArray(result.pixels.length * 4);
    const highlight = byId('import-highlight', HTMLInputElement).checked;
    result.pixels.forEach((index, at) => {
      const color = palette[index] ?? 0;
      let [r, g, b, a] = [(color >> 16) & 255, (color >> 8) & 255, color & 255, 255];
      if (index === transparent) [r, g, b, a] = [0, 0, 0, 0];
      // Changed pixels are tinted halfway to magenta, so the result stays visible.
      if (highlight && result.changedMask[at])
        [r, g, b, a] = [(r + 255) >> 1, g >> 1, (b + 255) >> 1, 255];
      out.set([r, g, b, a], at * 4);
    });
    drawScaled(byId('import-result', HTMLCanvasElement), region.width, region.height, out);
  }

  private summaryText(): string {
    const result = this.result!;
    const total = result.pixels.length;
    return `${result.changed} of ${total} pixels changed by palette mapping`;
  }

  private add(): void {
    const result = this.result;
    const region = this.region;
    if (!result || !region) return;
    const names = this.studio.project.sprites.map((sprite) => sprite.name);
    const sprite = createSprite(
      nameFromFile(this.fileName, names),
      region.width,
      region.height,
      this.transparentIndex(),
      result.pixels,
    );
    const text = this.summaryText();
    if (
      report(
        this.status,
        this.studio.addSprite(sprite, `Import ${this.fileName}`),
        `Imported ${this.fileName} as “${sprite.name}”: ${text}.`,
      )
    )
      this.close();
  }

  private replace(): void {
    const result = this.result;
    const region = this.region;
    const sprite = this.studio.activeSprite;
    if (!result || !region || !sprite) return;
    const text = this.summaryText();
    const problem = this.studio.replaceSpriteImage(
      sprite,
      region.width,
      region.height,
      result.pixels,
      this.transparentIndex(),
      `Import ${this.fileName} into ${sprite.name}`,
    );
    if (report(this.status, problem, `Replaced “${sprite.name}” with ${this.fileName}: ${text}.`))
      this.close();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }
}

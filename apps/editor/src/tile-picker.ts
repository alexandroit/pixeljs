import { byId, frameScheduler } from './dom.js';
import { paletteWords } from './palette.js';
import { tileCount, tilesPerRow, type TileMap } from './project.js';
import type { Studio } from './studio.js';

/**
 * Shows the active map's tileset with its whole-tile grid. Click or use the
 * arrow keys to choose the tile the map editor places; the number field
 * accepts a tile ID directly.
 */
export class TilePicker {
  private readonly canvas = byId('tile-picker', HTMLCanvasElement);
  private readonly input = byId('map-tile-id', HTMLInputElement);
  private readonly info = byId('tile-info', HTMLParagraphElement);
  private zoom = 1;
  private readonly schedule = frameScheduler(() => this.render());

  constructor(private readonly studio: Studio) {
    studio.on((event, subject) => {
      const map = studio.activeMap;
      if (event === 'tiles' || event === 'history') return;
      if (event === 'pixels' && (!map || subject !== map.tileset)) return;
      this.clampTile();
      this.schedule();
    });
    this.canvas.addEventListener('pointerdown', (event) => {
      const map = studio.activeMap;
      if (!map || event.button !== 0) return;
      const box = this.canvas.getBoundingClientRect();
      const x = Math.floor((event.clientX - box.left) / this.zoom / map.tileWidth);
      const y = Math.floor((event.clientY - box.top) / this.zoom / map.tileHeight);
      if (x < tilesPerRow(map) && y < Math.floor(map.tileset.height / map.tileHeight))
        this.choose(y * tilesPerRow(map) + x);
    });
    this.canvas.addEventListener('keydown', (event) => {
      const map = studio.activeMap;
      if (!map) return;
      const moves: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -tilesPerRow(map),
        ArrowDown: tilesPerRow(map),
      };
      const move = moves[event.key];
      if (move === undefined) return;
      event.preventDefault();
      this.choose(studio.tile + move);
    });
    this.input.addEventListener('change', () => this.choose(Number(this.input.value)));
    new ResizeObserver(() => this.schedule()).observe(this.canvas.parentElement ?? this.canvas);
  }

  /** Selects a tile ID, clamped to the tileset's whole tiles. */
  choose(tile: number): void {
    const map = this.studio.activeMap;
    if (!map || !Number.isFinite(tile)) return;
    const count = tileCount(map.tileset, map.tileWidth, map.tileHeight);
    this.studio.setTile(Math.max(0, Math.min(count - 1, Math.trunc(tile))));
    this.schedule();
  }

  private clampTile(): void {
    const map = this.studio.activeMap;
    if (!map) return;
    const count = tileCount(map.tileset, map.tileWidth, map.tileHeight);
    if (this.studio.tile >= count) this.studio.setTile(count - 1);
  }

  render(): void {
    const map = this.studio.activeMap;
    const context = this.canvas.getContext('2d');
    if (!map || !context) {
      this.info.textContent = 'Create a map to choose tiles.';
      this.canvas.width = this.canvas.height = 1;
      return;
    }
    const tileset = map.tileset;
    const room = this.canvas.parentElement?.clientWidth || 256;
    this.zoom = Math.max(1, Math.min(8, Math.floor(room / tileset.width)));
    const zoom = this.zoom;
    this.canvas.width = tileset.width * zoom;
    this.canvas.height = tileset.height * zoom;
    this.canvas.style.width = `${tileset.width * zoom}px`;
    this.canvas.style.height = `${tileset.height * zoom}px`;
    context.imageSmoothingEnabled = false;
    context.fillStyle = '#2a2c3a';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const image = new ImageData(tileset.width, tileset.height);
    const out = new Uint32Array(image.data.buffer);
    const words = paletteWords(this.studio.project.palette);
    tileset.pixels.forEach((index, at) => {
      out[at] = index === tileset.transparentIndex ? 0 : (words[index] ?? 0);
    });
    const scratch = document.createElement('canvas');
    scratch.width = tileset.width;
    scratch.height = tileset.height;
    scratch.getContext('2d')?.putImageData(image, 0, 0);
    context.drawImage(scratch, 0, 0, this.canvas.width, this.canvas.height);
    this.drawGrid(context, map);
    const count = tileCount(tileset, map.tileWidth, map.tileHeight);
    const tile = this.studio.tile;
    const perRow = tilesPerRow(map);
    context.strokeStyle = '#ffcc00';
    context.lineWidth = 2;
    context.strokeRect(
      (tile % perRow) * map.tileWidth * zoom + 1,
      Math.floor(tile / perRow) * map.tileHeight * zoom + 1,
      map.tileWidth * zoom - 2,
      map.tileHeight * zoom - 2,
    );
    if (document.activeElement !== this.input) this.input.value = String(tile);
    this.input.max = String(count - 1);
    this.canvas.setAttribute(
      'aria-label',
      `Tiles of ${tileset.name}: tile ${tile} of ${count} selected. Arrow keys choose a tile.`,
    );
    this.info.textContent = `Tile ${tile} (column ${tile % perRow}, row ${Math.floor(tile / perRow)}) of ${count}.`;
  }

  private drawGrid(context: CanvasRenderingContext2D, map: TileMap): void {
    const zoom = this.zoom;
    const cols = tilesPerRow(map);
    const rows = Math.floor(map.tileset.height / map.tileHeight);
    context.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    context.lineWidth = 1;
    context.beginPath();
    for (let col = 0; col <= cols; col++) {
      const x = col * map.tileWidth * zoom + 0.5;
      context.moveTo(x, 0);
      context.lineTo(x, rows * map.tileHeight * zoom);
    }
    for (let row = 0; row <= rows; row++) {
      const y = row * map.tileHeight * zoom + 0.5;
      context.moveTo(0, y);
      context.lineTo(cols * map.tileWidth * zoom, y);
    }
    context.stroke();
    // Pixels outside whole tiles are not part of any tile ID.
    context.fillStyle = 'rgba(15, 16, 21, 0.7)';
    context.fillRect(cols * map.tileWidth * zoom, 0, this.canvas.width, this.canvas.height);
    context.fillRect(0, rows * map.tileHeight * zoom, this.canvas.width, this.canvas.height);
  }
}

/**
 * Editor limits. Imported files are checked against them before anything in
 * the open project changes, and every edit is admitted against them first.
 */
export const MAX_PALETTE_COLORS = 256;
export const MAX_SPRITE_SIDE = 256;
export const MAX_SPRITES = 64;
export const MAX_MAP_SIDE = 256;
export const MAX_MAPS = 64;
/** Sixteen 256 × 256 maps; keeps the largest project file well below 16 MiB. */
export const MAX_TOTAL_MAP_CELLS = 1_048_576;
export const MAX_TILE_SIDE = 256;
export const MAX_NAME_LENGTH = 32;
export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
export const MAX_PNG_BYTES = 16 * 1024 * 1024;
export const MAX_PNG_SIDE = 1024;
export const MAX_HISTORY_STEPS = 256;
export const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
export const PROJECT_FORMAT = 'pixeljs-project';
export const PROJECT_VERSION = 1;
export const ASSETS_FORMAT = 'pixeljs-assets';
export const ASSETS_VERSION = 1;
export const SPRITE_ZOOMS: readonly number[] = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32];
export const MAP_ZOOMS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16];

/** Human-readable byte count for messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

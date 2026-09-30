import { MAX_HISTORY_BYTES, MAX_HISTORY_STEPS } from './limits.js';
import type { Music, Sound } from './audio-model.js';
import type { Sprite, TileMap } from './project.js';

export type EditTarget =
  | { kind: 'sprite'; sprite: Sprite }
  | { kind: 'map'; map: TileMap }
  | { kind: 'palette' }
  | { kind: 'sound'; sound: Sound }
  | { kind: 'music'; music: Music };

/** One reversible edit. `bytes` counts the deltas it retains. */
export interface HistoryEntry {
  readonly label: string;
  readonly bytes: number;
  readonly target: EditTarget;
  undo(): void;
  redo(): void;
}

/** Fixed per-entry overhead added to the bytes of its typed arrays. */
export const ENTRY_OVERHEAD = 64;

/**
 * Bounded undo/redo. Entries store deltas; the oldest entries are dropped
 * once either the step or the byte limit would be exceeded.
 */
export class History {
  private readonly done: HistoryEntry[] = [];
  private readonly undone: HistoryEntry[] = [];
  private total = 0;

  constructor(
    readonly maxSteps = MAX_HISTORY_STEPS,
    readonly maxBytes = MAX_HISTORY_BYTES,
  ) {}

  push(entry: HistoryEntry): void {
    for (const dropped of this.undone) this.total -= dropped.bytes;
    this.undone.length = 0;
    this.done.push(entry);
    this.total += entry.bytes;
    // An entry larger than the whole budget cannot be kept at all.
    while (this.done.length > 0 && (this.done.length > this.maxSteps || this.total > this.maxBytes))
      this.total -= this.done.shift()!.bytes;
  }

  undo(): HistoryEntry | null {
    const entry = this.done.pop();
    if (!entry) return null;
    entry.undo();
    this.undone.push(entry);
    return entry;
  }

  redo(): HistoryEntry | null {
    const entry = this.undone.pop();
    if (!entry) return null;
    entry.redo();
    this.done.push(entry);
    return entry;
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
    this.total = 0;
  }

  /** The newest applied entry: identifies the saved state for change tracking. */
  get top(): HistoryEntry | null {
    return this.done[this.done.length - 1] ?? null;
  }
  get undoCount(): number {
    return this.done.length;
  }
  get redoCount(): number {
    return this.undone.length;
  }
  get bytes(): number {
    return this.total;
  }
}

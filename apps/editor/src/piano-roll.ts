import {
  AUDIO_LIMITS,
  fits,
  isBlackKey,
  makeNote,
  noteAt,
  pitchName,
  replaceNote,
  roomAt,
  type Note,
} from './audio-model.js';
import { PixelView, type ViewSource } from './pixel-view.js';
import type { Rect } from './raster.js';

/** What a piano roll edits: one monophonic note list (a sound or a track). */
export interface RollHost {
  notes(): readonly Note[];
  /** Other tracks' notes, drawn dimmed. */
  ghosts(): readonly Note[];
  /** Columns shown. */
  steps(): number;
  /** Notes must start before this step. */
  endStep(): number;
  maxNotes(): number;
  /** Records a new note list as one undo step; returns an error message or null. */
  commit(notes: readonly Note[], label: string): string | null;
  /** Approximate playhead in steps, or null. */
  playhead(): number | null;
  /** The selected note changed (for the note inspector). */
  selected(note: Note | null): void;
  message(text: string, error: boolean): void;
}

export type RollTool = 'draw' | 'erase';
export const ROLL_ZOOMS: readonly number[] = [8, 10, 12, 16, 20, 24];

interface Cell {
  step: number;
  pitch: number;
}

type Gesture =
  | { kind: 'create'; note: Note; room: number }
  | { kind: 'move'; original: Note; from: Cell; note: Note }
  | { kind: 'resize'; original: Note; note: Note }
  | { kind: 'erase'; removed: Set<Note> };

const words = (hex: number): number => {
  const bytes = new Uint8Array([(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255]);
  return new Uint32Array(bytes.buffer)[0]!;
};
const COLORS = {
  white: words(0x1c1e29),
  black: words(0x14151d),
  c: words(0x23263a),
  outside: words(0x0e0f14),
  ghost: words(0x2c4f7a),
  selected: words(0xfff0a8),
};
/** Note color by volume: dim amber at 0 to the accent at 1. */
function noteColor(volume: number): number {
  const mix = (low: number, high: number) => Math.round(low + (high - low) * volume);
  return words((mix(0x6b, 0xff) << 16) | (mix(0x55, 0xcc) << 8) | mix(0x10, 0x00));
}
const EFFECT_MARKS: Record<string, string> = { slide: 'S', vibrato: 'V', fadeout: 'F' };

/**
 * A piano roll: steps left to right, MIDI pitches 127 at the top to 0 at the
 * bottom, one cell per step and pitch. A track plays one note at a time, so
 * notes never overlap in time. Grid lines every `grouping` steps (6 or 8)
 * are presentation only and never change the notes.
 */
export class PianoRoll {
  readonly view: PixelView;
  tool: RollTool = 'draw';
  grouping = 8;
  selectedNote: Note | null = null;
  cursor: Cell = { step: 0, pitch: 60 };
  private gesture: Gesture | null = null;
  private defaultLength = 1;
  private hover: Cell | null = null;
  private pendingPitch: number | null = null;

  constructor(
    scroller: HTMLElement,
    readonly canvas: HTMLCanvasElement,
    sizer: HTMLElement,
    private readonly host: RollHost,
  ) {
    const roll = this;
    const source: ViewSource = {
      get width() {
        return roll.host.steps();
      },
      get height() {
        return 128;
      },
      paint: (out, rect) => this.paint(out, rect),
      overlay: (context, view) => this.overlay(context, view),
    };
    this.view = new PixelView(scroller, canvas, sizer, source);
    this.view.zoom = 16;
    this.bind();
  }

  /** Notes as shown: the committed list, or the gesture's preview. */
  private shown(): readonly Note[] {
    const notes = this.host.notes();
    const gesture = this.gesture;
    if (!gesture) return notes;
    if (gesture.kind === 'create') return [...notes, gesture.note];
    if (gesture.kind === 'erase') return notes.filter((note) => !gesture.removed.has(note));
    return notes.map((note) => (note === gesture.original ? gesture.note : note));
  }

  /** Keeps the selection pointing at a note of the current list after undo or reload. */
  sync(): void {
    const notes = this.host.notes();
    const selected = this.selectedNote;
    if (selected && !notes.includes(selected)) {
      const same = notes.find(
        (note) => note.step === selected.step && note.pitch === selected.pitch,
      );
      this.select(same ?? null);
    }
    this.cursor.step = Math.min(this.cursor.step, this.host.steps() - 1);
    this.view.invalidate();
  }

  select(note: Note | null): void {
    this.selectedNote = note;
    if (note) this.defaultLength = note.length;
    this.host.selected(note);
    this.view.invalidate();
  }

  setGrouping(grouping: number): void {
    this.grouping = grouping;
    this.canvas.dataset['grouping'] = String(grouping);
    this.view.invalidate();
  }

  /** Records a list change; selects `next` when it succeeds. */
  private commit(notes: readonly Note[], label: string, next: Note | null): boolean {
    const problem = this.host.commit(notes, label);
    if (problem) {
      this.host.message(problem, true);
      return false;
    }
    this.select(next);
    return true;
  }

  // -------------------------------------------------------------------------
  // Rendering

  private paint(out: Uint32Array, rect: Rect): void {
    const end = this.host.endStep();
    for (let row = 0; row < rect.height; row++) {
      const pitch = 127 - (rect.y + row);
      const base = pitch % 12 === 0 ? COLORS.c : isBlackKey(pitch) ? COLORS.black : COLORS.white;
      for (let col = 0; col < rect.width; col++)
        out[row * rect.width + col] = rect.x + col >= end ? COLORS.outside : base;
    }
    const fill = (note: Note, color: number) => {
      const y = 127 - note.pitch - rect.y;
      if (y < 0 || y >= rect.height) return;
      const from = Math.max(note.step, rect.x);
      const to = Math.min(note.step + note.length, rect.x + rect.width);
      for (let x = from; x < to; x++) out[y * rect.width + x - rect.x] = color;
    };
    for (const note of this.host.ghosts()) fill(note, COLORS.ghost);
    for (const note of this.shown())
      fill(note, note === this.currentSelection() ? COLORS.selected : noteColor(note.volume));
  }

  /** The selected note as displayed during a move or resize. */
  private currentSelection(): Note | null {
    const gesture = this.gesture;
    if (gesture && (gesture.kind === 'move' || gesture.kind === 'resize')) return gesture.note;
    if (gesture?.kind === 'create') return gesture.note;
    return this.selectedNote;
  }

  private overlay(context: CanvasRenderingContext2D, view: PixelView): void {
    this.applyReveal(view);
    const zoom = view.zoom;
    const rect = view.visibleRect();
    if (rect.width === 0) return;
    const top = view.originY + rect.y * zoom;
    const bottom = view.originY + (rect.y + rect.height) * zoom;
    const left = view.originX + rect.x * zoom;
    const right = view.originX + (rect.x + rect.width) * zoom;
    context.save();
    context.lineWidth = 1;
    // Step lines, and the stronger grouping lines (6 or 8 steps).
    for (let step = rect.x; step <= rect.x + rect.width; step++) {
      const strong = step % this.grouping === 0;
      if (!strong && zoom < 6) continue;
      context.strokeStyle = strong ? 'rgba(210, 214, 235, 0.55)' : 'rgba(128, 134, 160, 0.22)';
      const x = view.originX + step * zoom + 0.5;
      context.beginPath();
      context.moveTo(x, top);
      context.lineTo(x, bottom);
      context.stroke();
    }
    // Octave lines below each C.
    context.strokeStyle = 'rgba(128, 134, 160, 0.45)';
    for (let row = rect.y; row < rect.y + rect.height; row++)
      if ((127 - row) % 12 === 0) {
        const y = view.originY + (row + 1) * zoom - 0.5;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(right, y);
        context.stroke();
      }
    // Note outlines and effect marks.
    context.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    context.font = `${Math.max(8, Math.floor(zoom * 0.6))}px ui-monospace, monospace`;
    context.textBaseline = 'middle';
    for (const note of this.shown()) {
      const x = view.originX + note.step * zoom;
      const y = view.originY + (127 - note.pitch) * zoom;
      context.strokeRect(x + 0.5, y + 0.5, note.length * zoom - 1, zoom - 1);
      const mark = EFFECT_MARKS[note.effect];
      if (mark && zoom >= 12) {
        context.fillStyle = '#000000';
        context.fillText(mark, x + 3, y + zoom / 2);
      }
    }
    // Octave names beside the grid, or over its first column when it fills the view.
    if (zoom >= 10) {
      context.fillStyle = 'rgba(228, 230, 235, 0.8)';
      context.font = `${Math.min(11, zoom - 2)}px system-ui, sans-serif`;
      const x = view.originX >= 34 ? view.originX - 30 : 4;
      for (let row = rect.y; row < rect.y + rect.height; row++) {
        const pitch = 127 - row;
        if (pitch % 12 === 0)
          context.fillText(pitchName(pitch), x, view.originY + row * zoom + zoom / 2);
      }
    }
    const end = this.host.endStep();
    if (end < this.host.steps()) {
      context.strokeStyle = '#ff8a80';
      const x = view.originX + end * zoom + 0.5;
      context.beginPath();
      context.moveTo(x, top);
      context.lineTo(x, bottom);
      context.stroke();
    }
    const playhead = this.host.playhead();
    if (playhead !== null) {
      context.strokeStyle = '#00e5ff';
      context.lineWidth = 2;
      const x = view.originX + playhead * zoom;
      context.beginPath();
      context.moveTo(x, top);
      context.lineTo(x, bottom);
      context.stroke();
      context.lineWidth = 1;
    }
    context.restore();
    const cellRect = (cell: Cell): Rect => ({
      x: cell.step,
      y: 127 - cell.pitch,
      width: 1,
      height: 1,
    });
    if (this.hover && !this.gesture)
      view.outline(context, cellRect(this.hover), 'rgba(255,255,255,0.6)');
    if (document.activeElement === this.canvas)
      view.outline(context, cellRect(this.cursor), '#ffcc00', [], -0.5);
    this.canvas.dataset['grouping'] = String(this.grouping);
  }

  // -------------------------------------------------------------------------
  // Input

  private cellAt(clientX: number, clientY: number): Cell | null {
    const point = this.view.toContent(clientX, clientY);
    if (point.x < 0 || point.x >= this.host.steps() || point.y < 0 || point.y > 127) return null;
    return { step: point.x, pitch: 127 - point.y };
  }

  private bind(): void {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const cell = this.cellAt(event.clientX, event.clientY);
      if (!cell) return;
      canvas.setPointerCapture(event.pointerId);
      this.cursor = cell;
      this.begin(cell, event);
      this.view.invalidate();
    });
    canvas.addEventListener('pointermove', (event) => {
      const cell = this.cellAt(event.clientX, event.clientY);
      this.hover = cell;
      if (cell && this.gesture) this.drag(cell);
      this.view.invalidate();
    });
    canvas.addEventListener('pointerup', () => this.finish());
    canvas.addEventListener('pointercancel', () => {
      this.gesture = null;
      this.view.invalidate();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.view.invalidate();
    });
    canvas.addEventListener('focus', () => this.view.invalidate());
    canvas.addEventListener('blur', () => this.view.invalidate());
    canvas.addEventListener('keydown', (event) => this.onKey(event));
  }

  private begin(cell: Cell, event: PointerEvent): void {
    const notes = this.host.notes();
    const hit = noteAt(notes, cell.step, cell.pitch);
    if (this.tool === 'erase') {
      this.gesture = { kind: 'erase', removed: new Set(hit ? [hit] : []) };
      return;
    }
    if (hit) {
      this.select(hit);
      const box = this.canvas.getBoundingClientRect();
      const within = (event.clientX - box.left - this.view.originX) / this.view.zoom - cell.step;
      const lastCell = cell.step === hit.step + hit.length - 1;
      this.gesture =
        lastCell && within >= 0.5
          ? { kind: 'resize', original: hit, note: hit }
          : { kind: 'move', original: hit, from: cell, note: hit };
      return;
    }
    const busy = noteAt(notes, cell.step);
    if (busy) {
      this.select(busy);
      this.host.message(
        `Step ${cell.step} already plays ${pitchName(busy.pitch)}: a voice plays one note at a time.`,
        true,
      );
      return;
    }
    const problem = this.addProblem(cell.step);
    if (problem) {
      this.host.message(problem, true);
      return;
    }
    const room = roomAt(notes, cell.step, AUDIO_LIMITS.maxSteps);
    const note = makeNote({
      step: cell.step,
      pitch: cell.pitch,
      length: Math.min(this.defaultLength, room),
    });
    this.gesture = { kind: 'create', note, room };
  }

  private addProblem(step: number): string | null {
    if (step >= this.host.endStep())
      return `Notes start before step ${this.host.endStep()}, the end of the piece.`;
    if (this.host.notes().length >= this.host.maxNotes())
      return `At most ${this.host.maxNotes()} notes.`;
    return null;
  }

  private drag(cell: Cell): void {
    const gesture = this.gesture;
    if (!gesture) return;
    const notes = this.host.notes();
    if (gesture.kind === 'create') {
      const length = Math.max(1, Math.min(gesture.room, cell.step - gesture.note.step + 1));
      gesture.note = makeNote({ ...gesture.note, length });
    } else if (gesture.kind === 'resize') {
      const wanted = Math.max(1, cell.step - gesture.original.step + 1);
      const length = roomAt(notes, gesture.original.step, wanted, gesture.original);
      gesture.note =
        length === gesture.original.length
          ? gesture.original
          : makeNote({ ...gesture.original, length });
    } else if (gesture.kind === 'move') {
      const step = gesture.original.step + cell.step - gesture.from.step;
      const pitch = gesture.original.pitch + cell.pitch - gesture.from.pitch;
      const moved = makeNote({ ...gesture.original, step, pitch });
      if (step === gesture.original.step && pitch === gesture.original.pitch)
        gesture.note = gesture.original;
      else if (
        step >= 0 &&
        step < this.host.endStep() &&
        pitch >= 0 &&
        pitch <= 127 &&
        fits(notes, moved, gesture.original)
      )
        gesture.note = moved;
    } else {
      const hit = noteAt(notes, cell.step, cell.pitch);
      if (hit) gesture.removed.add(hit);
    }
  }

  /** Commits the gesture in progress as one undo step. */
  finish(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    const notes = this.host.notes();
    if (gesture.kind === 'create') {
      this.defaultLength = gesture.note.length;
      this.commit(replaceNote(notes, null, gesture.note), 'Add note', gesture.note);
    } else if (gesture.kind === 'erase') {
      if (gesture.removed.size > 0)
        this.commit(
          notes.filter((note) => !gesture.removed.has(note)),
          gesture.removed.size === 1 ? 'Erase note' : 'Erase notes',
          null,
        );
    } else if (gesture.note !== gesture.original) {
      const label = gesture.kind === 'move' ? 'Move note' : 'Resize note';
      this.commit(replaceNote(notes, gesture.original, gesture.note), label, gesture.note);
    }
    this.view.invalidate();
  }

  /** Replaces the selected note (inspector edits); refuses overlaps. */
  replaceSelected(changes: Partial<Note>, label: string): boolean {
    const selected = this.selectedNote;
    if (!selected) return false;
    const next = makeNote({ ...selected, ...changes });
    if (next.step >= this.host.endStep()) {
      this.host.message(`Notes start before step ${this.host.endStep()}.`, true);
      return false;
    }
    if (!fits(this.host.notes(), next, selected)) {
      this.host.message('That would overlap another note: a voice plays one note at a time.', true);
      return false;
    }
    return this.commit(replaceNote(this.host.notes(), selected, next), label, next);
  }

  deleteSelected(): void {
    const note =
      this.selectedNote ?? noteAt(this.host.notes(), this.cursor.step, this.cursor.pitch);
    if (!note) return;
    this.commit(replaceNote(this.host.notes(), note, null), 'Erase note', null);
  }

  /** Space or Enter at the cursor: select the note there, or add one. */
  private applyAtCursor(): void {
    const notes = this.host.notes();
    const { step, pitch } = this.cursor;
    const hit = noteAt(notes, step, pitch);
    if (this.tool === 'erase') {
      if (hit) this.commit(replaceNote(notes, hit, null), 'Erase note', null);
      return;
    }
    if (hit) {
      this.select(hit);
      return;
    }
    const busy = noteAt(notes, step);
    if (busy) {
      this.select(busy);
      this.host.message(
        `Step ${step} already plays ${pitchName(busy.pitch)}: a voice plays one note at a time.`,
        true,
      );
      return;
    }
    const problem = this.addProblem(step);
    if (problem) {
      this.host.message(problem, true);
      return;
    }
    const note = makeNote({ step, pitch, length: roomAt(notes, step, this.defaultLength) });
    this.commit(replaceNote(notes, null, note), 'Add note', note);
  }

  private onKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey) return;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
      PageUp: [0, 12],
      PageDown: [0, -12],
    };
    const move = moves[event.key];
    let handled = true;
    if (move && event.altKey && this.selectedNote) {
      const note = this.selectedNote;
      this.replaceSelected({ step: note.step + move[0], pitch: note.pitch + move[1] }, 'Move note');
    } else if (move && event.shiftKey && move[1] === 0 && this.selectedNote) {
      const note = this.selectedNote;
      if (note.length + move[0] >= 1)
        this.replaceSelected({ length: note.length + move[0] }, 'Resize note');
    } else if (move) {
      this.cursor = {
        step: Math.max(0, Math.min(this.host.steps() - 1, this.cursor.step + move[0])),
        pitch: Math.max(0, Math.min(127, this.cursor.pitch + move[1])),
      };
      this.view.reveal(this.cursor.step, 127 - this.cursor.pitch);
      const hit = noteAt(this.host.notes(), this.cursor.step, this.cursor.pitch);
      this.host.message(
        `Step ${this.cursor.step}, ${pitchName(this.cursor.pitch)}${hit ? ` · note of ${hit.length} step${hit.length === 1 ? '' : 's'}` : ''}`,
        false,
      );
    } else if (event.key === 'Home' || event.key === 'End') {
      this.cursor.step = event.key === 'Home' ? 0 : this.host.steps() - 1;
      this.view.reveal(this.cursor.step, 127 - this.cursor.pitch);
    } else if (event.key === ' ' || event.key === 'Enter') this.applyAtCursor();
    else if (event.key === 'Delete' || event.key === 'Backspace') this.deleteSelected();
    else if (event.key === 'Escape' && (this.selectedNote || this.gesture)) {
      this.gesture = null;
      this.select(null);
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
      this.view.invalidate();
    }
  }

  /**
   * Centers a pitch row vertically once the view has a size (a hidden panel
   * has none yet), e.g. when a sound or track is first shown.
   */
  revealPitch(pitch: number): void {
    this.pendingPitch = pitch;
    this.view.invalidate();
  }

  private applyReveal(view: PixelView): void {
    const pitch = this.pendingPitch;
    if (pitch === null || view.height === 0) return;
    this.pendingPitch = null;
    view.scroller.scrollTop = Math.max(0, (127 - pitch + 0.5) * view.zoom - view.height / 2);
  }
}

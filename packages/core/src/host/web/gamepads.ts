import { integer, PixelJSError } from '../../api/errors.js';
import type { GamepadAxis, GamepadButton, GamepadSnapshot } from '../../api/types.js';

/** Button names in standard-mapping order: index i is `buttons[i]`. */
export const GAMEPAD_BUTTONS: readonly GamepadButton[] = Object.freeze([
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'Back',
  'Start',
  'LS',
  'RS',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
]);
/** Axis names in standard-mapping order: index i is `axes[i]`. */
export const GAMEPAD_AXES: readonly GamepadAxis[] = Object.freeze([
  'leftX',
  'leftY',
  'rightX',
  'rightY',
]);
export const MAX_GAMEPADS = 4;
export const GAMEPAD_DEAD_ZONE = 0.15;
const TRIGGER_THRESHOLD = 0.5;
const ID_LENGTH = 128;
// Entries of getGamepads() examined per poll; browsers list four.
const SCAN_LIMIT = 16;
const NO_PADS: readonly GamepadSnapshot[] = Object.freeze([]);

interface Reading {
  readonly index: number;
  readonly id: string;
  readonly standard: boolean;
  readonly buttons: number;
  readonly axes: readonly number[];
}

/** Zero inside the dead zone, then rescaled so the rest still spans [-1, 1]. */
export function deadZone(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const magnitude = Math.abs(value);
  if (magnitude <= GAMEPAD_DEAD_ZONE) return 0;
  const scaled = Math.min(1, (magnitude - GAMEPAD_DEAD_ZONE) / (1 - GAMEPAD_DEAD_ZONE));
  return value < 0 ? -scaled : scaled;
}
function isPressed(button: unknown, trigger: boolean): boolean {
  let pressed = false;
  let value = 0;
  if (typeof button === 'number') {
    pressed = button > TRIGGER_THRESHOLD;
    value = button;
  } else if (typeof button === 'object' && button !== null) {
    const { pressed: flag, value: amount } = button as { pressed?: unknown; value?: unknown };
    pressed = flag === true;
    value = typeof amount === 'number' && Number.isFinite(amount) ? amount : pressed ? 1 : 0;
  }
  // Analog triggers report `pressed` at different depths per browser.
  return trigger ? value > TRIGGER_THRESHOLD : pressed;
}
function arrayLike(value: unknown): ArrayLike<unknown> | null {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as ArrayLike<unknown>).length === 'number'
    ? (value as ArrayLike<unknown>)
    : null;
}
function padId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const id = value.slice(0, ID_LENGTH);
  // Never end on half of a surrogate pair.
  const last = id.charCodeAt(id.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? id.slice(0, -1) : id;
}
function readGamepad(value: unknown): Reading | null {
  if (typeof value !== 'object' || value === null) return null;
  const pad = value as Partial<
    Record<'index' | 'connected' | 'id' | 'mapping' | 'buttons' | 'axes', unknown>
  >;
  const index = pad.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_GAMEPADS)
    return null;
  if (pad.connected === false) return null;
  const standard = pad.mapping === 'standard';
  const buttons = arrayLike(pad.buttons);
  const axes = arrayLike(pad.axes);
  let held = 0;
  for (let bit = 0; bit < GAMEPAD_BUTTONS.length; bit++)
    if (buttons && isPressed(buttons[bit], standard && (bit === 6 || bit === 7))) held |= 1 << bit;
  return {
    index,
    id: padId(pad.id),
    standard,
    buttons: held,
    axes: GAMEPAD_AXES.map((_, axis) => deadZone(axes?.[axis])),
  };
}
function buttonBit(button: unknown): number {
  const bit =
    typeof button === 'string' ? (GAMEPAD_BUTTONS as readonly string[]).indexOf(button) : -1;
  if (bit < 0)
    throw new PixelJSError(
      'ARGUMENT',
      `Gamepad button must be one of ${GAMEPAD_BUTTONS.join(', ')}.`,
    );
  return 1 << bit;
}
const padIndex = (pad: unknown): number =>
  pad === undefined ? 0 : integer(pad, 'pad', 0, MAX_GAMEPADS - 1);

/**
 * Polled gamepads. Each poll is one tick: a button pressed and released
 * between two polls is never seen. Edges compare two consecutive polls of a
 * connected pad, so a pad has none in the first poll it appears in (also
 * after a reset), and a pad that disappears reads as nothing pressed.
 */
export class GamepadTracker {
  private snapshots: readonly GamepadSnapshot[] = NO_PADS;
  private readonly present = [false, false, false, false];
  private readonly held = [0, 0, 0, 0];
  private readonly pressed = [0, 0, 0, 0];
  private readonly released = [0, 0, 0, 0];
  private readonly axes: Array<readonly number[] | null> = [null, null, null, null];

  /** Reads `source()` (navigator.getGamepads); a missing or failing API reads as no pads. */
  poll(source: () => unknown): void {
    const found: Array<Reading | undefined> = [];
    let list: ArrayLike<unknown> | null = null;
    try {
      list = arrayLike(source());
    } catch {
      /* The Gamepad API can throw, e.g. when a permissions policy disallows it. */
    }
    const length = list ? Math.min(list.length, SCAN_LIMIT) : 0;
    for (let slot = 0; slot < length; slot++) {
      let reading: Reading | null = null;
      try {
        reading = readGamepad(list![slot]);
      } catch {
        /* A pad that cannot be read is treated as absent. */
      }
      if (reading && !found[reading.index]) found[reading.index] = reading;
    }
    const snapshots: GamepadSnapshot[] = [];
    for (let index = 0; index < MAX_GAMEPADS; index++) {
      const reading = found[index];
      const previous = reading && this.present[index] ? this.held[index]! : null;
      const held = reading ? reading.buttons : 0;
      this.pressed[index] = previous === null ? 0 : held & ~previous;
      this.released[index] = previous === null ? 0 : previous & ~held;
      this.held[index] = held;
      this.present[index] = reading !== undefined;
      this.axes[index] = reading ? Object.freeze(reading.axes) : null;
      if (reading)
        snapshots.push(
          Object.freeze({
            index,
            id: reading.id,
            mapping: reading.standard ? ('standard' as const) : ('unknown' as const),
            buttons: Object.freeze(GAMEPAD_BUTTONS.map((_, bit) => (held & (1 << bit)) !== 0)),
            axes: this.axes[index]!,
          }),
        );
    }
    this.snapshots = Object.freeze(snapshots);
  }
  /** Forgets all state; the next poll establishes a new baseline without edges. */
  reset(): void {
    this.snapshots = NO_PADS;
    for (let index = 0; index < MAX_GAMEPADS; index++) {
      this.present[index] = false;
      this.held[index] = 0;
      this.pressed[index] = 0;
      this.released[index] = 0;
      this.axes[index] = null;
    }
  }
  get gamepads(): readonly GamepadSnapshot[] {
    return this.snapshots;
  }
  isButtonDown(button: unknown, pad?: unknown): boolean {
    const bit = buttonBit(button);
    return (this.held[padIndex(pad)]! & bit) !== 0;
  }
  wasButtonPressed(button: unknown, pad?: unknown): boolean {
    const bit = buttonBit(button);
    return (this.pressed[padIndex(pad)]! & bit) !== 0;
  }
  wasButtonReleased(button: unknown, pad?: unknown): boolean {
    const bit = buttonBit(button);
    return (this.released[padIndex(pad)]! & bit) !== 0;
  }
  axis(name: unknown, pad?: unknown): number {
    const axis = typeof name === 'string' ? (GAMEPAD_AXES as readonly string[]).indexOf(name) : -1;
    if (axis < 0)
      throw new PixelJSError('ARGUMENT', `Gamepad axis must be one of ${GAMEPAD_AXES.join(', ')}.`);
    return this.axes[padIndex(pad)]?.[axis] ?? 0;
  }
}

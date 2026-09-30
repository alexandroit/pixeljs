import type { PointerSnapshot, PointerType } from '../../api/types.js';

/** Contacts tracked at once, including ended ones that a tick has not reported yet. */
export const MAX_POINTERS = 10;
const MAX_CONTACT_ID = 0x7fffffff;
const NO_POINTERS: readonly PointerSnapshot[] = Object.freeze([]);

export interface LogicalPoint {
  readonly x: number;
  readonly y: number;
}
interface Contact {
  readonly id: number;
  readonly pointerId: number;
  readonly type: PointerType;
  readonly primary: boolean;
  x: number;
  y: number;
  buttons: number;
  down: boolean;
  // Edges since the previous tick.
  pressed: boolean;
  released: boolean;
}

/**
 * Pointer contacts between logical ticks. Events change live state; tick()
 * latches each contact into a frozen snapshot, so reads never consume edges.
 * A contact that ended is reported once, as released, and then forgotten.
 */
export class PointerTracker {
  overflows = 0;
  private readonly contacts: Contact[] = [];
  private nextId = 1;
  private snapshots: readonly PointerSnapshot[] = NO_POINTERS;
  // The primary pointer's edges and last snapshot in the latest tick.
  private primaryPressed = false;
  private primaryReleased = false;
  private primaryTick: PointerSnapshot | null = null;
  // Where the primary pointer is while it holds no contact (a hovering mouse).
  private hoverX = 0;
  private hoverY = 0;
  private hoverType: PointerType = 'mouse';

  private held(pointerId: number): Contact | undefined {
    return this.contacts.find((contact) => contact.down && contact.pointerId === pointerId);
  }
  private primaryHeld(): Contact | undefined {
    return this.contacts.find((contact) => contact.down && contact.primary);
  }
  /** Whether a browser pointer currently holds a tracked contact. */
  holds(pointerId: number): boolean {
    return this.held(pointerId) !== undefined;
  }
  /** Whether any contact is held. */
  get holding(): boolean {
    return this.contacts.some((contact) => contact.down);
  }
  /**
   * Starts a contact with `buttons` (1 primary, 2 secondary, 4 middle) held.
   * Returns false when it is ignored: over capacity (an overflow) or held already.
   */
  press(
    pointerId: number,
    type: PointerType,
    primary: boolean,
    buttons: number,
    point: LogicalPoint | null,
  ): boolean {
    if (this.holds(pointerId)) return false;
    if (this.contacts.length >= MAX_POINTERS) {
      this.overflows++;
      return false;
    }
    this.contacts.push({
      id: this.nextId,
      pointerId,
      type,
      primary,
      x: point ? point.x : this.hoverX,
      y: point ? point.y : this.hoverY,
      buttons,
      down: true,
      pressed: true,
      released: false,
    });
    this.nextId = this.nextId === MAX_CONTACT_ID ? 1 : this.nextId + 1;
    return true;
  }
  /** Moves a held contact (0 `buttons` keeps its buttons) or a hovering primary pointer. */
  move(
    pointerId: number,
    type: PointerType,
    primary: boolean,
    buttons: number,
    point: LogicalPoint | null,
  ): void {
    const contact = this.held(pointerId);
    if (contact) {
      if (buttons !== 0) contact.buttons = buttons;
      if (point) {
        contact.x = point.x;
        contact.y = point.y;
      }
    } else if (primary && point && !this.primaryHeld()) {
      this.hoverX = point.x;
      this.hoverY = point.y;
      this.hoverType = type;
    }
  }
  /** Ends a held contact at `point`. Returns the buttons it held, or 0 if none was held. */
  release(pointerId: number, point: LogicalPoint | null): number {
    const contact = this.held(pointerId);
    if (!contact) return 0;
    if (point) {
      contact.x = point.x;
      contact.y = point.y;
    }
    this.end(contact);
    return contact.buttons;
  }
  /** Ends a held contact where it last was (cancel, lost capture). */
  cancel(pointerId: number): boolean {
    const contact = this.held(pointerId);
    if (contact) this.end(contact);
    return contact !== undefined;
  }
  private end(contact: Contact): void {
    // A released snapshot keeps the buttons held just before the end.
    contact.down = false;
    contact.released = true;
    if (contact.primary) {
      this.hoverX = contact.x;
      this.hoverY = contact.y;
      this.hoverType = contact.type;
    }
  }
  tick(): void {
    const snapshots: PointerSnapshot[] = [];
    let pressed = false;
    let released = false;
    let primary: PointerSnapshot | null = null;
    for (const contact of this.contacts) {
      const snapshot: PointerSnapshot = Object.freeze({
        id: contact.id,
        type: contact.type,
        x: contact.x,
        y: contact.y,
        buttons: contact.buttons,
        down: contact.down,
        pressed: contact.pressed,
        released: contact.released,
      });
      snapshots.push(snapshot);
      if (contact.primary) {
        pressed ||= contact.pressed;
        released ||= contact.released;
        primary = snapshot;
      }
      contact.pressed = false;
      contact.released = false;
    }
    let kept = 0;
    for (const contact of this.contacts) if (contact.down) this.contacts[kept++] = contact;
    this.contacts.length = kept;
    this.snapshots = Object.freeze(snapshots);
    this.primaryPressed = pressed;
    this.primaryReleased = released;
    this.primaryTick = primary;
  }
  /** Contacts down in the latest tick or released during it, in order of first contact. */
  get pointers(): readonly PointerSnapshot[] {
    return this.snapshots;
  }
  /**
   * The primary pointer: its held contact, else its last position. Position,
   * buttons and `down` are current; edges belong to the latest tick.
   */
  get pointer(): PointerSnapshot {
    const held = this.primaryHeld();
    const latest = this.primaryTick;
    return Object.freeze({
      id: held ? held.id : latest ? latest.id : 0,
      type: held ? held.type : latest ? latest.type : this.hoverType,
      x: held ? held.x : this.hoverX,
      y: held ? held.y : this.hoverY,
      buttons: held ? held.buttons : 0,
      down: held !== undefined,
      pressed: this.primaryPressed,
      released: this.primaryReleased,
    });
  }
  /** Forgets every contact without reporting releases. Returns the browser ids still held. */
  reset(): number[] {
    const held = this.contacts.filter((contact) => contact.down).map(({ pointerId }) => pointerId);
    this.contacts.length = 0;
    this.snapshots = NO_POINTERS;
    this.primaryPressed = false;
    this.primaryReleased = false;
    this.primaryTick = null;
    return held;
  }
  /** Keeps the last position inside a resized framebuffer. */
  resize(width: number, height: number): void {
    this.hoverX = Math.min(this.hoverX, width - 1);
    this.hoverY = Math.min(this.hoverY, height - 1);
  }
}

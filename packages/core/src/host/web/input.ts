import { PixelJSError } from '../../api/errors.js';
import type {
  GamepadAxis,
  GamepadButton,
  GamepadSnapshot,
  Input,
  PointerSnapshot,
  PointerType,
  ScalingMode,
  WheelSnapshot,
} from '../../api/types.js';
import { GamepadTracker } from './gamepads.js';
import { PointerTracker } from './pointers.js';
import { InlineStyles } from './styles.js';
import { Viewport } from './viewport.js';

/** Wheel deltas are reported in lines; pixel deltas count 16 pixels per line. */
export const WHEEL_PIXELS_PER_LINE = 16;
/** Largest wheel movement reported in one tick, in lines per axis. */
export const WHEEL_LIMIT = 100;
// A context menu this soon after a secondary-button release belongs to that
// press: some platforms (Windows) open it on release instead of on press.
const MENU_GRACE_MS = 250;
const NO_WHEEL: WheelSnapshot = Object.freeze({ x: 0, y: 0 });

/**
 * Converts one wheel delta to lines: pixels / 16, lines as is and a page as
 * one logical screen of 8-pixel lines (height / 8, at least one line).
 */
export function wheelLines(delta: number, deltaMode: number, height: number): number {
  const scale =
    deltaMode === 1 ? 1 : deltaMode === 2 ? Math.max(1, height / 8) : 1 / WHEEL_PIXELS_PER_LINE;
  const lines = delta * scale;
  return Number.isFinite(lines) ? lines : 0;
}
const clampWheel = (lines: number): number => Math.max(-WHEEL_LIMIT, Math.min(WHEEL_LIMIT, lines));
const pointerType = (type: string): PointerType =>
  type === 'pen' || type === 'touch' ? type : 'mouse';
/**
 * Buttons of a new contact as 1 primary, 2 secondary, 4 middle. Synthetic
 * events may report only `button`; a touch or pen contact (eraser included)
 * is at least primary; mouse back/forward buttons alone start no contact.
 */
function pressedButtons(event: PointerEvent, type: PointerType): number {
  const held = event.buttons & 7;
  if (held !== 0) return held;
  const button = event.button === 0 ? 1 : event.button === 1 ? 4 : event.button === 2 ? 2 : 0;
  return button !== 0 || type === 'mouse' ? button : 1;
}

/** Browser events accumulate until a logical tick; reads never consume edges. */
export class WebInput {
  private readonly down = new Set<string>();
  private readonly pendingPressed = new Set<string>();
  private readonly pendingReleased = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly pointerState = new PointerTracker();
  private readonly pads = new GamepadTracker();
  private readonly viewport: Viewport;
  private readonly styles: InlineStyles;
  private readonly readPads: () => unknown;
  private wheelX = 0;
  private wheelY = 0;
  private tickWheel: WheelSnapshot = NO_WHEEL;
  private menuUntil = -Infinity;
  private keyOverflows = 0;
  private disposed = false;
  private readonly removers: Array<() => void> = [];
  private readonly oldTabIndex: string | null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    width: number,
    private height: number,
    scaling: ScalingMode = 'manual',
  ) {
    const navigator = canvas.ownerDocument.defaultView?.navigator;
    this.readPads = () =>
      typeof navigator?.getGamepads === 'function' ? navigator.getGamepads() : null;
    this.styles = new InlineStyles(canvas);
    this.viewport = new Viewport(canvas, width, height, scaling, this.styles);
    this.oldTabIndex = canvas.getAttribute('tabindex');
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    this.styles.set('touch-action', 'none');
    this.listen(canvas, 'keydown', ((event: KeyboardEvent) => {
      if (event.code.length > 64) return;
      if (!this.down.has(event.code)) {
        if (
          this.down.size >= 256 ||
          this.pendingPressed.size >= 256 ||
          this.pendingReleased.size >= 256
        ) {
          this.keyOverflows++;
          this.reset();
          return;
        }
        this.down.add(event.code);
        this.pendingPressed.add(event.code);
      }
      if (/^(Arrow|Space)/.test(event.code)) event.preventDefault();
    }) as EventListener);
    this.listen(canvas, 'keyup', ((event: KeyboardEvent) => {
      if (this.down.delete(event.code)) {
        if (this.pendingReleased.size >= 256) {
          this.keyOverflows++;
          this.reset();
        } else this.pendingReleased.add(event.code);
      }
      if (/^(Arrow|Space)/.test(event.code)) event.preventDefault();
    }) as EventListener);
    this.listen(canvas, 'blur', () => this.reset());
    this.listen(canvas, 'pointerdown', ((event: PointerEvent) => {
      // A further button of a held pointer (a chord) changes its buttons only.
      if (this.pointerState.holds(event.pointerId)) {
        this.moved(event);
        return;
      }
      const point = this.viewport.map(event.clientX, event.clientY);
      // Contacts starting beside the image (letterbox margin, border, padding) are not the game's.
      if (point?.margin) return;
      const type = pointerType(event.pointerType);
      const buttons = pressedButtons(event, type);
      if (buttons === 0) return;
      if (!this.pointerState.press(event.pointerId, type, event.isPrimary, buttons, point)) return;
      canvas.focus({ preventScroll: true });
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* Detached/synthetic pointer. */
      }
      event.preventDefault();
    }) as EventListener);
    this.listen(canvas, 'pointermove', ((event: PointerEvent) =>
      this.moved(event)) as EventListener);
    this.listen(canvas, 'pointerup', ((event: PointerEvent) => {
      if (!this.pointerState.holds(event.pointerId)) return;
      const point = this.viewport.map(event.clientX, event.clientY);
      const buttons = this.pointerState.release(event.pointerId, point);
      if ((buttons & 2) !== 0) this.menuUntil = event.timeStamp + MENU_GRACE_MS;
      this.releaseCapture(event.pointerId);
    }) as EventListener);
    const cancel = ((event: PointerEvent): void => {
      if (this.pointerState.cancel(event.pointerId)) this.releaseCapture(event.pointerId);
    }) as EventListener;
    this.listen(canvas, 'pointercancel', cancel);
    this.listen(canvas, 'lostpointercapture', cancel);
    // The menu stays available unless a pointer is held down on the canvas.
    this.listen(canvas, 'contextmenu', (event) => {
      if (this.pointerState.holding || event.timeStamp <= this.menuUntil) event.preventDefault();
    });
    this.listen(
      canvas,
      'wheel',
      ((event: WheelEvent) => {
        this.wheelX = clampWheel(
          this.wheelX + wheelLines(event.deltaX, event.deltaMode, this.height),
        );
        this.wheelY = clampWheel(
          this.wheelY + wheelLines(event.deltaY, event.deltaMode, this.height),
        );
        // An unfocused game never takes over page scrolling.
        if (this.focused()) event.preventDefault();
      }) as EventListener,
      { passive: false },
    );
    const view = canvas.ownerDocument.defaultView;
    if (view) this.listen(view, 'blur', () => this.reset());
  }
  private listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.removers.push(() => target.removeEventListener(type, listener));
  }
  private moved(event: PointerEvent): void {
    // Hover of secondary pointers is never reported, so skip mapping it.
    if (!event.isPrimary && !this.pointerState.holds(event.pointerId)) return;
    this.pointerState.move(
      event.pointerId,
      pointerType(event.pointerType),
      event.isPrimary,
      event.buttons & 7,
      this.viewport.map(event.clientX, event.clientY),
    );
  }
  private focused(): boolean {
    const root = this.canvas.getRootNode() as Partial<DocumentOrShadowRoot>;
    return root.activeElement === this.canvas;
  }
  private releaseCapture(pointerId: number): void {
    try {
      if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    } catch {
      /* The element may have detached or the pointer may already have ended. */
    }
  }
  private resetPointers(): void {
    for (const pointerId of this.pointerState.reset()) this.releaseCapture(pointerId);
    this.menuUntil = -Infinity;
  }
  private check(): void {
    if (this.disposed) throw new PixelJSError('STATE', 'Input is no longer available.');
  }
  private validate(code: string): void {
    this.check();
    if (typeof code !== 'string' || code.length === 0 || code.length > 64) {
      throw new PixelJSError(
        'ARGUMENT',
        'Input code must be a non-empty KeyboardEvent.code string.',
      );
    }
  }
  /** Lost key events and ignored pointer contacts beyond the limits. */
  get overflows(): number {
    return this.keyOverflows + this.pointerState.overflows;
  }
  isDown(code: string): boolean {
    this.validate(code);
    return this.down.has(code);
  }
  wasPressed(code: string): boolean {
    this.validate(code);
    return this.pressed.has(code);
  }
  wasReleased(code: string): boolean {
    this.validate(code);
    return this.released.has(code);
  }
  get pointer(): PointerSnapshot {
    this.check();
    return this.pointerState.pointer;
  }
  get pointers(): readonly PointerSnapshot[] {
    this.check();
    return this.pointerState.pointers;
  }
  get wheel(): WheelSnapshot {
    this.check();
    return this.tickWheel;
  }
  get gamepads(): readonly GamepadSnapshot[] {
    this.check();
    return this.pads.gamepads;
  }
  isButtonDown(button: GamepadButton, pad?: number): boolean {
    this.check();
    return this.pads.isButtonDown(button, pad);
  }
  wasButtonPressed(button: GamepadButton, pad?: number): boolean {
    this.check();
    return this.pads.wasButtonPressed(button, pad);
  }
  wasButtonReleased(button: GamepadButton, pad?: number): boolean {
    this.check();
    return this.pads.wasButtonReleased(button, pad);
  }
  axis(name: GamepadAxis, pad?: number): number {
    this.check();
    return this.pads.axis(name, pad);
  }
  tick(): void {
    this.pressed.clear();
    this.released.clear();
    for (const code of this.pendingPressed) this.pressed.add(code);
    for (const code of this.pendingReleased) this.released.add(code);
    this.pendingPressed.clear();
    this.pendingReleased.clear();
    this.pointerState.tick();
    this.tickWheel =
      this.wheelX === 0 && this.wheelY === 0
        ? NO_WHEEL
        : Object.freeze({ x: this.wheelX, y: this.wheelY });
    this.wheelX = 0;
    this.wheelY = 0;
    this.pads.poll(this.readPads);
  }
  reset(): void {
    this.down.clear();
    this.pendingPressed.clear();
    this.pendingReleased.clear();
    this.pressed.clear();
    this.released.clear();
    this.resetPointers();
    this.wheelX = 0;
    this.wheelY = 0;
    this.tickWheel = NO_WHEEL;
    this.pads.reset();
  }
  /** A new logical size drops held pointers and re-fits the canvas. */
  resize(width: number, height: number): void {
    this.height = height;
    this.resetPointers();
    this.pointerState.resize(width, height);
    this.viewport.resize(width, height);
  }
  refit(): void {
    this.viewport.fit();
  }
  dispose(): void {
    if (this.disposed) return;
    for (const remove of this.removers) remove();
    this.removers.length = 0;
    this.reset();
    this.viewport.dispose();
    this.disposed = true;
    if (this.oldTabIndex === null) this.canvas.removeAttribute('tabindex');
    else this.canvas.setAttribute('tabindex', this.oldTabIndex);
    this.styles.restore();
  }
}

/** The frozen public view of a WebInput; `check` rejects use of an unusable engine. */
export function inputFacade(source: WebInput, check: () => void): Input {
  return Object.freeze({
    isDown: (code: string) => {
      check();
      return source.isDown(code);
    },
    wasPressed: (code: string) => {
      check();
      return source.wasPressed(code);
    },
    wasReleased: (code: string) => {
      check();
      return source.wasReleased(code);
    },
    get pointer() {
      check();
      return source.pointer;
    },
    get pointers() {
      check();
      return source.pointers;
    },
    get wheel() {
      check();
      return source.wheel;
    },
    get gamepads() {
      check();
      return source.gamepads;
    },
    isButtonDown: (button: GamepadButton, pad?: number) => {
      check();
      return source.isButtonDown(button, pad);
    },
    wasButtonPressed: (button: GamepadButton, pad?: number) => {
      check();
      return source.wasButtonPressed(button, pad);
    },
    wasButtonReleased: (button: GamepadButton, pad?: number) => {
      check();
      return source.wasButtonReleased(button, pad);
    },
    axis: (name: GamepadAxis, pad?: number) => {
      check();
      return source.axis(name, pad);
    },
  });
}

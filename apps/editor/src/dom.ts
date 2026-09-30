/** Returns the element with `id`, checked against the expected type. */
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing #${id} in the editor page.`);
  return element;
}

/** True while the user types into a field, so single-key shortcuts must not fire. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/** The single polite status line in the footer. Errors are styled but not modal. */
export class Status {
  constructor(private readonly element: HTMLElement) {}

  info(message: string): void {
    this.show(message, 'info');
  }

  error(message: string): void {
    this.show(message, 'error');
  }

  private show(message: string, kind: 'info' | 'error'): void {
    this.element.textContent = message;
    this.element.dataset['kind'] = kind;
  }
}

/** Shows an error when `problem` is set; returns true when the action succeeded. */
export function report(status: Status, problem: string | null, success?: string): boolean {
  if (problem) status.error(problem);
  else if (success) status.info(success);
  return problem === null;
}

/** Replaces a select's options while keeping DOM churn obvious and small. */
export function fillSelect(
  select: HTMLSelectElement,
  options: Array<{ value: string; label: string }>,
  selected: string,
): void {
  select.replaceChildren(
    ...options.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }),
  );
  select.value = selected;
}

/** Reads a whole-number input; NaN when empty or not an integer. */
export function intValue(input: HTMLInputElement): number {
  const value = Number(input.value);
  return input.value.trim() !== '' && Number.isInteger(value) ? value : Number.NaN;
}

/** Coalesces repeated requests into one callback per animation frame. */
export function frameScheduler(callback: () => void): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      callback();
    });
  };
}

/** Commits a number field on change; restores the field when the value is refused. */
export function bindNumber(
  input: HTMLInputElement,
  status: Status,
  apply: (value: number) => string | null,
  restore: () => void,
): void {
  input.addEventListener('change', () => {
    const value = Number(input.value);
    const problem =
      input.value.trim() === '' || !Number.isFinite(value) ? 'Enter a number.' : apply(value);
    if (problem) {
      status.error(problem);
      restore();
    }
  });
}

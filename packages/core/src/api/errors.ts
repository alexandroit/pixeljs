export class PixelJSError extends Error {
  override readonly name = 'PixelJSError';
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new PixelJSError('RANGE', `${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
export function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new PixelJSError('ARGUMENT', `${name} must be an object.`);
  }
}
export function flag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new PixelJSError('ARGUMENT', `${name} must be a boolean.`);
  return value;
}

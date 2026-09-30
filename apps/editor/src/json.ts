/** Validation helpers for untrusted JSON documents, and the editor's JSON writer. */

export class ProjectError extends Error {
  override readonly name = 'ProjectError';
}

export type Json = Record<string, unknown>;

export function fail(path: string, message: string): never {
  throw new ProjectError(path ? `${path}: ${message}` : message);
}

export function has(object: Json, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** An object with exactly the allowed own keys; unknown keys are rejected. */
export function record(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(path, 'expected an object.');
  const object = value as Json;
  for (const key of Object.keys(object))
    if (!required.includes(key) && !optional.includes(key))
      fail(path, `unknown field “${key.slice(0, 40)}”.`);
  for (const key of required) if (!has(object, key)) fail(path, `missing field “${key}”.`);
  return object;
}

export function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    fail(path, `expected an integer from ${min} to ${max}.`);
  return value;
}

/** A finite number in [min, max], or in (min, max] when `above` is set. */
export function num(value: unknown, path: string, min: number, max: number, above = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (above ? value <= min : value < min) ||
    value > max
  )
    fail(
      path,
      `expected a number ${above ? 'above' : 'from'} ${min} ${above ? 'up ' : ''}to ${max}.`,
    );
  return value;
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected true or false.');
  return value;
}

export function list(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array.');
  if (value.length < min || value.length > max)
    fail(path, `expected ${min === max ? min : `${min}–${max}`} entries, found ${value.length}.`);
  return value;
}

function scalar(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

function write(value: unknown, indent: string): string {
  if (scalar(value)) return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value))
    return value.length === 0
      ? '[]'
      : `[\n${value.map((item) => inner + write(item, inner)).join(',\n')}\n${indent}]`;
  const entries = Object.entries(value as Json);
  if (entries.length === 0) return '{}';
  if (entries.every(([, item]) => scalar(item)))
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(', ')} }`;
  return `{\n${entries
    .map(([key, item]) => `${inner}${JSON.stringify(key)}: ${write(item, inner)}`)
    .join(',\n')}\n${indent}}`;
}

/**
 * Two-space indented JSON in which objects holding only scalars (notes,
 * manifest entries) stay on one line, keeping large note lists compact.
 */
export function formatJson(value: unknown): string {
  return `${write(value, '')}\n`;
}

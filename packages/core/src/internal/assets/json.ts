import { PixelJSError } from '../../api/errors.js';

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
});

/** Quotes untrusted text for an error message, shortened to a readable length. */
export function quote(text: string): string {
  return JSON.stringify(text.length > 64 ? `${text.slice(0, 64)}…` : text);
}

/**
 * The JSON grammar accepted by `JSON.parse`, with two additions for PixelJS
 * formats: duplicate object keys and nesting deeper than `maxDepth` are
 * errors. Objects receive own data properties only, so a `"__proto__"` key
 * can never replace a prototype.
 */
class StrictParser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly what: string,
    private readonly maxDepth: number,
  ) {}

  parse(): unknown {
    const value = this.value(0);
    this.space();
    if (this.index !== this.text.length) this.fail('unexpected text after the value');
    return value;
  }

  private fail(problem: string): never {
    throw new PixelJSError(
      'ASSET_DATA',
      `${this.what} is not valid JSON: ${problem} at character ${this.index}.`,
    );
  }

  private space(): void {
    const text = this.text;
    while (this.index < text.length) {
      const code = text.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      this.index++;
    }
  }

  private value(depth: number): unknown {
    this.space();
    const code = this.text.charCodeAt(this.index);
    if (code === 0x7b) return this.object(depth + 1);
    if (code === 0x5b) return this.array(depth + 1);
    if (code === 0x22) return this.string();
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return this.number();
    if (this.text.startsWith('true', this.index)) return this.literal(4, true);
    if (this.text.startsWith('false', this.index)) return this.literal(5, false);
    if (this.text.startsWith('null', this.index)) return this.literal(4, null);
    return this.fail(Number.isNaN(code) ? 'unexpected end of input' : 'unexpected character');
  }

  private literal(length: number, value: boolean | null): boolean | null {
    this.index += length;
    return value;
  }

  private enter(depth: number): void {
    if (depth > this.maxDepth) this.fail(`nesting deeper than ${this.maxDepth} levels`);
    this.index++;
    this.space();
  }

  private object(depth: number): Record<string, unknown> {
    this.enter(depth);
    const entries = new Map<string, unknown>();
    if (this.text.charCodeAt(this.index) === 0x7d) {
      this.index++;
      return {};
    }
    for (;;) {
      this.space();
      if (this.text.charCodeAt(this.index) !== 0x22) this.fail('expected a quoted key');
      const key = this.string();
      if (entries.has(key)) this.fail(`duplicate key ${quote(key)}`);
      this.space();
      if (this.text.charCodeAt(this.index) !== 0x3a) this.fail('expected ":"');
      this.index++;
      entries.set(key, this.value(depth));
      this.space();
      const next = this.text.charCodeAt(this.index++);
      if (next === 0x7d) break;
      if (next !== 0x2c) {
        this.index--;
        this.fail('expected "," or "}"');
      }
    }
    // fromEntries defines own properties, even for "__proto__".
    return Object.fromEntries(entries) as Record<string, unknown>;
  }

  private array(depth: number): unknown[] {
    this.enter(depth);
    const items: unknown[] = [];
    if (this.text.charCodeAt(this.index) === 0x5d) {
      this.index++;
      return items;
    }
    for (;;) {
      items.push(this.value(depth));
      this.space();
      const next = this.text.charCodeAt(this.index++);
      if (next === 0x5d) return items;
      if (next !== 0x2c) {
        this.index--;
        this.fail('expected "," or "]"');
      }
    }
  }

  private string(): string {
    const text = this.text;
    let result = '';
    let start = ++this.index;
    for (;;) {
      if (this.index >= text.length) this.fail('unterminated string');
      const code = text.charCodeAt(this.index);
      if (code === 0x22) {
        result += text.slice(start, this.index++);
        return result;
      }
      if (code < 0x20) this.fail('control character in a string');
      if (code !== 0x5c) {
        this.index++;
        continue;
      }
      result += text.slice(start, this.index);
      const escape = text.charAt(this.index + 1);
      if (escape === 'u') {
        const hex = text.slice(this.index + 2, this.index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid \\u escape');
        result += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 6;
      } else {
        const replacement = Object.hasOwn(ESCAPES, escape) ? ESCAPES[escape] : undefined;
        if (replacement === undefined) this.fail('invalid escape');
        result += replacement;
        this.index += 2;
      }
      start = this.index;
    }
  }

  private number(): number {
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (!match) return this.fail('invalid number');
    this.index += match[0].length;
    return Number(match[0]);
  }
}

/** Decodes bounded UTF-8 bytes and parses them with {@link StrictParser}. */
export function parseStrictJson(bytes: Uint8Array, what: string, maxDepth = 16): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PixelJSError('ASSET_DATA', `${what} is not valid UTF-8.`, { cause: error });
  }
  return new StrictParser(text, what, maxDepth).parse();
}

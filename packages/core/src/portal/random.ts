import { PixelJSError } from '../api/errors.js';

/**
 * A deterministic generator of pseudo-random numbers (mulberry32). It is not
 * cryptographic: use it for gameplay, never for secrets.
 */
export interface Random {
  /** The next unsigned 32-bit integer. */
  next(): number;
  /** An integer from 0 to `maxExclusive - 1`; `maxExclusive` is 1 to 2³². */
  int(maxExclusive: number): number;
  /** An integer from `min` to `maxInclusive`, both included. */
  range(min: number, maxInclusive: number): number;
  /** A number from 0 (included) to 1 (excluded). */
  float(): number;
  /** One item of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Shuffles an array in place (Fisher–Yates) and returns it. */
  shuffle<T>(items: T[]): T[];
  /** The current 32-bit state: `createRandom(random.state())` continues the same sequence. */
  state(): number;
  /** A new generator seeded from this one's next number, which advances this one by one step. */
  fork(): Random;
}

const LIMIT = 0x100000000; // 2³²

/**
 * Creates a generator from a seed, such as the `seed` every player of an online match
 * receives. It uses only 32-bit integer operations (`Math.imul`, shifts, `>>> 0`), so a
 * seed gives the same numbers in every JavaScript engine: use it for shared worlds,
 * replays and anything that must be reproduced.
 */
export function createRandom(seed: number): Random {
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed))
    throw new PixelJSError('RANGE', 'seed must be an integer.');
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const int = (maxExclusive: number): number => {
    if (
      typeof maxExclusive !== 'number' ||
      !Number.isInteger(maxExclusive) ||
      maxExclusive < 1 ||
      maxExclusive > LIMIT
    )
      throw new PixelJSError('RANGE', 'maxExclusive must be an integer between 1 and 2^32.');
    return next() % maxExclusive;
  };
  return {
    next,
    int,
    range(min: number, maxInclusive: number): number {
      if (
        typeof min !== 'number' ||
        typeof maxInclusive !== 'number' ||
        !Number.isSafeInteger(min) ||
        !Number.isSafeInteger(maxInclusive) ||
        maxInclusive < min ||
        maxInclusive - min >= LIMIT
      )
        throw new PixelJSError(
          'RANGE',
          'range() needs integers min <= maxInclusive at most 2^32 - 1 apart.',
        );
      return min + int(maxInclusive - min + 1);
    },
    float: () => next() / LIMIT,
    pick<T>(items: readonly T[]): T {
      if (!Array.isArray(items) || items.length === 0)
        throw new PixelJSError('RANGE', 'pick() needs a non-empty array.');
      return items[int(items.length)] as T;
    },
    shuffle<T>(items: T[]): T[] {
      if (!Array.isArray(items)) throw new PixelJSError('ARGUMENT', 'shuffle() needs an array.');
      for (let i = items.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const item = items[i] as T;
        items[i] = items[j] as T;
        items[j] = item;
      }
      return items;
    },
    state: () => state,
    fork: () => createRandom(next()),
  };
}

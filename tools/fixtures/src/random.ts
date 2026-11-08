/**
 * Small seeded PRNG (mulberry32) so fixtures and simulator runs are reproducible from a seed.
 * Not cryptographic; deterministic across platforms and Node versions.
 */
export interface Rng {
  readonly seed: number;
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Weighted pick: `[[value, weight], ...]`. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T;
  shuffle<T>(items: readonly T[]): T[];
  /** Independent child generator (stable for the same parent state and label). */
  fork(label: string): Rng;
}

export function hashString(value: string): number {
  // FNV-1a 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    seed,
    next,
    int(min, max) {
      if (max < min) throw new RangeError(`int(${min}, ${max}): max < min`);
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(probability) {
      return next() < probability;
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('pick() from an empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    weighted(entries) {
      const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
      if (total <= 0) throw new RangeError('weighted() needs a positive total weight');
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= Math.max(0, weight);
        if (roll < 0) return value;
      }
      return (entries[entries.length - 1] as readonly [(typeof entries)[number][0], number])[0];
    },
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j] as (typeof copy)[number], copy[i] as (typeof copy)[number]];
      }
      return copy;
    },
    fork(label) {
      return createRng((hashString(label) ^ Math.floor(next() * 4294967296)) >>> 0);
    },
  };
  return rng;
}

const WORDS = [
  'alpha',
  'bravo',
  'cache',
  'delta',
  'event',
  'fetch',
  'graph',
  'hydrate',
  'index',
  'join',
  'kernel',
  'layout',
  'merge',
  'node',
  'offset',
  'parse',
  'query',
  'render',
  'stream',
  'token',
  'update',
  'value',
  'worker',
  'yield',
  'zone',
] as const;

export function word(rng: Rng): string {
  return rng.pick(WORDS);
}

/** One plausible line of TypeScript-ish source code. */
export function codeLine(rng: Rng, index: number): string {
  const kind = rng.int(0, 4);
  const a = word(rng);
  const b = word(rng);
  switch (kind) {
    case 0:
      return `export const ${a}_${index} = ${rng.int(0, 9999)};`;
    case 1:
      return `export function ${a}${capitalize(b)}${index}(input: number): number {`;
    case 2:
      return `  return ${a}(${rng.int(0, 99)}, '${b}');`;
    case 3:
      return `// ${a} ${b} ${word(rng)} ${word(rng)}`;
    default:
      return `const ${b}${index} = await ${a}.${word(rng)}(${rng.int(0, 999)});`;
  }
}

/** `count` lines of source-like text, LF line endings, trailing newline. */
export function codeLines(rng: Rng, count: number, startIndex = 0): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(codeLine(rng, startIndex + i));
  return lines;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

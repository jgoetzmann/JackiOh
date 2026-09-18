// The only source of randomness in the engine (§10.7, §9.3). The cursor lives in GameState, so
// (seed, cursor) reproduces a sequence exactly, in this process or any other.

/** xmur3: string seed to a 32-bit integer stream, used once to seed mulberry32. */
function seedToInt(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32, stepped `n` times from the seed. */
function valueAt(seedInt: number, n: number): number {
  let a = (seedInt + Math.imul(n, 0x6d2b79f5)) >>> 0;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

export type Rng = {
  /** Draws taken so far; store this in state and resume from it. */
  readonly cursor: number;
  next(): number;
  int(n: number): number;
  pick<T>(list: readonly T[]): T | undefined;
  shuffle<T>(list: readonly T[]): T[];
  coin(): boolean;
  chance(p: number): boolean;
  /** Lucky X (§6.1): roll X extra times and keep the best per `better`. */
  lucky<T>(x: number, roll: () => T, better: (a: T, b: T) => T): T;
};

export function createRng(seed: string, cursor = 0): Rng {
  const seedInt = seedToInt(seed);
  let at = cursor;

  const rng: Rng = {
    get cursor(): number {
      return at;
    },
    next(): number {
      const value = valueAt(seedInt, at);
      at += 1;
      return value;
    },
    int(n: number): number {
      if (n <= 0) return 0;
      return Math.floor(rng.next() * n) % n;
    },
    pick<T>(list: readonly T[]): T | undefined {
      if (list.length === 0) return undefined;
      return list[rng.int(list.length)];
    },
    /** Fisher-Yates, top down, so the result depends only on (seed, cursor). */
    shuffle<T>(list: readonly T[]): T[] {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = rng.int(i + 1);
        const a = out[i] as T;
        const b = out[j] as T;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
    coin(): boolean {
      return rng.next() < 0.5;
    },
    chance(p: number): boolean {
      return rng.next() < p;
    },
    lucky<T>(x: number, roll: () => T, better: (a: T, b: T) => T): T {
      let best = roll();
      for (let i = 0; i < Math.max(0, Math.trunc(x)); i += 1) {
        best = better(best, roll());
      }
      return best;
    },
  };

  return rng;
}

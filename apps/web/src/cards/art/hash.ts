// The deterministic number helpers behind the procedural card art (docs/polish/6-cards.md,
// Surface A). The art is a pure function of the card id, so everything here is exact integer
// arithmetic or plain rounding: one id draws the same picture on every client, in every test and
// after every reload. Nothing here reads `Math.random` or the clock.

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MULBERRY_INCREMENT = 0x6d2b79f5;
const UINT32_RANGE = 4294967296;
/** Coordinates and opacities in an `ArtSpec` are rounded to this many decimal places. */
const ART_DECIMALS = 2;
const ROUNDING = 10 ** ART_DECIMALS;

/** FNV-1a over the UTF-8 bytes of `id`, as a 32-bit unsigned integer. */
export function hashId(id: string): number {
  let hash = FNV_OFFSET_BASIS;
  const mix = (byte: number): void => {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  };
  for (const char of id) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      mix(code);
    } else if (code < 0x800) {
      mix(0xc0 | (code >> 6));
      mix(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      mix(0xe0 | (code >> 12));
      mix(0x80 | ((code >> 6) & 0x3f));
      mix(0x80 | (code & 0x3f));
    } else {
      mix(0xf0 | (code >> 18));
      mix(0x80 | ((code >> 12) & 0x3f));
      mix(0x80 | ((code >> 6) & 0x3f));
      mix(0x80 | (code & 0x3f));
    }
  }
  return hash >>> 0;
}

/** mulberry32: a 32-bit seeded generator returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

/** Rounds to `ART_DECIMALS` places and never returns `-0`, so specs compare and print cleanly. */
export function round2(value: number): number {
  const rounded = Math.round(value * ROUNDING) / ROUNDING;
  return rounded === 0 ? 0 : rounded;
}

/** A number as it is written into SVG: rounded, with no exponent and no `-0`. */
export function fmt(value: number): string {
  return String(round2(value));
}

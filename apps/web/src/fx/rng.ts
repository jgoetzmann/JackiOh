/**
 * Seeded randomness for the effects layer (docs/polish/1-animations.md, S5).
 *
 * Every random draw the canvas engine makes (particle spread, crack shapes, projectile arcs) comes
 * from an `FxRng` built here, so one seed and one sequence of calls always draw the same picture.
 * That keeps the particle tests exact and lets two runs of the same game look the same.
 */

/** Uniform in [0, 1). */
export type FxRng = () => number;

/** mulberry32's Weyl increment. */
const MULBERRY_INCREMENT = 0x6d2b79f5;
/** 2^32: maps an unsigned 32-bit word to [0, 1). */
const UINT32_RANGE = 4294967296;
/** Lattice points per noise channel. A power of two, so wrapping is a bit mask. */
const NOISE_LATTICE_SIZE = 256;
const NOISE_LATTICE_MASK = NOISE_LATTICE_SIZE - 1;

/** mulberry32: a small, fast 32-bit generator with a good spread for visual noise. */
export function createRng(seed: number): FxRng {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

/**
 * Smooth 1D value noise in [-1, 1]. Random values sit on the integer lattice and a smoothstep blends
 * neighbours, so the output is continuous with a bounded slope (at most 3 per unit of t). The shake
 * reads it at `t = seconds × frequency`, which is what makes it feel like a rumble, not static.
 */
export function createNoise1D(seed: number): (tSeconds: number) => number {
  const rng = createRng(seed);
  const lattice = new Float64Array(NOISE_LATTICE_SIZE);
  for (let i = 0; i < NOISE_LATTICE_SIZE; i++) lattice[i] = rng() * 2 - 1;
  return (tSeconds) => {
    const i0 = Math.floor(tSeconds);
    const f = tSeconds - i0;
    const a = lattice[i0 & NOISE_LATTICE_MASK]!;
    const b = lattice[(i0 + 1) & NOISE_LATTICE_MASK]!;
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  };
}

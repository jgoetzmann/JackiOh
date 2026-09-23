// docs/polish/1-animations.md, behaviour B30: the trauma shake (S5, after Eiserloh's GDC 2016 talk).
// Trauma lives in [0, 1] and decays linearly; the offset is trauma² times smooth, seeded noise.

import { describe, expect, it } from "vitest";

import { FX_SHAKE_FREQ_HZ, FX_SHAKE_MAX_DEG, FX_SHAKE_MAX_PX, FX_TRAUMA_DECAY } from "./constants.ts";
import { createNoise1D } from "./rng.ts";
import { createShake } from "./shake.ts";

const EPS = 1e-9;

function samples(seed: number, trauma: number, fromMs = 0, toMs = 2_000, stepMs = 7) {
  const shake = createShake({ seed });
  shake.add(trauma);
  const out: { x: number; y: number; angle: number }[] = [];
  for (let t = fromMs; t <= toMs; t += stepMs) out.push(shake.sample(t));
  return out;
}

describe("B30 trauma", () => {
  it("B30 the default tuning is 18 px, 1.2 degrees, 18 Hz and 1.2 trauma per second", () => {
    expect(FX_SHAKE_MAX_PX).toBe(18);
    expect(FX_SHAKE_MAX_DEG).toBe(1.2);
    expect(FX_SHAKE_FREQ_HZ).toBe(18);
    expect(FX_TRAUMA_DECAY).toBe(1.2);
  });

  it("B30 a new shake has no trauma and is not active", () => {
    const shake = createShake();
    expect(shake.trauma()).toBe(0);
    expect(shake.active()).toBe(false);
  });

  it("B30 add accumulates trauma", () => {
    const shake = createShake();
    shake.add(0.25);
    expect(shake.trauma()).toBeCloseTo(0.25, 9);
    shake.add(0.3);
    expect(shake.trauma()).toBeCloseTo(0.55, 9);
    expect(shake.active()).toBe(true);
  });

  it("B30 add clamps trauma to 1", () => {
    const shake = createShake();
    shake.add(0.7);
    shake.add(0.7);
    expect(shake.trauma()).toBe(1);
    shake.add(5);
    expect(shake.trauma()).toBe(1);
  });

  it("B30 a negative add changes nothing", () => {
    const shake = createShake();
    shake.add(0.4);
    shake.add(-0.3);
    expect(shake.trauma()).toBeCloseTo(0.4, 9);
    const idle = createShake();
    idle.add(-1);
    expect(idle.trauma()).toBe(0);
    expect(idle.active()).toBe(false);
  });

  it("B30 trauma decays linearly at FX_TRAUMA_DECAY per second", () => {
    const shake = createShake();
    shake.add(1);
    shake.step(100);
    expect(shake.trauma()).toBeCloseTo(1 - FX_TRAUMA_DECAY * 0.1, 9);
    shake.step(100);
    expect(shake.trauma()).toBeCloseTo(1 - FX_TRAUMA_DECAY * 0.2, 9);
    // Two 50 ms steps decay exactly as one 100 ms step: linear, not exponential.
    const halves = createShake();
    halves.add(1);
    halves.step(50);
    halves.step(50);
    const whole = createShake();
    whole.add(1);
    whole.step(100);
    expect(halves.trauma()).toBeCloseTo(whole.trauma(), 9);
  });

  it("B30 decay floors at 0 and the shake goes inactive", () => {
    const shake = createShake();
    shake.add(0.5);
    shake.step(10_000);
    expect(shake.trauma()).toBe(0);
    expect(shake.active()).toBe(false);
  });

  it("B30 stepping a shake with no trauma leaves it at 0", () => {
    const shake = createShake();
    shake.step(16);
    shake.step(1_000);
    expect(shake.trauma()).toBe(0);
    expect(shake.active()).toBe(false);
  });

  it("B30 decayPerSecond is configurable", () => {
    const shake = createShake({ decayPerSecond: 1 });
    shake.add(1);
    shake.step(250);
    expect(shake.trauma()).toBeCloseTo(0.75, 9);
  });

  it("B30 reset drops all trauma", () => {
    const shake = createShake();
    shake.add(0.9);
    shake.reset();
    expect(shake.trauma()).toBe(0);
    expect(shake.active()).toBe(false);
  });
});

describe("B30 samples", () => {
  it("B30 every sample stays inside max offset and max angle times trauma squared", () => {
    for (const trauma of [1, 0.8, 0.5, 0.2]) {
      const t2 = trauma * trauma;
      for (const s of samples(3, trauma)) {
        expect(Math.abs(s.x)).toBeLessThanOrEqual(FX_SHAKE_MAX_PX * t2 + EPS);
        expect(Math.abs(s.y)).toBeLessThanOrEqual(FX_SHAKE_MAX_PX * t2 + EPS);
        expect(Math.abs(s.angle)).toBeLessThanOrEqual(FX_SHAKE_MAX_DEG * t2 + EPS);
      }
    }
  });

  it("B30 the offsets scale with custom maxima", () => {
    const shake = createShake({ seed: 9, maxOffsetPx: 3, maxAngleDeg: 0.4 });
    shake.add(0.6);
    for (let t = 0; t <= 2_000; t += 5) {
      const s = shake.sample(t);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(3 * 0.36 + EPS);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(3 * 0.36 + EPS);
      expect(Math.abs(s.angle)).toBeLessThanOrEqual(0.4 * 0.36 + EPS);
    }
  });

  it("B30 a full-trauma shake really moves, on both axes and in angle", () => {
    const all = samples(5, 1);
    const peak = (pick: (s: { x: number; y: number; angle: number }) => number) => Math.max(...all.map((s) => Math.abs(pick(s))));
    expect(peak((s) => s.x)).toBeGreaterThan(FX_SHAKE_MAX_PX * 0.1);
    expect(peak((s) => s.y)).toBeGreaterThan(FX_SHAKE_MAX_PX * 0.1);
    expect(peak((s) => s.angle)).toBeGreaterThan(FX_SHAKE_MAX_DEG * 0.1);
  });

  it("B30 no trauma means no offset at all", () => {
    const shake = createShake({ seed: 4 });
    for (const t of [0, 16, 333, 1_000]) {
      const s = shake.sample(t);
      expect(Math.abs(s.x)).toBe(0);
      expect(Math.abs(s.y)).toBe(0);
      expect(Math.abs(s.angle)).toBe(0);
    }
  });

  it("B30 samples 1 ms apart differ by less than 10% of the maximum", () => {
    const shake = createShake({ seed: 21 });
    shake.add(1);
    let previous = shake.sample(0);
    for (let t = 1; t <= 3_000; t += 1) {
      const next = shake.sample(t);
      expect(Math.abs(next.x - previous.x), `x at ${t} ms`).toBeLessThan(FX_SHAKE_MAX_PX * 0.1);
      expect(Math.abs(next.y - previous.y), `y at ${t} ms`).toBeLessThan(FX_SHAKE_MAX_PX * 0.1);
      expect(Math.abs(next.angle - previous.angle), `angle at ${t} ms`).toBeLessThan(FX_SHAKE_MAX_DEG * 0.1);
      previous = next;
    }
  });

  it("B30 the output is deterministic per seed", () => {
    expect(samples(11, 0.9)).toEqual(samples(11, 0.9));
  });

  it("B30 different seeds shake differently", () => {
    expect(samples(11, 0.9)).not.toEqual(samples(12, 0.9));
  });
});

describe("B30 the smooth noise the shake rides on", () => {
  it("B30 createNoise1D stays in [-1, 1] and is deterministic per seed", () => {
    const a = createNoise1D(17);
    const b = createNoise1D(17);
    const c = createNoise1D(18);
    let differs = false;
    for (let t = 0; t <= 20; t += 0.013) {
      const value = a(t);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
      expect(b(t)).toBe(value);
      if (c(t) !== value) differs = true;
    }
    expect(differs).toBe(true);
  });

  it("B30 createNoise1D is continuous: times 10 microseconds apart give nearby values", () => {
    const noise = createNoise1D(3);
    for (let t = 0; t <= 10; t += 0.01) {
      expect(Math.abs(noise(t + 0.00001) - noise(t))).toBeLessThan(0.01);
    }
  });

  it("B30 createNoise1D is not constant", () => {
    const noise = createNoise1D(3);
    const values = Array.from({ length: 200 }, (_, i) => noise(i * 0.25));
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.2);
  });
});

// docs/polish/1-animations.md, behaviours B23 to B26: the pooled particle system (S5).
//
// No canvas is needed: `inspect()`, `alive()`, `capacity()` and `stats()` are the observable surface,
// and nothing here draws.

import { describe, expect, it, vi } from "vitest";

import { FX_MAX_PARTICLE_LIFE_MS } from "./constants.ts";
import { createParticleSystem, type EmitOptions } from "./particles.ts";
import { PARTICLE_PRESETS } from "./presets.ts";
import { createRng } from "./rng.ts";
import type { SpriteCache } from "./sprites.ts";
import type { FxPreset, FxSpread } from "./types.ts";

const PRESETS: readonly FxPreset[] = [
  "fire",
  "ember",
  "holy",
  "sparkle",
  "arcane",
  "poison",
  "smoke",
  "dust",
  "shard",
  "spark",
  "gold",
  "prismatic",
  "void",
  "confetti",
];

const BOX = { x: 100, y: 120, width: 90, height: 126 };

function opts(count: number, spread: FxSpread = "point", power = 1): EmitOptions {
  return { count, spread, box: BOX, power };
}

function system(capacity: number, seed = 1) {
  return createParticleSystem({ capacity, rng: createRng(seed) });
}

/** Steps `total` ms in frames of at most `frame` ms, the way the director's loop does. */
function run(ps: { step(dtMs: number): void }, total: number, frame = 50): void {
  let left = total;
  while (left > 0) {
    const dt = Math.min(frame, left);
    ps.step(dt);
    left -= dt;
  }
}

/* ------------------------------------------------------------------------------------------- *
 * B23: the cap
 * ------------------------------------------------------------------------------------------- */

describe("B23 the particle cap", () => {
  it("B23 emitting 9x capacity of one preset then 1x of another leaves exactly capacity alive, all of the second", () => {
    const ps = system(40);
    expect(ps.capacity()).toBe(40);

    ps.emit("fire", 145, 183, opts(9 * 40));
    expect(ps.alive()).toBeLessThanOrEqual(40);

    ps.emit("smoke", 145, 183, opts(40));
    expect(ps.alive()).toBe(ps.capacity());
    const live = ps.inspect();
    expect(live).toHaveLength(40);
    expect(live.every((p) => p.preset === "smoke")).toBe(true);
  });

  it("B23 emit returns how many it emitted, and alive counts them", () => {
    const ps = system(100);
    expect(ps.emit("spark", 10, 10, opts(12))).toBe(12);
    expect(ps.alive()).toBe(12);
    expect(ps.emit("dust", 10, 10, opts(8, "ring"))).toBe(8);
    expect(ps.alive()).toBe(20);
    expect(ps.inspect()).toHaveLength(20);
  });

  it("B23 emitting zero particles adds none", () => {
    const ps = system(50);
    expect(ps.emit("fire", 10, 10, opts(0))).toBe(0);
    expect(ps.alive()).toBe(0);
    expect(ps.inspect()).toEqual([]);
  });

  it("B23 area and ring spreads never exceed the cap either", () => {
    for (const spread of ["point", "area", "ring"] as const) {
      const ps = system(30);
      for (let i = 0; i < 5; i += 1) ps.emit(PRESETS[i % PRESETS.length] ?? "fire", 50, 50, opts(25, spread, 2));
      expect(ps.alive(), spread).toBe(30);
      expect(ps.inspect(), spread).toHaveLength(30);
    }
  });

  it("B23 repeated overflow keeps the newest particles", () => {
    const ps = system(16);
    ps.emit("fire", 0, 0, opts(16));
    ps.emit("ember", 0, 0, opts(16));
    ps.emit("gold", 0, 0, opts(10));
    const counts = new Map<FxPreset, number>();
    for (const p of ps.inspect()) counts.set(p.preset, (counts.get(p.preset) ?? 0) + 1);
    expect(counts.get("gold")).toBe(10);
    expect(counts.get("ember")).toBe(6);
    expect(counts.get("fire")).toBeUndefined();
  });

  it("B23 lowering the capacity trims live particles to it at once", () => {
    const ps = system(50);
    ps.emit("smoke", 0, 0, opts(50));
    ps.setCapacity(20);
    expect(ps.capacity()).toBe(20);
    expect(ps.alive()).toBeLessThanOrEqual(20);
    ps.emit("fire", 0, 0, opts(50));
    expect(ps.alive()).toBe(20);
    expect(ps.inspect()).toHaveLength(20);
  });

  it("B23 raising the capacity admits more particles", () => {
    const ps = system(10);
    ps.setCapacity(60);
    expect(ps.capacity()).toBe(60);
    ps.emit("confetti", 0, 0, opts(60, "area"));
    expect(ps.alive()).toBe(60);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B24: pooling
 * ------------------------------------------------------------------------------------------- */

describe("B24 pooling", () => {
  it("B24 10,000 emit and step cycles allocate the pool exactly once", () => {
    const ps = system(200);
    expect(ps.stats().allocations).toBe(1);
    for (let i = 0; i < 10_000; i += 1) {
      ps.emit(PRESETS[i % PRESETS.length] ?? "fire", 200 + (i % 7), 300, opts(3 + (i % 5), i % 3 === 0 ? "area" : "point"));
      ps.step(16);
    }
    expect(ps.stats().allocations).toBe(1);
    expect(ps.alive()).toBeLessThanOrEqual(200);
  });

  it("B24 shrinking the capacity never reallocates, and growing reallocates once", () => {
    const ps = system(80);
    ps.setCapacity(20);
    ps.setCapacity(40);
    expect(ps.stats().allocations).toBe(1);
    ps.setCapacity(160);
    expect(ps.stats().allocations).toBe(2);
    ps.emit("dust", 0, 0, opts(160));
    expect(ps.alive()).toBe(160);
  });

  it("B24 clear empties the pool without reallocating it", () => {
    const ps = system(64);
    ps.emit("holy", 0, 0, opts(64));
    ps.clear();
    expect(ps.alive()).toBe(0);
    expect(ps.inspect()).toEqual([]);
    expect(ps.stats().allocations).toBe(1);
    ps.emit("holy", 0, 0, opts(5));
    expect(ps.alive()).toBe(5);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B25: bounded life
 * ------------------------------------------------------------------------------------------- */

describe("B25 every particle dies within FX_MAX_PARTICLE_LIFE_MS", () => {
  it("B25 there is a preset for every FxPreset, and every preset's life fits under FX_MAX_PARTICLE_LIFE_MS", () => {
    expect(Object.keys(PARTICLE_PRESETS).sort()).toEqual([...PRESETS].sort());
    for (const preset of PRESETS) {
      const [min, max] = PARTICLE_PRESETS[preset].life;
      expect(min, preset).toBeGreaterThanOrEqual(0);
      expect(min, preset).toBeLessThanOrEqual(max);
      expect(max, preset).toBeLessThanOrEqual(FX_MAX_PARTICLE_LIFE_MS);
    }
    expect(FX_MAX_PARTICLE_LIFE_MS).toBe(900);
  });

  it("B25 after emitting every preset and stepping 900 ms nothing is alive", () => {
    const ps = system(PRESETS.length * 30);
    for (const preset of PRESETS) {
      for (const spread of ["point", "area", "ring"] as const) ps.emit(preset, 300, 200, opts(10, spread, 3));
    }
    expect(ps.alive()).toBe(PRESETS.length * 30);
    run(ps, FX_MAX_PARTICLE_LIFE_MS);
    expect(ps.alive()).toBe(0);
    expect(ps.inspect()).toEqual([]);
  });

  it("B25 particles are still alive 1 ms after they are emitted", () => {
    const ps = system(PRESETS.length * 5);
    for (const preset of PRESETS) ps.emit(preset, 0, 0, opts(5));
    ps.step(1);
    expect(ps.alive()).toBe(PRESETS.length * 5);
  });

  it("B25 one oversized step kills everything", () => {
    const ps = system(100);
    for (const preset of PRESETS) ps.emit(preset, 0, 0, opts(5, "area"));
    ps.step(5_000);
    expect(ps.alive()).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B26: determinism
 * ------------------------------------------------------------------------------------------- */

function script(seed: number) {
  const ps = system(300, seed);
  ps.emit("fire", 120, 80, opts(40, "area", 1.5));
  ps.step(16);
  ps.emit("smoke", 300, 240, opts(30, "ring", 1));
  ps.step(33);
  ps.emit("spark", 10, 10, opts(25, "point", 2));
  ps.step(16);
  return ps.inspect();
}

describe("B26 determinism", () => {
  it("B26 the same seed, emits and steps give identical particles", () => {
    const a = script(42);
    expect(a.length).toBeGreaterThan(0);
    expect(script(42)).toEqual(a);
  });

  it("B26 a different seed gives different particles", () => {
    expect(script(43)).not.toEqual(script(42));
  });

  it("B26 createRng is deterministic per seed and uniform in [0, 1)", () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    const seqA = Array.from({ length: 1000 }, () => a());
    const seqB = Array.from({ length: 1000 }, () => b());
    const seqC = Array.from({ length: 1000 }, () => c());
    expect(seqB).toEqual(seqA);
    expect(seqC).not.toEqual(seqA);
    for (const value of seqA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    const mean = seqA.reduce((s, v) => s + v, 0) / seqA.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
    expect(new Set(seqA).size).toBeGreaterThan(990);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * S5: drawing. `draw` paints every live particle; a null sprite falls back to a filled arc in the
 * preset colour (the jsdom and no-2D-context case, and any sprite the cache could not make).
 * ------------------------------------------------------------------------------------------- */

type DrawCall = { name: string; args: unknown[]; fillStyle: unknown };

/** A 2D context that records every method call with the fill style current at that moment. */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "#000000" };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return (...args: unknown[]): undefined => {
        calls.push({ name: key, args, fillStyle: target.fillStyle });
        return undefined;
      };
    },
    set(target, key, value) {
      if (typeof key === "string") target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function spriteCache(get: SpriteCache["get"]): SpriteCache {
  return { get, size: () => 0, clear: () => undefined };
}

describe("S5 drawing live particles", () => {
  it("S5 a null sprite falls back to one filled arc per live particle, in a colour of its preset", () => {
    const ps = createParticleSystem({ capacity: 50, rng: createRng(3), sprites: spriteCache(() => null) });
    ps.emit("fire", 100, 100, opts(6));
    ps.step(16);
    const { ctx, calls } = recordingContext();

    ps.draw(ctx, 1);

    const arcs = calls.filter((c) => c.name === "arc");
    const fills = calls.filter((c) => c.name === "fill");
    expect(arcs).toHaveLength(6);
    expect(fills).toHaveLength(6);
    for (const fill of fills) expect(PARTICLE_PRESETS.fire.colors).toContain(fill.fillStyle);
    expect(calls.some((c) => c.name === "drawImage")).toBe(false);
  });

  it("S5 each fallback arc is drawn at its particle, never with a negative radius", () => {
    const ps = createParticleSystem({ capacity: 20, rng: createRng(9), sprites: spriteCache(() => null) });
    ps.emit("smoke", 200, 150, opts(4));
    ps.step(16);
    const live = ps.inspect();
    const { ctx, calls } = recordingContext();

    ps.draw(ctx, 1);

    const arcs = calls.filter((c) => c.name === "arc").map((c) => c.args as number[]);
    expect(arcs.map(([x, y]) => [x, y])).toEqual(live.map((p) => [p.x, p.y]));
    for (const [, , radius] of arcs) expect(radius).toBeGreaterThanOrEqual(0);
  });

  it("S5 a cached sprite is drawn with drawImage, and no fallback arc is painted", () => {
    const sprite = { kind: "sprite" } as unknown as CanvasImageSource;
    const ps = createParticleSystem({ capacity: 50, rng: createRng(3), sprites: spriteCache(() => sprite) });
    ps.emit("gold", 100, 100, opts(5));
    ps.emit("dust", 300, 300, opts(3));
    ps.step(16);
    const { ctx, calls } = recordingContext();

    ps.draw(ctx, 1);

    const images = calls.filter((c) => c.name === "drawImage");
    expect(images).toHaveLength(8);
    for (const image of images) expect(image.args[0]).toBe(sprite);
    expect(calls.some((c) => c.name === "arc")).toBe(false);
  });

  it("S5 draw asks the sprite cache for each live particle's preset and colour at the dpr it is given", () => {
    const get = vi.fn<SpriteCache["get"]>(() => null);
    const ps = createParticleSystem({ capacity: 50, rng: createRng(5), sprites: spriteCache(get) });
    ps.emit("arcane", 100, 100, opts(4));
    ps.step(16);

    ps.draw(recordingContext().ctx, 2);

    expect(get).toHaveBeenCalled();
    for (const [preset, colorIndex, dpr] of get.mock.calls) {
      expect(preset).toBe("arcane");
      expect(colorIndex).toBeGreaterThanOrEqual(0);
      expect(colorIndex).toBeLessThan(PARTICLE_PRESETS.arcane.colors.length);
      expect(dpr).toBe(2);
    }
  });

  it("S5 a pool with nothing alive draws nothing", () => {
    const ps = createParticleSystem({ capacity: 10, rng: createRng(1), sprites: spriteCache(() => null) });
    const { ctx, calls } = recordingContext();

    ps.draw(ctx, 1);
    ps.emit("ember", 50, 50, opts(3));
    run(ps, 1000);
    ps.draw(ctx, 1);

    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B43: streaks. A preset with `stretch` draws each moving particle along its velocity.
 * ------------------------------------------------------------------------------------------- */

describe("B43 streaks", () => {
  it("B43 a stretched preset draws one sprite per particle under a rotation transform, then restores the dpr transform", () => {
    expect(PARTICLE_PRESETS.spark.stretch ?? 0).toBeGreaterThan(0);
    const sprite = { kind: "sprite" } as unknown as CanvasImageSource;
    const ps = createParticleSystem({ capacity: 50, rng: createRng(7), sprites: spriteCache(() => sprite) });
    ps.emit("spark", 100, 100, opts(6));
    ps.step(16);
    const { ctx, calls } = recordingContext();

    ps.draw(ctx, 2);

    expect(calls.filter((c) => c.name === "drawImage")).toHaveLength(6);
    const transforms = calls.filter((c) => c.name === "setTransform").map((c) => c.args as number[]);
    // One per streak, plus the reset to the plain dpr scale at the end of the pass.
    expect(transforms.length).toBe(7);
    const rotated = transforms.slice(0, 6);
    for (const [a, b] of rotated) expect(Math.hypot(a ?? 0, b ?? 0)).toBeCloseTo(2, 6);
    expect(transforms[6]).toEqual([2, 0, 0, 2, 0, 0]);
    // A streak is longer than it is thick.
    for (const draw of calls.filter((c) => c.name === "drawImage")) {
      const [, , , w, h] = draw.args as number[];
      expect(w ?? 0).toBeGreaterThan(h ?? 0);
    }
  });

  it("B43 a preset without stretch never touches the transform", () => {
    expect(PARTICLE_PRESETS.gold.stretch).toBeUndefined();
    const sprite = { kind: "sprite" } as unknown as CanvasImageSource;
    const ps = createParticleSystem({ capacity: 50, rng: createRng(7), sprites: spriteCache(() => sprite) });
    ps.emit("gold", 100, 100, opts(6));
    ps.step(16);
    const { ctx, calls } = recordingContext();
    ps.draw(ctx, 1);
    expect(calls.some((c) => c.name === "setTransform")).toBe(false);
  });

  it("B43 every stretch is a non-negative number", () => {
    for (const preset of PRESETS) expect(PARTICLE_PRESETS[preset].stretch ?? 0).toBeGreaterThanOrEqual(0);
  });
});

describe("B43 twirling confetti", () => {
  it("B43 a twirling preset is drawn turned by its own rotation, one sprite per particle", () => {
    expect(PARTICLE_PRESETS.confetti.twirl).toBe(true);
    const sprite = { kind: "sprite" } as unknown as CanvasImageSource;
    const ps = createParticleSystem({ capacity: 50, rng: createRng(11), sprites: spriteCache(() => sprite) });
    ps.emit("confetti", 200, 200, opts(5, "area"));
    ps.step(16);
    const { ctx, calls } = recordingContext();
    ps.draw(ctx, 1);
    expect(calls.filter((c) => c.name === "drawImage")).toHaveLength(5);
    const transforms = calls.filter((c) => c.name === "setTransform").map((c) => c.args as number[]);
    expect(transforms).toHaveLength(6);
    expect(transforms[5]).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("R200 particles age by real time", () => {
  it("R200 step(dt, age) moves a particle by dt but ages it by age, so a stall never keeps it alive", () => {
    const ps = system(64);
    ps.emit("fire", 100, 100, opts(8));
    ps.step(16);
    const before = ps.inspect().map((p) => p.life);
    expect(before.length).toBe(8);
    // One 2 s frame: the loop clamps dt to 50 ms, but 2 s really passed.
    ps.step(50, 2_000);
    expect(ps.alive()).toBe(0);
  });

  it("R200 step(dt) alone ages by dt, as before", () => {
    const ps = system(64);
    ps.emit("fire", 100, 100, opts(8));
    ps.step(50);
    expect(ps.alive()).toBe(8);
  });
});

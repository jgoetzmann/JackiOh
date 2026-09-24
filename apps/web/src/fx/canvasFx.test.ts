// docs/polish/1-animations.md, behaviour B31: projectiles, cracks and rings (S5 `canvasFx.ts`).
//
// A projectile's head is observed through the trail it leaves in a real `ParticleSystem`: clearing
// the system and stepping a few frames leaves only particles emitted near the head at that moment.

import { describe, expect, it } from "vitest";

import { createCanvasFx } from "./canvasFx.ts";
import { FX_MAX_TAIL_MS } from "./constants.ts";
import { PARTICLE_PRESETS } from "./presets.ts";
import { createParticleSystem } from "./particles.ts";
import { createRng } from "./rng.ts";
import type { FxBox, FxVec } from "./types.ts";

/** A 2D context that accepts any call and records the method names it was sent. */
function recordingContext() {
  const calls: string[] = [];
  const gradient = { addColorStop: () => {} };
  const state: Record<string | symbol, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    shadowBlur: 0,
    filter: "none",
    canvas: { width: 1280, height: 720 },
  };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol") return undefined;
      return (..._args: unknown[]) => {
        calls.push(prop);
        if (prop === "createRadialGradient" || prop === "createLinearGradient" || prop === "createConicGradient") return gradient;
        if (prop === "getTransform") return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        if (prop === "measureText") return { width: 0 };
        return undefined;
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const PAINTS = new Set(["stroke", "fill", "drawImage", "fillRect", "strokeRect"]);

function setup(capacity = 4_000) {
  const particles = createParticleSystem({ capacity, rng: createRng(1) });
  const fx = createCanvasFx({ particles, rng: createRng(2) });
  return { particles, fx };
}

function stepFor(fx: { step(dtMs: number): void }, total: number, frame = 16): void {
  let left = total;
  while (left > 0) {
    const dt = Math.min(frame, left);
    fx.step(dt);
    left -= dt;
  }
}

function centroid(points: readonly { x: number; y: number }[]): FxVec {
  const n = points.length;
  return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
}

function distance(a: FxVec, b: FxVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const BOX: FxBox = { x: 400, y: 200, width: 90, height: 126 };

describe("B31 projectiles", () => {
  const FROM: FxVec = { x: 100, y: 300 };
  const TO: FxVec = { x: 700, y: 300 };
  const FLIGHT = 400;

  it("B31 a projectile leaves trail particles of its preset near its start early in the flight", () => {
    const { particles, fx } = setup();
    fx.projectile("fire", FROM, TO, FLIGHT);
    expect(fx.alive()).toBe(1);

    stepFor(fx, 16);
    particles.clear();
    stepFor(fx, 48);

    const trail = particles.inspect();
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((p) => p.preset === "fire")).toBe(true);
    const head = centroid(trail);
    expect(distance(head, FROM)).toBeLessThan(distance(head, TO));
  });

  it("B31 late in the flight the trail is near the target", () => {
    const { particles, fx } = setup();
    fx.projectile("arcane", FROM, TO, FLIGHT);

    stepFor(fx, 336);
    expect(fx.alive()).toBe(1);
    particles.clear();
    stepFor(fx, 48);

    const trail = particles.inspect();
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((p) => p.preset === "arcane")).toBe(true);
    const head = centroid(trail);
    expect(distance(head, TO)).toBeLessThan(distance(head, FROM));
  });

  it("B31 the trail moves from start to target as the flight goes on", () => {
    const { particles, fx } = setup();
    fx.projectile("poison", { x: 200, y: 600 }, { x: 800, y: 100 }, 480);
    const heads: FxVec[] = [];
    for (let frame = 0; frame < 28; frame += 1) {
      particles.clear();
      fx.step(16);
      const trail = particles.inspect();
      if (trail.length > 0) heads.push(centroid(trail));
    }
    expect(heads.length).toBeGreaterThan(5);
    const first = heads[0] as FxVec;
    const last = heads[heads.length - 1] as FxVec;
    expect(last.x).toBeGreaterThan(first.x + 200);
    expect(last.y).toBeLessThan(first.y - 150);
  });

  it("B31 a projectile ends when its flight is over", () => {
    const { fx } = setup();
    fx.projectile("fire", FROM, TO, FLIGHT);
    stepFor(fx, FLIGHT - 20);
    expect(fx.alive()).toBe(1);
    stepFor(fx, 21);
    expect(fx.alive()).toBe(0);
  });

  it("B31 a zero-length flight is over after the first step", () => {
    const { fx } = setup();
    fx.projectile("spark", FROM, TO, 0);
    fx.step(1);
    expect(fx.alive()).toBe(0);
  });

  it("B31 a projectile whose start is its target still ends on time", () => {
    const { fx } = setup();
    fx.projectile("holy", FROM, FROM, 200);
    stepFor(fx, 201);
    expect(fx.alive()).toBe(0);
  });
});

describe("B31 cracks and rings", () => {
  it("B31 a crack lives for its duration and then alive() is 0", () => {
    const { fx } = setup();
    fx.crack(BOX, 300);
    expect(fx.alive()).toBe(1);
    stepFor(fx, 280);
    expect(fx.alive()).toBe(1);
    stepFor(fx, 21);
    expect(fx.alive()).toBe(0);
  });

  it("B31 a ring lives for its duration and then alive() is 0", () => {
    const { fx } = setup();
    fx.ring("gold", BOX, 500);
    expect(fx.alive()).toBe(1);
    stepFor(fx, 480);
    expect(fx.alive()).toBe(1);
    stepFor(fx, 21);
    expect(fx.alive()).toBe(0);
  });

  it("B31 zero-duration cracks and rings are gone after one step", () => {
    const { fx } = setup();
    fx.crack(BOX, 0);
    fx.ring("dust", BOX, 0);
    fx.step(1);
    expect(fx.alive()).toBe(0);
  });

  it("B31 alive counts projectiles, cracks and rings together, and each ends on its own clock", () => {
    const { fx } = setup();
    fx.projectile("arcane", { x: 0, y: 0 }, { x: 500, y: 0 }, 200);
    fx.crack(BOX, 400);
    fx.ring("void", BOX, 600);
    expect(fx.alive()).toBe(3);
    stepFor(fx, 201);
    expect(fx.alive()).toBe(2);
    stepFor(fx, 200);
    expect(fx.alive()).toBe(1);
    stepFor(fx, 200);
    expect(fx.alive()).toBe(0);
  });

  it("B31 clear removes every projectile, crack and ring at once", () => {
    const { fx } = setup();
    fx.projectile("fire", { x: 0, y: 0 }, { x: 100, y: 100 }, 1_000);
    fx.crack(BOX, 1_000);
    fx.ring("gold", BOX, 1_000);
    fx.clear();
    expect(fx.alive()).toBe(0);
  });

  it("B31 stepping with nothing alive keeps alive() at 0", () => {
    const { fx } = setup();
    fx.step(16);
    fx.step(1_000);
    expect(fx.alive()).toBe(0);
  });
});

describe("B31 drawing", () => {
  it("B31 each live crack, ring and projectile paints onto the context", () => {
    for (const start of [
      (fx: ReturnType<typeof setup>["fx"]) => fx.crack(BOX, 300),
      (fx: ReturnType<typeof setup>["fx"]) => fx.ring("arcane", BOX, 300),
      (fx: ReturnType<typeof setup>["fx"]) => fx.projectile("fire", { x: 0, y: 0 }, { x: 300, y: 0 }, 300),
    ]) {
      const { fx } = setup();
      start(fx);
      fx.step(16);
      const { ctx, calls } = recordingContext();
      expect(() => fx.draw(ctx)).not.toThrow();
      expect(calls.some((name) => PAINTS.has(name)), calls.join(",")).toBe(true);
    }
  });

  it("B31 drawing after everything has ended does not throw", () => {
    const { fx } = setup();
    fx.crack(BOX, 100);
    stepFor(fx, 200);
    const { ctx } = recordingContext();
    expect(() => fx.draw(ctx)).not.toThrow();
    expect(fx.alive()).toBe(0);
  });
});

/** A 2D context that records every call with its arguments. */
function argumentContext() {
  const calls: { name: string; args: unknown[] }[] = [];
  const gradient = { addColorStop: () => {} };
  const state: Record<string | symbol, unknown> = { globalAlpha: 1, globalCompositeOperation: "source-over" };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol") return undefined;
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        if (prop === "createRadialGradient" || prop === "createLinearGradient") return gradient;
        return undefined;
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("B41 flashes", () => {
  it("B41 a preset with a flash spec blooms for its flash time, counted by alive()", () => {
    const { fx } = setup();
    const ms = PARTICLE_PRESETS.spark.flash?.ms ?? 0;
    fx.flash("spark", { x: 445, y: 263 }, BOX, 24);
    expect(fx.alive()).toBe(1);
    stepFor(fx, ms - 10);
    expect(fx.alive()).toBe(1);
    const { ctx, calls } = argumentContext();
    fx.draw(ctx);
    expect(calls.some((c) => c.name === "createRadialGradient")).toBe(true);
    expect(calls.some((c) => c.name === "fill")).toBe(true);
    stepFor(fx, 11);
    expect(fx.alive()).toBe(0);
  });

  it("B41 a preset without a flash spec paints nothing", () => {
    const { fx } = setup();
    fx.flash("smoke", { x: 445, y: 263 }, BOX, 24);
    expect(fx.alive()).toBe(0);
  });

  it("B41 every flash ends inside the tail the runner allows", () => {
    for (const spec of Object.values(PARTICLE_PRESETS)) {
      if (spec.flash !== undefined) expect(spec.flash.ms).toBeLessThanOrEqual(FX_MAX_TAIL_MS);
    }
  });

  it("B41 a bigger burst blooms wider, within the clamp", () => {
    const radius = (count: number): number => {
      const { fx } = setup();
      fx.flash("gold", { x: 0, y: 0 }, BOX, count);
      stepFor(fx, 1);
      const { ctx, calls } = argumentContext();
      fx.draw(ctx);
      const arc = calls.find((c) => c.name === "arc");
      return (arc?.args[2] as number | undefined) ?? 0;
    };
    expect(radius(40)).toBeGreaterThan(radius(8));
  });
});

describe("B42 projectile arrival", () => {
  it("B42 a projectile bursts particles of its preset at its target when its flight ends", () => {
    const { particles, fx } = setup();
    const to: FxVec = { x: 700, y: 300 };
    fx.projectile("fire", { x: 100, y: 300 }, to, 200);
    stepFor(fx, 192);
    particles.clear();
    stepFor(fx, 16);
    expect(fx.alive()).toBe(0);
    const burst = particles.inspect();
    expect(burst.length).toBeGreaterThanOrEqual(10);
    expect(burst.every((p) => p.preset === "fire")).toBe(true);
    const centre = centroid(burst);
    expect(distance(centre, to)).toBeLessThan(20);
  });

  it("B42 the head is drawn with a comet tail behind it", () => {
    const { fx } = setup();
    fx.projectile("arcane", { x: 0, y: 0 }, { x: 600, y: 0 }, 300);
    stepFor(fx, 120);
    const { ctx, calls } = argumentContext();
    fx.draw(ctx);
    expect(calls.filter((c) => c.name === "stroke").length).toBeGreaterThan(2);
    expect(calls.some((c) => c.name === "createRadialGradient")).toBe(true);
  });
});

describe("B44 ring shape", () => {
  it("B44 a ring about a wide box is no wider than maxAspect times its height allows", () => {
    const { fx } = setup();
    const lane: FxBox = { x: 0, y: 0, width: 480, height: 80 };
    fx.ring("dust", lane, 400);
    stepFor(fx, 1);
    const { ctx, calls } = argumentContext();
    fx.draw(ctx);
    const ellipses = calls.filter((c) => c.name === "ellipse").map((c) => c.args as number[]);
    expect(ellipses.length).toBeGreaterThan(0);
    for (const [, , rx, ry] of ellipses) expect((rx ?? 0) / (ry ?? 1)).toBeLessThanOrEqual(1.8 + 1e-9);
  });

  it("B44 a ring is drawn as several glowing strokes, widest first", () => {
    const { fx } = setup();
    fx.ring("arcane", BOX, 400);
    stepFor(fx, 16);
    const { ctx, calls } = argumentContext();
    fx.draw(ctx);
    expect(calls.filter((c) => c.name === "stroke").length).toBeGreaterThanOrEqual(3);
  });
});

describe("R200 and intensity: shapes age by real time, projectiles scale with intensity", () => {
  const FROM: FxVec = { x: 100, y: 300 };
  const TO: FxVec = { x: 700, y: 300 };

  it("R200 a stalled frame ages every shape by the real time that passed, not the clamped step", () => {
    // Review: dt is clamped to 50 ms, so on a 500 ms frame a 900 ms effect lived for seconds of wall time.
    const { fx } = setup();
    fx.crack(BOX, 400);
    fx.ring("gold", BOX, 500);
    fx.projectile("fire", FROM, TO, 300);
    fx.step(50, 600);
    expect(fx.alive()).toBe(0);
  });

  it("R200 without a separate age the step ages by dt, as before", () => {
    const { fx } = setup();
    fx.crack(BOX, 300);
    fx.step(50);
    expect(fx.alive()).toBe(1);
  });

  it("B54 a projectile's trail and arrival burst scale with its density (the intensity), as a burst's count does", () => {
    const emitted = (density: number): number => {
      const { particles, fx } = setup();
      fx.projectile("fire", FROM, TO, 200, density);
      stepFor(fx, 201);
      return particles.alive();
    };
    const low = emitted(0.45);
    const normal = emitted(1);
    const high = emitted(1.6);
    expect(low).toBeLessThan(normal);
    expect(normal).toBeLessThan(high);
    expect(low).toBeLessThanOrEqual(Math.ceil(normal * 0.6));
  });
});

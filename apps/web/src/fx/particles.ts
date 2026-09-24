/**
 * The pooled particle system (docs/polish/1-animations.md, S5; B23–B26).
 *
 * Particles live in a struct of arrays: one typed array per field, sized to the capacity, and no
 * object per particle, so a busy board allocates nothing after construction. A ring cursor hands out
 * slots: while there is room it takes the next free slot, and once the pool is full it overwrites
 * the oldest one, so the live count can never pass the capacity. Every random draw comes from the
 * injected `FxRng`, so one seed and one sequence of emits and steps always gives the same particles.
 */
import { PARTICLE_PRESETS, PRESET_ORDER, type ParticlePresetSpec } from "./presets.ts";
import type { FxRng } from "./rng.ts";
import { createSpriteCache, domSpriteCanvas, type SpriteCache } from "./sprites.ts";
import type { FxBox, FxPreset, FxSpread } from "./types.ts";

export type EmitOptions = { count: number; spread: FxSpread; box: FxBox; power: number };

export type ParticleSystem = {
  /** Emits at (x, y), or across `box` for "area" and around its ellipse for "ring". Returns how many. */
  emit(preset: FxPreset, x: number, y: number, options: EmitOptions): number;
  /**
   * Moves every particle by `dtMs` (the clamped frame time) and ages it by `ageMs` (the real time
   * that passed, default `dtMs`): a stalled frame never flings a particle, and never keeps one alive
   * past its wall-clock life either (R200).
   */
  step(dtMs: number, ageMs?: number): void;
  /** Draws every live particle; a null sprite falls back to a filled arc in the preset colour. */
  draw(ctx: CanvasRenderingContext2D, dpr: number): void;
  alive(): number;
  capacity(): number;
  /** Lowers or raises the live cap; growing reallocates the pool, shrinking never does. */
  setCapacity(capacity: number): void;
  /** `allocations` counts pool (re)allocations: 1 after construction. */
  stats(): { allocations: number };
  /** Live particles in slot order, for tests. */
  inspect(): ReadonlyArray<{ preset: FxPreset; x: number; y: number; life: number }>;
  clear(): void;
};

/** CLAUDE.md rule 9: the look-and-feel numbers of drawing and stepping. */
const TUNING = {
  /** Fraction of a particle's life spent fading in. */
  fadeInFraction: 0.12,
  /** Alpha a particle is born with before it fades fully in. */
  bornAlpha: 0.4,
  /** Non-shrinking presets (smoke, poison, dust, confetti) grow by this fraction of their size over life. */
  expandOverLife: 0.45,
  /** A spinning sprite is squashed by |cos(rotation)| down to this fraction, which reads as tumbling. */
  tumbleFloor: 0.25,
  /** A particle with less than this left to live is dead, so summed frame steps cannot strand one. */
  lifeEpsilonMs: 1e-6,
  msPerSecond: 1000,
} as const;

/**
 * Streaks (a preset's `stretch`): a moving particle is drawn `1 + stretch × speed / 1000` times as
 * long as it is wide, along its velocity, capped at `maxLength`, and `thin` times as thick, so a
 * spark reads as a hot scratch of light rather than a dot. Below `minSpeed` it is a plain dot.
 */
const STREAK = {
  maxLength: 5,
  thin: 0.55,
  minSpeed: 30,
} as const;

const TAU = Math.PI * 2;

const SPECS: readonly ParticlePresetSpec[] = PRESET_ORDER.map((p) => PARTICLE_PRESETS[p]);
const LIGHTER: readonly boolean[] = SPECS.map((s) => s.blend === "lighter");
const STRETCH: readonly number[] = SPECS.map((s) => s.stretch ?? 0);
const TWIRL: readonly boolean[] = SPECS.map((s) => s.twirl === true);
const PRESET_INDEX = new Map<FxPreset, number>(PRESET_ORDER.map((p, i) => [p, i]));
const MAX_COLORS = Math.max(1, ...SPECS.map((s) => s.colors.length));

type Pool = {
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  size: Float32Array;
  rot: Float32Array;
  spin: Float32Array;
  /** Timing stays in doubles so summed frame steps land exactly on a lifetime. */
  age: Float64Array;
  life: Float64Array;
  preset: Uint8Array;
  color: Uint8Array;
  live: Uint8Array;
};

function allocatePool(n: number): Pool {
  return {
    x: new Float32Array(n),
    y: new Float32Array(n),
    vx: new Float32Array(n),
    vy: new Float32Array(n),
    size: new Float32Array(n),
    rot: new Float32Array(n),
    spin: new Float32Array(n),
    age: new Float64Array(n),
    life: new Float64Array(n),
    preset: new Uint8Array(n),
    color: new Uint8Array(n),
    live: new Uint8Array(n),
  };
}

function copyPool(from: Pool, to: Pool, n: number): void {
  to.x.set(from.x.subarray(0, n));
  to.y.set(from.y.subarray(0, n));
  to.vx.set(from.vx.subarray(0, n));
  to.vy.set(from.vy.subarray(0, n));
  to.size.set(from.size.subarray(0, n));
  to.rot.set(from.rot.subarray(0, n));
  to.spin.set(from.spin.subarray(0, n));
  to.age.set(from.age.subarray(0, n));
  to.life.set(from.life.subarray(0, n));
  to.preset.set(from.preset.subarray(0, n));
  to.color.set(from.color.subarray(0, n));
  to.live.set(from.live.subarray(0, n));
}

function between(range: readonly [number, number], u: number): number {
  return range[0] + (range[1] - range[0]) * u;
}

/** `sprites` defaults to `createSpriteCache(domSpriteCanvas())`. */
export function createParticleSystem(options: { capacity: number; rng: FxRng; sprites?: SpriteCache }): ParticleSystem {
  const rng = options.rng;
  const sprites = options.sprites ?? createSpriteCache(domSpriteCanvas());

  let cap = options.capacity;
  let pool = allocatePool(cap);
  let allocations = 1;
  let cursor = 0;
  let aliveCount = 0;

  const dragFactor = new Float64Array(SPECS.length);
  /** Sprites resolved for the current dpr, indexed preset × colour, so drawing builds no cache keys. */
  const spriteTable: Array<CanvasImageSource | null | undefined> = new Array(SPECS.length * MAX_COLORS);
  let spriteDpr = Number.NaN;

  const nextSlot = (s: number) => (s + 1 >= cap ? 0 : s + 1);

  /** A free slot while there is room (searching from the cursor), else the oldest one at the cursor. */
  const claimSlot = (): number => {
    if (aliveCount < cap) {
      let s = cursor;
      for (let i = 0; i < cap; i++) {
        if (!pool.live[s]) break;
        s = nextSlot(s);
      }
      cursor = nextSlot(s);
      pool.live[s] = 1;
      aliveCount++;
      return s;
    }
    const s = cursor;
    cursor = nextSlot(s);
    return s;
  };

  const kill = (i: number) => {
    if (pool.live[i]) {
      pool.live[i] = 0;
      aliveCount--;
    }
  };

  const spriteFor = (p: number, c: number, dpr: number): CanvasImageSource | null => {
    if (dpr !== spriteDpr) {
      spriteTable.fill(undefined);
      spriteDpr = dpr;
    }
    const k = p * MAX_COLORS + c;
    let sprite = spriteTable[k];
    if (sprite === undefined) {
      sprite = sprites.get(PRESET_ORDER[p]!, c, dpr);
      spriteTable[k] = sprite;
    }
    return sprite;
  };

  const drawPass = (ctx: CanvasRenderingContext2D, dpr: number, lighter: boolean) => {
    let blendSet = false;
    let rotated = false;
    const { x, y, vx, vy, size, rot, spin, age, life, preset, color, live } = pool;
    for (let i = 0; i < cap; i++) {
      if (!live[i]) continue;
      const p = preset[i]!;
      if (LIGHTER[p] !== lighter) continue;
      if (!blendSet) {
        ctx.globalCompositeOperation = lighter ? "lighter" : "source-over";
        blendSet = true;
      }
      const spec = SPECS[p]!;
      const lifeMs = life[i]!;
      const t = lifeMs > 0 ? Math.min(1, age[i]! / lifeMs) : 1;
      const alpha =
        t < TUNING.fadeInFraction
          ? TUNING.bornAlpha + (1 - TUNING.bornAlpha) * (t / TUNING.fadeInFraction)
          : 1 - (t - TUNING.fadeInFraction) / (1 - TUNING.fadeInFraction);
      const s = size[i]! * (spec.shrink ? 1 - t : 1 + TUNING.expandOverLife * t);
      const tumble = spin[i] !== 0 ? TUNING.tumbleFloor + (1 - TUNING.tumbleFloor) * Math.abs(Math.cos(rot[i]!)) : 1;
      const px = x[i]!;
      const py = y[i]!;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      const sprite = spriteFor(p, color[i]!, dpr);
      const stretch = STRETCH[p]!;
      const speed = stretch > 0 ? Math.hypot(vx[i]!, vy[i]!) : 0;
      if (sprite && speed > STREAK.minSpeed) {
        // A streak along the velocity: the transform carries the dpr scale the surface set.
        const length = s * Math.min(STREAK.maxLength, 1 + (stretch * speed) / TUNING.msPerSecond);
        const thick = s * STREAK.thin;
        const c = vx[i]! / speed;
        const n = vy[i]! / speed;
        ctx.setTransform(dpr * c, dpr * n, -dpr * n, dpr * c, dpr * px, dpr * py);
        ctx.drawImage(sprite, -length / 2, -thick / 2, length, thick);
        rotated = true;
      } else if (sprite && TWIRL[p]) {
        // A scrap of paper turning in the air: rotated by its spin, still squashed by its tumble.
        const c = Math.cos(rot[i]!);
        const n = Math.sin(rot[i]!);
        ctx.setTransform(dpr * c, dpr * n, -dpr * n, dpr * c, dpr * px, dpr * py);
        const h = s * tumble;
        ctx.drawImage(sprite, -s / 2, -h / 2, s, h);
        rotated = true;
      } else if (sprite) {
        if (rotated) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          rotated = false;
        }
        const h = s * tumble;
        ctx.drawImage(sprite, px - s / 2, py - h / 2, s, h);
      } else {
        ctx.fillStyle = spec.colors[color[i]!] ?? spec.colors[0] ?? "#ffffff";
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0, s / 2), 0, TAU);
        ctx.fill();
      }
    }
    if (rotated) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  return {
    emit(presetName, x, y, emitOptions) {
      const p = PRESET_INDEX.get(presetName)!;
      const n = Math.min(emitOptions.count, cap);
      const spec = SPECS[p]!;
      const { power, spread, box } = emitOptions;
      const colorCount = spec.colors.length;

      for (let k = 0; k < n; k++) {
        const slot = claimSlot();
        const angle = rng() * TAU;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        let px = x;
        let py = y;
        if (spread === "area") {
          px = box.x + rng() * box.width;
          py = box.y + rng() * box.height;
        } else if (spread === "ring") {
          px = box.x + box.width / 2 + (cos * box.width) / 2;
          py = box.y + box.height / 2 + (sin * box.height) / 2;
        }
        const speed = between(spec.speed, rng()) * power;
        pool.x[slot] = px;
        pool.y[slot] = py;
        pool.vx[slot] = cos * speed;
        pool.vy[slot] = sin * speed;
        pool.size[slot] = between(spec.size, rng());
        pool.life[slot] = between(spec.life, rng());
        pool.age[slot] = 0;
        pool.rot[slot] = rng() * TAU;
        pool.spin[slot] = (rng() * 2 - 1) * spec.spin;
        pool.color[slot] = Math.floor(rng() * colorCount);
        pool.preset[slot] = p;
      }
      return n;
    },

    step(dtMs, ageMs = dtMs) {
      if (aliveCount === 0) return;
      const dts = dtMs / TUNING.msPerSecond;
      const ageStep = Math.max(0, ageMs);
      for (let p = 0; p < SPECS.length; p++) {
        dragFactor[p] = Math.pow(1 - SPECS[p]!.drag, dts);
      }
      const { x, y, vx, vy, rot, spin, age, life, preset, live } = pool;
      for (let i = 0; i < cap; i++) {
        if (!live[i]) continue;
        const a = age[i]! + ageStep;
        age[i] = a;
        if (a >= life[i]! - TUNING.lifeEpsilonMs) {
          kill(i);
          continue;
        }
        const p = preset[i]!;
        const f = dragFactor[p]!;
        const nvx = vx[i]! * f;
        const nvy = (vy[i]! + SPECS[p]!.gravity * dts) * f;
        vx[i] = nvx;
        vy[i] = nvy;
        x[i] = x[i]! + nvx * dts;
        y[i] = y[i]! + nvy * dts;
        rot[i] = rot[i]! + spin[i]! * dts;
      }
    },

    draw(ctx, dpr) {
      if (aliveCount === 0) return;
      drawPass(ctx, dpr, false);
      drawPass(ctx, dpr, true);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    },

    alive: () => aliveCount,
    capacity: () => cap,

    setCapacity(next) {
      // Raising the cap inside the pool already allocated reuses it; only outgrowing it reallocates.
      if (next > pool.x.length) {
        const grown = allocatePool(next);
        copyPool(pool, grown, cap);
        pool = grown;
        allocations++;
        cap = next;
        return;
      }
      if (next >= cap) {
        cap = next;
        return;
      }
      for (let i = next; i < cap; i++) kill(i);
      cap = next;
      if (cursor >= cap) cursor = 0;
    },

    stats: () => ({ allocations }),

    inspect() {
      const out: Array<{ preset: FxPreset; x: number; y: number; life: number }> = [];
      for (let i = 0; i < cap; i++) {
        if (!pool.live[i]) continue;
        out.push({
          preset: PRESET_ORDER[pool.preset[i]!]!,
          x: pool.x[i]!,
          y: pool.y[i]!,
          life: pool.life[i]! - pool.age[i]!,
        });
      }
      return out;
    },

    clear() {
      pool.live.fill(0);
      aliveCount = 0;
      cursor = 0;
    },
  };
}

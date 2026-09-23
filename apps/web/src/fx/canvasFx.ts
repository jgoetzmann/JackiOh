/**
 * Shaped canvas effects (docs/polish/1-animations.md, S5; B31): spell projectiles on a shallow
 * quadratic arc that leave a particle trail and a comet tail, branching death cracks, expanding
 * shock rings, and the short bloom a preset with a `flash` paints where its burst fires. Loose
 * particles belong to the ParticleSystem; this module only owns the shapes, and each one ends
 * exactly when its time is up, so nothing outlives the tail the runner allows (R200).
 *
 * Glow comes from layered strokes and radial gradients under `lighter` blending, never from
 * `shadowBlur` or text, and every random choice (arc bend, crack shape) comes from the injected
 * `FxRng`.
 */
import { PARTICLE_PRESETS } from "./presets.ts";
import type { ParticleSystem, EmitOptions } from "./particles.ts";
import type { FxRng } from "./rng.ts";
import type { FxBox, FxPreset, FxVec } from "./types.ts";

export type CanvasFx = {
  /**
   * A glowing head along a shallow quadratic arc, emitting `preset` trail particles each step; ends at
   * flightMs. `density` (the intensity scale, default 1) multiplies the trail and the arrival burst.
   */
  projectile(preset: FxPreset, from: FxVec, to: FxVec, flightMs: number, density?: number): void;
  /** Jagged branching polyline from the box centre, white-hot fading to dark over durationMs. */
  crack(box: FxBox, durationMs: number): void;
  /** An expanding elliptical shock wave about the box (RING.scaleFrom to RING.scaleTo), fading over durationMs. */
  ring(preset: FxPreset, box: FxBox, durationMs: number): void;
  /**
   * The preset's bloom (`PARTICLE_PRESETS[preset].flash`) at `at`, sized against `box` and the
   * burst's `count`. A preset without a flash paints nothing.
   */
  flash(preset: FxPreset, at: FxVec, box: FxBox, count: number): void;
  /**
   * Moves everything on by `dtMs` (the clamped frame time, which paces the trail) and ages it by
   * `ageMs` (the real time that passed, default `dtMs`), so a stalled frame never stretches a shape
   * past its wall-clock end (R200).
   */
  step(dtMs: number, ageMs?: number): void;
  draw(ctx: CanvasRenderingContext2D): void;
  /** Projectiles, cracks, rings and flashes still running. */
  alive(): number;
  clear(): void;
};

/** CLAUDE.md rule 9: every shape number in one place. */
const PROJECTILE = {
  /** Control-point offset from the chord midpoint, as a fraction of the chord length. */
  arcMin: 0.1,
  arcMax: 0.2,
  /** Trail particles per ms of flight, and at least this many each step. */
  trailPerMs: 0.45,
  trailMinPerStep: 2,
  /** Trail particles drift slowly: their preset speed is scaled by this. */
  trailPower: 0.35,
  /** Each trail particle is born this far (CSS px, either way) off the path, so the trail has body. */
  trailJitter: 4,
  /**
   * Head glow: a radial gradient from the core colour out to the halo, radii in CSS px. The body
   * colour sits at `bodyRadius` with `bodyAlpha`, and the halo colour at `haloAt` of the radius with
   * `haloAlpha`, fading to nothing at the edge.
   */
  haloRadius: 24,
  haloAt: 0.7,
  haloAlpha: 0.25,
  bodyRadius: 11,
  bodyAlpha: 0.85,
  coreRadius: 5,
  /** The comet tail: this many past head positions, drawn as a tapering stroke. */
  tailPoints: 9,
  tailWidth: 16,
  tailAlpha: 0.55,
  /** On arrival the bolt bursts: this many particles of its preset, thrown this hard. */
  arrivalCount: 18,
  arrivalPower: 1.5,
} as const;

const CRACK = {
  branchesMin: 3,
  branchesMax: 5,
  /** How far a main branch reaches, as a fraction of the half diagonal. */
  reachMin: 0.55,
  reachMax: 0.95,
  segmentsPerBranch: 4,
  /** Max turn per segment, radians. */
  zigzag: 0.9,
  /** Radians of jitter on each main branch's direction. */
  angleJitter: 0.8,
  branchChance: 0.4,
  /** Sub-branch length as a fraction of its parent's. */
  branchScale: 0.45,
  branchTurnMin: 0.5,
  branchTurnMax: 1.1,
  maxDepth: 2,
  /** Fraction of the duration spent spreading outward from the centre. */
  growFraction: 0.25,
  /** Colour ramp points (fraction of duration): white-hot → orange by `hotUntil`, → dark by `darkAt`. */
  hotUntil: 0.35,
  darkAt: 0.7,
  /** The crack fades out between these fractions of its duration, so it goes with the card. */
  fadeFrom: 0.2,
  fadeTo: 0.45,
  /** The glow stroke is only drawn while the crack is still hot. */
  glowUntil: 0.45,
  glowWidth: 6,
  glowAlpha: 0.5,
  coreWidth: 1.7,
  hot: [255, 251, 232] as const,
  warm: [255, 154, 60] as const,
  dark: [43, 29, 24] as const,
} as const;

const RING = {
  scaleFrom: 0.55,
  scaleTo: 1.45,
  widthFrom: 9,
  widthTo: 1.5,
  /** A zero-size box (a viewport anchor) still gets a visible ring, and no stroke is thinner than this. */
  minRadiusPx: 24,
  minWidthPx: 0.5,
  /** A wide box (a lane zone) still gets a ring about the card in it, not one the width of the lane. */
  maxAspect: 1.8,
  /**
   * The shock wave is three strokes of one ellipse, widest and faintest first: [width multiple,
   * alpha]. The outer two use the preset's deeper colour and the last its hot core, so the ring
   * glows instead of reading as an outline.
   */
  passes: [
    [3.4, 0.16],
    [1.8, 0.34],
    [0.7, 0.95],
  ],
  /**
   * A painted (source-over) ring is dust or void: no hot core, only soft strokes in its pale colour,
   * [width multiple, alpha], so it reads as a cloud rolling out rather than a drawn line (visual
   * pass 2: the old two strokes at up to 0.58 alpha read as a solid beige donut).
   */
  paintedPasses: [
    [5.2, 0.06],
    [3.4, 0.09],
    [2, 0.12],
    [1, 0.14],
  ],
} as const;

const FLASH = {
  /** The bloom's radius is `scale × min(box side) × sqrt(count / countRef)`, clamped. */
  countRef: 20,
  minRadiusPx: 26,
  maxRadiusPx: 150,
  /** It swells from this fraction of its radius to the full radius. */
  growFrom: 0.5,
  /** Where the gradient passes from the core colour to the halo colour, and their alphas there. */
  coreStop: 0.22,
  coreAlpha: 0.9,
  haloStop: 0.5,
  haloAlpha: 0.55,
  /** The anamorphic streak through the bloom: length and thickness multiples of the radius. */
  streakLength: 2.2,
  streakThickness: 0.1,
  streakAlpha: 0.8,
} as const;

/** Anything within this of its end time has ended, so summed frame steps cannot strand a shape. */
const END_EPSILON_MS = 1e-6;
const TAU = Math.PI * 2;

type Projectile = {
  preset: FxPreset;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
  flightMs: number;
  /** The intensity scale on the trail and the arrival burst. */
  density: number;
  elapsed: number;
  lastT: number;
  hx: number;
  hy: number;
  /** Past head positions for the comet tail, oldest first (x, y pairs). */
  tail: number[];
};

type Flash = {
  core: string;
  color: string;
  x: number;
  y: number;
  radius: number;
  durationMs: number;
  elapsed: number;
};

type Crack = {
  /** Flat segments: x1, y1, x2, y2, reveal (0..1, by distance from the centre). */
  segments: number[];
  durationMs: number;
  elapsed: number;
};

type Ring = {
  preset: FxPreset;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  durationMs: number;
  elapsed: number;
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

const HEX_RADIX = 16;
const CHANNEL_MAX = 255;
const RED_SHIFT = 16;
const GREEN_SHIFT = 8;

/** `#rrggbb` → `rgba(r, g, b, a)`; anything else is returned as given (alpha then comes from globalAlpha). */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = Number.parseInt(m[1]!, HEX_RADIX);
  return `rgba(${(n >> RED_SHIFT) & CHANNEL_MAX}, ${(n >> GREEN_SHIFT) & CHANNEL_MAX}, ${n & CHANNEL_MAX}, ${alpha})`;
}

function rampColor(p: number): string {
  let from: readonly [number, number, number];
  let to: readonly [number, number, number];
  let t: number;
  if (p <= CRACK.hotUntil) {
    from = CRACK.hot;
    to = CRACK.warm;
    t = p / CRACK.hotUntil;
  } else {
    from = CRACK.warm;
    to = CRACK.dark;
    t = clamp((p - CRACK.hotUntil) / (CRACK.darkAt - CRACK.hotUntil), 0, 1);
  }
  const c = (i: 0 | 1 | 2) => Math.round(lerp(from[i], to[i], t));
  return `rgb(${c(0)}, ${c(1)}, ${c(2)})`;
}

export function createCanvasFx(options: { particles: ParticleSystem; rng: FxRng }): CanvasFx {
  const { particles, rng } = options;
  const projectiles: Projectile[] = [];
  const cracks: Crack[] = [];
  const rings: Ring[] = [];
  const flashes: Flash[] = [];

  /** One reusable emit request, so a trail step allocates nothing. */
  const trailBox: FxBox = { x: 0, y: 0, width: 0, height: 0 };
  const trailEmit: EmitOptions = { count: 1, spread: "point", box: trailBox, power: PROJECTILE.trailPower };
  const arrivalEmit: EmitOptions = {
    count: PROJECTILE.arrivalCount,
    spread: "point",
    box: trailBox,
    power: PROJECTILE.arrivalPower,
  };

  /** The quadratic Bézier point for `t`, written into `at` (no allocation per trail particle). */
  const at = { x: 0, y: 0 };
  const pointAt = (pr: Projectile, t: number): void => {
    const u = 1 - t;
    at.x = u * u * pr.fx + 2 * u * t * pr.cx + t * t * pr.tx;
    at.y = u * u * pr.fy + 2 * u * t * pr.cy + t * t * pr.ty;
  };

  const emitTrail = (pr: Projectile, x: number, y: number) => {
    const jx = x + (rng() * 2 - 1) * PROJECTILE.trailJitter;
    const jy = y + (rng() * 2 - 1) * PROJECTILE.trailJitter;
    trailBox.x = jx;
    trailBox.y = jy;
    trailEmit.count = 1;
    particles.emit(pr.preset, jx, jy, trailEmit);
  };

  const growCrack = (
    segments: number[],
    box: FxBox,
    cx: number,
    cy: number,
    reach: number,
    x: number,
    y: number,
    angle: number,
    length: number,
    depth: number,
  ) => {
    const segLength = length / CRACK.segmentsPerBranch;
    let px = x;
    let py = y;
    let a = angle;
    for (let s = 0; s < CRACK.segmentsPerBranch; s++) {
      a += (rng() - 0.5) * CRACK.zigzag;
      const nx = clamp(px + Math.cos(a) * segLength, box.x, box.x + box.width);
      const ny = clamp(py + Math.sin(a) * segLength, box.y, box.y + box.height);
      const reveal = Math.min(1, Math.hypot(nx - cx, ny - cy) / reach);
      segments.push(px, py, nx, ny, reveal);
      if (depth < CRACK.maxDepth && rng() < CRACK.branchChance) {
        const side = rng() < 0.5 ? -1 : 1;
        const turn = lerp(CRACK.branchTurnMin, CRACK.branchTurnMax, rng()) * side;
        growCrack(segments, box, cx, cy, reach, nx, ny, a + turn, length * CRACK.branchScale, depth + 1);
      }
      px = nx;
      py = ny;
    }
  };

  const drawProjectile = (ctx: CanvasRenderingContext2D, pr: Projectile) => {
    const spec = PARTICLE_PRESETS[pr.preset];
    const colors = spec.colors;
    const core = colors[0] ?? "#ffffff";
    const body = colors[1] ?? core;
    const halo = colors[colors.length - 1] ?? body;
    // Glowing presets add light; a poison or void bolt still glows, or it would vanish on the board.
    ctx.globalCompositeOperation = "lighter";

    // The comet tail: a stroke through the last head positions, thin and faint at its old end.
    const tail = pr.tail;
    const points = tail.length / 2;
    ctx.lineCap = "round";
    for (let k = 1; k < points; k++) {
      const f = k / points;
      ctx.globalAlpha = PROJECTILE.tailAlpha * f;
      ctx.strokeStyle = k === points - 1 ? core : body;
      ctx.lineWidth = Math.max(1, PROJECTILE.tailWidth * f);
      ctx.beginPath();
      ctx.moveTo(tail[(k - 1) * 2]!, tail[(k - 1) * 2 + 1]!);
      ctx.lineTo(tail[k * 2]!, tail[k * 2 + 1]!);
      ctx.stroke();
    }

    // The head: one radial gradient, white-hot core through the body colour to a soft halo.
    const gradient = ctx.createRadialGradient(pr.hx, pr.hy, 0, pr.hx, pr.hy, PROJECTILE.haloRadius);
    gradient.addColorStop(0, withAlpha(core, 1));
    gradient.addColorStop(PROJECTILE.coreRadius / PROJECTILE.haloRadius, withAlpha(core, 1));
    gradient.addColorStop(PROJECTILE.bodyRadius / PROJECTILE.haloRadius, withAlpha(body, PROJECTILE.bodyAlpha));
    gradient.addColorStop(PROJECTILE.haloAt, withAlpha(halo, PROJECTILE.haloAlpha));
    gradient.addColorStop(1, withAlpha(halo, 0));
    ctx.globalAlpha = 1;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(pr.hx, pr.hy, PROJECTILE.haloRadius, 0, TAU);
    ctx.fill();
  };

  const drawFlash = (ctx: CanvasRenderingContext2D, fl: Flash) => {
    const p = fl.durationMs > 0 ? clamp(fl.elapsed / fl.durationMs, 0, 1) : 1;
    const eased = 1 - (1 - p) * (1 - p);
    const radius = fl.radius * lerp(FLASH.growFrom, 1, eased);
    const fade = (1 - p) * (1 - p);
    if (radius <= 0 || fade <= 0) return;
    const gradient = ctx.createRadialGradient(fl.x, fl.y, 0, fl.x, fl.y, radius);
    gradient.addColorStop(0, withAlpha(fl.core, 1));
    gradient.addColorStop(FLASH.coreStop, withAlpha(fl.core, FLASH.coreAlpha));
    gradient.addColorStop(FLASH.haloStop, withAlpha(fl.color, FLASH.haloAlpha));
    gradient.addColorStop(1, withAlpha(fl.color, 0));
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = gradient;
    ctx.globalAlpha = fade;
    ctx.beginPath();
    ctx.arc(fl.x, fl.y, radius, 0, TAU);
    ctx.fill();
    // A thin horizontal streak through the bloom, the lens-flare line of a hard hit.
    ctx.globalAlpha = fade * FLASH.streakAlpha;
    ctx.beginPath();
    ctx.ellipse(fl.x, fl.y, radius * FLASH.streakLength, Math.max(1, radius * FLASH.streakThickness), 0, 0, TAU);
    ctx.fill();
  };

  const strokeCrack = (ctx: CanvasRenderingContext2D, cr: Crack, reveal: number) => {
    const seg = cr.segments;
    ctx.beginPath();
    for (let i = 0; i < seg.length; i += 5) {
      if (seg[i + 4]! > reveal) continue;
      ctx.moveTo(seg[i]!, seg[i + 1]!);
      ctx.lineTo(seg[i + 2]!, seg[i + 3]!);
    }
    ctx.stroke();
  };

  const drawCrack = (ctx: CanvasRenderingContext2D, cr: Crack) => {
    const p = cr.durationMs > 0 ? clamp(cr.elapsed / cr.durationMs, 0, 1) : 1;
    const reveal = Math.min(1, p / CRACK.growFraction);
    const alpha = p <= CRACK.fadeFrom ? 1 : clamp(1 - (p - CRACK.fadeFrom) / (CRACK.fadeTo - CRACK.fadeFrom), 0, 1);
    if (alpha <= 0) return;
    const color = rampColor(p);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (p < CRACK.glowUntil) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = alpha * CRACK.glowAlpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = CRACK.glowWidth;
      strokeCrack(ctx, cr, reveal);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = CRACK.coreWidth;
    strokeCrack(ctx, cr, reveal);
  };

  const drawRing = (ctx: CanvasRenderingContext2D, rg: Ring) => {
    const p = rg.durationMs > 0 ? clamp(rg.elapsed / rg.durationMs, 0, 1) : 1;
    const eased = 1 - (1 - p) * (1 - p) * (1 - p);
    const scale = lerp(RING.scaleFrom, RING.scaleTo, eased);
    const spec = PARTICLE_PRESETS[rg.preset];
    const hot = spec.colors[0] ?? "#ffffff";
    const deep = spec.colors[1] ?? hot;
    const fade = clamp(1 - p, 0, 1);
    const width = lerp(RING.widthFrom, RING.widthTo, p);
    const rx = Math.max(0, rg.rx * scale);
    const ry = Math.max(0, rg.ry * scale);
    ctx.globalCompositeOperation = spec.blend;
    const painted = spec.blend !== "lighter";
    const passes = painted ? RING.paintedPasses : RING.passes;
    const last = passes.length - 1;
    passes.forEach(([widthMul, alpha], index) => {
      const core = !painted && index === last;
      ctx.globalAlpha = fade * alpha;
      ctx.strokeStyle = core || painted ? hot : deep;
      ctx.lineWidth = Math.max(RING.minWidthPx, width * widthMul);
      ctx.beginPath();
      ctx.ellipse(rg.cx, rg.cy, rx, ry, 0, 0, TAU);
      ctx.stroke();
    });
  };

  return {
    projectile(preset, from, to, flightMs, density = 1) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const chord = Math.hypot(dx, dy);
      const bend = chord * lerp(PROJECTILE.arcMin, PROJECTILE.arcMax, rng());
      // The perpendicular that points up the screen, so every shot lobs rather than dips.
      let nx = chord > 0 ? -dy / chord : 0;
      let ny = chord > 0 ? dx / chord : -1;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      projectiles.push({
        preset,
        fx: from.x,
        fy: from.y,
        cx: (from.x + to.x) / 2 + nx * bend,
        cy: (from.y + to.y) / 2 + ny * bend,
        tx: to.x,
        ty: to.y,
        flightMs,
        density: Math.max(0, density),
        elapsed: 0,
        lastT: 0,
        hx: from.x,
        hy: from.y,
        tail: [from.x, from.y],
      });
    },

    crack(box, durationMs) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const halfDiagonal = Math.hypot(box.width, box.height) / 2;
      const segments: number[] = [];
      const branches =
        CRACK.branchesMin + Math.floor(rng() * (CRACK.branchesMax - CRACK.branchesMin + 1));
      const reach = halfDiagonal * CRACK.reachMax;
      for (let b = 0; b < branches; b++) {
        const angle = (b / branches) * TAU + (rng() - 0.5) * CRACK.angleJitter;
        const length = halfDiagonal * lerp(CRACK.reachMin, CRACK.reachMax, rng());
        growCrack(segments, box, cx, cy, reach, cx, cy, angle, length, 0);
      }
      cracks.push({ segments, durationMs, elapsed: 0 });
    },

    ring(preset, box, durationMs) {
      const ry = Math.max(RING.minRadiusPx, box.height / 2);
      rings.push({
        preset,
        cx: box.x + box.width / 2,
        cy: box.y + box.height / 2,
        rx: Math.max(RING.minRadiusPx, Math.min(box.width / 2, ry * RING.maxAspect)),
        ry,
        durationMs,
        elapsed: 0,
      });
    },

    flash(preset, at, box, count) {
      const spec = PARTICLE_PRESETS[preset].flash;
      if (spec === undefined) return;
      const side = Math.min(box.width, box.height);
      const radius = clamp(
        spec.scale * side * Math.sqrt(Math.max(1, count) / FLASH.countRef),
        FLASH.minRadiusPx,
        FLASH.maxRadiusPx,
      );
      flashes.push({ core: spec.core, color: spec.color, x: at.x, y: at.y, radius, durationMs: spec.ms, elapsed: 0 });
    },

    step(dtMs, ageMs = dtMs) {
      const age = Math.max(0, ageMs);
      let w = 0;
      for (const pr of projectiles) {
        pr.elapsed += age;
        const t = pr.flightMs > 0 ? Math.min(1, pr.elapsed / pr.flightMs) : 1;
        const perStep = Math.max(PROJECTILE.trailMinPerStep, dtMs * PROJECTILE.trailPerMs);
        const n = Math.max(1, Math.round(perStep * pr.density));
        for (let k = 1; k <= n; k++) {
          pointAt(pr, pr.lastT + ((t - pr.lastT) * k) / n);
          emitTrail(pr, at.x, at.y);
        }
        pointAt(pr, t);
        pr.hx = at.x;
        pr.hy = at.y;
        pr.lastT = t;
        pr.tail.push(at.x, at.y);
        if (pr.tail.length > PROJECTILE.tailPoints * 2) pr.tail.splice(0, 2);
        if (pr.elapsed < pr.flightMs - END_EPSILON_MS) {
          projectiles[w++] = pr;
        } else {
          // The bolt bursts where it lands; the planner's impact (sparks, splat, shake) lands with it.
          trailBox.x = pr.tx;
          trailBox.y = pr.ty;
          arrivalEmit.count = Math.max(1, Math.round(PROJECTILE.arrivalCount * pr.density));
          particles.emit(pr.preset, pr.tx, pr.ty, arrivalEmit);
        }
      }
      projectiles.length = w;

      w = 0;
      for (const cr of cracks) {
        cr.elapsed += age;
        if (cr.elapsed < cr.durationMs - END_EPSILON_MS) cracks[w++] = cr;
      }
      cracks.length = w;

      w = 0;
      for (const rg of rings) {
        rg.elapsed += age;
        if (rg.elapsed < rg.durationMs - END_EPSILON_MS) rings[w++] = rg;
      }
      rings.length = w;

      w = 0;
      for (const fl of flashes) {
        fl.elapsed += age;
        if (fl.elapsed < fl.durationMs - END_EPSILON_MS) flashes[w++] = fl;
      }
      flashes.length = w;
    },

    draw(ctx) {
      if (projectiles.length + cracks.length + rings.length + flashes.length === 0) return;
      for (const rg of rings) drawRing(ctx, rg);
      for (const cr of cracks) drawCrack(ctx, cr);
      for (const fl of flashes) drawFlash(ctx, fl);
      for (const pr of projectiles) drawProjectile(ctx, pr);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    },

    alive: () => projectiles.length + cracks.length + rings.length + flashes.length,

    clear() {
      projectiles.length = 0;
      cracks.length = 0;
      rings.length = 0;
      flashes.length = 0;
    },
  };
}

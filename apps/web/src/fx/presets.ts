/**
 * Particle physics per preset (docs/polish/1-animations.md, S5). CLAUDE.md rule 9: this table is
 * where every particle number lives. Glowing presets (fire, holy, arcane, sparkle, gold, prismatic,
 * spark, confetti) add light with `lighter`; the rest (ember, poison, smoke, dust, shard, void) paint
 * over with `source-over`. Every `life[1]` stays at or under FX_MAX_PARTICLE_LIFE_MS, so nothing a
 * burst leaves behind outlives the tail the runner allows (R200).
 *
 * Two optional looks ride on a preset. `stretch` draws a fast particle as a streak along its
 * velocity instead of a dot, which is what makes an impact's sparks and a shattering shield read as
 * flying debris. `flash` gives every burst of the preset a short bright bloom at its origin (the
 * white-hot pop of a hit, the violet flare of a trap going off, the gold flare of a Legendary); the
 * director asks canvasFx for it when the burst fires, and it lives FLASH ms at most, well inside the
 * tail.
 */
import type { FxPreset } from "./types.ts";

export type ParticlePresetSpec = {
  /** ms, max ≤ FX_MAX_PARTICLE_LIFE_MS */
  life: readonly [number, number];
  /** CSS px per second */
  speed: readonly [number, number];
  /** CSS px diameter */
  size: readonly [number, number];
  /** px/s², negative rises */
  gravity: number;
  /** fraction of velocity lost per second, 0..1 */
  drag: number;
  /** max radians per second */
  spin: number;
  blend: "lighter" | "source-over";
  /** CSS colours the sprites are drawn in */
  colors: readonly string[];
  /** size eases to 0 over life */
  shrink: boolean;
  /** Streak length per 1000 px/s of speed (0 or absent: a round dot). See particles.ts STREAK. */
  stretch?: number;
  /** Drawn turned by its own rotation (a paper scrap twirling), rather than squashed by it. */
  twirl?: boolean;
  /** A bloom painted at the origin of every burst of this preset (canvasFx.flash). */
  flash?: FlashSpec;
};

/**
 * `scale` sizes the bloom against the anchor box (its shorter side), and `ms` is how long it lives.
 * `core` is the hot centre, `color` the halo it cools to.
 */
export type FlashSpec = { core: string; color: string; scale: number; ms: number };

export const PARTICLE_PRESETS: { readonly [P in FxPreset]: ParticlePresetSpec } = {
  fire: {
    life: [320, 700],
    speed: [40, 150],
    size: [12, 30],
    gravity: -240,
    drag: 0.6,
    spin: 0,
    blend: "lighter",
    colors: ["#fff3b0", "#ffc04d", "#ff7a1a", "#e8401c"],
    shrink: true,
    flash: { core: "#fff6d6", color: "#ff7a1a", scale: 0.9, ms: 220 },
  },
  ember: {
    life: [500, 900],
    speed: [30, 150],
    size: [3, 7],
    gravity: -130,
    drag: 0.35,
    spin: 3,
    blend: "source-over",
    colors: ["#ffe08a", "#ff9a2e", "#ff5a1f"],
    shrink: true,
    stretch: 1.6,
  },
  holy: {
    life: [450, 850],
    speed: [20, 90],
    size: [10, 22],
    gravity: -150,
    drag: 0.5,
    spin: 0,
    blend: "lighter",
    colors: ["#fffbe6", "#ffec9e", "#ffd24a"],
    shrink: true,
    flash: { core: "#fffdf2", color: "#ffe28a", scale: 1.1, ms: 300 },
  },
  sparkle: {
    life: [350, 750],
    speed: [40, 170],
    size: [3, 8],
    gravity: -60,
    drag: 0.8,
    spin: 6,
    blend: "lighter",
    colors: ["#ffffff", "#fff6c8", "#c4f6ff"],
    shrink: true,
  },
  arcane: {
    life: [400, 800],
    speed: [50, 180],
    size: [5, 14],
    gravity: -40,
    drag: 0.85,
    spin: 4,
    blend: "lighter",
    colors: ["#ecd6ff", "#b784ff", "#7c52ff", "#63d2ff"],
    shrink: true,
    flash: { core: "#f6ecff", color: "#9d6bff", scale: 0.85, ms: 240 },
  },
  poison: {
    life: [500, 900],
    speed: [15, 70],
    size: [14, 32],
    gravity: -30,
    drag: 0.7,
    spin: 1,
    blend: "source-over",
    colors: ["#86dd6e", "#4fae4a", "#8a5cc2"],
    shrink: false,
  },
  smoke: {
    life: [550, 900],
    speed: [15, 70],
    size: [24, 52],
    gravity: -50,
    drag: 0.8,
    spin: 1.5,
    blend: "source-over",
    colors: ["#8c8c94", "#6d6d75", "#acacb3"],
    shrink: false,
  },
  dust: {
    life: [380, 780],
    speed: [70, 240],
    size: [14, 34],
    gravity: 60,
    drag: 0.92,
    spin: 1,
    blend: "source-over",
    colors: ["#d8c6a2", "#b39c77", "#efe2c6"],
    shrink: false,
  },
  shard: {
    life: [400, 800],
    speed: [120, 320],
    size: [4, 10],
    gravity: 420,
    drag: 0.4,
    spin: 12,
    blend: "source-over",
    colors: ["#fff7d1", "#ffd966", "#e8b923"],
    shrink: true,
    stretch: 2.2,
  },
  spark: {
    life: [180, 420],
    speed: [240, 560],
    size: [4, 9],
    gravity: 320,
    drag: 0.85,
    spin: 0,
    blend: "lighter",
    colors: ["#ffffff", "#fff0c0", "#ffb070", "#ff7a3d"],
    shrink: true,
    stretch: 6,
    flash: { core: "#ffffff", color: "#ffa347", scale: 1, ms: 200 },
  },
  gold: {
    life: [450, 850],
    speed: [60, 200],
    size: [4, 10],
    gravity: -40,
    drag: 0.6,
    spin: 5,
    blend: "lighter",
    colors: ["#fff4c2", "#ffd54a", "#e0a800"],
    shrink: true,
    flash: { core: "#fffbe8", color: "#ffc83d", scale: 1.2, ms: 280 },
  },
  prismatic: {
    life: [450, 850],
    speed: [60, 220],
    size: [4, 11],
    gravity: -30,
    drag: 0.6,
    spin: 6,
    blend: "lighter",
    colors: ["#ff7aa8", "#ffd36b", "#7dffb2", "#6bc7ff", "#c28bff"],
    shrink: true,
    flash: { core: "#ffffff", color: "#c9a4ff", scale: 1.2, ms: 280 },
  },
  void: {
    life: [450, 850],
    speed: [20, 90],
    size: [10, 24],
    gravity: 60,
    drag: 0.7,
    spin: 2,
    blend: "source-over",
    colors: ["#7a48b4", "#3d1f66", "#a26bff"],
    shrink: true,
  },
  confetti: {
    life: [600, 900],
    speed: [200, 480],
    size: [6, 11],
    gravity: 380,
    drag: 0.6,
    spin: 10,
    blend: "source-over",
    colors: ["#ff5c7a", "#ffd24a", "#5fe0a0", "#5fb6ff", "#c07bff"],
    shrink: false,
    twirl: true,
  },
};

/** Every preset in a fixed order: the particle pool stores a preset as its index here. */
export const PRESET_ORDER: readonly FxPreset[] = [
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

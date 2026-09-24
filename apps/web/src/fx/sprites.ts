/**
 * Procedural particle sprites (docs/polish/1-animations.md, S5). Each sprite is a radial-gradient disc
 * painted once into a small offscreen canvas per (preset, colour, dpr) and reused for every particle
 * after that, which is the cheap way to draw soft glowing dots (MDN, "Optimizing canvas"). There are
 * no image assets: every look is a gradient drawn here.
 */
import { PARTICLE_PRESETS } from "./presets.ts";
import { isHeadlessDom } from "./surface.ts";
import type { FxPreset } from "./types.ts";

export type SpriteSurface = { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D };
export type SpriteCanvasFactory = (sizePx: number) => SpriteSurface | null;

export type SpriteCache = {
  /** A radial-gradient disc for (preset, colour index, dpr), drawn once and cached; null without a 2D context. */
  get(preset: FxPreset, colorIndex: number, dpr: number): CanvasImageSource | null;
  size(): number;
  clear(): void;
};

/** CSS px diameter a sprite is painted at; particles scale it to their own size when drawn. */
const SPRITE_BASE_PX = 48;

type SpriteStyle = "glow" | "soft" | "hard" | "paper";

/**
 * How each preset's disc falls off. Glow has a hot white core, soft is a faint puff, hard a solid
 * dot. Paper is not a disc at all: a small flat rectangle with a lit edge, which the particle
 * system's tumble squash turns into a spinning scrap of confetti.
 */
const SPRITE_STYLE: { readonly [P in FxPreset]: SpriteStyle } = {
  fire: "glow",
  ember: "hard",
  holy: "glow",
  sparkle: "glow",
  arcane: "glow",
  poison: "soft",
  smoke: "soft",
  dust: "soft",
  shard: "hard",
  spark: "glow",
  gold: "glow",
  prismatic: "glow",
  void: "soft",
  confetti: "paper",
};

/** The paper scrap, as fractions of the sprite: its width, its height, and the lit band along its top. */
const PAPER = { width: 0.86, height: 0.5, lit: 0.35, litWhiten: 0.45 } as const;

/** Gradient stops per disc style: [offset along the radius, alpha, how far the colour is mixed toward white]. */
const GRADIENT_STOPS: { readonly [S in Exclude<SpriteStyle, "paper">]: ReadonlyArray<readonly [number, number, number]> } = {
  glow: [
    [0, 1, 0.65],
    [0.2, 1, 0.2],
    [0.45, 0.5, 0],
    [1, 0, 0],
  ],
  soft: [
    [0, 0.72, 0.12],
    [0.4, 0.46, 0],
    [0.75, 0.16, 0],
    [1, 0, 0],
  ],
  hard: [
    [0, 1, 0.25],
    [0.55, 0.92, 0],
    [0.8, 0.35, 0],
    [1, 0, 0],
  ],
};

const HEX_RADIX = 16;
const CHANNEL_MAX = 255;
const WHITE: readonly [number, number, number] = [CHANNEL_MAX, CHANNEL_MAX, CHANNEL_MAX];

function parseHex(color: string): readonly [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return WHITE;
  const n = Number.parseInt(m[1]!, HEX_RADIX);
  return [(n >> 16) & CHANNEL_MAX, (n >> 8) & CHANNEL_MAX, n & CHANNEL_MAX];
}

function rgba(rgb: readonly [number, number, number], alpha: number, whiten: number): string {
  const mix = (c: number) => Math.round(c + (CHANNEL_MAX - c) * whiten);
  return `rgba(${mix(rgb[0])}, ${mix(rgb[1])}, ${mix(rgb[2])}, ${alpha})`;
}

/** Real document canvases; returns a factory that yields null under jsdom (isHeadlessDom). */
export function domSpriteCanvas(doc?: Document): SpriteCanvasFactory {
  return (sizePx) => {
    const d = doc ?? document;
    const view = d.defaultView ?? undefined;
    if (isHeadlessDom(view)) return null;
    const canvas = d.createElement("canvas");
    canvas.width = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext("2d");
    return ctx ? { canvas, ctx } : null;
  };
}

function paintSprite(ctx: CanvasRenderingContext2D, preset: FxPreset, color: string, sizePx: number): void {
  const r = sizePx / 2;
  const rgb = parseHex(color);
  const style = SPRITE_STYLE[preset];
  ctx.clearRect(0, 0, sizePx, sizePx);
  if (style === "paper") {
    const w = sizePx * PAPER.width;
    const h = sizePx * PAPER.height;
    const x = (sizePx - w) / 2;
    const y = (sizePx - h) / 2;
    ctx.fillStyle = rgba(rgb, 1, 0);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = rgba(rgb, 1, PAPER.litWhiten);
    ctx.fillRect(x, y, w, h * PAPER.lit);
    return;
  }
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  for (const [offset, alpha, whiten] of GRADIENT_STOPS[style]) {
    gradient.addColorStop(offset, rgba(rgb, alpha, whiten));
  }
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
}

export function createSpriteCache(factory: SpriteCanvasFactory): SpriteCache {
  const sprites = new Map<string, CanvasImageSource>();

  return {
    get(preset, colorIndex, dpr) {
      const colors = PARTICLE_PRESETS[preset].colors;
      const count = colors.length;
      const index = ((Math.floor(colorIndex) % count) + count) % count;
      const key = `${preset}|${index}|${dpr}`;
      const hit = sprites.get(key);
      if (hit) return hit;

      const sizePx = Math.ceil(SPRITE_BASE_PX * dpr);
      const surface = factory(sizePx);
      if (!surface) return null;
      paintSprite(surface.ctx, preset, colors[index] ?? "#ffffff", sizePx);
      sprites.set(key, surface.canvas);
      return surface.canvas;
    },
    size: () => sprites.size,
    clear: () => sprites.clear(),
  };
}

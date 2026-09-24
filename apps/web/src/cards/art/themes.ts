// Which picture a card gets (docs/polish/6-cards.md, Surface A). The theme comes from the card's
// tags, then its Token tag, then its type, and sets the palette, the emblem and the motes. The
// composition comes from the type alone and sets the geometry. Both are presentation only: no
// rule reads them (CLAUDE.md rule 7).

import type { CardType, Tag } from "@jackioh/shared";

import type { EmblemGlyph } from "./emblems.ts";

export type ArtThemeId =
  | "human" | "felinor" | "ky" | "cn" | "fruit" | "chaos" | "quickdraw" | "token"
  | "unit" | "spell" | "field-spell" | "trap" | "field-trap";

export type Composition = "figure" | "burst" | "landscape" | "sigil";

export type ThemePalette = {
  /** Top and bottom of the sky gradient. */
  sky: readonly [string, string];
  /** Far, mid and near layers, lightest to darkest. */
  ridges: readonly [string, string, string];
  glow: string;
  emblem: { glyph: EmblemGlyph; fill: string; stroke: string };
  mote: string;
};

/** First match wins; Token and the type themes come after every tag here. */
const TAG_THEMES: readonly (readonly [Tag, ArtThemeId])[] = [
  ["Call to Chaos", "chaos"],
  ["CN", "cn"],
  ["KY", "ky"],
  ["Felinor", "felinor"],
  ["Fruit", "fruit"],
  ["Quickdraw", "quickdraw"],
  ["Human", "human"],
];

const TYPE_THEMES: Readonly<Record<CardType, ArtThemeId>> = {
  Unit: "unit",
  Spell: "spell",
  "Field Spell": "field-spell",
  Trap: "trap",
  "Field Trap": "field-trap",
};

const TYPE_COMPOSITIONS: Readonly<Record<CardType, Composition>> = {
  Unit: "figure",
  Spell: "burst",
  "Field Spell": "landscape",
  Trap: "sigil",
  "Field Trap": "sigil",
};

export function themeFor(tags: readonly Tag[], type: CardType): ArtThemeId {
  for (const [tag, theme] of TAG_THEMES) {
    if (tags.includes(tag)) return theme;
  }
  if (tags.includes("Token")) return "token";
  return TYPE_THEMES[type];
}

export function compositionFor(type: CardType): Composition {
  return TYPE_COMPOSITIONS[type];
}

export const THEME_PALETTES: Readonly<Record<ArtThemeId, ThemePalette>> = {
  human: {
    sky: ["#3d5288", "#0f1729"],
    ridges: ["#46598a", "#27355a", "#0a1020"],
    glow: "#b9d3ff",
    emblem: { glyph: "shield", fill: "#e3ebf8", stroke: "#1b2745" },
    mote: "#d6e5ff",
  },
  felinor: {
    sky: ["#7a3f66", "#1d0c1b"],
    ridges: ["#7d4a70", "#4a2645", "#160914"],
    glow: "#ffc9a8",
    emblem: { glyph: "cat", fill: "#f3c56e", stroke: "#3b1734" },
    mote: "#ffd9ec",
  },
  ky: {
    sky: ["#1f6b6c", "#07191b"],
    ridges: ["#2c7470", "#174745", "#061413"],
    glow: "#9af7e2",
    emblem: { glyph: "book", fill: "#effbf5", stroke: "#0f3b37" },
    mote: "#c1fff1",
  },
  cn: {
    sky: ["#2f6b1e", "#081506"],
    ridges: ["#3d6e25", "#214114", "#081205"],
    glow: "#c0ff55",
    emblem: { glyph: "virus", fill: "#cfff72", stroke: "#1b3809" },
    mote: "#e2ffa6",
  },
  fruit: {
    sky: ["#9a4a1e", "#2a0f06"],
    ridges: ["#8e4c26", "#5a2a13", "#1c0a05"],
    glow: "#ffc080",
    emblem: { glyph: "fruit", fill: "#e2513f", stroke: "#3d0f08" },
    mote: "#ffe2ad",
  },
  chaos: {
    sky: ["#4a0f5e", "#0b0211"],
    ridges: ["#5a1f6b", "#35103f", "#0e0312"],
    glow: "#ec4dff",
    emblem: { glyph: "vortex", fill: "#f7b0ff", stroke: "#2a0636" },
    mote: "#fbc4ff",
  },
  quickdraw: {
    sky: ["#6a3522", "#180b07"],
    ridges: ["#6e4030", "#43241a", "#140906"],
    glow: "#86e6ff",
    emblem: { glyph: "bolt", fill: "#b4f3ff", stroke: "#10343d" },
    mote: "#d2f8ff",
  },
  token: {
    sky: ["#626876", "#1b1d23"],
    ridges: ["#6a707d", "#3e424c", "#131418"],
    glow: "#eef1f8",
    emblem: { glyph: "coin", fill: "#dde1ea", stroke: "#2b2f39" },
    mote: "#f4f6fb",
  },
  unit: {
    sky: ["#5c4a3a", "#16110c"],
    ridges: ["#614e3d", "#3b2e23", "#120d09"],
    glow: "#ffd3a0",
    emblem: { glyph: "sword", fill: "#ccd4de", stroke: "#231b13" },
    mote: "#ffe6c8",
  },
  spell: {
    sky: ["#303a92", "#0a0b26"],
    ridges: ["#3b4596", "#232a63", "#090b20"],
    glow: "#96adff",
    emblem: { glyph: "star", fill: "#eef2ff", stroke: "#1b2160" },
    mote: "#cfd9ff",
  },
  "field-spell": {
    sky: ["#2a4a7a", "#d08a4c"],
    ridges: ["#56607e", "#2f3550", "#0e1020"],
    glow: "#ffe2a6",
    emblem: { glyph: "tower", fill: "#fff4dc", stroke: "#2a2440" },
    mote: "#fff0d0",
  },
  trap: {
    sky: ["#7a1818", "#1b0404"],
    ridges: ["#7a2a24", "#4a1512", "#160403"],
    glow: "#ff7a52",
    emblem: { glyph: "eye", fill: "#ffd9bf", stroke: "#3a0806" },
    mote: "#ffb9a0",
  },
  "field-trap": {
    sky: ["#2c1d42", "#07040d"],
    ridges: ["#3f2d5a", "#241838", "#09060f"],
    glow: "#8cffc6",
    emblem: { glyph: "rune", fill: "#b8ffd9", stroke: "#12301f" },
    mote: "#c9ffe2",
  },
};

/**
 * The glyphs a theme's emblem is picked from, per card. The first is the theme's signature and is
 * listed twice where the theme is an identity (a Felinor should mostly read as a cat), so a grid
 * of one type or one tribe does not print the same picture a hundred times.
 */
export const EMBLEM_POOLS: Readonly<Record<ArtThemeId, readonly EmblemGlyph[]>> = {
  human: ["shield", "shield", "sword", "tower", "crown", "star", "flame"],
  felinor: ["cat", "cat", "cat", "moon", "star", "crown"],
  ky: ["book", "book", "rune", "hourglass", "eye", "crystal", "star"],
  cn: ["virus", "virus", "eye", "flame"],
  fruit: ["fruit", "fruit", "fruit", "crystal"],
  chaos: ["vortex", "vortex", "eye", "flame", "moon"],
  quickdraw: ["bolt", "bolt", "hourglass", "sword", "star"],
  token: ["coin", "coin", "crystal", "star"],
  // The type themes draw only from glyphs no tribe signs with (no cat, book, virus, fruit, vortex,
  // bolt or coin), so an untagged card never passes for a tribe's.
  unit: ["sword", "tower", "eye", "crown", "flame", "shield", "moon"],
  spell: ["star", "flame", "moon", "crystal", "hourglass", "rune", "eye"],
  "field-spell": ["tower", "star", "moon", "crystal", "crown"],
  trap: ["eye", "rune", "flame", "hourglass", "sword"],
  "field-trap": ["rune", "eye", "moon", "tower", "crystal"],
};

/**
 * How far, in degrees either way, a card's palette may turn around the colour wheel. The type
 * themes turn furthest, since nothing else tells two plain Spells apart; the tribes turn far enough
 * that two of them rarely share a colour, but stay recognisable; tokens stay grey.
 */
export const HUE_DRIFT: Readonly<Record<ArtThemeId, number>> = {
  human: 28,
  felinor: 26,
  ky: 26,
  cn: 22,
  fruit: 24,
  chaos: 28,
  quickdraw: 26,
  token: 0,
  unit: 34,
  spell: 38,
  "field-spell": 34,
  trap: 26,
  "field-trap": 32,
};

const HEX_CHANNEL_MAX = 255;
const HUE_TURN = 360;
const HUE_SEXTANT = 60;

/** Turns a `#rrggbb` colour `degrees` around the hue wheel, keeping its saturation and lightness. */
export function turnHue(hex: string, degrees: number): string {
  if (degrees === 0) return hex;
  const channel = (index: number): number => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / HEX_CHANNEL_MAX;
  const r = channel(0);
  const g = channel(1);
  const b = channel(2);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma === 0) return hex;
  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / chroma) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  hue = (((hue * HUE_SEXTANT + degrees) % HUE_TURN) + HUE_TURN) % HUE_TURN;

  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((hue / HUE_SEXTANT) % 2) - 1));
  const m = lightness - c / 2;
  const sextant = Math.floor(hue / HUE_SEXTANT);
  const [r1, g1, b1] =
    sextant === 0 ? [c, x, 0] : sextant === 1 ? [x, c, 0] : sextant === 2 ? [0, c, x] : sextant === 3 ? [0, x, c] : sextant === 4 ? [x, 0, c] : [c, 0, x];
  let out = "#";
  for (const value of [r1, g1, b1]) {
    const byte = Math.max(0, Math.min(HEX_CHANNEL_MAX, Math.round((value + m) * HEX_CHANNEL_MAX)));
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** A theme palette with every colour turned by `degrees`, and its emblem swapped for `glyph`. */
export function driftPalette(palette: ThemePalette, degrees: number, glyph: EmblemGlyph): ThemePalette {
  const turn = (hex: string): string => turnHue(hex, degrees);
  return {
    sky: [turn(palette.sky[0]), turn(palette.sky[1])],
    ridges: [turn(palette.ridges[0]), turn(palette.ridges[1]), turn(palette.ridges[2])],
    glow: turn(palette.glow),
    emblem: { glyph, fill: turn(palette.emblem.fill), stroke: turn(palette.emblem.stroke) },
    mote: turn(palette.mote),
  };
}

/**
 * The Radiant face's gold. A radiant spec mixes each base colour this far toward its gold
 * counterpart, so the theme still shows through the foil.
 */
export const RADIANT_MIX = 0.7;

export const RADIANT_PALETTE = {
  sky: ["#b07a1c", "#2e1a04"],
  ridges: ["#c08a2a", "#7a5010", "#2a1703"],
  glow: "#ffe389",
  emblem: { fill: "#ffe07a", stroke: "#6b3f00" },
  mote: "#fff4c2",
  ray: "#fff1b0",
} as const;

/** Mixes two `#rrggbb` colours: `t = 0` gives `from`, `t = 1` gives `to`. */
export function mixHex(from: string, to: string, t: number): string {
  const channel = (hex: string, index: number): number => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  let out = "#";
  for (let index = 0; index < 3; index += 1) {
    const a = channel(from, index);
    const b = channel(to, index);
    const value = Math.max(0, Math.min(255, Math.round(a + (b - a) * t)));
    out += value.toString(16).padStart(2, "0");
  }
  return out;
}

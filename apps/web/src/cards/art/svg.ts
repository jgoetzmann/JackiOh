// Prints an `ArtSpec` as a `data:image/svg+xml,…` URI (docs/polish/6-cards.md, Surface A, B3).
//
// The document is one <svg viewBox="0 0 100 100"> with no <text>, no <title> and no external
// reference: the only `url(…)`s point at gradients defined inside it, and nothing uses `href`.
// It is percent-encoded in full, parentheses and quotes included, so it can sit inside a CSS
// `url("…")` in any browser and in jsdom's style parser.

import { EMBLEM_BOX, EMBLEMS } from "./emblems.ts";
import { fmt } from "./hash.ts";
import { artSpec, ART_BOX, type ArtSpec } from "./procedural.ts";
import { RADIANT_PALETTE, type ArtThemeId, type Composition } from "./themes.ts";

const DATA_PREFIX = "data:image/svg+xml,";
/** Rays reach past every corner of the box from anywhere inside it. */
const RAY_LENGTH = 150;
const EMBLEM_STROKE_WIDTH = 1.1;
/** The glow's gradient keeps this share of its opacity at its midpoint. */
const GLOW_MID_STOP = 0.45;
const VIGNETTE_RADIUS = 72;
const VIGNETTE_START = 0.6;
const VIGNETTE_OPACITY = 0.5;
const DEGREES = Math.PI / 180;

/** The procedural-art memo is cleared once it would pass this many entries. */
const ART_CACHE_MAX = 512;

/** The accent glyph is quieter than the emblem. */
const ACCENT_OPACITY = 0.8;

/** One glyph from EMBLEMS, placed, turned and scaled into the box. */
function glyphMarkup(placed: NonNullable<ArtSpec["accent"]>, opacity: number): string {
  const glyph = EMBLEMS[placed.glyph];
  const scale = placed.size / EMBLEM_BOX;
  const centre = EMBLEM_BOX / 2;
  const fade = opacity === 1 ? "" : ` opacity="${fmt(opacity)}"`;
  return (
    `<g transform="translate(${fmt(placed.x)} ${fmt(placed.y)}) rotate(${fmt(placed.rotate)}) ` +
    `scale(${fmt(scale)}) translate(-${centre} -${centre})"${fade}>` +
    `<path d="${glyph.d}" fill="${placed.fill}" stroke="${placed.stroke}" stroke-width="${EMBLEM_STROKE_WIDTH}" ` +
    `stroke-linejoin="round" fill-rule="${glyph.rule}"/></g>`
  );
}

function rayPath(cx: number, cy: number, angle: number, width: number): string {
  const a = (angle - width / 2) * DEGREES;
  const b = (angle + width / 2) * DEGREES;
  return (
    `M${fmt(cx)} ${fmt(cy)}` +
    `L${fmt(cx + RAY_LENGTH * Math.cos(a))} ${fmt(cy + RAY_LENGTH * Math.sin(a))}` +
    `L${fmt(cx + RAY_LENGTH * Math.cos(b))} ${fmt(cy + RAY_LENGTH * Math.sin(b))}Z`
  );
}

/** The SVG document, unencoded. */
function artSvg(spec: ArtSpec): string {
  const { sky, glow, emblem } = spec;
  const half = ART_BOX / 2;
  const angle = sky.angle * DEGREES;
  const dx = Math.sin(angle) * half;
  const dy = -Math.cos(angle) * half;
  const parts: string[] = [];

  parts.push(
    `<svg viewBox="0 0 ${ART_BOX} ${ART_BOX}" width="${ART_BOX}" height="${ART_BOX}" ` +
      `xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">`,
  );
  parts.push("<defs>");
  parts.push(
    `<linearGradient id="s" gradientUnits="userSpaceOnUse" x1="${fmt(half - dx)}" y1="${fmt(half - dy)}" ` +
      `x2="${fmt(half + dx)}" y2="${fmt(half + dy)}">` +
      `<stop offset="0" stop-color="${sky.from}"/><stop offset="1" stop-color="${sky.to}"/></linearGradient>`,
  );
  parts.push(
    `<radialGradient id="g">` +
      `<stop offset="0" stop-color="${glow.color}" stop-opacity="${fmt(glow.opacity)}"/>` +
      `<stop offset="${GLOW_MID_STOP}" stop-color="${glow.color}" stop-opacity="${fmt(glow.opacity * GLOW_MID_STOP)}"/>` +
      `<stop offset="1" stop-color="${glow.color}" stop-opacity="0"/></radialGradient>`,
  );
  parts.push(
    `<radialGradient id="v" gradientUnits="userSpaceOnUse" cx="${half}" cy="${half}" r="${VIGNETTE_RADIUS}">` +
      `<stop offset="${VIGNETTE_START}" stop-color="#000" stop-opacity="0"/>` +
      `<stop offset="1" stop-color="#000" stop-opacity="${VIGNETTE_OPACITY}"/></radialGradient>`,
  );
  parts.push("</defs>");

  parts.push(`<rect width="${ART_BOX}" height="${ART_BOX}" fill="url(#s)"/>`);
  parts.push(`<circle cx="${fmt(glow.cx)}" cy="${fmt(glow.cy)}" r="${fmt(glow.r)}" fill="url(#g)"/>`);

  if (spec.rays.length > 0) {
    parts.push(`<g fill="${RADIANT_PALETTE.ray}">`);
    for (const ray of spec.rays) {
      parts.push(`<path d="${rayPath(glow.cx, glow.cy, ray.angle, ray.width)}" opacity="${fmt(ray.opacity)}"/>`);
    }
    parts.push("</g>");
  }

  for (const ridge of spec.ridges) {
    parts.push(`<path d="${ridge.d}" fill="${ridge.fill}" opacity="${fmt(ridge.opacity)}" fill-rule="evenodd"/>`);
  }

  parts.push(glyphMarkup(emblem, 1));
  if (spec.accent !== null) parts.push(glyphMarkup(spec.accent, ACCENT_OPACITY));

  for (const mote of spec.motes) {
    parts.push(
      `<circle cx="${fmt(mote.x)}" cy="${fmt(mote.y)}" r="${fmt(mote.r)}" fill="${mote.fill}" opacity="${fmt(mote.opacity)}"/>`,
    );
  }

  parts.push(`<rect width="${ART_BOX}" height="${ART_BOX}" fill="url(#v)"/>`);
  parts.push("</svg>");
  return parts.join("");
}

/** encodeURIComponent, plus the five characters it leaves alone that CSS or jsdom may choke on. */
function encodeSvg(svg: string): string {
  return encodeURIComponent(svg).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `data:image/svg+xml,…`: one <svg viewBox="0 0 100 100">, no <text>, no <title>, no external refs. */
export function artDataUri(spec: ArtSpec): string {
  return `${DATA_PREFIX}${encodeSvg(artSvg(spec))}`;
}

// The memo behind `CardArt`: keyed `${defId}|${radiant}|${composition}`, as the Surface fixes.
// Transient `t-<n>` defs can be minted without bound, so the map is cleared rather than grown.
const proceduralCache = new Map<string, string>();

export function proceduralArtUri(defId: string, theme: ArtThemeId, composition: Composition, radiant: boolean): string {
  const key = `${defId}|${radiant}|${composition}`;
  const hit = proceduralCache.get(key);
  if (hit !== undefined) return hit;
  if (proceduralCache.size >= ART_CACHE_MAX) proceduralCache.clear();
  const uri = artDataUri(artSpec(defId, theme, composition, radiant));
  proceduralCache.set(key, uri);
  return uri;
}

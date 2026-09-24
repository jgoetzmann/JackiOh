// The art slice's public surface (docs/polish/6-cards.md, Surface A). Code inside
// `apps/web/src/cards/` imports the file it needs by path; code outside `cards/` goes through
// `cards/index.ts`, which re-exports the pieces it needs from here.

export type { ArtThemeId, Composition } from "./themes.ts";
export { compositionFor, themeFor } from "./themes.ts";
export type { EmblemGlyph } from "./emblems.ts";
export type { ArtSpec } from "./procedural.ts";
export { artSpec } from "./procedural.ts";
export { hashId, seededRandom } from "./hash.ts";
export { artDataUri } from "./svg.ts";
export type { ArtManifest } from "./manifest.ts";
export { ART_MANIFEST, artUrl } from "./manifest.ts";
export type { ArtShape, CardArtProps } from "./CardArt.tsx";
export { CardArt } from "./CardArt.tsx";

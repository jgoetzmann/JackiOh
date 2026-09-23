// Which cards have real art (docs/polish/6-cards.md, Surface A, B5).
//
// Real art lands later as `apps/web/public/art/<id>.webp` and `<id>-radiant.webp`. The client
// asks for a file only when this manifest lists it, so a card without art never costs a request
// and the board never fires a storm of 404s. Until an artist delivers, every card is procedural.
//
// To add art: drop the file(s) in `apps/web/public/art/`, then add a line here, for example
//   "core-002": { base: true, radiant: true },
// A radiant face whose own file is missing shows the base file under a gold tint.

export type ArtManifest = Readonly<Record<string, { readonly base?: true; readonly radiant?: true }>>;

/** Which ids have real art in apps/web/public/art/. Ships empty. */
export const ART_MANIFEST: ArtManifest = {};

const ART_DIRECTORY = "art/";
const ART_EXTENSION = ".webp";
const RADIANT_SUFFIX = "-radiant";

/** `${import.meta.env.BASE_URL}art/<id>.webp` or `…/<id>-radiant.webp`; `tint` = gold overlay on base art. */
export function artUrl(
  defId: string,
  radiant: boolean,
  manifest: ArtManifest = ART_MANIFEST,
): { src: string; tint: boolean } | null {
  if (!Object.hasOwn(manifest, defId)) return null;
  const entry = manifest[defId];
  if (entry === undefined) return null;
  const root = `${import.meta.env.BASE_URL}${ART_DIRECTORY}${defId}`;
  if (radiant && entry.radiant === true) return { src: `${root}${RADIANT_SUFFIX}${ART_EXTENSION}`, tint: false };
  if (entry.base === true) return { src: `${root}${ART_EXTENSION}`, tint: radiant };
  return null;
}

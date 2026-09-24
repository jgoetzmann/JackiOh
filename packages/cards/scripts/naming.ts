/**
 * The catalog-id <-> filename convention for card scripts and card tests
 * (BUILD M4-T2 `cards/src/scripts/NNN-slug.ts`, M4-T3 `cards/test/NNN-slug.test.ts`, SPEC §10.9).
 *
 * Pure string functions, no I/O and no catalog import, so `gen-registry.ts`, `missing-tests.ts`
 * and `test/registry.test.ts` all read one copy of the rules.
 *
 * The convention, by example (the catalog id is the key of `packages/cards/catalog.json`, SPEC §5):
 *
 *   core-001    "Big D-fender"          src/scripts/001-big-d-fender.ts     test/001-big-d-fender.test.ts
 *   core-043    "Big Felinor"           src/scripts/043-big-felinor.ts      test/043-big-felinor.test.ts
 *   core-051-1  "KY's Empty Notebook"   src/scripts/051-1-kys-empty-notebook.ts
 *   core-090-1  "CN-Virus"              src/scripts/090-1-cn-virus.ts
 *   core-t-rush "Rush Token"            src/scripts/t-rush.ts               test/t-rush.test.ts
 *   core-t-coin "The Coin"              src/scripts/t-coin.ts               test/t-coin.test.ts
 *
 * So a basename is `<prefix>-<slug>`, where the prefix is the id minus its set segment, except for
 * the named tokens of SPEC §7 — the four shared ones and The Coin — which are filed under the bare
 * prefix (`t-rush`, `t-coin`).
 */

/** Every shipped id is `<set>-<prefix>`; SPEC §5 ships only the Core set. */
const SET_SEGMENT_SEPARATOR = "-";

/**
 * The filename prefix of a catalog id: the id minus its leading set segment.
 * `core-001` -> `001`, `core-051-1` -> `051-1`, `core-t-rush` -> `t-rush`.
 */
export function slugPrefixOf(id: string): string {
  const cut = id.indexOf(SET_SEGMENT_SEPARATOR);
  if (cut <= 0 || cut === id.length - 1) {
    throw new Error(`"${id}" is not a catalog id (expected "<set>-<prefix>", e.g. "core-043")`);
  }
  return id.slice(cut + 1);
}

/** `051-1` and `t-rush` are token prefixes; `051` is a card prefix. Nothing nests deeper. */
export function isTokenPrefix(prefix: string): boolean {
  return /^t-/.test(prefix) || /^\d+-\d+$/.test(prefix);
}

/** SPEC §7's named tokens (the four shared ones and The Coin), filed under the bare prefix (`t-rush.ts`). */
export function isSharedTokenPrefix(prefix: string): boolean {
  return /^t-/.test(prefix);
}

/**
 * A card name as a filename slug: lowercase, apostrophes dropped, every other run of
 * non-alphanumerics collapsed to one `-`.
 *
 * Checked against every §8 name, so: "Big D-fender" -> `big-d-fender`, "KY's Empty Notebook" ->
 * `kys-empty-notebook` (the apostrophe vanishes rather than becoming a dash), "CN-Virus" ->
 * `cn-virus`, "/fullsend" -> `fullsend`, "Call to Chaos (Core Edition)" ->
 * `call-to-chaos-core-edition`, `"Miss" Mrow` -> `miss-mrow`, "4-mana 7/7" -> `4-mana-7-7`.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The canonical basename (no extension) for a catalog entry: what `gen-registry.ts` expects to
 * import and what `missing-tests.ts` prints as the file a card still needs.
 */
export function expectedBasename(id: string, name: string): string {
  const prefix = slugPrefixOf(id);
  // SPEC §7's shared tokens are one word already ("Rush Token" under `t-rush`), so the prefix is
  // the whole filename; anything else carries its slug.
  if (isSharedTokenPrefix(prefix)) return prefix;
  return `${prefix}-${slugify(name)}`;
}

/** `001-big-d-fender.ts` -> `001-big-d-fender`; also strips `.test.ts`. */
export function basenameOf(filename: string): string {
  return filename.replace(/\.test\.ts$/, "").replace(/\.ts$/, "");
}

/**
 * Whether `basename` (no extension) is the file of catalog id `id`.
 *
 * The slug itself is not checked: the prefix decides which card a file belongs to, so a misspelled
 * slug still lands on the right card (and `expectedBasename` is what reports the misspelling).
 * The one hard case is the prefix boundary: `051-1-kys-empty-notebook` belongs to `core-051-1`
 * (KY's Empty Notebook) and must NOT be read as a slug of `core-051` (KY's Private Tutor).
 *
 * With `allIds` (every catalog id) the answer is exact: the longest id prefix the basename carries
 * wins, which is what `gen-registry.ts` and `missing-tests.ts` pass. Without it the rule is the
 * documented heuristic "a lone digit segment right after a card prefix is a token sub-index", which
 * is right for every shipped id except #25 "4-mana 7/7", whose slug itself opens with a digit
 * segment (`025-4-mana-7-7`) — pass `allIds` when the exact answer matters.
 */
export function matchesCard(basename: string, id: string, allIds?: readonly string[]): boolean {
  if (allIds !== undefined) return resolveBasename(basename, allIds) === id;

  const prefix = slugPrefixOf(id);
  if (basename === prefix) return true; // the slugless form: `t-rush.ts`
  if (!basename.startsWith(`${prefix}-`)) return false;
  const rest = basename.slice(prefix.length + 1);
  if (rest === "") return false;
  if (isTokenPrefix(prefix)) return true; // a token id has no sub-token, so the rest is a slug
  return !/^\d(-|$)/.test(rest);
}

/**
 * Which catalog id a basename belongs to, by longest prefix: `051-1-kys-empty-notebook` matches
 * the prefixes `051` and `051-1`, and the longer one is the card that owns the file.
 * `undefined` means the filename names no shipped card (a typo'd or unpadded prefix).
 */
export function resolveBasename(basename: string, allIds: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const id of allIds) {
    const prefix = slugPrefixOf(id);
    if (basename !== prefix && !basename.startsWith(`${prefix}-`)) continue;
    if (prefix.length > bestLength) {
      best = id;
      bestLength = prefix.length;
    }
  }
  return best;
}

/**
 * A filename prefix as a sortable number, mirroring the engine's index ranking
 * (`engine/src/catalog.ts` `indexRank`): `001` -> 1, `051-1` -> 51.1 (so a card-defined token sorts
 * straight after its card), `t-rush` -> +Infinity (SPEC §7's shared tokens sort last).
 */
export function prefixRank(prefix: string): number {
  const parts = /^(\d+)(?:-(\d+))?$/.exec(prefix);
  if (parts === null) return Number.POSITIVE_INFINITY;
  const [, main, sub] = parts;
  const rank = Number.parseFloat(sub === undefined ? `${main}` : `${main}.${sub}`);
  return Number.isFinite(rank) ? rank : Number.POSITIVE_INFINITY;
}

/**
 * The deterministic ordering both scripts use: SPEC §5 index ascending, card-defined tokens after
 * their card, shared tokens next, and anything that names no catalog card last — then the basename,
 * so the order never depends on the order the filesystem listed the directory.
 */
export function sortKey(basename: string, id: string | undefined): readonly [number, number, string] {
  const tier = id === undefined ? 1 : 0;
  const rank = id === undefined ? Number.POSITIVE_INFINITY : prefixRank(slugPrefixOf(id));
  return [tier, rank, basename];
}

/** Compares two `sortKey`s. */
export function compareSortKeys(
  a: readonly [number, number, string],
  b: readonly [number, number, string],
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1; // Infinity - Infinity is NaN, so compare, don't subtract
  if (a[2] === b[2]) return 0;
  return a[2] < b[2] ? -1 : 1;
}

/**
 * A legal, unique JS identifier for the namespace import of a script file: basenames are unique
 * within `src/scripts/`, and the `m` guard keeps `001-…` from starting an identifier with a digit.
 */
export function moduleAliasOf(basename: string): string {
  return `m${basename.replace(/[^a-zA-Z0-9]+/g, "_")}`;
}

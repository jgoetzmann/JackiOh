// The shipped catalog as data (BUILD M4-T1, M4-T2).
//
// `packages/cards/catalog.json` is the card data proved against SPEC §8 by `test/catalog.test.ts`.
// This module is the ONLY place in the repo that reads that file, so:
//   - a card script never imports JSON and never restates its own stats (`export const def =
//     cardDef("core-043")` is the contract, see README), and
//   - every `def` in the package is identical to the catalog the client and the engine see.

import type { CardDef, CardDefs } from "@jackioh/shared";
import catalogJson from "../catalog.json";

/**
 * JSON widens `type`, `rarity`, `set` and the keyword unions to `string`, so the data and the
 * `CardDef` type meet here once. `test/catalog.test.ts` (M4-T1) is what actually proves the values,
 * encoding SPEC §8 as a fixture table; this cast carries no other trust.
 */
export const CATALOG: CardDefs = catalogJson as unknown as CardDefs;

/** §9.4: the catalog version the engine registers, bumped when card data changes. */
export const CATALOG_VERSION = "core-1";

/** Every catalog id, in catalog.json order (`core-001` … `core-t-bread`). */
export const CATALOG_IDS: readonly string[] = Object.keys(CATALOG);

/** A def by catalog id. Throws rather than returning undefined: a card file names a real card. */
export function cardDef(id: string): CardDef {
  const def = CATALOG[id];
  if (def === undefined) {
    throw new Error(`no catalog entry "${id}" (packages/cards/catalog.json)`);
  }
  return def;
}

/** A def by its SPEC §5 index ("43", "51.1", "T-rush"), for tests and pools named by index. */
export function cardDefByIndex(index: string): CardDef {
  const def = Object.values(CATALOG).find((entry) => entry.index === index);
  if (def === undefined) {
    throw new Error(`no catalog entry with index "${index}" (packages/cards/catalog.json)`);
  }
  return def;
}

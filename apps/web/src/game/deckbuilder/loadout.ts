// The collection as the builder reads it, and the shelf of cards the pool offers.
//
// NO RULE LIVES HERE (CLAUDE.md rule 7). Whether a deck or a trio is legal is
// `@jackioh/validator`'s alone (SPEC §9.4, R253), called from workshop.ts; this module only turns
// `GET /api/collection` into the validator's `Collection` and lists the cards a deck could hold.

import type { CatalogSnapshot, Collection } from "@jackioh/validator";

/** `GET /api/collection`'s entries, as the validator wants them. */
export function collectionFrom(
  entries: readonly { cardId: string; quantity: number }[],
): Collection {
  const owned: Record<string, number> = {};
  for (const entry of entries) owned[entry.cardId] = entry.quantity;
  return owned;
}

/**
 * The cards offered in the pool: everything the profile owns that the catalog knows about, in
 * catalog order (every non-token card when `collection` is null). Tokens are left out because
 * R251 and L3 keep them out of every deck — the pool is a shelf of cards a deck can hold, and the
 * validator still has the last word on anything that reaches a deck by another route (an import).
 */
export function poolFrom(catalog: CatalogSnapshot, collection: Collection | null): readonly string[] {
  const ids = Object.keys(catalog.cards).filter((id) => {
    const def = catalog.cards[id];
    if (def === undefined) return false;
    if (def.token || def.tags.includes("Token")) return false;
    if (collection === null) return true;
    return (collection[id] ?? 0) > 0;
  });
  return ids.sort((a, b) => {
    const left = catalog.cards[a];
    const right = catalog.cards[b];
    const byIndex = indexOrder(left?.index) - indexOrder(right?.index);
    if (byIndex !== 0) return byIndex;
    return a.localeCompare(b);
  });
}

/** §5: `index` is "43" or "51.1"; sort by the printed number so the pool reads like SPEC §8. */
function indexOrder(index: string | undefined): number {
  if (index === undefined) return Number.POSITIVE_INFINITY;
  const parsed = Number.parseFloat(index);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

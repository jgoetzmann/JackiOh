// The deckbuilder's draft: three lists of card ids, and the moves a player can make on them.
//
// NO RULE LIVES HERE. CLAUDE.md rule 7 and SPEC §9.4 put the loadout rules in exactly one place —
// `@jackioh/validator`, "one validator module shared by client and server, at save and again at
// queue" — and §9.3 makes the client's verdict UX while the server's is law. So this module holds
// the draft and calls `validateLoadout`; it never decides whether a draft is legal and never
// writes an L1–L6 sentence. `LOADOUT_DECKS` is imported rather than restated for the same reason.
//
// The one thing it does decide is a UX refusal: a drag that would put a card in a second deck is
// not applied, because BUILD M8's row for `09-deckbuilder.cy.ts` says "a card dragged into a second
// deck is refused". That is a refusal to *create* the state L4 forbids, not a second copy of L4:
// the move is simply not made, nothing is worded, and if such a state arrives from elsewhere (a
// loadout saved before a catalog change, say) the validator's own L4 sentence is what is shown.

import {
  LOADOUT_DECKS,
  validateLoadout,
  type CatalogSnapshot,
  type Collection,
  type LoadoutError,
  type LoadoutResult,
} from "@jackioh/validator";

export { LOADOUT_DECKS };

/** Three decks of card ids, in loadout order. Deck numbers elsewhere are 1-based. */
export type Draft = readonly (readonly string[])[];

/** 1-based deck numbers, `[1, 2, 3]`. The validator labels decks the same way. */
export const DECK_NUMBERS: readonly number[] = Array.from(
  { length: LOADOUT_DECKS },
  (_unused, index) => index + 1,
);

export function emptyDraft(): Draft {
  return DECK_NUMBERS.map(() => []);
}

/**
 * The draft a saved loadout opens with. A profile that has never saved gets `loadout: null` from
 * `GET /api/loadout` (§9.4 has no "create the row first" step), which opens empty rather than as
 * an error. A stored loadout with the wrong number of decks is padded, not rejected: L1 is the
 * validator's to report, and dropping decks here would hide it.
 */
export function draftFrom(decks: readonly (readonly string[])[] | null | undefined): Draft {
  const stored = decks ?? [];
  const next: string[][] = stored.map((deck) => [...deck]);
  while (next.length < LOADOUT_DECKS) next.push([]);
  return next;
}

/** The 1-based deck holding `cardId`, or null. First match wins; L4 reports the rest. */
export function deckHolding(draft: Draft, cardId: string): number | null {
  for (const [index, deck] of draft.entries()) {
    if (deck.includes(cardId)) return index + 1;
  }
  return null;
}

export type Move =
  | { applied: true; draft: Draft }
  /** The move was not made. `heldBy` is the 1-based deck that already holds the card. */
  | { applied: false; draft: Draft; heldBy: number | null };

/**
 * Put `cardId` into deck `deck` (1-based). Refused when any deck already holds it: with
 * `MAX_COPIES = 1` a second copy is illegal wherever it lands, so the refusal covers the same deck
 * (L3) and a second one (L4) without the builder having to tell them apart.
 */
export function addCard(draft: Draft, deck: number, cardId: string): Move {
  const index = deck - 1;
  if (index < 0 || index >= draft.length) return { applied: false, draft, heldBy: null };
  const held = deckHolding(draft, cardId);
  if (held !== null) return { applied: false, draft, heldBy: held };
  const next = draft.map((cards) => [...cards]);
  next[index]?.push(cardId);
  return { applied: true, draft: next };
}

/** Take `cardId` out of deck `deck` (1-based). Removing what is not there is a no-op. */
export function removeCard(draft: Draft, deck: number, cardId: string): Move {
  const index = deck - 1;
  const cards = draft[index];
  if (cards === undefined || !cards.includes(cardId)) {
    return { applied: false, draft, heldBy: deckHolding(draft, cardId) };
  }
  const next = draft.map((deckCards) => [...deckCards]);
  const at = next[index]?.indexOf(cardId) ?? -1;
  if (at >= 0) next[index]?.splice(at, 1);
  return { applied: true, draft: next };
}

/**
 * The client's verdict (§9.3: UX; the server's is law). The decks are passed WITHOUT a `name`, so
 * the validator falls back to `Deck 1` / `Deck 2` / `Deck 3` — the labels the server's relay of the
 * same module produces, and the ones `e2e/cypress/e2e/09-deckbuilder.cy.ts` asserts.
 */
export function verdict(draft: Draft, catalog: CatalogSnapshot, collection: Collection): LoadoutResult {
  return validateLoadout({
    decks: draft.map((cards) => ({ cards })),
    catalog,
    collection,
  });
}

/** `verdict`, flattened to the list the builder renders. Empty when the draft is legal. */
export function issuesOf(
  draft: Draft,
  catalog: CatalogSnapshot,
  collection: Collection,
): readonly LoadoutError[] {
  const result = verdict(draft, catalog, collection);
  return result.ok ? [] : result.errors;
}

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
 * catalog order. Tokens are left out because L3 bans them from a deck — the pool is a shelf of
 * legal choices, and the validator still has the last word on anything that reaches a deck by
 * another route.
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

// Dev decks for the hotseat route (BUILD M5-T3): `?a=<deckId>&b=<deckId>` → a list of card ids.
//
// No card id is written down here. `packages/cards` has not shipped its defs yet, and inventing
// "core-001" would be a guess at SPEC §8 that would go stale the day the catalog lands. A
// `DeckSource` is therefore a QUERY over whatever catalog the engine hands the client
// (`EnginePort.catalog`), and every deck in the registry is derived: the day the catalog exists,
// these decks exist too, with no edit here.
//
// This module decides nothing about legality. `validateDeck` in `packages/engine/src/state.ts`
// is the authority and `createGame` throws when a deck breaks §2.6 — the checks below exist only
// so the route can print a readable sentence instead of showing a thrown stack, which is the same
// trade `e2e/support/commands.ts` makes in `asDeck`.

import type { CardCost, CardDef, CardDefs } from "@jackioh/shared";

/**
 * SPEC §2.6 L2 / L3. Re-exported from the engine's own `config` entry point rather than restated:
 * BUILD §2 keeps every rules constant in `packages/engine/src/config.ts` and says nothing else
 * spells the numbers. These used to be literals because the engine did not compile and its barrel
 * would have dragged in modules the client excludes — both now resolved, the second by the engine's
 * `"./config"` export, which reaches the constants without loading the barrel.
 */
// Imported and then re-exported, not `export … from`: this module uses both constants itself
// (`resolveDeck`, the dev decks), and a bare re-export creates no local binding.
import { DECK_SIZE, MAX_COPIES } from "@jackioh/engine/config";

export { DECK_SIZE, MAX_COPIES };

export type DeckSource = {
  id: string;
  label: string;
  /** The card ids this deck resolves to, in library order. May be shorter than `DECK_SIZE`. */
  resolve(catalog: CardDefs): string[];
};

export type ResolvedDeck = { deck: string[] } | { error: string };

/**
 * R65 read out of play: an X-cost card's printed cost is 0 and an embiggen card's is its base
 * price. `cheap20` sorts on this, so it agrees with the engine's own out-of-play cost.
 */
export function printedCost(cost: CardCost): number {
  if (typeof cost === "number") return cost;
  if (cost === "X") return 0;
  return cost.base;
}

/**
 * `validateDeck`'s Token test, mirrored: `def.token || def.tags.includes("Token")` (§2.6 L3).
 * A deck built from anything else would be refused by `createGame`.
 */
function deckable(def: CardDef): boolean {
  return !def.token && !def.tags.includes("Token");
}

/**
 * SPEC §5 index order. Indices are mostly numeric strings ("1".."100") but tokens use "51.1" and
 * "T-rush", so a numeric compare with a lexicographic fallback and an id tie-break keeps the order
 * total — a deck must resolve the same way on every run or the M5-T3 replay hash moves.
 */
export function byIndex(a: CardDef, b: CardDef): number {
  const na = Number.parseFloat(a.index);
  const nb = Number.parseFloat(b.index);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum && na !== nb) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  if (a.index !== b.index) return a.index < b.index ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function candidates(catalog: CardDefs): CardDef[] {
  return Object.values(catalog).filter(deckable).sort(byIndex);
}

/**
 * The dev decks. Both satisfy `DECK_SIZE = 20` and `MAX_COPIES = 1` by construction: they take
 * distinct definitions off a sorted list, so no id can repeat.
 */
export const DEV_DECKS: readonly DeckSource[] = [
  {
    id: "first20",
    label: "First 20 (by §5 index)",
    resolve: (catalog) =>
      candidates(catalog)
        .slice(0, DECK_SIZE)
        .map((def) => def.id),
  },
  {
    id: "cheap20",
    label: "Cheapest 20 (by printed cost)",
    resolve: (catalog) =>
      [...candidates(catalog)]
        // `candidates` is already in index order and `sort` is stable, so equal costs keep it.
        .sort((a, b) => printedCost(a.cost) - printedCost(b.cost))
        .slice(0, DECK_SIZE)
        .map((def) => def.id),
  },
];

export const DEFAULT_DECK_ID = "first20";

export const DECK_IDS: readonly string[] = DEV_DECKS.map((source) => source.id);

export function deckSource(id: string): DeckSource | undefined {
  return DEV_DECKS.find((source) => source.id === id);
}

/**
 * A readable message for a list that `validateDeck` would refuse, or `null` when it would not.
 * `size` is the seat's deck size: §2.6's DECK_SIZE, or a handicap's `deckSize` (R184).
 */
function refusal(deck: readonly string[], catalog: CardDefs, id: string, size: number): string | null {
  if (deck.length !== size) {
    return size === DECK_SIZE
      ? `deck "${id}" holds ${deck.length} cards; a deck is exactly ${DECK_SIZE} (§2.6 L2)`
      : `deck "${id}" holds ${deck.length} cards; its seat's handicap wants exactly ${size} (R184)`;
  }
  if (new Set(deck).size !== deck.length) {
    return `deck "${id}" repeats a card id; at most ${MAX_COPIES} copy of each (§2.6 L3)`;
  }
  for (const defId of deck) {
    const def = catalog[defId];
    if (def === undefined) return `deck "${id}": "${defId}" is not in the catalog (§9.4 L6)`;
    if (!deckable(def)) return `deck "${id}": "${defId}" is a Token card and cannot be in a deck (§2.6 L3)`;
  }
  return null;
}

/**
 * Resolve one `a=` / `b=` deck id against the catalog.
 *
 * `overrides` is the E2E injection (`window.__jackiohE2E.decks`, ASSUMPTION A1 in
 * `e2e/support/types.ts`): a spec that needs a specific scenario deck hands the exact card ids
 * over and they take precedence over the registry. They are external input, so they are checked
 * against the catalog like anything else.
 *
 * `size` is how many cards the seat's deck must hold: DECK_SIZE, unless the E2E injection gave the
 * seat a handicap, whose `deckSize` rules instead (R184). The dev decks are always DECK_SIZE long, so
 * a handicapped seat plays an injected deck of its own size or none.
 *
 * Never throws and never invents a card id: an unknown deck id, an empty catalog or a catalog too
 * small to fill a deck all come back as `{ error }` for the route to print.
 */
export function resolveDeck(
  id: string,
  catalog: CardDefs,
  overrides?: Readonly<Record<string, readonly string[]>>,
  size: number = DECK_SIZE,
): ResolvedDeck {
  const injected = overrides?.[id];
  if (injected !== undefined) {
    const deck = [...injected];
    const bad = refusal(deck, catalog, id, size);
    return bad === null ? { deck } : { error: bad };
  }

  const source = deckSource(id);
  if (source === undefined) {
    return {
      error: `unknown deck "${id}". Dev decks: ${DECK_IDS.join(", ")}.`,
    };
  }

  const pool = candidates(catalog);
  if (pool.length === 0) {
    return {
      error:
        `deck "${id}" cannot be built: the card catalog is empty. ` +
        `packages/cards has not shipped its definitions yet (BUILD M4-T1), and the client never ` +
        `invents card ids.`,
    };
  }
  if (pool.length < DECK_SIZE) {
    return {
      error: `deck "${id}" needs ${DECK_SIZE} non-Token cards; the catalog offers ${pool.length}.`,
    };
  }

  const deck = source.resolve(catalog);
  const bad = refusal(deck, catalog, id, size);
  return bad === null ? { deck } : { error: bad };
}

/**
 * Both seats at once: `[p1, p2]`, or the first error either side produced. `sizes` is each seat's
 * deck size in the same order (see `resolveDeck`), DECK_SIZE for both when omitted.
 */
export function resolveDecks(
  a: string,
  b: string,
  catalog: CardDefs,
  overrides?: Readonly<Record<string, readonly string[]>>,
  sizes: readonly [number, number] = [DECK_SIZE, DECK_SIZE],
): { decks: [string[], string[]] } | { error: string } {
  const first = resolveDeck(a, catalog, overrides, sizes[0]);
  if ("error" in first) return { error: first.error };
  const second = resolveDeck(b, catalog, overrides, sizes[1]);
  if ("error" in second) return { error: second.error };
  return { decks: [first.deck, second.deck] };
}

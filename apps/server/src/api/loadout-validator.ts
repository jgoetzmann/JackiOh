/**
 * The one place `apps/server` reaches `@jackioh/validator` (SPEC §9.4: "one validator module
 * shared by client and server"; BUILD M6-T3 greps for exactly this import).
 *
 * Rules L1–L6 and the draft rules D1–D4 and T1–T3 (R250, R252) live in that package and nowhere
 * else. `src/api/decks.ts` depends only on the `LoadoutValidator` port for L1–L6 and on the draft
 * checks re-exported below, so no handler restates a rule and the client's verdict and the
 * server's come from one implementation. This file is the adapter between the two shapes and
 * decides nothing: it translates `LoadoutValidateInput` into the validator's inputs, and its
 * `LoadoutResult` back into `LoadoutIssue[]`.
 *
 * R253 picks the rule set by what is being queued, and the port's `scope` carries that choice:
 * `"deck"` is a Best-of-1 deck (`validateDeck`: L2, L3, L5, L6) and `"trio"`, the default, is a
 * Conquest trio (`validateLoadout`: L1–L6). `names` are the saved decks' own names, so a refusal
 * says "Aggro has 19 cards" rather than "Deck 1 has 19 cards" (§9.4: "a queue-time failure names
 * the deck and the card").
 *
 * Note what is deliberately NOT here: the catalog-version comparison. §9.4 rejects a stale
 * version at save, but staleness is not one of L1–L6 — the validator only checks membership in the
 * snapshot it is handed, and the endpoint compares versions.
 */

import { validateDeck, validateLoadout, type LoadoutDeck, type LoadoutResult } from "@jackioh/validator";
import type { LoadoutIssue, LoadoutValidateInput, LoadoutValidator } from "./ports";

/**
 * The draft rules, the name normaliser, the trio's size and R340's room check for an imported trio,
 * passed through so the rest of the server (`src/api/decks.ts`, `src/db/seed-accounts.ts`) reaches
 * the shared module through this file too: the grep in `test/validator-single-source.test.ts` holds
 * the server to one importer.
 */
export { checkDeckDraft, checkImportRoom, checkTrioDraft, normalizeName, TRIO_DECKS } from "@jackioh/validator";

/** One deck as the validator reads it: its cards, and its saved name when there is one. */
function deckAt(input: LoadoutValidateInput, index: number): LoadoutDeck {
  const cards = input.decks[index] ?? [];
  const name = input.names?.[index];
  return name === undefined ? { cards } : { name, cards };
}

/** The port, bound to the shared module. */
export const sharedLoadoutValidator: LoadoutValidator = (
  input: LoadoutValidateInput,
): LoadoutIssue[] => {
  const catalog = {
    version: input.catalogVersion,
    cards: input.catalog.defs,
    banned: input.catalog.cardIds.filter((cardId) => input.catalog.isBanned(cardId)),
  };
  const collection = Object.fromEntries(input.owned);
  const result: LoadoutResult =
    input.scope === "deck"
      ? validateDeck({ deck: deckAt(input, 0), catalog, collection })
      : validateLoadout({
          decks: input.decks.map((_cards, index) => deckAt(input, index)),
          catalog,
          collection,
        });
  if (result.ok) return [];
  return result.errors.map((error) => ({
    rule: error.rule,
    message: error.message,
    ...(error.deck === undefined ? {} : { deck: error.deck }),
    ...(error.cardId === undefined ? {} : { cardId: error.cardId }),
  }));
};

/** Kept as a function too, so the composition root reads the same either way. */
export function loadoutValidator(): LoadoutValidator {
  return sharedLoadoutValidator;
}

/**
 * The one place `apps/server` reaches `@jackioh/validator` (SPEC §9.4: "one validator module
 * shared by client and server"; BUILD M6-T3 greps for exactly this import).
 *
 * Rules L1–L6 live in that package and nowhere else. `src/api/loadouts.ts` depends only on the
 * `LoadoutValidator` port, so no handler restates a rule and the client's verdict and the
 * server's come from one implementation. This file is the adapter between the two shapes and
 * decides nothing: it translates `LoadoutValidateInput` into the validator's `LoadoutInput`, and
 * its `LoadoutResult` back into `LoadoutIssue[]`.
 *
 * Note what is deliberately NOT here: the catalog-version comparison. §9.4 rejects a stale
 * version at save and at queue, but staleness is not one of L1–L6 — the validator only checks
 * membership in the snapshot it is handed, and the endpoint compares versions.
 */

import { validateDeck, validateLoadout, type CatalogSnapshot, type LoadoutResult } from "@jackioh/validator";
import type {
  CatalogInfo,
  DeckValidateInput,
  DeckValidator,
  LoadoutIssue,
  LoadoutValidateInput,
  LoadoutValidator,
} from "./ports";

function snapshotOf(catalogVersion: string, catalog: CatalogInfo): CatalogSnapshot {
  return {
    version: catalogVersion,
    cards: catalog.defs,
    banned: catalog.cardIds.filter((cardId) => catalog.isBanned(cardId)),
  };
}

function issuesOf(result: LoadoutResult): LoadoutIssue[] {
  if (result.ok) return [];
  return result.errors.map((error) => ({
    rule: error.rule,
    message: error.message,
    ...(error.deck === undefined ? {} : { deck: error.deck }),
    ...(error.cardId === undefined ? {} : { cardId: error.cardId }),
  }));
}

/** The port, bound to the shared module. */
export const sharedLoadoutValidator: LoadoutValidator = (
  input: LoadoutValidateInput,
): LoadoutIssue[] => {
  return issuesOf(
    validateLoadout({
      decks: input.decks.map((cards) => ({ cards })),
      catalog: snapshotOf(input.catalogVersion, input.catalog),
      collection: Object.fromEntries(input.owned),
    }),
  );
};

/** R171: one library deck, through the same module. */
export const sharedDeckValidator: DeckValidator = (input: DeckValidateInput): LoadoutIssue[] =>
  issuesOf(
    validateDeck({
      deck: input.name === undefined ? { cards: input.cards } : { name: input.name, cards: input.cards },
      catalog: snapshotOf(input.catalogVersion, input.catalog),
      collection: Object.fromEntries(input.owned),
      allowIncomplete: input.allowIncomplete,
    }),
  );

/** Kept as a function too, so the composition root reads the same either way. */
export function loadoutValidator(): LoadoutValidator {
  return sharedLoadoutValidator;
}

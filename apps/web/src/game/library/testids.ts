// The deck library's `data-testid` vocabulary (BUILD M9-T2), in one file.
//
// `e2e/support/testids.ts` mirrors these for `13-deck-library.cy.ts`, the same way it mirrors the
// loadout editor's `game/deckbuilder/testids.ts`. Card ids are catalog ids (`core-001`), deck ids
// are the server's (`/api/decks`).

import type { LoadoutRule } from "@jackioh/validator";

/** The screen itself. */
export const LIBRARY = "library";
/** Rendered instead of the screen while its reads are in flight, or when one it needs failed. */
export const LIBRARY_LOADING = "library-loading";
export const LIBRARY_ERROR = "library-error";

// --- deck list mode ------------------------------------------------------------------------

/** The saved decks, and one row per deck. */
export const LIBRARY_DECKS = "library-decks";
export function libraryDeckId(deckId: string): string {
  return `library-deck-${deckId}`;
}
/** Two-step delete: the first click arms it, the confirm deletes. */
export function libraryDeckDeleteId(deckId: string): string {
  return `library-deck-delete-${deckId}`;
}
export function libraryDeckDeleteConfirmId(deckId: string): string {
  return `library-deck-delete-confirm-${deckId}`;
}
/** "New deck", with the `k/max` count beside it; disabled at the cap (R171). */
export const LIBRARY_NEW_DECK = "library-new-deck";
export const LIBRARY_DECK_TOTAL = "library-deck-total";
/** The badge on a deck (list row or editor header) short of the deck size (R171). */
export const LIBRARY_INCOMPLETE = "library-incomplete";

// --- edit mode: pages ----------------------------------------------------------------------

export const LIBRARY_PAGES = "library-pages";
export function pageCardId(cardId: string): string {
  return `library-page-card-${cardId}`;
}
export const PAGE_PREV = "library-page-prev";
export const PAGE_NEXT = "library-page-next";
/** "Page i / n", with `data-page` (1-based), `data-pages`, `data-rows`, `data-cols`. */
export const PAGE_INDICATOR = "library-page-indicator";

// --- edit mode: the decklist ---------------------------------------------------------------

/** The decklist, which is also the drop target a page card is dragged onto. */
export const DECKLIST = "library-decklist";
export function deckBarId(cardId: string): string {
  return `library-bar-${cardId}`;
}
export const DECK_NAME_INPUT = "library-deck-name";
/** `n/deckSize`, with `data-count` and `data-deck-size`. */
export const DECK_CARD_COUNT = "library-card-count";
export const DECK_SAVE = "library-save";
export const DECK_SAVED = "library-saved";
export const DECK_BACK = "library-back";
/** Shown when Back would drop unsaved edits; confirming discards them. */
export const DECK_DISCARD_CONFIRM = "library-discard-confirm";
/** Every validator sentence, verbatim (the house rule in `Deckbuilder.tsx`'s header). */
export const DECK_ERRORS = "library-errors";
export function deckErrorId(rule: LoadoutRule): string {
  return `library-error-${rule}`;
}
/** A refusal that is not a rule failure (a stale catalog, the cap, a 403): the server's words. */
export const DECK_SAVE_ERROR = "library-save-error";
/** The full card shown beside the decklist while a bar is hovered or focused. */
export const HOVER_PREVIEW = "library-hover-preview";

// --- the inspector -------------------------------------------------------------------------

export const INSPECTOR = "library-inspector";
/** The 3D card; its inline `transform` is what a drag changes. */
export const INSPECTOR_CARD = "library-inspector-card";
export const INSPECTOR_FLIP = "library-inspector-flip";
export const INSPECTOR_CLOSE = "library-inspector-close";
/** Add to / remove from the deck: the path that needs no right-click. */
export const INSPECTOR_TOGGLE = "library-inspector-toggle";

/**
 * A bar dragged out of the decklist carries this MIME, so the pages can tell "remove this" from a
 * page card's `DECK_DRAG_MIME` "add this".
 */
export const DECK_BAR_MIME = "application/x-jackioh-deck-bar";

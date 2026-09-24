// The deckbuilder's `data-testid` vocabulary, in one file.
//
// BUILD M5-T1 fixes the board's testids and `e2e/support/testids.ts` mirrors them. The builder has
// no such list yet: `e2e/cypress/e2e/09-deckbuilder.cy.ts` says so in as many words ("`support/
// testids.ts` has no deckbuilder vocabulary, and M8's house rule forbids inventing one in a
// spec") and leaves the names as an ASK. These are the names that ASK is answered with, so the
// agent who owns `e2e/support/testids.ts` has exactly one file to copy from.
//
// `data-legal="false"` is deliberately NOT a new word: `e2e/support/testids.ts` already exports it
// as `ILLEGAL` for the board's M5-T2 highlighting, and a pool card that may not be dragged into
// the open deck is the same statement about the same vocabulary.

import type { CardType, Rarity, Tag } from "@jackioh/shared";
import type { LoadoutRule } from "@jackioh/validator";

import type { CostBucket } from "./filters.ts";

/** The screen itself, so a spec can wait for it rather than for a route. */
export const DECKBUILDER = "deckbuilder";

/** The card pool, and one entry per card in it. */
export const CARD_POOL = "card-pool";

export function poolCardId(cardId: string): string {
  return `${CARD_POOL}-${cardId}`;
}

/** `n` is 1-based, matching the validator's `Deck 1` / `Deck 2` / `Deck 3` labels. */
export function deckTabId(deck: number): string {
  return `deck-tab-${deck}`;
}

/** The drop region of deck `n`. `e2e/support/testids.ts` `deckDropId` names the same element. */
export function deckDropId(deck: number): string {
  return `deck-drop-${deck}`;
}

/** The list inside that region. A drop on it bubbles to the region, so either works. */
export function deckListId(deck: number): string {
  return `deck-list-${deck}`;
}

/**
 * One card already in deck `n`.
 *
 * TWO SPELLINGS ON PURPOSE, and a discrepancy to reconcile: the hand-off brief for this screen
 * asks for `deck-card-<n>-<cardId>`, while `e2e/support/testids.ts` `deckCardId` (added by the
 * agent who owns `e2e/support/**`) spells it `deck-<n>-card-<cardId>`. Neither is fixed by BUILD.
 * Rather than guess which survives, the button carries the first and its row carries the second,
 * so a selector written against either finds the card. Collapse this to one name once the two
 * agree — it is the only place to change.
 */
export function deckCardId(deck: number, cardId: string): string {
  return `deck-card-${deck}-${cardId}`;
}

export function deckCardRowId(deck: number, cardId: string): string {
  return `deck-${deck}-card-${cardId}`;
}

/**
 * The MIME the pool puts a catalog id on when a drag starts, alongside a `text/plain` copy.
 * `e2e/support/testids.ts` `DECK_DRAG_MIME` is the same string; `onDrop` reads both, and prefers
 * the id the component recorded on `dragstart` because Cypress and jsdom synthesise drag events
 * without a `DataTransfer` at all.
 */
export const DECK_DRAG_MIME = "application/x-jackioh-card";

/** The card count of deck `n`, against `DECK_SIZE` (L2). */
export function deckCountId(deck: number): string {
  return `deck-count-${deck}`;
}

/** The save control (§9.4: one `saveLoadout` for all three decks, never a per-deck save). */
export const LOADOUT_SAVE = "loadout-save";

/** Shown after a 200 from `PUT /api/loadout`. */
export const LOADOUT_SAVED = "loadout-saved";

/** The list every L1–L6 sentence is rendered into. */
export const LOADOUT_ERRORS = "loadout-errors";

/**
 * One marker per rule, carrying that rule's sentence and nothing else. There may be several
 * elements with the same testid — the validator reports every failure, so a loadout can break L3
 * twice — which is why each also carries `data-rule` and, where the validator named them,
 * `data-deck` and `data-card`.
 */
export function loadoutErrorId(rule: LoadoutRule): string {
  return `loadout-error-${rule}`;
}

/** A refusal from `PUT /api/loadout` that is not a rule failure (a stale catalog, a 403, …). */
export const LOADOUT_SAVE_ERROR = "loadout-save-error";

/** Rendered instead of the builder while the three reads are in flight. */
export const DECKBUILDER_LOADING = "deckbuilder-loading";

/** Rendered instead of the builder when a read the screen cannot do without failed. */
export const DECKBUILDER_ERROR = "deckbuilder-error";

// ---------------------------------------------------------------------------------------------
// Browse: filters, sort, the pool grid's inspect control, the deck sidebar and its mana curve
// (docs/polish/6-cards.md, Surface D). Additions only: every name above keeps its spelling and its
// meaning. `e2e/support/testids.ts` block A14 mirrors these name for name.
//
// No new name starts with `card-` or `hand-card-`: `cy.fieldCardByName` and `cy.handCardByName`
// select on those prefixes, and a new id carrying one would hijack them.
// ---------------------------------------------------------------------------------------------

/** Lower-case, every run of characters outside `[a-z0-9]` becomes one "-", trimmed of "-". */
export function slugOf(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The filter bar: search, chips, the owned toggle, sort, clear and the result count. */
export const DB_FILTERS = "db-filters";

/** The free-text search box. */
export const DB_SEARCH = "db-search";

/** A cost chip: `db-filter-cost-0` … `db-filter-cost-5`, `db-filter-cost-6+`, `db-filter-cost-X`. */
export function filterCostId(bucket: CostBucket): string {
  return `db-filter-cost-${bucket}`;
}

/** A type chip: `db-filter-type-unit`, `db-filter-type-field-spell`, … */
export function filterTypeId(type: CardType): string {
  return `db-filter-type-${slugOf(type)}`;
}

/** A tag chip: `db-filter-tag-human`, `db-filter-tag-call-to-chaos`, … */
export function filterTagId(tag: Tag): string {
  return `db-filter-tag-${slugOf(tag)}`;
}

/** A rarity chip: `db-filter-rarity-common`, … `db-filter-rarity-mythic`. */
export function filterRarityId(rarity: Rarity): string {
  return `db-filter-rarity-${slugOf(rarity)}`;
}

/** The "owned only" checkbox. Checked by default; disabled when the collection could not be read. */
export const DB_FILTER_OWNED = "db-filter-owned";

/** Restores the default filter. */
export const DB_FILTER_CLEAR = "db-filter-clear";
/** The phone-width toggle that folds the chip rows away (its `aria-expanded` says which). */
export const DB_FILTER_TOGGLE = "db-filter-toggle";

/** The sort key select (cost, name, rarity, attack, health, type). */
export const DB_SORT = "db-sort";

/** The sort direction toggle; carries `data-dir="asc|desc"`. */
export const DB_SORT_DIR = "db-sort-dir";

/** How many pool cards the filter shows, in `data-count`. */
export const DB_RESULT_COUNT = "db-result-count";

/** Shown in place of an empty grid when nothing matches. */
export const DB_EMPTY = "db-empty";

/** The "+" button on pool card `cardId`, which adds it to the open deck (a click on the card opens its detail view). */
export function addPoolId(cardId: string): string {
  return `db-add-${cardId}`;
}

/** The polite status line that says what the last add or removal did ("Bigot added to Deck 1 · 7/20"). */
export const DB_DECK_STATUS = "db-deck-status";

/** The detail view's "Add to Deck N" action. */
export const DB_DETAIL_ADD = "db-detail-add";

/** The deck sidebar: tabs, the open deck's list and curve, and the save control. */
export const DB_SIDEBAR = "db-sidebar";

/** Deck `n`'s mana curve: one `.db-bar[data-bucket][data-count]` per cost bucket. */
export function deckCurveId(deck: number): string {
  return `deck-curve-${deck}`;
}

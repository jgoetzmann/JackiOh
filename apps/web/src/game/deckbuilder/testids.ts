// The deck workshop's `data-testid` vocabulary, in one file (SPEC §9.4, R250–R256).
//
// BUILD M5-T1 fixes the board's testids and `e2e/support/testids.ts` mirrors them; this file is the
// builder's half of that contract, so the agent who owns `e2e/support/testids.ts` has exactly one
// file to copy from. The workshop replaced the three-deck loadout editor, and with it the per-deck
// names (`deck-tab-<n>`, `deck-drop-<n>`, `deck-list-<n>`, `deck-card-<n>-<id>`,
// `deck-<n>-card-<id>`, `deck-count-<n>`, `deck-curve-<n>`, `deck-fold-<n>`, `db-deck-status`,
// `loadout-save`, `loadout-saved`, `loadout-save-error`, `deckbuilder`): one deck is open at a time
// now, so its elements carry no number.
//
// `data-legal="false"` is deliberately NOT a new word: `e2e/support/testids.ts` already exports it
// as `ILLEGAL` for the board's M5-T2 highlighting, and a pool card the open deck will not take is
// the same statement about the same vocabulary.

import type { CardType, Rarity, Tag } from "@jackioh/shared";
import type { LoadoutRule } from "@jackioh/validator";

import type { CostBucket } from "./filters.ts";

// ---------------------------------------------------------------------------------------------
// The workshop: the screen, the save status, the rail of decks and trios
// ---------------------------------------------------------------------------------------------

/** The workshop's root: the whole screen, whether a deck, a trio, the import or nothing is open.
 *  `data-view="list|editor"` says which half a phone shows. */
export const WORKSHOP = "workshop";

/** The save status line, always on screen: `data-state="saved|saving|offline|error"` (R256). */
export const SYNC_STATUS = "sync-status";

/** On a phone, the editor's way back to the list of decks and trios (hidden on wider screens). */
export const WORKSHOP_BACK = "workshop-back";

/** Shown in the main column when nothing is open. */
export const WORKSHOP_EMPTY = "workshop-empty";

/** The list of saved decks, and its "n/10" beside the heading. */
export const DECK_LIST = "deck-list";
export const DECK_CAP = "deck-cap";

/**
 * One saved deck in the list: `data-count` (its cards), `data-status` (`ready`, `complete`,
 * `incomplete`, `unowned` or `invalid`, the chip it wears), `data-unsynced="true"` while a save is
 * pending, and `aria-current="true"` when it is open.
 */
export function deckRowId(deckId: string): string {
  return `deck-row-${deckId}`;
}

/** Makes a deck and opens it. Disabled at the cap, with `deck-cap-reason` saying why. */
export const DECK_NEW = "deck-new";
export const DECK_CAP_REASON = "deck-cap-reason";

/** The list of saved trios, its "n/5", and New trio (disabled at the cap, with its reason). */
export const TRIO_LIST = "trio-list";
export const TRIO_CAP = "trio-cap";
export const TRIO_NEW = "trio-new";
export const TRIO_CAP_REASON = "trio-cap-reason";

/** One saved trio in the list: `data-ready="true|false"` (R253's Conquest verdict). */
export function trioRowId(trioId: string): string {
  return `trio-row-${trioId}`;
}

// ---------------------------------------------------------------------------------------------
// The deck editor
// ---------------------------------------------------------------------------------------------

/** The open deck's editor: `data-deck` is its id. */
export const DECK_EDITOR = "deck-editor";

/** The open deck's name (D1 met gently: an emptied name saves as "Untitled deck"). */
export const DECK_NAME_INPUT = "deck-name-input";

/** The open deck's card count against `DECK_SIZE`, in `data-count`. */
export const DECK_COUNT = "deck-count";

/** The open deck's drop region: a card dragged from the pool lands here. */
export const DECK_DROP = "deck-drop";

/** The open deck's list of tiles. */
export const DECK_CARDS = "deck-cards";

/**
 * One card in the open deck: a tile whose click takes it out. `data-conflict="true"` and
 * `data-conflict-with="<deck name>"` when a compared deck holds it too (shown, never removed).
 */
export function deckCardId(cardId: string): string {
  return `deck-card-${cardId}`;
}

/** The open deck's mana curve: one `.db-bar[data-bucket][data-count]` per cost bucket. */
export const DECK_CURVE = "deck-curve";

/** On a phone, the toggle that folds the curve and the tiles away (`aria-expanded`). */
export const DECK_FOLD = "deck-fold";

/** The polite line naming the last add, removal or refusal, and "Deck complete — saved". */
export const DECK_STATUS = "deck-status";

/** The server's refusal of this deck's last save, verbatim (R256). */
export const DECK_SAVE_ERROR = "deck-save-error";

/** Copies the deck's code (R255), and shows it in `deck-code-output`, a read-only field. */
export const DECK_COPY_CODE = "deck-copy-code";
export const DECK_CODE_OUTPUT = "deck-code-output";

/** Delete, then the confirm that really deletes, or the one that keeps the deck. */
export const DECK_DELETE = "deck-delete";
export const DECK_DELETE_CONFIRM = "deck-delete-confirm";
export const DECK_DELETE_CANCEL = "deck-delete-cancel";

/**
 * "Compare with" (R251): a select whose options are `trio:<trioId>` (a trio this deck is in: its
 * other decks), `deck:<deckId>` (another deck, up to two at once) and `none`. Each compared deck is
 * then a chip, `deck-compare-<deckId>`, whose press stops comparing with it.
 */
export const DECK_COMPARE_SELECT = "deck-compare-select";

export function deckCompareChipId(deckId: string): string {
  return `deck-compare-${deckId}`;
}

/** How many of the open deck's cards a compared deck also holds, when any do. */
export const DECK_CONFLICTS = "deck-conflicts";

/** The Best-of-1 verdict under the deck (`data-ready`): "Ready to queue", or `loadout-errors`. */
export const DECK_VERDICT = "deck-verdict";

/** The list every L1–L6 sentence is rendered into, in a deck's verdict and in a trio's. */
export const LOADOUT_ERRORS = "loadout-errors";

/**
 * One marker per failure, carrying the validator's sentence and nothing else. Several elements
 * may share a testid (the validator reports every failure), which is why each also carries
 * `data-rule` and, where the validator named them, `data-deck` and `data-card`.
 */
export function loadoutErrorId(rule: LoadoutRule): string {
  return `loadout-error-${rule}`;
}

/** Rendered instead of the workshop while the route's reads are in flight. */
export const DECKBUILDER_LOADING = "deckbuilder-loading";

/** Rendered instead of the workshop when a read the screen cannot do without failed. */
export const DECKBUILDER_ERROR = "deckbuilder-error";

/**
 * The MIME the pool puts a catalog id on when a drag starts, alongside a `text/plain` copy.
 * `e2e/support/testids.ts` `DECK_DRAG_MIME` is the same string. A drop reads both, and prefers the
 * id the component recorded on `dragstart`, because Cypress and jsdom synthesise drag events
 * without a `DataTransfer` at all.
 */
export const DECK_DRAG_MIME = "application/x-jackioh-card";

// ---------------------------------------------------------------------------------------------
// The trio editor
// ---------------------------------------------------------------------------------------------

/** The open trio's editor: `data-trio` is its id. */
export const TRIO_EDITOR = "trio-editor";

/** The open trio's name (T1 met gently: an emptied name saves as "Untitled trio"). */
export const TRIO_NAME_INPUT = "trio-name-input";

/** Slot `n`'s deck select, 1-based: the value `""` is Empty, else a deck id. */
export function trioSlotId(slot: number): string {
  return `trio-slot-${String(slot)}`;
}

/** Opens slot `n`'s deck in the deck editor. */
export function trioOpenDeckId(slot: number): string {
  return `trio-open-${String(slot)}`;
}

/** R253's Conquest verdict (`data-ready`): "Ready for Conquest", or `loadout-errors`. */
export const TRIO_VERDICT = "trio-verdict";

/** The trio's three decks side by side. */
export const TRIO_COMPARE = "trio-compare";

/**
 * Card `cardId` in slot `n`'s column (1-based): `data-conflict="true|false"`, and, for a card
 * another slot's deck holds too, `data-conflict-with="<deck name>"` (names joined with ", ").
 */
export function trioCardId(slot: number, cardId: string): string {
  return `trio-card-${String(slot)}-${cardId}`;
}

export const TRIO_DELETE = "trio-delete";
export const TRIO_DELETE_CONFIRM = "trio-delete-confirm";
export const TRIO_DELETE_CANCEL = "trio-delete-cancel";

/** R339: "Copy trio code", and the read-only field the code is shown in once copied. */
export const TRIO_COPY_CODE = "trio-copy-code";
export const TRIO_CODE_OUTPUT = "trio-code-output";

// ---------------------------------------------------------------------------------------------
// Import (R255)
// ---------------------------------------------------------------------------------------------

/** Opens the import panel from the rail. */
export const DECK_IMPORT_OPEN = "deck-import-open";

/** The import panel itself. */
export const DECK_IMPORT = "deck-import";

/** Where the code is pasted. */
export const DECK_IMPORT_INPUT = "deck-import-input";

/**
 * The live read of the pasted code, `data-ok="true|false"`: the name, the count, what was left
 * out and which cards are not owned, or the reason the code cannot be read.
 */
export const DECK_IMPORT_PREVIEW = "deck-import-preview";

/** "Import as new deck": off until the code reads, and at the deck cap (`deck-import-cap-reason`
 *  says why). */
export const DECK_IMPORT_SUBMIT = "deck-import-submit";
export const DECK_IMPORT_CAP_REASON = "deck-import-cap-reason";
export const DECK_IMPORT_CANCEL = "deck-import-cancel";

// ---------------------------------------------------------------------------------------------
// Import a trio (R339–R341)
// ---------------------------------------------------------------------------------------------

/** Opens the trio import panel from the rail's Trios group. */
export const TRIO_IMPORT_OPEN = "trio-import-open";

/** The trio import panel itself. */
export const TRIO_IMPORT = "trio-import";

/** Where the trio code is pasted. */
export const TRIO_IMPORT_INPUT = "trio-import-input";

/**
 * The live read of the pasted trio code, `data-ok="true|false"`: the trio's name, each slot's deck
 * (`trio-import-slot-<n>`), the cards the decks share (`trio-import-shared`), or the reason the
 * code cannot be read.
 */
export const TRIO_IMPORT_PREVIEW = "trio-import-preview";

/** Slot `n` of the preview, 1-based: `data-empty="true|false"`, and `data-count` for a deck. */
export function trioImportSlotId(slot: number): string {
  return `trio-import-slot-${String(slot)}`;
}

/** The cards two or more of the code's decks share (`data-count`): kept, and flagged. */
export const TRIO_IMPORT_SHARED = "trio-import-shared";

/**
 * "Import as new trio": off until the code reads, and while the caps leave too little room, with
 * `trio-import-cap-reason` saying exactly how many deck and trio slots it needs (R340;
 * `data-decks-short`, `data-trios-short`).
 */
export const TRIO_IMPORT_SUBMIT = "trio-import-submit";
export const TRIO_IMPORT_CAP_REASON = "trio-import-cap-reason";
export const TRIO_IMPORT_CANCEL = "trio-import-cancel";

/** The server's refusal of an import, in its own words: nothing was made. */
export const TRIO_IMPORT_ERROR = "trio-import-error";

// ---------------------------------------------------------------------------------------------
// Browse: filters, sort, the pool grid and its inspect control (docs/polish/6-cards.md, Surface D).
// `e2e/support/testids.ts` block A14 mirrors these name for name.
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

/** The card pool, and one entry per card in it: `card-pool-<id>` carries `data-legal`,
 *  `data-in-deck="true"` when the open deck holds it, and `data-unavailable="true"` with
 *  `data-held-by="<deck name>"` when a compared deck does (R251). */
export const CARD_POOL = "card-pool";

export function poolCardId(cardId: string): string {
  return `${CARD_POOL}-${cardId}`;
}

/** The "+" button on pool card `cardId`, which adds it to the open deck (a click on the card opens its detail view). */
export function addPoolId(cardId: string): string {
  return `db-add-${cardId}`;
}

/** The detail view's "Add to <deck name>" action. */
export const DB_DETAIL_ADD = "db-detail-add";

/** The open deck's sidebar: its name, count, curve, tiles, comparison, verdict and actions. */
export const DB_SIDEBAR = "db-sidebar";


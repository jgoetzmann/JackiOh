// Every selector the specs use lives here. BUILD M5-T1 fixes the testid vocabulary:
//
//   zone-<side>-<row>-<lane>   card-<instanceId>   hero-<side>
//   hand-card-<instanceId>     end-turn            offer-draw        power
//
// and BUILD M5-T4 fixes `data-animating="<eventType>"` and `data-prompt-kind`. Anything below
// that is not in those two lists is marked ASSUMPTION and is only ever built here, so the web
// team has one file to align with.

import type { EventType, Lane, PromptKind, Row, Side } from "./types.ts";

/** `[data-testid="…"]`. */
export function ts(testid: string): string {
  return `[data-testid="${testid}"]`;
}

export function zoneId(side: Side, row: Row, lane: Lane): string {
  return `zone-${side}-${row}-${lane}`;
}

export function cardId(instanceId: string): string {
  return `card-${instanceId}`;
}

export function handCardId(instanceId: string): string {
  return `hand-card-${instanceId}`;
}

export function heroId(side: Side): string {
  return `hero-${side}`;
}

export const END_TURN = "end-turn";
export const OFFER_DRAW = "offer-draw";
export const POWER = "power";

/** BUILD M5-T4 `promptOpened`: the modal carries `data-prompt-kind`. */
export const PROMPT = "[data-prompt-kind]";

export function promptOf(kind: PromptKind): string {
  return `[data-prompt-kind="${kind}"]`;
}

/** BUILD M5-T4: an element animating an event carries `data-animating="<eventType>"`. */
export const ANIMATING = "[data-animating]";

export function animating(event: EventType): string {
  return `[data-animating="${event}"]`;
}

/** BUILD M5-T4 `locked`: "zone has `data-locked=\"true\"`". */
export const LOCKED = '[data-locked="true"]';

// ---------------------------------------------------------------------------------------------
// ASSUMPTIONS beyond the BUILD contract. Each is listed in e2e/README.md.
// ---------------------------------------------------------------------------------------------

/** A4: one option of an open prompt, keyed by `PendingOption.key` (SPEC §10.8). */
export function promptOptionId(key: string): string {
  return `prompt-option-${key}`;
}

/** A4: the confirm button of a multi-select prompt (tribute, mulligan, hand-with-min>1). */
export const PROMPT_SUBMIT = "prompt-submit";

/** A4: the numeric input of an `x` / `embiggen` prompt. */
export const PROMPT_X_INPUT = "prompt-x";

/** A5: the result overlay (BUILD M5-T4 `gameOver`: "overlay text Win / Loss / Draw"). */
export const RESULT_OVERLAY = "result-overlay";

/** A5: the turn banner (BUILD M5-T4 `turnStarted` / `turnAutoEnded`). */
export const BANNER = "turn-banner";

/** A5: the hotseat seat-handover button (BUILD M5-T3). */
export const SEAT_SWITCH = "seat-switch";

/** A5: per-side graveyard, exile and library counters (BUILD M5-T4 acceptance rows). */
export function graveyardCountId(side: Side): string {
  return `graveyard-count-${side}`;
}

export function exileCountId(side: Side): string {
  return `exile-count-${side}`;
}

export function libraryCountId(side: Side): string {
  return `library-count-${side}`;
}

export function handCountId(side: Side): string {
  return `hand-count-${side}`;
}

/** A5: the mana crystal tray (BUILD M5-T4 `manaChanged`: "crystal count equals mana"). */
export function manaId(side: Side): string {
  return `mana-${side}`;
}

export const MANA_CRYSTAL = ".mana-crystal";

/** BUILD M5-T4 fixes these class names in its acceptance column. */
export const DAMAGE_POP = ".damage-pop";
export const HEAL_POP = ".heal-pop";
export const LOSS_POP = ".loss-pop";
export const RADIANT = ".radiant";

/** A5: the switch-position control on a card (BUILD M5-T2 "switch via a button on the card"). */
export function switchPositionId(instanceId: string): string {
  return `switch-${instanceId}`;
}

/** A5: a zone the client has highlighted as legal for the held card (BUILD M5-T2). */
export const LEGAL = '[data-legal="true"]';
export const ILLEGAL = '[data-legal="false"]';

// ---------------------------------------------------------------------------------------------
// A5 (continued): shown stats. BUILD M5-T4's `buffed` row is "shown stats equal the view", so the
// numbers have to be read off attributes rather than out of rendered text — a reformat of
// `{health}/{maxHealth}` must not break a spec. Specs 02, 03 and 04 each declare these locally
// today; these are the same attributes `apps/web/src/game/Card.tsx` already renders.
// ---------------------------------------------------------------------------------------------

export function attackIs(attack: number): string {
  return `[data-attack="${String(attack)}"]`;
}

export function healthIs(health: number): string {
  return `[data-health="${String(health)}"]`;
}

export function maxHealthIs(maxHealth: number): string {
  return `[data-max-health="${String(maxHealth)}"]`;
}

export function armorIs(armor: number): string {
  return `[data-armor="${String(armor)}"]`;
}

/** One keyword badge on a card, by `Keyword.kind` (SPEC §6.1). */
export function keywordIs(keyword: string): string {
  return `[data-keyword="${keyword}"]`;
}

/** §3.3: `ATK` or `DEF`. A Defense Position card is rotated. */
export function positionIs(position: "ATK" | "DEF"): string {
  return `[data-position="${position}"]`;
}

/** BUILD M5-T4 `radiantSet`: the attribute beside the `.radiant` class. */
export const RADIANT_ATTR = '[data-radiant="true"]';

// ---------------------------------------------------------------------------------------------
// A5 (continued): regions and chrome. Every name below is one `apps/web` already renders —
// `animTestid` in apps/web/src/game/animations.ts for the piles and toasts, `testid` in
// apps/web/src/game/contract.ts for the shell — so these document the vocabulary in one place
// rather than inventing it. No frozen spec calls them yet; the animation table (BUILD M5-T4)
// targets them, so a spec that asserts a pile animation will.
// ---------------------------------------------------------------------------------------------

/** The hand as a region. An opponent hand is a `count` only (§10.8), so it holds no card ids. */
export function handRegionId(side: Side): string {
  return `hand-${side}`;
}

export function libraryId(side: Side): string {
  return `library-${side}`;
}

export function graveyardId(side: Side): string {
  return `graveyard-${side}`;
}

export function exileId(side: Side): string {
  return `exile-${side}`;
}

/**
 * The player-modifier badge list beside the hero (R169, BUILD M5-T4 `modifierChanged`). The
 * container is rendered on both seats even when the list is empty — `apps/web/src/game/Hero.tsx`
 * keeps it because the fade `modifierChanged` plays is the animation for the badge that has just
 * *left* — so it carries `data-count` and "no badges" is a different DOM state from "no list".
 */
export function modifiersId(side: Side): string {
  return `modifiers-${side}`;
}

/**
 * R169: one badge inside that list. A class rather than a testid, like `.mana-crystal` and
 * `.damage-pop` above, because the badges are a repeated part of one named element rather than an
 * element a spec addresses on its own.
 */
export const MODIFIER_BADGE = ".modifier-badge";

/**
 * R169: the badge for one modifier, keyed by `ModifierView.id`. The id is the only thing that
 * travels besides the caption — never the `sourceId` of the card that installed it, which is why
 * a badge can be public on both seats without leaking a face-down card's identity.
 */
export function modifierBadgeOf(modifierId: string): string {
  return `[data-modifier-id="${modifierId}"]`;
}

/** The backrow as a region: a face-down `BackrowView` carries no `instanceId` (§10.8). */
export function backrowRegionId(side: Side): string {
  return `backrow-${side}`;
}

/** The whole app shell, carrying `data-viewer`. */
export const GAME = "game";
/** The board (BUILD M5-T4 puts `rotated` and `swapped` on it). */
export const BOARD = "board";
export const CONCEDE = "concede";
export const LOG = "log";
/** §9.3: where a refused action's reason is shown, relayed and never restated. */
export const ACTION_ERROR = "action-error";
/** §2.5: the draw-offer toast. */
export const DRAW_TOAST = "draw-toast";
/** The prompt modal as an animation target (`animTestid.prompt`), not as a selector: see PROMPT. */
export const PROMPT_MODAL = "prompt-modal";
/** The backdrop behind an open prompt. */
export const PROMPT_SCRIM = "prompt-scrim";

// ---------------------------------------------------------------------------------------------
// A11: the deck workshop (`/decks`, SPEC §9.4, R250–R256). BUILD names no testid for this screen,
// so these mirror, name for name, `apps/web/src/game/deckbuilder/testids.ts`, which is the screen's
// own vocabulary. Keep the two files identical: that file says so too.
//
// The workshop replaced the three-deck loadout editor, and with it every per-deck name
// (`deck-tab-<n>`, `deck-drop-<n>`, `deck-count-<n>`, `deck-card-<n>-<id>`, `loadout-save`, …): one
// deck is open at a time, so its elements carry no number. There is no Save button either: an edit
// saves `DECK_AUTOSAVE_DEBOUNCE_MS` after the last one, so a spec waits on `SYNC_STATUS`'s
// `data-state="saved"` (R256).
// ---------------------------------------------------------------------------------------------

/** The workshop's root, whatever is open; `data-view="list|editor"` says which half a phone shows. */
export const WORKSHOP = "workshop";
/** The save status line, always on screen: `data-state="saved|saving|offline|error"` (R256). */
export const SYNC_STATUS = "sync-status";
/** On a phone only (≤1100 px), the editor's way back to the list. */
export const WORKSHOP_BACK = "workshop-back";
/** The main column when nothing is open. */
export const WORKSHOP_EMPTY = "workshop-empty";

/** The list of saved decks, and its "n/10" (`data-count`, `data-limit`). */
export const DECK_LIST = "deck-list";
export const DECK_CAP = "deck-cap";

/** One saved deck in the list: `data-count`, `data-status`, `data-unsynced`, `aria-current`. */
export function deckRowId(deckId: string): string {
  return `deck-row-${deckId}`;
}

/** Makes a deck and opens it. Disabled at the cap (R250), with `DECK_CAP_REASON` saying why. */
export const DECK_NEW = "deck-new";
export const DECK_CAP_REASON = "deck-cap-reason";

/** The list of saved trios, its "n/5", and New trio (disabled at the cap, with its reason). */
export const TRIO_LIST = "trio-list";
export const TRIO_CAP = "trio-cap";
export const TRIO_NEW = "trio-new";
export const TRIO_CAP_REASON = "trio-cap-reason";

/** One saved trio in the list: `data-ready="true|false"` (R253's Best-of-3 verdict). */
export function trioRowId(trioId: string): string {
  return `trio-row-${trioId}`;
}

/**
 * The card pool a deck is built from, and one entry per card in it: `card-pool-<id>` carries
 * `data-legal`, `data-in-deck="true"` when the open deck holds it, and `data-unavailable="true"`
 * with `data-held-by="<deck name>"` when a compared deck does (R251). The workshop's file lists
 * these with the browse names; they sit here because `card-pool-` starts with `card-`, which A14's
 * block promises none of its names does (a pool entry is never on the board, so
 * `cy.fieldCardByName` cannot meet one).
 */
export const CARD_POOL = "card-pool";

export function poolCardId(catalogCardId: string): string {
  return `${CARD_POOL}-${catalogCardId}`;
}

/** The open deck's editor: `data-deck` is its id. */
export const DECK_EDITOR = "deck-editor";
/** The open deck's name. */
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
export function deckCardId(catalogCardId: string): string {
  return `deck-card-${catalogCardId}`;
}

/** The open deck's mana curve: one `.db-bar[data-bucket][data-count]` per cost bucket. */
export const DECK_CURVE = "deck-curve";
/** On a phone, the toggle that folds the curve and the tiles away (`aria-expanded`). */
export const DECK_FOLD = "deck-fold";
/** The polite line naming the last add, removal or refusal (a refusal names the deck holding it). */
export const DECK_STATUS = "deck-status";
/** The server's refusal of this deck's last save, verbatim (R256). */
export const DECK_SAVE_ERROR = "deck-save-error";

/** Copies the deck's code (R255) and shows it in `DECK_CODE_OUTPUT`, a read-only field. */
export const DECK_COPY_CODE = "deck-copy-code";
export const DECK_CODE_OUTPUT = "deck-code-output";

/** Delete, then the confirm that really deletes, or the one that keeps the deck. */
export const DECK_DELETE = "deck-delete";
export const DECK_DELETE_CONFIRM = "deck-delete-confirm";
export const DECK_DELETE_CANCEL = "deck-delete-cancel";

/**
 * "Compare with" (R251): option values `trio:<trioId>` (a trio holding this deck: its other decks),
 * `deck:<deckId>` (another deck) and `none`. Each compared deck is then a chip, `deckCompareChipId`.
 */
export const DECK_COMPARE_SELECT = "deck-compare-select";

export function deckCompareChipId(deckId: string): string {
  return `deck-compare-${deckId}`;
}

/** How many of the open deck's cards a compared deck also holds, in `data-count`. */
export const DECK_CONFLICTS = "deck-conflicts";

/** The Best-of-1 verdict under the deck (`data-ready`), around `LOADOUT_ERRORS`. */
export const DECK_VERDICT = "deck-verdict";

/** The list every L1–L6 sentence is rendered into, in a deck's verdict and in a trio's (`data-count`). */
export const LOADOUT_ERRORS = "loadout-errors";

/**
 * One marker per failure, carrying the validator's sentence and nothing else. Several may share a
 * testid (the validator reports every failure), so each also carries `data-rule`, `data-source`
 * and, where the validator named them, `data-deck` and `data-card`.
 */
export function loadoutErrorId(rule: string): string {
  return `loadout-error-${rule}`;
}

/** Rendered instead of the workshop while the route's reads are in flight, or when one failed. */
export const DECKBUILDER_LOADING = "deckbuilder-loading";
export const DECKBUILDER_ERROR = "deckbuilder-error";

/**
 * The MIME a pool drag carries the catalog id on, beside a `text/plain` copy. The board's own drag
 * uses `application/x-jackioh-target` for a click target (apps/web/src/game/Card.tsx); a workshop
 * drag carries a catalog id, which is a different thing, so it gets its own type.
 */
export const DECK_DRAG_MIME = "application/x-jackioh-card";

/** The open trio's editor: `data-trio` is its id. */
export const TRIO_EDITOR = "trio-editor";
export const TRIO_NAME_INPUT = "trio-name-input";

/** Slot `n`'s deck `<select>`, 1-based: the value `""` is Empty, else a deck id. */
export function trioSlotId(slot: number): string {
  return `trio-slot-${String(slot)}`;
}

/** Opens slot `n`'s deck in the deck editor. */
export function trioOpenDeckId(slot: number): string {
  return `trio-open-${String(slot)}`;
}

/** R253's Best-of-3 verdict (`data-ready`), around `LOADOUT_ERRORS`. */
export const TRIO_VERDICT = "trio-verdict";
/** The trio's three decks side by side. */
export const TRIO_COMPARE = "trio-compare";

/**
 * Card `cardId` in slot `n`'s column (1-based): `data-conflict="true|false"` and, for a card another
 * slot's deck holds too, `data-conflict-with="<deck name>"` (names joined with ", ").
 */
export function trioCardId(slot: number, catalogCardId: string): string {
  return `trio-card-${String(slot)}-${catalogCardId}`;
}

export const TRIO_DELETE = "trio-delete";
export const TRIO_DELETE_CONFIRM = "trio-delete-confirm";
export const TRIO_DELETE_CANCEL = "trio-delete-cancel";

/** Opens the import panel from the rail (R255). */
export const DECK_IMPORT_OPEN = "deck-import-open";
/** The import panel. */
export const DECK_IMPORT = "deck-import";
/** Where the code is pasted. */
export const DECK_IMPORT_INPUT = "deck-import-input";
/** The live read of the pasted code, `data-ok="true|false"`: what it holds, or why it cannot be read. */
export const DECK_IMPORT_PREVIEW = "deck-import-preview";
/** "Import as new deck": off until the code reads, and at the deck cap. */
export const DECK_IMPORT_SUBMIT = "deck-import-submit";
export const DECK_IMPORT_CAP_REASON = "deck-import-cap-reason";
export const DECK_IMPORT_CANCEL = "deck-import-cancel";

// ---------------------------------------------------------------------------------------------
// A13: the invite code screen (BUILD M6-T1, SPEC §9.4). Like A11's deckbuilder block, BUILD names
// no testid for this screen, so these mirror — name for name — the screen's own vocabulary:
// `inviteTestid`, `codeFieldTestid` and `codeFieldSegmentTestid` in `apps/web/src/auth/testids.ts`,
// which `apps/web/src/routes/invite.tsx` and `apps/web/src/auth/CodeField.tsx` render. Keep the two
// files identical.
//
// THESE WERE NEVER MISSING FROM THE CLIENT. The M8 rule-8 review recorded spec 10's "code screen
// shown" as blocked because `invite-code-input`, `invite-submit` and `invite-error` "really are
// absent from both the client and `testids.ts`"
// (reviews/2026-09-18-m5-m6-m8-gates.md). Only the second half was true: `invite.tsx` has
// exported and rendered all three since it was written. Nothing under `e2e/` had ever named them,
// which is why the row was proved as a URL redirect and an `/invite` route rendering a blank page
// would have passed it.
// ---------------------------------------------------------------------------------------------

/**
 * The box §9.4's `XXXX-XXXX-XXXX-XXXX` code is typed into: one real `<input>` with transparent text
 * over the four segments below. R191 reads it exactly as the server does, so a character outside
 * R104's alphabet is refused (the value stays and `CODE_FIELD_HINT` names it), never dropped.
 */
export const INVITE_CODE_INPUT = "invite-code-input";
/**
 * Submits the code (`POST /api/codes/redeem`). Enabled only while the code is complete, redemption
 * is not paused, no request is in flight, the account has tries left and no rate limit is running.
 */
export const INVITE_SUBMIT = "invite-submit";
/** The server's refusal, rendered verbatim — §9.4's identical error is never paraphrased here. */
export const INVITE_ERROR = "invite-error";
/** §9.4's circuit breaker is open: the screen says so rather than guessing after a 503. */
export const INVITE_PAUSED = "invite-paused";
/** An active account reached the code screen; redemption is the pending → active transition only. */
export const INVITE_NOT_NEEDED = "invite-not-needed";
/** The tries `GET /api/codes/status` says this account has left, as `data-remaining`. */
export const INVITE_ATTEMPTS = "invite-attempts";
/** R192: a 429 `rate_limited` refusal's wait, as `data-retry-after-ms`. Submit is off meanwhile. */
export const INVITE_RATE_LIMITED = "invite-rate-limited";
/** The address the pending account signed in with, beside the way out. */
export const INVITE_ACCOUNT_EMAIL = "invite-account-email";
/** Signs out (clears both session keys) and lands on `/`: the code screen is never a dead end. */
export const INVITE_SIGN_OUT = "invite-sign-out";
/** The line under the field saying what a code looks like. */
export const INVITE_HELP = "invite-help";

/** The code field's root, carrying `data-complete` and, while one stands, `data-problem`. */
export const CODE_FIELD = "code-field";
/** "N of 16 characters" (`aria-live="polite"`). */
export const CODE_FIELD_PROGRESS = "code-field-progress";
/** The refused character's sentence, with `data-kind="excluded|foreign|tooLong"`. Only while a problem stands. */
export const CODE_FIELD_HINT = "code-field-hint";

/** One drawn group (`aria-hidden`), with `data-state="empty|partial|complete"` and `data-active`. */
export function codeFieldSegmentId(index: number): string {
  return `code-field-segment-${String(index)}`;
}

// ---------------------------------------------------------------------------------------------
// PRACTICE: `/practice`, a game against the AI with no account and no server (SPEC §9.9, R187,
// spec 13). Like A11 and A13 these name the route's own vocabulary: `practiceTestid` in
// `apps/web/src/practice/testids.ts` carries the same strings. Keep the two files identical.
// ---------------------------------------------------------------------------------------------

/** The setup form: a difficulty, a deck and Start. */
export const PRACTICE_SETUP = "practice-setup";

/** One `<input type="radio">` per difficulty. */
export function practiceDifficultyId(d: "easy" | "medium" | "hard"): string {
  return `practice-difficulty-${d}`;
}

/** The deck `<select>`: `random`, `preset:<id>` per preset, and `saved:<1..3>` for an active account. */
export const PRACTICE_DECK = "practice-deck";
/** Under the deck picker: why no saved deck is offered; absent when some are. */
export const PRACTICE_DECK_HINT = "practice-deck-hint";
/** The chosen deck: its name, its identity and, once the catalog is in, its curve and cards. */
export const PRACTICE_DECK_PREVIEW = "practice-deck-preview";
/** In the preview: one bar per cost, `data-cost` and `data-count`. */
export const PRACTICE_DECK_CURVE = "practice-deck-curve";
/** In the preview: one row per card of the chosen deck. */
export function practiceDeckCardId(defId: string): string {
  return `practice-deck-card-${defId}`;
}
export const PRACTICE_START = "practice-start";
/** Shown while the worker builds the decks and deals. */
export const PRACTICE_LOADING = "practice-loading";
/** The worker failed or refused the setup. */
export const PRACTICE_ERROR = "practice-error";
/** Above the board; carries data-difficulty, data-human-seat, data-ai-seat and data-thinking. */
export const PRACTICE_HUD = "practice-hud";
/** Rendered only while the AI owes an action; role="status", text "AI is thinking…". */
export const PRACTICE_THINKING = "practice-thinking";
/** Mid-game it opens PRACTICE_LEAVE; once the game is over, or on the failure screen, it leaves at once. */
export const PRACTICE_NEW_GAME = "practice-new-game";
/** Out to the main menu: mid-game it opens PRACTICE_LEAVE first; once the game is over it leaves at once. */
export const PRACTICE_MENU = "practice-menu";
/** "Leave this game?": the confirmation PRACTICE_NEW_GAME or PRACTICE_MENU opens while a game is in progress. */
export const PRACTICE_LEAVE = "practice-leave";
/** In the confirmation: abandon the game and go back to setup. */
export const PRACTICE_LEAVE_CONFIRM = "practice-leave-confirm";
/** In the confirmation: close it and carry on. */
export const PRACTICE_LEAVE_STAY = "practice-leave-stay";
/** The end-of-game dialog; data-outcome="win|loss|draw". */
export const PRACTICE_RESULT = "practice-result";
/** In the result dialog: the same difficulty and deck again, with a fresh seed and seat. */
export const PRACTICE_PLAY_AGAIN = "practice-play-again";
/** In the result dialog: back to the setup screen. */
export const PRACTICE_CHANGE_SETUP = "practice-change-setup";
/** In the result dialog: close it and look at the final board. */
export const PRACTICE_VIEW_BOARD = "practice-view-board";
/** In the HUD once the game is over: the outcome, which reopens the result dialog. */
export const PRACTICE_OUTCOME = "practice-outcome";
/** In the HUD while any modifier is live (R169): a chip with the count, `data-count`; it opens the panel. */
export const PRACTICE_MODIFIERS = "practice-modifiers";
/** Every live modifier's label in full, grouped You and AI. */
export const PRACTICE_MODIFIERS_PANEL = "practice-modifiers-panel";

// ---------------------------------------------------------------------------------------------
// A14: card faces, inspect and deck-builder browse (polish 6, docs/polish/6-cards.md). These mirror,
// name for name, `apps/web/src/cards/inspect/testids.ts` (the `INSPECT_*` overlays) and the browse
// additions to `apps/web/src/game/deckbuilder/testids.ts` (the `DB_*` names, the id functions and
// `slugOf`). Keep the files identical. No name here starts with `card-` or `hand-card-`, so
// `cy.fieldCardByName` and `cy.handCardByName` still resolve to the named card.
// ---------------------------------------------------------------------------------------------

/** A14: the hover preview (desktop, after the hover delay). `pointer-events: none`. */
export const INSPECT_HOVER = "inspect-hover";
/** A14: the touch long-press sheet (`role="dialog"`). */
export const INSPECT_SHEET = "inspect-sheet";
/** A14: the deck builder's detail view: both faces side by side and the glossary. */
export const INSPECT_DETAIL = "inspect-detail";
/** A14: the backdrop behind the sheet or the detail; a click on it closes the overlay. */
export const INSPECT_SCRIM = "inspect-scrim";
/** A14: the close control of the sheet or the detail. */
export const INSPECT_CLOSE = "inspect-close";
/** A14: the enlarged face inside the preview or the sheet. */
export const INSPECT_FACE = "inspect-face";
/** A14: the detail view's base face. */
export const INSPECT_FACE_BASE = "inspect-face-base";
/** A14: the detail view's radiant face. */
export const INSPECT_FACE_RADIANT = "inspect-face-radiant";
/** A14: the keyword glossary, one `li[data-glossary-term]` per term. */
export const INSPECT_GLOSSARY = "inspect-glossary";
/** A14: a face in play's printed text, beside it in the preview or the sheet where the two differ (SPEC §10.10). */
export const INSPECT_PRINTED = "inspect-printed";

/** A14: lower-case, every run of characters outside `[a-z0-9]` becomes one "-", trimmed of "-". */
export function slugOf(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A14: the deck builder's filter bar. */
export const DB_FILTERS = "db-filters";
/** A14: its free-text search box. */
export const DB_SEARCH = "db-search";

/** A14: a cost chip, `0`–`5`, `6+` or `X` (`db-filter-cost-6+`, `db-filter-cost-X`). */
export function filterCostId(bucket: string): string {
  return `db-filter-cost-${bucket}`;
}

/** A14: a type chip (`db-filter-type-field-spell`). */
export function filterTypeId(type: string): string {
  return `db-filter-type-${slugOf(type)}`;
}

/** A14: a tag chip (`db-filter-tag-call-to-chaos`). */
export function filterTagId(tag: string): string {
  return `db-filter-tag-${slugOf(tag)}`;
}

/** A14: a rarity chip (`db-filter-rarity-legendary`). */
export function filterRarityId(rarity: string): string {
  return `db-filter-rarity-${slugOf(rarity)}`;
}

/** A14: the "owned only" checkbox; checked by default. */
export const DB_FILTER_OWNED = "db-filter-owned";
/** A14: restores the default filter. */
export const DB_FILTER_CLEAR = "db-filter-clear";
/** A14: at phone width, folds the chip rows away; `aria-expanded` says which. */
export const DB_FILTER_TOGGLE = "db-filter-toggle";
/** A14: the sort key select (cost, name, rarity, attack, health, type). */
export const DB_SORT = "db-sort";
/** A14: the sort direction toggle, `data-dir="asc|desc"`. */
export const DB_SORT_DIR = "db-sort-dir";
/** A14: the visible pool's size, in `data-count`. */
export const DB_RESULT_COUNT = "db-result-count";
/** A14: shown when no pool card matches the filter. */
export const DB_EMPTY = "db-empty";

/** A14: the "+" on pool card `catalogCardId`, which adds it to the open deck (a click on the card opens its detail view). */
export function addPoolId(catalogCardId: string): string {
  return `db-add-${catalogCardId}`;
}

/** A14: the detail view's "Add to <deck name>". */
export const DB_DETAIL_ADD = "db-detail-add";
/** A14: the open deck's sidebar: its name, count, curve, tiles, comparison, verdict and actions. */
export const DB_SIDEBAR = "db-sidebar";

// ---------------------------------------------------------------------------------------------
// A15: the opponent's-play showcase, the log's card lines and the pile browser. These mirror, name
// for name, `apps/web/src/game/showcase/constants.ts` (`showcaseTestid`), `LOG_CARD_TESTID` in
// `apps/web/src/game/Log.tsx` and the `INSPECT_LIST_*` names in
// `apps/web/src/cards/inspect/testids.ts`. Keep the files identical. None starts with `card-` or
// `hand-card-`, so `cy.fieldCardByName` and `cy.handCardByName` never resolve to one of them.
// ---------------------------------------------------------------------------------------------

/** A15: the opponent's play, held up for about a second. `data-showcase="played|set|hidden"`; click-through. */
export const SHOWCASE = "showcase";
/** A15: its caption ("Opponent played", "Opponent set a card"). */
export const SHOWCASE_CAPTION = "showcase-caption";
/** A15: the face of a card the view names, inside the showcase. */
export const SHOWCASE_FACE = "showcase-face";
/** A15: the back drawn for a card the view hides (R97, R227), inside the showcase. */
export const SHOWCASE_BACK = "showcase-back";
/** A15: the polite live region that says what the opponent played; always present, empty between plays. */
export const SHOWCASE_LIVE = "showcase-live";

/** A15: a log line that names a card is this button, `data-def-id` naming the card; hover or click opens it. */
export const LOG_CARD = "log-card";

/** A15: a pile (`graveyard-<side>`, `exile-<side>`) that holds cards carries `data-browsable="true"`. */
export const BROWSABLE = '[data-browsable="true"]';
/** A15: a pile's hover preview: its title, count and newest faces. `pointer-events: none`. */
export const INSPECT_LIST_HOVER = "inspect-list-hover";
/** A15: a pile's sheet (`role="dialog"`): every card, newest first. */
export const INSPECT_LIST_SHEET = "inspect-list-sheet";
/** A15: the count in the preview or the sheet, in `data-count`. */
export const INSPECT_LIST_COUNT = "inspect-list-count";
/** A15: one face in the preview, or one face button in the sheet; `data-def-name` is its name. */
export const INSPECT_LIST_CARD = "inspect-list-card";
/** A15: the preview's "+N more" line, past its cap. */
export const INSPECT_LIST_MORE = "inspect-list-more";
/** A15: a face opened large inside the sheet. */
export const INSPECT_LIST_DETAIL = "inspect-list-detail";
/** A15: back from a face opened large to the whole list. */
export const INSPECT_LIST_BACK = "inspect-list-back";

// ---------------------------------------------------------------------------------------------
// A16: the lobby, the Best-of-3 series screen and the board's series banner (SPEC §9.5,
// R257–R264). Like A11 and A13 these mirror, name for name, the screens' own vocabulary:
// `playTestid` / `playModeTestid` in `apps/web/src/routes/play.tsx`, `seriesTestid` in
// `apps/web/src/routes/series.tsx` and `seriesBannerTestid` in `apps/web/src/routes/SeriesBanner.tsx`.
// Keep the files identical.
// ---------------------------------------------------------------------------------------------

/** R257: the three queue modes, as the lobby's radios and the API spell them. */
export type QueueMode = "bo1" | "bo3" | "random";

/** "Find a match" (`POST /api/queue` with the chosen mode, deck or trio). */
export const PLAY_QUEUE = "play-queue";
export const PLAY_LEAVE_QUEUE = "play-leave-queue";
export const PLAY_CREATE_ROOM = "play-create-room";
/** The created room's code, as text. */
export const PLAY_ROOM_CODE = "play-room-code";
/** The created room's mode, in `data-mode` (R264). */
export const PLAY_ROOM_MODE = "play-room-mode";
export const PLAY_JOIN_INPUT = "play-join-code";
export const PLAY_JOIN_SUBMIT = "play-join-submit";
/** "In the … queue", "Give your opponent this code": what the lobby is waiting on. */
export const PLAY_STATUS = "play-status";
/** A refusal, in the server's words (a 422's validator sentences as a list). */
export const PLAY_ERROR = "play-error";
/** Best of 1's deck `<select>`: one option per saved deck, its value the deck id. */
export const PLAY_DECK_SELECT = "play-deck-select";
/** Best of 3's trio `<select>`: one option per saved trio, its value the trio id. */
export const PLAY_TRIO_SELECT = "play-trio-select";
/** The client's verdict on the choice (`data-ready`): UX only, the server's is law (R253). */
export const PLAY_VERDICT = "play-choice-verdict";

/** One mode radio (R257). */
export function playModeId(mode: QueueMode): string {
  return `play-mode-${mode}`;
}

/** The series screen (`data-status="picking|playing|over"`). */
export const SERIES_SCREEN = "series-screen";
/** A refusal or a failed read, in the server's words. */
export const SERIES_ERROR = "series-error";
/** The game wins so far, in `data-you` and `data-opponent`. */
export const SERIES_SCORE = "series-score";
/** "Opponent is choosing…" / "Opponent has picked." (`data-picked`), and never what (R259). */
export const SERIES_OPPONENT_STATUS = "series-opponent-status";
/** The pick clock's whole seconds left, in `data-seconds` (R260). */
export const SERIES_PICK_CLOCK = "series-pick-clock";
/** While a game is on: the way to its board. */
export const SERIES_OPEN_MATCH = "series-open-match";
export const SERIES_FORFEIT = "series-forfeit";
export const SERIES_FORFEIT_CONFIRM = "series-forfeit-confirm";
/** Once over: `data-outcome="win|loss|draw|abandoned"`. */
export const SERIES_RESULT = "series-result";

/** One of your three decks (0-based trio slot): `data-played`, `data-picked`. */
export function seriesDeckId(slot: number): string {
  return `series-deck-${String(slot)}`;
}

/** Its Pick button: rendered only while picking, and only for a deck not yet played. */
export function seriesPickId(slot: number): string {
  return `series-pick-${String(slot)}`;
}

/** One of the opponent's slots: `data-played` and nothing else (R259). */
export function seriesOpponentDeckId(slot: number): string {
  return `series-opponent-deck-${String(slot)}`;
}

/** One game of the history: `data-result="win|loss|draw|pending"`. */
export function seriesGameId(gameNo: number): string {
  return `series-game-${String(gameNo)}`;
}

/** The board's series banner (`data-series-id`), on a series game only. */
export const SERIES_BANNER = "series-banner";
/** Once the game is over: the way on to the next game, or to the series screen to pick for it. */
export const SERIES_BANNER_CONTINUE = "series-banner-continue";
/** Once the series is over: its result, in `data-outcome`. */
export const SERIES_BANNER_RESULT = "series-banner-result";

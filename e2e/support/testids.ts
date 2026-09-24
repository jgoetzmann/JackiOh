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
// A11: the deckbuilder (BUILD M6-T3, SPEC §9.4). BUILD names no testid for this screen, so these
// were a contract with whoever built `/decks` — and they now mirror, name for name,
// `apps/web/src/game/deckbuilder/testids.ts`, which is the screen's own vocabulary. Keep the two
// files identical: that file says so too.
// ---------------------------------------------------------------------------------------------

/** The screen itself, so a spec can wait for it rather than for a route. */
export const DECKBUILDER = "deckbuilder";
/** Rendered instead of the builder while its three reads are in flight, or when one failed. */
export const DECKBUILDER_LOADING = "deckbuilder-loading";
export const DECKBUILDER_ERROR = "deckbuilder-error";

/** The card pool a deck is built from. */
export const CARD_POOL = "card-pool";

/** A11: one card in the pool, keyed by catalog id (`card-pool-core-001`). */
export function cardPoolId(catalogCardId: string): string {
  return `${CARD_POOL}-${catalogCardId}`;
}

/** A11: the tab that selects deck `oneBased` of the three L1 wants (1..DECKS_PER_LOADOUT). */
export function deckTabId(oneBased: number): string {
  return `deck-tab-${String(oneBased)}`;
}

/** A11: the drop region of deck `oneBased`. `cy.dragCardToDeck` falls back to the tab itself. */
export function deckDropId(oneBased: number): string {
  return `deck-drop-${String(oneBased)}`;
}

/** A11: the list inside that region. A drop on it bubbles to the region, so either works. */
export function deckListId(oneBased: number): string {
  return `deck-list-${String(oneBased)}`;
}

/** A11: how many cards deck `oneBased` holds, for L2's "exactly DECK_SIZE". */
export function deckCountId(oneBased: number): string {
  return `deck-count-${String(oneBased)}`;
}

/** A11: the control for one card already in a deck, so a drag can be asserted to have landed. */
export function deckCardId(oneBased: number, catalogCardId: string): string {
  return `deck-card-${String(oneBased)}-${catalogCardId}`;
}

/** A11: its row. The screen renders both spellings; this is the container of `deckCardId`. */
export function deckCardRowId(oneBased: number, catalogCardId: string): string {
  return `deck-${String(oneBased)}-card-${catalogCardId}`;
}

/**
 * A11: the payload `cy.dragCardToDeck` puts on the `DataTransfer`, alongside a `text/plain` copy
 * of the same catalog id. The board's own drag uses `application/x-jackioh-target` for a click
 * target (apps/web/src/game/Card.tsx); a deckbuilder drag carries a catalog id, which is a
 * different thing, so it gets its own type.
 */
export const DECK_DRAG_MIME = "application/x-jackioh-card";

/** A11: §9.4's save — one `saveLoadout` for all three decks, never a per-deck save. */
export const LOADOUT_SAVE = "loadout-save";
/** Shown after a 200 from `PUT /api/loadout`. */
export const LOADOUT_SAVED = "loadout-saved";
/** The list every L1–L6 sentence is rendered into, carrying `data-count`. */
export const LOADOUT_ERRORS = "loadout-errors";
/** A refusal that is not a rule failure (a stale catalog, a 403, …). */
export const LOADOUT_SAVE_ERROR = "loadout-save-error";

/**
 * A11: one marker per rule, carrying that rule's sentence and nothing else. There may be several
 * with the same testid — the validator reports every failure — so each also carries `data-rule`
 * and, where the validator named them, `data-deck` and `data-card`.
 */
export function loadoutErrorId(rule: string): string {
  return `loadout-error-${rule}`;
}

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

/** A14: the polite status line naming the last add or removal and the deck's count. */
export const DB_DECK_STATUS = "db-deck-status";

/** A14: the detail view's "Add to Deck N". */
export const DB_DETAIL_ADD = "db-detail-add";
/** A14: the deck sidebar: tabs, the open deck and the save control. */
export const DB_SIDEBAR = "db-sidebar";

/** A14: deck `oneBased`'s mana curve, one `.db-bar[data-bucket][data-count]` per bucket. */
export function deckCurveId(oneBased: number): string {
  return `deck-curve-${oneBased}`;
}

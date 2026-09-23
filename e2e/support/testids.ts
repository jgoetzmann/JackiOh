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

/**
 * A11: "Import from library…" on deck `oneBased` (R171), one option per library deck with the
 * deck's id as its value. Picking one replaces the slot's draft with a copy of that deck.
 */
export function deckImportId(oneBased: number): string {
  return `deck-import-${String(oneBased)}`;
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
// no testid for this screen, so these mirror — name for name — the screen's own vocabulary in
// `apps/web/src/routes/invite.tsx`, which exports every one of them. Keep the two files identical.
//
// THESE WERE NEVER MISSING FROM THE CLIENT. The M8 rule-8 review recorded spec 10's "code screen
// shown" as blocked because `invite-code-input`, `invite-submit` and `invite-error` "really are
// absent from both the client and `testids.ts`"
// (reviews/2026-09-18-m5-m6-m8-gates.md). Only the second half was true: `invite.tsx` has
// exported and rendered all three since it was written. Nothing under `e2e/` had ever named them,
// which is why the row was proved as a URL redirect and an `/invite` route rendering a blank page
// would have passed it.
// ---------------------------------------------------------------------------------------------

/** The box §9.4's `XXXX-XXXX-XXXX-XXXX` code is typed into; R104's alphabet normalises the input. */
export const INVITE_CODE_INPUT = "invite-code-input";
/** Submits the code (`POST /api/codes/redeem`). Disabled while the box is empty or paused. */
export const INVITE_SUBMIT = "invite-submit";
/** The server's refusal, rendered verbatim — §9.4's identical error is never paraphrased here. */
export const INVITE_ERROR = "invite-error";
/** §9.4's circuit breaker is open: the screen says so rather than guessing after a 503. */
export const INVITE_PAUSED = "invite-paused";
/** An active account reached the code screen; redemption is the pending → active transition only. */
export const INVITE_NOT_NEEDED = "invite-not-needed";

// ---------------------------------------------------------------------------------------------
// A14: the deck library (BUILD M9, SPEC §11 R171 and R172). Like A11 these mirror, name for name,
// the screen's own vocabulary — `apps/web/src/game/library/testids.ts` — plus the `/play` deck
// picker in `apps/web/src/routes/play.tsx` (`playTestid.deck`). Keep the files identical.
// ---------------------------------------------------------------------------------------------

/** The screen itself. */
export const LIBRARY = "library";
/** Rendered instead of the screen while its reads are in flight, or when one it needs failed. */
export const LIBRARY_LOADING = "library-loading";
export const LIBRARY_ERROR = "library-error";

/** The saved decks, and one row per deck (`deckId` is the server's, from `/api/decks`). */
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

/** Edit mode: the pages of cards, one card per catalog id, and the arrows that turn them. */
export const LIBRARY_PAGES = "library-pages";
export function pageCardId(catalogCardId: string): string {
  return `library-page-card-${catalogCardId}`;
}
export const PAGE_PREV = "library-page-prev";
export const PAGE_NEXT = "library-page-next";
/** "Page i / n", with `data-page` (1-based), `data-pages`, `data-rows`, `data-cols`. */
export const PAGE_INDICATOR = "library-page-indicator";

/** Edit mode: the decklist, which is also the drop target a page card is dragged onto. */
export const DECKLIST = "library-decklist";
export function deckBarId(catalogCardId: string): string {
  return `library-bar-${catalogCardId}`;
}
export const DECK_NAME_INPUT = "library-deck-name";
/** `n/deckSize`, with `data-count` and `data-deck-size`. */
export const DECK_CARD_COUNT = "library-card-count";
export const DECK_SAVE = "library-save";
export const DECK_SAVED = "library-saved";
export const DECK_BACK = "library-back";
/** Shown when Back would drop unsaved edits; confirming discards them. */
export const DECK_DISCARD_CONFIRM = "library-discard-confirm";
/** Every validator sentence, verbatim, one marker per rule. */
export const DECK_ERRORS = "library-errors";
export function deckErrorId(rule: string): string {
  return `library-error-${rule}`;
}
/** A refusal that is not a rule failure (a stale catalog, the cap, a 403): the server's words. */
export const DECK_SAVE_ERROR = "library-save-error";
/** The full card shown beside the decklist while a bar is hovered or focused. */
export const HOVER_PREVIEW = "library-hover-preview";

/** The full-screen inspector. Its card's inline `transform` is what a drag changes. */
export const INSPECTOR = "library-inspector";
export const INSPECTOR_CARD = "library-inspector-card";
export const INSPECTOR_FLIP = "library-inspector-flip";
export const INSPECTOR_CLOSE = "library-inspector-close";
/** Add to / remove from the deck: the path that needs no right-click. */
export const INSPECTOR_TOGGLE = "library-inspector-toggle";

/** A bar dragged out of the decklist carries this MIME: "remove this", not a page card's "add". */
export const DECK_BAR_MIME = "application/x-jackioh-deck-bar";

/** R172: `/play`'s deck picker; option values are `library:<deckId>` and `loadout:<deckIndex>`. */
export const PLAY_DECK = "play-deck";

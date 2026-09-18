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

/** The player-modifier badges beside the hero (§6.4). */
export function modifiersId(side: Side): string {
  return `modifiers-${side}`;
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
// are a contract with whoever builds `/decks` — `cy.dragCardToDeck` is written against them and
// they are the only names the suite will look for. `apps/web/src/routes/decks.tsx` is still the
// placeholder, so nothing here is confirmed yet.
// ---------------------------------------------------------------------------------------------

/** A11: one card in the pool a deck is built from, keyed by catalog id (`core-001`). */
export function cardPoolId(catalogCardId: string): string {
  return `card-pool-${catalogCardId}`;
}

/** A11: the tab that selects deck `oneBased` of the three L1 wants (1..DECKS_PER_LOADOUT). */
export function deckTabId(oneBased: number): string {
  return `deck-tab-${String(oneBased)}`;
}

/** A11: the drop zone of deck `oneBased`. `cy.dragCardToDeck` falls back to the tab itself. */
export function deckDropId(oneBased: number): string {
  return `deck-drop-${String(oneBased)}`;
}

/** A11: one card already in a deck, so a drag can be asserted to have landed. */
export function deckCardId(oneBased: number, catalogCardId: string): string {
  return `deck-${String(oneBased)}-card-${catalogCardId}`;
}

/**
 * A11: the payload `cy.dragCardToDeck` puts on the `DataTransfer`, alongside a `text/plain` copy
 * of the same catalog id. The board's own drag uses `application/x-jackioh-target` for a click
 * target (apps/web/src/game/Card.tsx); a deckbuilder drag carries a catalog id, which is a
 * different thing, so it gets its own type.
 */
export const DECK_DRAG_MIME = "application/x-jackioh-card";

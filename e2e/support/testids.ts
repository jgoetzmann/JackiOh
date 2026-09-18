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

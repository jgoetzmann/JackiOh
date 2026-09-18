// #38 Quickstriker (SPEC §8.2): Field Spell, "Your cards gain 'Combo X: deal X damage to the enemy
// hero', X = cards you played earlier this turn". §8 prints NO radiant text for this card, so
// BUILD M4-T1 makes the radiant face equal to the base face; `radiant` below is the same object.
//
// §6.2 reads Combo X as "extra effect if X or more cards were played earlier this turn, checked
// against `turnLog.cardsPlayed` at play time", and §8.2's Engine cell fixes the number: "On each
// play: damage = `turnLog.cardsPlayed` before this card". Both the reducer's play path
// (engine/src/reduce.ts) and `castCard` (engine/src/resolve.ts) increment `cardsPlayed` and push
// `playedIds` BEFORE they push the `cardPlayed` event and before they run the card's script, so the
// count a `cardPlayed` trigger reads already INCLUDES the card that is being played. X is therefore
// `cardsPlayed - 1`, which makes the first play of a turn deal 0, the second 1, the third 2.
//
// ROUTE: this is a `TriggerDef` on `cardPlayed` that the card registers while it sits in the
// backrow, not the `{ kind: "quickstrikerDamage" }` `PlayerModifier` that `engine/src/state.ts`
// declares. `playSteps.quickstrikerCombo` (§10.5 step 5) does read that member, but no card ever
// installs one, so that path is unreachable and this file is the whole card. A modifier would also
// outlive the card's zone, which "Your cards gain …" must not: §8.2's "nothing when not on the
// field" is exactly the property a field trigger has for free (script.ts: "a trigger a card
// registers while it is in a given zone") and a player modifier does not. See the report.
//
// "Your cards" is the controller's own plays, and R119 excludes the play that puts this Field Spell
// onto the field; both live in `answers` below.
//
// X of 0 returns no effect rather than a 0-damage instance: `dealDamage` treats a hit of 0 as no
// damage instance at all (R63), so the two are the same to the state, and an empty list keeps the
// event log clean.

import type { EffectContext, Script, TriggerDef } from "@jackioh/engine";
import { cardsPlayedThisTurn } from "@jackioh/engine";
import { damage } from "@jackioh/engine/effects";
import type { GameEvent } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-038");

/** §8.2 Engine: the count `turnLog.cardsPlayed` holds already includes the card being played. */
const COUNTS_ITSELF = 1;

type PlayEvent = Extract<GameEvent, { type: "cardPlayed" }>;

/**
 * Whether this play is one Quickstriker answers, the same shape #33 Unstable Clone Machine uses.
 *
 * R119 — "a permanent does not answer its own arrival": §10.5 step 4 (`playSteps.placeStep`) puts
 * the card on the field, counts the play and emits `cardPlayed`, and only THEN calls `settle`, so
 * the arriving card is already a registered watcher when §10.3 dispatches its own arrival. The
 * engine enforces R119 for one class of holder only: `traps.trapsWatching` drops a trap from the
 * events that name the trap itself (`isOwnArrival`, over `cardPlayed`/`summoned`/`cardResolved`),
 * and `triggers.dispatchEvent` then skips every `holder.isTrap` so the traps are not queued twice.
 * Nothing filters the queued holders by instance, so a permanent that is not a Trap owes the check
 * inside its own trigger, by comparing the event's instance against `ctx.self`. Quickstriker is a
 * Field Spell, not a Trap, so without this it would count its own play and a Quickstriker played
 * second would open with 1 damage.
 *
 * The arrival is excluded from ANSWERING, not from the count: the play still raises
 * `turnLog.cardsPlayed`, so the next card played reads it as one of the cards played earlier (§6.2).
 *
 * "Your cards" is the controller's own plays, read off `ctx.self` rather than `ctx.controller`
 * because the card's own controller is unambiguous however the dispatcher centres the context
 * (R33 lets a stolen Field Spell read "you" as its new controller, which is what `self.controller`
 * already is).
 */
function answers(ctx: EffectContext, event: PlayEvent): boolean {
  const self = ctx.self;
  if (self === null) return false;
  if (event.instanceId === self.id) return false;
  return event.player === self.controller;
}

const combo: TriggerDef = {
  id: "quickstriker-combo",
  on: ["cardPlayed"],
  run: (ctx) => {
    const event = ctx.event;
    if (event.type !== "cardPlayed" || !answers(ctx, event)) return [];

    const x = Math.max(0, cardsPlayedThisTurn(ctx.state, event.player) - COUNTS_ITSELF);
    return x === 0 ? [] : [damage({ to: { of: "enemyHero" }, amount: x })];
  },
};

export const base: Script = { triggers: [combo] };

/** §8: no radiant text, so BUILD M4-T1 makes the radiant face the base face. */
export const radiant: Script = base;

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
// declares. That member has no reader anywhere in the engine — `mana.ts` only consumes
// `costDiscount`, and nothing in `modifiers.ts`, `reduce.ts` or `resolve.ts` looks at it — so a
// modifier would be inert, and it would also outlive the card's zone, which "Your cards gain …"
// must not: §8.2's "nothing when not on the field" is exactly the property a field trigger has for
// free (script.ts: "a trigger a card registers while it is in a given zone") and a player modifier
// does not. See the report.
//
// "Your cards" is the controller's own plays, so the trigger filters on `event.player`. It reads
// the controller off `ctx.self` rather than off `ctx.controller`, because the trigger dispatcher
// (engine/src/triggers.ts) does not exist yet and may well build the context around the event's
// player; the card's own controller is unambiguous either way.
//
// X of 0 returns no effect rather than a 0-damage instance: `dealDamage` treats a hit of 0 as no
// damage instance at all (R63), so the two are the same to the state, and an empty list keeps the
// event log clean.

import type { Script, TriggerDef } from "@jackioh/engine";
import { cardsPlayedThisTurn } from "@jackioh/engine";
import { damage } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-038");

/** §8.2 Engine: the count `turnLog.cardsPlayed` holds already includes the card being played. */
const COUNTS_ITSELF = 1;

const combo: TriggerDef = {
  id: "quickstriker-combo",
  on: ["cardPlayed"],
  run: (ctx) => {
    const event = ctx.event;
    if (event.type !== "cardPlayed") return [];

    // "Your cards": the controller of this Field Spell, not whoever the dispatcher centres on.
    const owner = ctx.self?.controller ?? ctx.controller;
    if (event.player !== owner) return [];

    const x = Math.max(0, cardsPlayedThisTurn(ctx.state, owner) - COUNTS_ITSELF);
    return x === 0 ? [] : [damage({ to: { of: "enemyHero" }, amount: x })];
  },
};

export const base: Script = { triggers: [combo] };

/** §8: no radiant text, so BUILD M4-T1 makes the radiant face the base face. */
export const radiant: Script = base;

// #89 Corpse Eater (SPEC §8.5, §6.2, §10.3, §10.4, R11, R38, R68, R78, R89).
//
// Base: "Rush. While in your hand: whenever a unit on either side dies, this gains its attack and
// max health". Radiant: "Rush, Divine Shield; gains double".
//
// §8's Conventions: the radiant cell lists keywords without "Plus", so `Rush, Divine Shield` is the
// radiant face's COMPLETE keyword list — and both keyword lists are printed data in
// `catalog.json`, read as §10.4 layer 1, so no line of script grants them. The only clause the
// radiant cell restates is the gain, and it changes one number: doubled.
//
// A HAND-ZONE TRIGGER. `handTriggers` is the list `triggers.ts` registers for a card whose zone is
// a hand; a card on the field registers `triggers` instead and one in a graveyard registers
// nothing (§10.3, R68). So "while in your hand" and the must-pass row's "stops once on the field"
// are both the registry's doing: this file declares the trigger under `handTriggers` and nothing
// more. Hand triggers fire in hand order, after both sides' field and backrow triggers (R68).
//
// WHY IT READS THE EVENT AND NOT THE INSTANCE (R89, R78). R78 resets an instance as it leaves the
// field — damage, buffs, granted keywords, counters, position, controller — and every trigger but
// the Death hook is queued and runs after that. R89 is the answer: "the `destroyed` event carries
// what the card was: its owner, its attack and max health as the layers computed them at the moment
// it died, and `killerId`". So `event.attack` and `event.maxHealth` ARE R38's "current attack and
// max health": post-buff, post-aura, post-Fuse, on the face that was running. There is nothing left
// on the instance to read, and `findInstance` on a vanished token would find nothing at all.
//
// WHICH DEATHS COUNT. §8's Engine cell: "a death is a unit going from the field to a graveyard, a
// sacrifice included (§6.2) … a card that reaches a graveyard from a hand (#80's discard, #76's
// replaced hand) never died, so it does not count, and tokens never reach a GY at all (R11)".
// Three filters, and only one of them is this card's:
//
//   1. "from the field" — free. The `destroyed` event has exactly two emitters, `stateCheck`'s
//      §4.5 step 1 and `effects/destroy.ts`'s `sacrifice`, and both require `zone.z === "field"`.
//      A discard, a burn and a bounce emit `discarded`, `burned` and `bounced` instead, so a card
//      that reached a graveyard from a hand never produces this event and cannot feed the Eater.
//   2. "a unit" — this card's. The state check also marks and collects BACKROW cards (a destroyed
//      Field Spell or Trap), and they emit the same event, so the def's type is checked.
//   3. "tokens never feed Corpse Eater" (R11's own words in its card list) — this card's. A unit
//      token IS collected by §4.5 and DOES emit `destroyed`; `moveToZone` then makes it cease to
//      exist instead of entering a graveyard. The event cannot tell, so the def's `token` flag is
//      what excludes it. `token` is printed catalog data, never a layer, so `defOf` is the read.
//
// `defOf(state, defId)` is the engine's own catalog read, so the def comes from the same place the
// layers read it — including a transient Fuse def (R77), whose `type` and `token` are still right.
//
// WHERE THE GAIN LIVES. `buff` is §10.4 layer 4, stored on the instance as `buffs`, which is
// exactly where a stat change has to live for a card that is not on the field: layer 1 is the
// printed face and layer 5 is auras, neither of which a hand card can carry. R78 only resets buffs
// when a card LEAVES the field, and this one enters it carrying them (`placeOnField` resets
// nothing), so an Eater that ate 8/8 worth of corpses in hand is played as a 10/10.

import type { Effect, Script, TriggerDef } from "@jackioh/engine";
import { defOf } from "@jackioh/engine";
import { buff } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-089");

/** `factor` is the whole of the radiant text: 1 gains its stats, 2 gains double (§8 Conventions). */
function feed(factor: number): TriggerDef {
  return {
    id: "corpse-eater-feed",
    on: ["destroyed"],
    run: (ctx): Effect[] => {
      const event = ctx.event;
      // `on` already narrows this, and the check is what gives the payload its type.
      if (event.type !== "destroyed") return [];

      const dead = defOf(ctx.state, event.defId);
      // A destroyed Field Spell or Trap emits the same event; only units feed it.
      if (dead.type !== "Unit") return [];
      // R11: a unit token ceases to exist and never reaches a graveyard, so it never died for this.
      if (dead.token) return [];

      // R38, R89: the attack and max health the layers computed at the moment it died. R219: a gain
      // is never a loss, so a unit #46 starved below 0 max health gives nothing rather than shrinking
      // the Eater (§10.4 floors attack at 0 already; max health below 0 is only the check's signal).
      return [
        buff({
          target: { of: "self" },
          attack: Math.max(0, event.attack) * factor,
          health: Math.max(0, event.maxHealth) * factor,
        }),
      ];
    },
  };
}

export const base: Script = { handTriggers: [feed(1)] };

export const radiant: Script = { handTriggers: [feed(2)] };

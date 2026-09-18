// #41 Sheepish (SPEC §8.2). Trap, cost 1, Epic.
//   Base:    "When the opponent plays a Unit: Transform it into a Sheep Token"
//   Radiant: "Also add a Lava Golem costing 0 to your hand" — §8 Conventions: "Also" adds an
//            effect and every base clause the cell does not restate is kept, so the radiant face is
//            the same Transform plus the Lava Golem.
//
// TIMING (R17, §10.5 step 4, §10.3). The §8 Engine cell is "Fires on the play, before the Cry
// resolves (ruling), so the Cry is lost". That is not a field on this trigger: it is which event it
// watches. §10.5 step 4 moves the card to the field, emits `cardPlayed` and says "Sheepish fires
// here for Units"; step 5 is the Cry. §10.3's resolution loop offers every freshly emitted event to
// the traps first ("Traps check events, fire immediately"), and `traps.ts` restates it: "Sheepish
// fires on the `summoned`/`cardPlayed` pair emitted at step 4, before the Cry of step 5; Bear
// Honeypot, Unstable Clone Machine and Unlicensed Experimentation fire on the events step 7 emits,
// after the card has resolved (R61)". So watching `cardPlayed` IS "before the Cry".
//
// `cardPlayed` rather than `summoned`: the row's condition is "the opponent PLAYS a Unit", and
// `cardPlayed` is the event that carries the player who played it and the cost paid, where
// `summoned` also covers Recruit, copies, tokens and Reborn — none of which is a play (R1, R61).
//
// ARMING (R61). `traps.ts` rules that `run` returning `[]` is "a trap that fired for nothing" and
// "can never mean 'this event was not mine'", so every condition that must leave the trap armed and
// face-down lives in the `when` predicate: the opponent's play, and a Unit. A Spell, a Field Spell,
// a Trap, or the controller's own Unit therefore leaves Sheepish set.
//
// IMMUTABLE (R17, R23). `transform` already refuses an Immutable target, which is exactly R17's
// "Sheepish on an Immutable unit still fires and is consumed with no effect". This card neither
// checks Immutable nor consumes itself: `fireTrap` emits `trapFired`, runs the state check and
// consumes the trap "whatever its effects achieved". R33's face-down identity is the view's.

import type { Effect, Script, TrapTrigger } from "@jackioh/engine";
import { defOf } from "@jackioh/engine";
import { addToHand, transform } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-041");

/** §7: the Sheep Token, whose only generator is this card. */
const SHEEP_TOKEN = "core-t-sheep";
/** #55 Lava Golem, added by the radiant text at cost 0 (`costOverride`, R65). */
const LAVA_GOLEM = "core-055";

/** The two faces differ only in whether the Lava Golem comes with the Sheep. */
function sheepish(lavaGolem: boolean): TrapTrigger {
  return {
    id: lavaGolem ? "sheepish-radiant" : "sheepish",
    on: ["cardPlayed"],
    when: (ctx) => {
      const event = ctx.event;
      if (event.type !== "cardPlayed") return false;
      // §8: "the opponent". A trap never answers its own controller's play.
      if (event.player === ctx.controller) return false;
      // §5.1: a Unit, so a Spell or a backrow card leaves the trap armed (R61).
      return defOf(ctx.state, event.defId).type === "Unit";
    },
    run: (ctx) => {
      const event = ctx.event;
      if (event.type !== "cardPlayed") return [];
      // Named by the event, not by a TargetSpec: nobody chose this unit, the play produced it.
      const effects: Effect[] = [transform({ instanceId: event.instanceId, defId: SHEEP_TOKEN })];
      // R120: §8's conventions make an "Also" clause independent, so it still lands when an
      // Immutable target refused the Transform (R17, R23) and the trap is still consumed (R61).
      if (lavaGolem) effects.push(addToHand({ defId: LAVA_GOLEM, costOverride: 0 }));
      return effects;
    },
  };
}

const baseTrigger = sheepish(false);
const radiantTrigger = sheepish(true);

export const base: Script = { triggers: [baseTrigger] };

export const radiant: Script = { triggers: [radiantTrigger] };

// #35 Lunar Eclipse (SPEC §8.2 row 35): "Deal 3 damage to a target; the next Spell you play this
// turn costs 1 less", radiant "6 damage; 2 less".
//
// The radiant cell changes only the two numbers, so both clauses stay (§8 Conventions).
// R81: the target travels in the `play` action and resolution never pauses.
//
// The discount is a player-level `PlayerModifier` (engine/src/state.ts), and the engine already
// reads every part of the shape below:
//   * `effectiveCost` (mana.ts) subtracts a live `costDiscount` and skips one whose `onlyType` is
//     not the card's type, which is what makes a unit play leave the discount alone;
//   * `expireModifiers` (modifiers.ts) drops a `{ until: "thisTurn" }` modifier at cleanup, which
//     §2.2 names with this card ("Cleanup expires every 'this turn' effect (the Lunar Eclipse
//     discount, …)");
//   * `oncePerTurn` on the `costDiscount` variant is the "consumed on use" half of the §8.2 Engine
//     cell: without it every Spell this turn would be cheaper, not just the next one.
//
// MISSING VERB (reported; #64, #77, #78 and #79 import the same verb, so one implementation serves
// all five cards):
//
//   addPlayerModifier({ player?: PlayerSpec; mod: DistributiveOmit<PlayerModifier, "id"> })
//       Wraps `modifiers.addModifier(ctx, playerOf(ctx, player ?? "self"), mod)`, which assigns the
//       id and emits `modifierChanged`. `effects/index.ts` has no modifier verb at all today —
//       `gainMana` and `nextTurnMana` are the only player-level verbs and neither touches
//       `side.mods` — and `addModifier` itself is engine code a card script may not call
//       (CLAUDE.md rule 5).
//
// A SECOND, SMALLER ENGINE GAP (reported): nothing consumes the discount on use. `consumeModifier`
// exists and is called from nowhere, and `oncePerTurn` is read by nothing, so `reduce`'s play case
// has to consume a `oncePerTurn` `costDiscount` once it has applied.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { addPlayerModifier, damage } from "@jackioh/engine/effects";
import type { TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-035");

/** R81: "target" is any unit or hero (§8 Conventions), chosen with the play. */
const targets: TargetDecl[] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } },
];

/** 3 damage and −1, or 6 and −2. Both numbers come from the same cell, so one builder. */
function eclipse(amount: number, discount: number): (ctx: EffectContext) => Effect[] {
  return (ctx) => [
    damage({ to: { of: "chosen" }, amount }),
    addPlayerModifier({
      player: "self",
      mod: {
        kind: "costDiscount",
        amount: discount,
        // "the next Spell you play": Spells only, and only the next one.
        onlyType: "Spell",
        oncePerTurn: true,
        // §2.2: cleanup takes it if no Spell used it.
        expiry: { until: "thisTurn", turn: ctx.state.turn },
      },
    }),
  ];
}

export const base: Script = { targets, cry: eclipse(3, 1) };

export const radiant: Script = { targets, cry: eclipse(6, 2) };

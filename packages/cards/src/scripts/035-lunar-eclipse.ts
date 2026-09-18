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
// `addPlayerModifier` has since landed in `effects/index.ts`, so the verb this file needed exists.
//
// ONE ENGINE GAP IS LEFT, AND IT IS WHY `only the NEXT Spell is cheaper` IS RED. Nothing consumes
// the discount on use. `playSteps.consumeUsedDiscounts` is the only consumer in the tree and its
// predicate is `mod.expiry.until !== "used" → skip`, while `oncePerTurn` — declared on the
// `costDiscount` variant at `state.ts:72` — is read by no source file at all. So every Spell played
// this turn is cheaper, not just the next one.
//
// THE CARD CANNOT FIX THIS BY CHANGING ITS EXPIRY, which was tried and measured:
//   * `{ until: "used" }` does get the discount consumed on the first Spell — and then leaks. It is
//     `modifiers.expireModifiers` that runs at cleanup, and it keeps everything that is neither
//     `thisTurn` nor a due `nextTurnOf`. So the discount survives into later turns, against §2.2's
//     own sentence ("Cleanup expires every 'this turn' effect (the Lunar Eclipse discount, …)") and
//     against the §8.2 Engine cell's "consumed on use OR AT CLEANUP". Two green cases in
//     `test/035-lunar-eclipse.test.ts` go red on it: "the discount expires at cleanup" (both faces)
//     and "a Spell on a later turn pays full price".
//   * Nor can `expireModifiers` simply drop every `{ until: "used" }` modifier at cleanup: R30 and
//     §2.2 require the other one, #79 Twinspell's `echoNextSpell`, to SURVIVE cleanup.
//   * And no card-side workaround exists: `addPlayerModifier` is the only player-modifier verb in
//     the barrel — there is nothing that removes or consumes one — so a script cannot retire its
//     own rider at end of turn.
//
// THE FIX IS ONE LINE OF ENGINE, in `playSteps.consumeUsedDiscounts`: treat `oncePerTurn: true` as
// a second way of saying "consumed on use", alongside `{ until: "used" }` —
//
//     if (mod.kind !== "costDiscount") continue;
//     if (mod.expiry.until !== "used" && mod.oncePerTurn !== true) continue;
//
// — which leaves the expiry below free to be `thisTurn`, so §2.2's cleanup still takes an unused
// discount. Nothing else in the tree sets `oncePerTurn`, so the blast radius is this card alone.

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

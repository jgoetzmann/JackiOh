// #77 Professor Curvature (SPEC §8.3, R48, R65, §2.2, §10.1).
//
// Base: "Cry: during your next turn, cards whose cost is 4 cost 1 less"; the radiant cell is
// "2 less", a cell that changes only a number, so it changes only that number (§8 Conventions).
// Stats are 4/5 → 8/10 and come from the catalog; nothing about them belongs in this file.
//
// §8's Engine cell: "Delayed player modifier, checked against current cost at play; expires at that
// turn's cleanup." That is one `PlayerModifier`, not a delayed effect:
//
//   R48  "Applies to cards whose current cost is 4 at play time" → `onlyCurrentCost: 4`, which
//        `mana.effectiveCost` reads AFTER `costMod` and the flat discounts, exactly where R65 puts
//        it: "add player discounts; apply Professor Curvature if the result is then 4; floor at 0".
//        So a printed-5 card the board has already discounted to 4 is caught, and a printed-4 card
//        another discount has already taken to 3 is not.
//   R48  "during your NEXT turn" → `{ until: "nextTurnOf", player, fromTurn }`. `mana.modifierIsLive`
//        answers false while `state.turn === fromTurn`, so the discount does nothing on the turn
//        Curvature was played, and `modifiers.expireModifiers` drops it at the cleanup of that
//        player's next turn (§2.2: "Cleanup expires … Professor Curvature's discount on its turn").
//
// The modifier sits on the controller's own `mods`, so it is read only when that player's cards are
// costed; the opponent's turn in between cannot reach it even while it is live.
//
// Missing verb (see the report): `addPlayerModifier({ player, mod })`. `modifiers.addModifier` is
// the engine-side implementation and is not exported by `effects/index.ts`, so there is no way for a
// card to install a player modifier without writing state itself (CLAUDE.md rule 5 forbids that).

import type { Script } from "@jackioh/engine";
import { addPlayerModifier } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-077");

/** R48: the current cost the discount looks for, checked after every other modifier (R65). */
const TARGET_COST = 4;

/** The two faces differ only in how much the discount is worth. */
function professorCurvature(amount: number): Script {
  return {
    cry: (ctx) => [
      addPlayerModifier({
        player: "self",
        mod: {
          kind: "costDiscount",
          amount,
          onlyCurrentCost: TARGET_COST,
          // R48: it covers the controller's NEXT turn, so it survives the turn it was created on.
          expiry: { until: "nextTurnOf", player: ctx.controller, fromTurn: ctx.state.turn },
        },
      }),
    ],
  };
}

export const base: Script = professorCurvature(1);

export const radiant: Script = professorCurvature(2);

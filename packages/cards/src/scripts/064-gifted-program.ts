// #64 Gifted Program (SPEC §8.3, §10.1, §10.5 step 3, §5.2, R56, R70, R74, R78).
//
// Base: "The first card costing 1 or less you play each turn becomes Radiant as it is played".
// Radiant: "2 or less" — §8's Conventions make that a change to the threshold only.
//
// §8.3's Engine cell is "Pre-resolution hook; cost = cost paid; per-turn flag", and §10.5 step 3 is
// that hook's place in the play sequence: after the cost is paid (step 2) and before the card is
// moved or resolved (steps 4 and 5). `playSteps.ts` calls step 3 by running every `onPlayHook` on
// the board in R68's order, handing each one the played card as its single target and
// `{ playedId, playedBy, costPaid }` as its data — so `onPlayHook` IS this card and this hook is
// the whole of it. Setting the flag here is what makes step 5 run the radiant text (§5.2, R74):
// the card is still in hand, and R74's in-hand swap means its script and stats swap on the next
// read.
//
// Every card's play runs this hook, both players' included, so the hook checks three things:
//   - "you play": `playedBy` is this Field Spell's own controller;
//   - R56: the cost compared is the one ACTUALLY PAID after every modifier, which is what
//     `costPaid` carries — a 2-cost card discounted to 1 qualifies under the base face, and a cast
//     pays 0 and so always qualifies (R70);
//   - "the first ... each turn": the per-turn flag, which §10.1 puts on the card's own instance as
//     the turn it last fired on. R78 clears instance memory when the card leaves the field, which
//     is also what should happen to the flag.
//
// Gifted Program cannot catch its own play: step 3 runs before step 4 puts it on the board, so it
// is not among the hooks that run for itself.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { remember, setRadiant } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-064");

/** The per-turn flag (§8.3), kept in this instance's own memory (§10.1). */
const USED_TURN = "giftedUsedTurn";

/**
 * §10.9: a hook may READ state to compute an effect's arguments; it never writes. The two reads
 * here are this instance's own memory and the turn counter.
 */
function alreadyFiredThisTurn(ctx: EffectContext): boolean {
  const used = ctx.self?.memory[USED_TURN];
  return typeof used === "number" && used === ctx.state.turn;
}

/** `maxCost` is the printed threshold: 1 on the base face, 2 on the radiant one. */
function giftedProgram(maxCost: number): Script {
  return {
    onPlayHook: (ctx): Effect[] => {
      if (ctx.self === null) return [];
      // "you play": the hook runs for every play on the board, this side's and the other's.
      if (ctx.data["playedBy"] !== ctx.controller) return [];

      // R56: the cost actually paid, which step 2 has already settled.
      const costPaid = ctx.data["costPaid"];
      if (typeof costPaid !== "number" || costPaid > maxCost) return [];

      if (alreadyFiredThisTurn(ctx)) return [];

      return [
        remember({ key: USED_TURN, value: ctx.state.turn }),
        // The played card is step 3's single target; the flag is set before step 5 resolves it.
        setRadiant({ target: { of: "chosen" } }),
      ];
    },
  };
}

export const base: Script = giftedProgram(1);

export const radiant: Script = giftedProgram(2);

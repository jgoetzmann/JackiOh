// #31 KY's Math Equation (SPEC §8.2 row 31): "Deal Fib(cost+1) damage to a target. End of turn:
// return to hand with cost +1", radiant "Fib(cost+2)".
//
// Three rulings drive the whole card:
//   R67  the Fib index is printed cost + `costMod` + 1 (radiant + 2). Player discounts and the cost
//        actually paid are ignored, so the index reads `printedCost` + `costMod` and never
//        `effectiveCost` (R65 is the calculation this deliberately does NOT use).
//   R25  Fib = 0,1,1,2,3,5,8,13,21,34,55,89 and the index clamps at 11, which is what `fib` in
//        engine/src/config.ts already does — nothing here re-derives Fibonacci.
//   R78  `costMod` persists in every zone, so each return leaves the +1 on this instance for good
//        and the sequence is 1 → 2 → 3 → 5 damage as the card is replayed.
//
// The return is an `endOfTurn` hook on a Spell that is sitting in its owner's graveyard: §5.1's
// "add this back to your hand" spells are found there by `triggerHoldersWithHook` (triggers.ts,
// R68), which unlike `turn.ts`'s `triggerOrder` reaches the hand and the graveyard. The hook is
// one-shot by reading the turn log: the return happens on the turn the card was played, not at
// every end of turn for the rest of the game.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { fib, printedCost, wasPlayedThisTurn } from "@jackioh/engine";
import { bounce, damage, setCostMod } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-031");

/** R67: printed cost + `costMod` + 1, radiant + 2. Discounts and the cost paid are ignored. */
function fibIndex(ctx: EffectContext): number {
  const self = ctx.self;
  if (self === null) return 0;
  return printedCost(ctx.state, self) + self.costMod + (ctx.radiant ? 2 : 1);
}

/** R25: `fib` clamps the index at 11, so the damage tops out at 89. */
function blast(ctx: EffectContext): Effect[] {
  return [damage({ to: { of: "chosen" }, amount: fib(fibIndex(ctx)) })];
}

/**
 * "End of turn: return to hand with cost +1". Only on the turn it was played: the spell stays in the
 * graveyard when its hand is full (`bounce` burns it back, §2.4), and a card that is still there on
 * a later turn is no longer returning, so the turn log — which `startTurn` clears — is the gate.
 */
function returnToHand(ctx: EffectContext): Effect[] {
  const self = ctx.self;
  if (self === null) return [];
  if (self.zone.z !== "graveyard") return [];
  if (!wasPlayedThisTurn(ctx.state, self.owner, self)) return [];
  // R78: the +1 rides on the instance in every zone, so it is what the next play's Fib index reads.
  return [setCostMod({ amount: 1 }), bounce({ target: { of: "self" } })];
}

/** R81: the target travels in the `play` action; "target" is any unit or hero (§8 Conventions). */
const targets: Script["targets"] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } },
];

export const base: Script = {
  targets,
  cry: blast,
  endOfTurn: returnToHand,
};

// The radiant cell restates only the damage number, so the return clause is kept (§8 Conventions).
export const radiant: Script = {
  targets,
  cry: blast,
  endOfTurn: returnToHand,
};

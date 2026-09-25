// #31 KY's Math Equation (SPEC §8.2 row 31): "Deal Fib(cost+1) damage to a target. End of turn:
// return to hand with cost +1", radiant "Deal Fib(cost+3) damage to a target. …" (R275 raised it
// from Fib(cost+2)).
//
// Four rulings drive the whole card:
//   R67  the Fib index is printed cost + `costMod` + 1 (radiant + 3). Player discounts and the cost
//        actually paid are ignored, so the index reads `printedCost` + `costMod` and never
//        `effectiveCost` (R65 is the calculation this deliberately does NOT use). That cost still
//        floors at 0 as every cost does (§2.3), so #95's "costs 2 less" on a 1-cost Equation leaves
//        cost 0 and Fib(1), not a negative cost and Fib(0).
//   R25  Fib = 0,1,1,2,3,5,8,13,21,34,55,89 and the index clamps at 11, which is what `fib` in
//        engine/src/config.ts already does — nothing here re-derives Fibonacci.
//   R78  `costMod` persists in every zone, so each return leaves the +1 on this instance for good
//        and the sequence is 1 → 2 → 3 → 5 damage as the card is replayed (radiant 3 → 5 → 8 → 13).
//   R280 the damage it would deal now is the card's `preview`, labelled with the running face's
//        "Fib(cost+1)" / "Fib(cost+3)", off the same `damageNow` its Cry deals. It reads the card's
//        own cost and nothing else, so it shows wherever the card may be read (§10.8).
//
// The return is an `endOfTurn` hook on a Spell that is sitting in its owner's graveyard: §5.1's
// "add this back to your hand" spells are found there by `triggerHoldersWithHook` (triggers.ts,
// R68), which unlike `turn.ts`'s `triggerOrder` reaches the hand and the graveyard. The hook is
// one-shot by reading the turn log: the return happens on the turn the card was played, not at
// every end of turn for the rest of the game.

import type { CardInstance, Effect, EffectContext, GameState, Script } from "@jackioh/engine";
import { fib, printedCost, wasPlayedThisTurn } from "@jackioh/engine";
import { bounce, damage, setCostMod } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-031");

/** §8: what each face adds to the cost before taking the Fibonacci number, "Fib(cost+1)" / "Fib(cost+3)". */
const FIB_OFFSET = { base: 1, radiant: 3 } as const;

/** R280: the formula as each face prints it, which the preview labels its number with. */
const FORMULA = { base: "Fib(cost+1)", radiant: "Fib(cost+3)" } as const;

/**
 * R67: printed cost + `costMod`, floored at 0 as every cost is (§2.3, §6.3 Cost), then + 1, radiant
 * + 3. Discounts and the cost paid are ignored.
 */
function fibIndex(state: GameState, self: CardInstance, radiant: boolean): number {
  return Math.max(0, printedCost(state, self) + self.costMod) + FIB_OFFSET[radiant ? "radiant" : "base"];
}

/**
 * The damage the card deals if it resolves now — the Cry's amount and the preview's value, one
 * function so the two cannot disagree (R280). R25: `fib` clamps the index at 11, so it tops out at 89.
 */
function damageNow(state: GameState, self: CardInstance, radiant: boolean): number {
  return fib(fibIndex(state, self, radiant));
}

function blast(ctx: EffectContext): Effect[] {
  const self = ctx.self;
  return [damage({ to: { of: "chosen" }, amount: self === null ? fib(0) : damageNow(ctx.state, self, ctx.radiant) })];
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
  // It is the price of the return, so it lands only on a card that reached the hand: a full hand
  // burns the card back to the graveyard (§2.4, R4), which is no return at all.
  return [bounce({ target: { of: "self" } }), setCostMod({ amount: 1, inHandOnly: true })];
}

/** R81: the target travels in the `play` action; "target" is any unit or hero (§8 Conventions). */
const targets: Script["targets"] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } },
];

/**
 * R280: "Fib(cost+1) {n}" — the damage it deals if played now, in hand, and as the card stands
 * wherever else it may be read. It reads its own cost, which is the card's (§9.1): `viewFor` shows
 * it only where the card itself is shown, never on the opponent's hand.
 */
const preview: Script["preview"] = (ctx) => [
  { label: FORMULA[ctx.radiant ? "radiant" : "base"], value: damageNow(ctx.state, ctx.self, ctx.radiant) },
];

export const base: Script = {
  targets,
  cry: blast,
  endOfTurn: returnToHand,
  preview,
};

// The radiant face changes only the Fibonacci offset (R275), so the return clause is kept.
export const radiant: Script = {
  targets,
  cry: blast,
  endOfTurn: returnToHand,
  preview,
};

// #21 Hinder (SPEC §8.2): "Cast on draw: the opponent's next mana refresh is 1 lower", radiant
// "2 lower" — a Radiant cell that changes only a number changes only that number (§8 Conventions).
//
// Nothing here casts the card or draws again: `staticFlags.castOnDraw` is the whole of that, and
// `drawOne` (engine/src/draw.ts) casts it, repeats the draw and stops at CAST_ON_DRAW_CHAIN_CAP
// (R58), while `castCard` makes the cast free and counts it as a card played (R40, R70).
//
// The floor is not this card's either: `nextTurnMana` moves `mana.nextTurnMod`, and §2.3's
// `maxManaFor` floors `min(turnsStarted, MAX_MANA) + permMod + nextTurnMod` at 0, after which
// `refreshMana` clears the one-shot modifier. So a −2 against a 1-mana refresh is 0, not −1.

import type { Script } from "@jackioh/engine";
import { nextTurnMana } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-021");

/** The only difference between the two faces is how much lower the opponent's refresh is. */
function hinder(lower: number): Script {
  return {
    staticFlags: { castOnDraw: true },
    cry: () => [nextTurnMana({ amount: -lower, player: "enemy" })],
  };
}

export const base: Script = hinder(1);

export const radiant: Script = hinder(2);

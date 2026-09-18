// #84 Going Long (SPEC §8.4 row 84): Field Spell, Quickdraw, cost 2 embiggen 4, Rare.
//   Base:    "Your hero has Armor 2 (paid 4: 5)"
//   Radiant: "Armor 4 (paid 4: 10)" — the cell changes only the two numbers (§8 Conventions).
//   Engine:  "Hero armor in pipeline step 2".
//
// So the card is four numbers on one axis (base/radiant) times another (the embiggen price paid):
//     paid 2 → 2   paid 4 → 5   |   radiant paid 2 → 4   radiant paid 4 → 10
// The embiggen choice is a play-time choice that lands on the instance (`reduce.ts` sets
// `card.embiggened`, R81), and the radiant face is the instance's flag, so both axes are readable
// off the card that is sitting in the backrow — and both are read there, by the engine, not here.
//
// QUICKDRAW is §6.2's `quickdraw` static flag: `setup.ts` moves every library card carrying it into
// the opening hand, where each one replaces one of the opening draws. Both faces declare it — a
// Radiant copy in a deck still starts in hand — and nothing else about the opening hand is this
// card's business.
//
// THE ARMOR is the `heroArmor` static flag, #73 Anti-oneshot Armor's shape exactly: a flag on the
// card in the backrow that the pipeline reads, never a write to the hero. `damage.ts`'s
// `heroArmorOf(state, player)` sums the hero's own Armor and every backrow `heroArmor` grant,
// each one taking the `HERO_ARMOR` value its instance's `radiant` and `embiggened` select (R124:
// hero Armor from several sources adds up, unlike step 3's cap, which takes the smallest).
// §4.4 step 2, `subsystems/lethal`, `subsystems/scorer` and §10.8's hero block all read that one
// function, so the projections and the client cannot disagree with the hit. Two consequences the
// flag gets for free, both of them tested: the Armor stops the moment the Field Spell leaves the
// backrow, because nothing was ever stored; and "Ignores armor" (True Strike) skips step 2 whole,
// because the flag is only ever consulted inside it.
//
// `flagsOf` resolves the face off the instance, so the radiant numbers need no card-side code —
// the same trick that makes #73's "Cap 3" free.

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-084");

/**
 * Both faces are the same script: §6.2's Quickdraw flag and the `heroArmor` flag. The four values
 * live in `config.HERO_ARMOR` and are selected by the instance's `radiant` and `embiggened`, not by
 * this file — a Field Spell with no Cry, no trigger and no ability has nothing else to declare.
 */
function goingLong(): Script {
  return {
    staticFlags: { quickdraw: true, heroArmor: true },
  };
}

export const base: Script = goingLong();

/** "Armor 4 (paid 4: 10)": two numbers, both of them the pipeline's to read (`HERO_ARMOR.radiant`). */
export const radiant: Script = goingLong();

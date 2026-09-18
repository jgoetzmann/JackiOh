// #28 Knockoff Temu Glowy Jelly Bean (SPEC §8.2): "2 random cards among your library, hand and
// field become Radiant", radiant "5" — a Radiant cell that changes only a number changes only that
// number (§8 Conventions).
//
// ONE `setRadiantRandom` call, not N calls and not one call per zone. The pick has to be uniform
// over the union of the three zones and has to produce `count` DIFFERENT cards (R60), and both only
// hold if the union is pooled once and drawn from once: three calls of one card each would weight
// small zones and could repeat, and N calls of one card each would re-pool between picks.
// `effects/radiant.ts` pools the non-Radiant cards of the named zones in a fixed order (hand order,
// library top down, then lane order), shuffles that pool with the match rng and takes the first
// `count` — so it is uniform, the cards are all different, it takes all of them when fewer exist,
// and it does nothing at all when every card is already Radiant (R60).
//
// "Field" is the field as §3.2 and R13 define it, which `setRadiantRandom` already honours: both
// rows, and only the top of a Stack pile, since cards under a Stack are not on the field.
//
// A field card converts in place (§5.2, R22): setting the flag is not an entry to the field, so the
// base-stat layer swaps at once through `faceOf`/`unitView` while damage taken, buffs and granted
// keywords stay and the Cry does not re-fire. A 4/5 that has taken 2 becomes an 8/10 that has taken
// 2, i.e. 8 health. None of that is this card's code — it is what "set a flag" buys.

import type { RadiantZone } from "@jackioh/engine/effects";
import type { Script } from "@jackioh/engine";
import { setRadiantRandom } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-028");

/**
 * The union the pick is uniform over. Listed in `effects/radiant.ts`'s canonical pool order (hand,
 * then library top down, then lane order) so the draw depends only on (seed, cursor) and replays
 * exactly (§9.3); §8.2 writes the same three zones as "your library, hand and field".
 */
const ZONES: readonly RadiantZone[] = ["hand", "library", "field"];

function knockoffTemu(count: number): Script {
  return {
    cry: () => [setRadiantRandom({ zones: [...ZONES], count })],
  };
}

export const base: Script = knockoffTemu(2);

export const radiant: Script = knockoffTemu(5);

// #27 Blood Ridden Glowy Jelly Bean (SPEC §8.2): "Cast on draw: a random card in your hand becomes
// Radiant; you lose 5 health", radiant "2 random cards".
//
// The radiant cell restates only the number of random cards, so every clause it does not restate is
// kept (§8 Conventions): the cast-on-draw trigger and the 5 health both stay. `staticFlags` are read
// through `scriptOf`, which returns the radiant script once the instance is Radiant, so the radiant
// face has to carry `castOnDraw` too or a Radiant copy would go to hand uncast.
//
// Nothing here casts the card or repeats the draw: `staticFlags.castOnDraw` is the whole of that.
// `drawOne` (engine/src/draw.ts) casts the card the moment it is drawn — even with a full hand,
// since it never enters the hand — repeats the draw, and stops the chain at CAST_ON_DRAW_CHAIN_CAP
// (R58); `castCard` makes the cast free and counts it as a card played, which is what feeds Combo
// (R40, R70).
//
// "A random card in your hand" is R60's pick: `setRadiantRandom` pools only the non-Radiant cards,
// takes `count` different ones, takes all of them when fewer exist, and does nothing when the hand
// holds none. The card being cast is in the `resolving` zone while its script runs, so it can never
// pick itself.
//
// "You lose 5 health" is R18's verb, not damage: `loseHealth` bypasses Armor, the Anti-oneshot cap
// (#73 Going Long) and Fed Fauci's tokens, and it can take the hero to 0.

import type { Script } from "@jackioh/engine";
import { loseHealth, setRadiantRandom } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-027");

/** §8.2: the blood price is the same on both faces; only the number of cards changes. */
const HEALTH_LOST = 5;

function bloodRidden(count: number): Script {
  return {
    staticFlags: { castOnDraw: true },
    cry: () => [
      setRadiantRandom({ zones: "hand", count }),
      loseHealth({ player: "self", amount: HEALTH_LOST }),
    ],
  };
}

export const base: Script = bloodRidden(1);

export const radiant: Script = bloodRidden(2);

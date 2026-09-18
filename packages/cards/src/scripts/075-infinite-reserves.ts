// #75 Infinite Reserves (SPEC §8.3): "Draws from an empty library give you a Rush Token card
// instead of fatigue", radiant "Cry: draw 3; same" — "same" says so explicitly (§8 Conventions), so
// the radiant face keeps the replacement and ADDS a Cry.
//
// The replacement is a draw hook, not an effect: `staticFlags.infiniteReserves` is the whole of it.
// `drawOne` (engine/src/draw.ts) walks the player's backrow for the flag before it takes fatigue,
// creates the Rush Token card in that player's HAND — §8.3's Engine cell, "the token is a 1-cost
// hand card", so `addToHand`, never a summon — emits `drawn` for it, and returns without touching
// `fatigueCount` or dealing the R3 fatigue damage. Three things follow that this card cannot
// influence and must not duplicate:
//   - R4: the token goes through the same `addToHand` a real draw uses, so a full hand burns it;
//   - R11: a unit-token card may sit in a hand or library and ceases to exist if it leaves that
//     zone other than by being drawn or played — `moveToZone` enforces that, not this file;
//   - the token's identity: `drawOne` looks it up by §5 index "T-rush", i.e. the shipped Rush Token
//     (3/3 Rush, cost 1), so the card it gives you is a real catalog card with no override.
//
// The flag is read off the BACKROW, so this only works while Infinite Reserves is on the field; it
// is a Field Spell, so §3.2 makes it public and permanent and nothing here touches `faceUp`.
//
// The radiant Cry is an ordinary draw of 3 and fires only when the card is played from hand or cast
// (R1). It is deliberately NOT special-cased against its own flag: a radiant Infinite Reserves
// played on an empty library draws three Rush Token cards, because the flag is already in play by
// the time the Cry runs (§10.5 puts the card on the field at step 4 and fires the Cry at step 5).

import type { Script } from "@jackioh/engine";
import { draw } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-075");

/** The replacement both faces share; the radiant face adds the Cry on top of it ("same"). */
function infiniteReserves(): Script {
  return { staticFlags: { infiniteReserves: true } };
}

export const base: Script = infiniteReserves();

export const radiant: Script = {
  ...infiniteReserves(),
  cry: () => [draw({ count: 3 })],
};

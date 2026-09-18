// #47 Fig of Life (SPEC §8.2): "Heal a target 20", radiant "50" — a radiant cell that changes only
// a number changes only that number (§8 Conventions), so the two faces are one effect at two sizes.
//
// R19 is the whole of the §8.2 Engine cell ("any unit or hero"): the declaration below says
// `of: ["unit", "hero"]` with `side: "any"`, so the picker offers both heroes and every unit on
// either side, and healing the opponent's board is legal if the player wants it.
//
// The pick is a DECLARED play-time target, so it travels in the play action's `targets` and never
// pauses resolution (R81); `legalActions` builds the picker from the declaration without running
// this script, and R90 validates what the play carried. It arrives as `{ of: "chosen" }`. An empty
// target set — no units and, impossibly, no heroes — fizzles and the spell still counts as played
// (§8 Conventions).
//
// What "heal 20" means is §6.3's Heal row, not this card's: a unit loses up to 20 damage and never
// rises past its max health (healing never raises max health), while a hero simply gains 20 health
// with no cap, because §3 gives a hero no maximum — a 30-health hero reaches 50. `effects/heal.ts`
// is that split, so this file only names the amount.

import type { Script } from "@jackioh/engine";
import { heal } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-047");

/** The two faces differ only in how much the target is healed. */
function figOfLife(amount: number): Script {
  return {
    // R19: any unit or hero, either side.
    targets: [{ kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } }],
    cry: () => [heal({ target: { of: "chosen" }, amount })],
  };
}

export const base: Script = figOfLife(20);

export const radiant: Script = figOfLife(50);

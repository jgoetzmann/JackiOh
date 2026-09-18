// #19 Midrange Menace (SPEC §8.1): 9/9 → 18/18, "Taunt; End of turn: heal to full", radiant
// "Taunt, Immutable; same". Engine cell: "Heal removes all damage".
//
// The radiant cell lists keywords without "Plus", so `[Taunt, Immutable]` is the radiant form's
// complete keyword list, and "same" restates the end-of-turn clause verbatim (§8 Conventions) — so
// both faces carry the identical hook.
//
// Neither keyword is granted here. Taunt on the base face and Taunt + Immutable on the radiant face
// are PRINTED in the catalog (`def.base.keywords`, `def.radiant.keywords`) and §10.4's layer system
// applies them: `combat.ts`'s `tauntWall` enforces the Taunt and R23's scope ("blocks Vanilla,
// Transform … on the Immutable card itself; Radiant still allowed") is the effects library's, in
// `effects/transform.ts`. A script that re-granted a printed keyword would double it.
//
// "End of turn" is the controller's own end of turn (§6.2): `turn.ts`'s
// `triggerOrder(sink, "endOfTurn", player)` is narrowed to the active player, so this never fires on
// the opponent's end — the same reading as #13's "not on the opponent's end".
//
// "Heal to full" is §6.3's Heal with `toFull`, which takes ALL of the unit's damage off and raises
// nothing: `healToFull` in `damage.ts`. §4's "damage stays on a unit between turns … only a heal or
// leaving the field takes it off" is why the card needs this at all.

import type { Script } from "@jackioh/engine";
import { heal } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-019");

/** The one clause both faces share; a fresh Script per face so neither can be mutated into the other. */
function menace(): Script {
  return {
    endOfTurn: () => [heal({ target: { of: "self" }, toFull: true })],
  };
}

export const base: Script = menace();

export const radiant: Script = menace();

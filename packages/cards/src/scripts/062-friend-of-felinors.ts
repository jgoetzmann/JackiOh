// #62 Friend of Felinors (SPEC §8.3, §7, R64).
//
// Base: "Fill your board with Felinor Tokens". Radiant: "Then your units get +2/+2", which §8's
// Conventions read as an addition ("Then") rather than a replacement, so the radiant face fills the
// board first and buffs afterwards.
//
// R64 defines "fill your board": every empty, unlocked unit zone, left to right — so an occupied
// zone is untouched and a full board produces nothing. `fillBoard` is that verb; this file never
// counts zones itself.
//
// §8.3's Engine cell for the radiant face is "Permanent buff on those instances", i.e. layer 4 of
// §10.4 on each unit rather than an aura, which is what `buffAllUnits` writes. Ordering is the
// whole of the radiant clause: the tokens are summoned by the effect BEFORE the buff effect in the
// same list, and `applyEffects` runs a list in order, so the new tokens are units the controller
// has when the buff lands and they get +2/+2 too (BUILD M4-T4 #62).

import type { Effect, Script } from "@jackioh/engine";
import { buffAllUnits, fillBoard } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-062");

/** §7's shared Felinor Token. Read through `cardDef` so a wrong id fails at import, not in play. */
const FELINOR_TOKEN = cardDef("core-t-felinor").id;

export const base: Script = {
  cry: (): Effect[] => [fillBoard({ defId: FELINOR_TOKEN })],
};

export const radiant: Script = {
  cry: (): Effect[] => [
    fillBoard({ defId: FELINOR_TOKEN }),
    // "Then your units get +2/+2": after the fill, so the new tokens are included.
    buffAllUnits({ side: "self", attack: 2, health: 2 }),
  ],
};

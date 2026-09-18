// #45 Deft Duelist (SPEC §8.2). Unit 4/3 → 8/6, Human, cost 2, Rare.
//   Base:    "Charge; may attack and switch position in the same turn"
//   Radiant: "Charge, Armor 1; same" — §8 Conventions: a keyword cell without "Plus" gives the
//            radiant face's COMPLETE keyword list (Charge and Armor 1), and "same" restates the
//            second clause explicitly, so the two exertions are on both faces.
//   Engine:  "Two exertions: one attack plus one switch."
//
// Charge and Armor 1 are PRINTED keywords: `catalog.json` carries them on `base.keywords` and
// `radiant.keywords`, and §10.4 layer 1 reads them off the def. Granting either here would be a
// second source — for Armor it would literally double it, because §10.4 sums Armor across sources.
// So the only thing this script says is the one clause no keyword covers.
//
// R49 IS A STATIC FLAG, NOT A HOOK. §4.1 gives every unit "one exertion per turn: one attack or one
// position switch", and R6 adds that switching to Attack spends that turn's exertion, so a plain
// unit that switched cannot attack — "#45 is the exception". That is a property of the card the
// attack validator and the switch action both have to read BEFORE the player acts, not an effect the
// card can return, so it lives in `staticFlags` (R49) and `combat.ts` reads it through `flagsOf`:
//
//   hasTwoExertions(unit)  →  flagsOf(unit).deftDuelist === true
//   hasExertion(unit, kind) →  attack reads `exertion.attacked`, switch reads `exertion.switched`,
//                              independently, where every other unit needs both unspent.
//
// Both orders therefore work in one turn, and only those two: attack → switch, or switch → attack
// (R6's switch to Attack Position included). It is still one attack and one switch, not two of
// either, because each exertion is its own boolean.
//
// Charge itself needs nothing here either: §4.1's summoning sickness is lifted for units AND the
// hero by Charge, which `whyCannotDeclare` reads from the computed keyword set.

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-045");

/** R49's two exertions. Identical on both faces: the radiant cell restates the clause as "same". */
function deftDuelist(): Script {
  return { staticFlags: { deftDuelist: true } };
}

export const base: Script = deftDuelist();

export const radiant: Script = deftDuelist();

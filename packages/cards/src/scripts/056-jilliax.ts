// #56 Jilliax (SPEC §8.3): 3/2 → 6/4, "Rush, Taunt, Lifesteal, Divine Shield" / radiant "Charge,
// Taunt, Lifesteal, Indestructible". Engine cell: "Keywords only".
//
// Both faces are empty scripts on purpose. §10.4's keyword layer reads the printed keywords off the
// running face of the def (`faceOf` in engine/src/layers.ts), and every one of these six keywords is
// a pipeline or validator rule the engine already owns (§6.1):
//   Rush            sickness exemption for unit targets only (`whyCannotDeclare`, §4.1, §4.2 step 1)
//   Charge          full sickness exemption, hero included
//   Taunt           attack-target validator (`tauntWall`, §4.2 step 3)
//   Lifesteal       damage pipeline step 8 (§4.4), heals the source's controller's hero
//   Divine Shield   pipeline step 1: negate the whole hit, lose the shield
//   Indestructible  pipeline step 4 and the state check (§4.5 step 1, R46, R69)
// A card file that re-stated any of them would be a second implementation of a printed keyword, so
// there is nothing here to write (CLAUDE.md rule 5, BUILD M4-T4 "keywords only").
//
// §8 Conventions on the radiant cell: it lists keywords with no "Plus", so it "gives the radiant
// form's complete keyword list" — it REPLACES the base list rather than adding to it. Radiant
// Jilliax therefore has no Rush and no Divine Shield. `catalog.json`'s `radiant.keywords` for
// core-056 is exactly [Charge, Taunt, Lifesteal, Indestructible], which matches, so no script
// compensates for the swap; `test/catalog.test.ts` (M4-T1) is what pins that data.
//
// R46/R69 are the two rulings the radiant face leans on: a marked Indestructible unit switches to
// Attack Position and loses Taunt for the turn instead of dying, and it is still collected when its
// max health falls to 0 or less — while Sacrifice and Exile go around Indestructible entirely (§6.3).

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-056");

export const base: Script = {};

export const radiant: Script = {};

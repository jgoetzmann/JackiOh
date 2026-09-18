// #63 Plastic Surgery (SPEC §8.3, §6.1, R21, R78, R81, R90).
//
// Base: "Target unit gets +3/+3 and 1 random keyword". Radiant: "+6/+6 and 2 random keywords",
// which §8's Conventions read as changing only those numbers.
//
// §8.3's Engine cell is "Pool in 6.1", i.e. R21's eleven keywords (Taunt, Armor 1, Rush, Charge,
// First Strike, Poisonous, Lifesteal, Reborn, Divine Shield, Trample, Cleave). R21 also fixes the
// two constraints on the draw: a unit never gets a keyword it already has, and one grant never
// repeats. `grantRandomKeywords` is that verb and already enforces both — it recomputes the
// candidate list from `unitView` before every draw, so the keyword just granted is out of the pool
// for the next one — which is why the pool is NOT restated here. A card file that carried its own
// copy of R21 would be a second source of truth (see #80 Zao Gao, the pool's other user).
//
// Both the buff (layer 4 of §10.4) and the grant (`grantedKeywords`) are permanent on the instance
// and drop when the card leaves the field (R78).
//
// R81/R90: the target travels in the `play` action, so resolution never pauses; a play whose
// declared pick the board cannot satisfy is still legal and the spell simply fizzles (§8
// Conventions), which is why both effects resolve `{ of: "chosen" }` and do nothing when it is
// empty.

import type { Effect, Script } from "@jackioh/engine";
import { buff, grantRandomKeywords } from "@jackioh/engine/effects";
import type { TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-063");

/** "Target unit": either side, §8's Conventions, and no narrowing in either cell. */
const targets: TargetDecl[] = [
  { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit"] } },
];

/** The radiant face is the same card at doubled numbers, so one factory carries both. */
function surgery(stat: number, keywords: number): Script {
  return {
    targets,
    cry: (): Effect[] => [
      buff({ target: { of: "chosen" }, attack: stat, health: stat }),
      grantRandomKeywords({ target: { of: "chosen" }, count: keywords }),
    ],
  };
}

export const base: Script = surgery(3, 1);

export const radiant: Script = surgery(6, 2);

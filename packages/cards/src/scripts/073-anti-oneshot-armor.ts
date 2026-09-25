// #73 Anti-oneshot Armor (SPEC §8.3): "Your hero can't take more than 5 damage in one instance.
// Cry: draw 1", radiant "Your hero can't take more than 3 damage in one instance. Cry: draw 2" (§8's
// cell "Cap 3; Cry: draw 2", R275: the cap is tightened AND the Cry draws twice as many).
//
// The cap is not an effect and not an aura: it is step 3 of the §4.4 damage pipeline
// ("Hero cap: if the target is a hero with Anti-oneshot Armor, clamp to 5 (radiant 3)"), so the card
// contributes a static flag and the pipeline reads it. `damage.ts heroDamageCap` walks the player's
// backrow for `staticFlags.antiOneshot`, takes `ANTI_ONESHOT_CAP.radiant` when the INSTANCE is
// radiant and `.base` otherwise, and clamps with the smallest cap on that side. Three consequences
// this card gets for free and must not re-implement:
//   - the cap is per damage instance, so two 12-damage hits cost the hero 5 each;
//   - it is hero-only — `heroDamageCap` is consulted only for `target.kind === "hero"` — so units
//     take their full hit;
//   - the radiant number comes from `@jackioh/engine/config`, not from this file, which is why
//     "Cap 3" needs no radiant-specific code at all. The Cry's draw count is the one number the
//     two faces differ in here.
//
// R18 is likewise the engine's: "lose health" is not damage — no Armor, no Anti-oneshot cap — and
// `damage.ts loseHealth` never calls `heroDamageCap`. #27 Blood Ridden Glowy Jelly Bean's "you lose
// 5 health" therefore goes through in full past this card, which the test proves.
//
// §5.1 lists Anti-oneshot Armor as the example of "a Field Spell that may have a Cry", and §3.2
// makes a played Field Spell public, so nothing here touches `faceUp` either (`summonOnto` and the
// play pipeline set it). The Cry fires only when the card is played from hand or cast (R1).

import type { Script } from "@jackioh/engine";
import { draw } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-073");

/** "Cry: draw 1", radiant "Cry: draw 2". */
const BASE_DRAW = 1;
const RADIANT_DRAW = 2;

/**
 * The cap's VALUE is read off the instance's radiant flag by the pipeline from `ANTI_ONESHOT_CAP`
 * (engine/src/config.ts), so the only thing the two faces parameterise here is the Cry's draw.
 */
function antiOneshotArmor(draws: number): Script {
  return {
    staticFlags: { antiOneshot: true },
    cry: () => [draw({ count: draws })],
  };
}

export const base: Script = antiOneshotArmor(BASE_DRAW);

export const radiant: Script = antiOneshotArmor(RADIANT_DRAW);

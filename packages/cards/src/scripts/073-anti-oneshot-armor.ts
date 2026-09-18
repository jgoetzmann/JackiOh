// #73 Anti-oneshot Armor (SPEC §8.3): "Your hero can't take more than 5 damage in one instance.
// Cry: draw 1", radiant "Cap 3" — the radiant cell changes only that number, so the Cry is kept on
// both faces (§8 Conventions).
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
//     "Cap 3" needs no radiant-specific code at all.
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

/**
 * Both faces are the same script. The cap's VALUE is the radiant difference and it lives in
 * `ANTI_ONESHOT_CAP` (engine/src/config.ts), read off the instance's radiant flag by the pipeline —
 * so there is no number to parameterise here.
 */
function antiOneshotArmor(): Script {
  return {
    staticFlags: { antiOneshot: true },
    cry: () => [draw({ count: 1 })],
  };
}

export const base: Script = antiOneshotArmor();

export const radiant: Script = antiOneshotArmor();

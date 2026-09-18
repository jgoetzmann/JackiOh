// #14 Jlockeed's Weapons (SPEC §8.1): Field Spell, cost 4. Base "Aura: your units have +4 attack,
// Rush, First Strike", radiant "+10 attack". §8's Engine cell: "Aura grants keywords; removed when
// it leaves".
//
// The radiant cell changes only a number, so it changes only that number (§8 Conventions): the two
// keywords are kept and the attack bonus becomes +10.
//
// Nothing here removes anything. An aura is §10.4 layer 5, gathered from every permanent in play by
// `auraMods` in `engine/src/layers.ts` and recomputed on every read, so the bonus covers units
// summoned after the Field Spell landed (BUILD M3-T2's acceptance names this card for exactly that)
// and vanishes the instant the card stops being an aura source — destroyed, exiled, stolen or
// bounced. `applies` reads instance data only and never calls back into `unitView`, or the layers
// would recurse.
//
// "Your units": the controller's units on the field, in the `units` row. The Field Spell itself sits
// in the backrow, so the row test also keeps the aura off its own card, and a unit the opponent
// steals stops matching because `controller` is what is compared (R78 resets it on the way out).
// Rush from this aura is what R83's "a Reborn body the board has granted Rush may attack again"
// refers to; granting the keyword is all this card does about it.

import type { AuraHook, Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-014");

/** +`attack` attack, Rush and First Strike to the controller's units on the field (§10.4 layer 5). */
function weaponsAura(attack: number): AuraHook {
  return ({ self }) => [
    {
      applies: (unit) =>
        unit.controller === self.controller && unit.zone.z === "field" && unit.zone.row === "units",
      mod: { attack, keywords: [{ kind: "Rush" }, { kind: "First Strike" }] },
    },
  ];
}

export const base: Script = { aura: weaponsAura(4) };

export const radiant: Script = { aura: weaponsAura(10) };

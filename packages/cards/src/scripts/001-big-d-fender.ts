// SPEC §8.1 #1 Big D-fender — 0/8 → 0/16 Unit, Human, cost 2.
// Base: "Aura: your units in Defense Position have +2 Armor". The radiant cell is "+4 Armor", and
// per §8's Conventions a cell that changes only a number changes only that number, so the radiant
// form is the same aura at 4.
//
// Engine cell: an aura layer keyed on `position == DEF` (§10.4 layer 5); 0 attack, so R7 stops it
// from ever declaring an attack — that is the combat validator reading the printed stats, nothing
// for this file to script. Armor sums across every source (§10.4), so a Defense-Position ally ends
// up with this aura's 2 on top of Defense Position's own +1 (§4.1) and takes 3 less (BUILD M4-T4).

import type { AuraHook, Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-001");

/**
 * Armor +n on the controller's own units that are on the field in Defense Position (§4.1, §10.4).
 * "Your units" is the controller's side, so an enemy unit in Defense Position gets nothing, and the
 * aura reads the position off the instance on every read rather than storing a total.
 */
function defenseArmorAura(n: number): AuraHook {
  return ({ self }) => [
    {
      applies: (unit) =>
        unit.controller === self.controller &&
        unit.zone.z === "field" &&
        unit.zone.row === "units" &&
        (unit.position ?? "ATK") === "DEF",
      mod: { keywords: [{ kind: "Armor", n }] },
    },
  ];
}

export const base: Script = { aura: defenseArmorAura(2) };

export const radiant: Script = { aura: defenseArmorAura(4) };

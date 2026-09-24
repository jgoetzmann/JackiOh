// #65.1 Spikey Pillow (SPEC §8.3, §4.1, §10.4, §7; the token #65 summons).
//
// Base 0/2: "Cannot be in Defense Position. Aura: your units have −2 attack".
// Radiant 0/4: "Aura: your non-Spikey-Pillow units have −2 attack" — a restated clause, so it
// replaces the base aura while the Defense-Position ban is kept (§8 Conventions, and §5.2's ruling
// that a token with a radiant face still has one).
//
// §8.3's Engine cell: "Position validator flag; aura floors attack at 0".
//
// §4.1 and the §3 ruling ("Spikey Pillow cannot be switched to Defense"): the ban is the
// `neverDefense` static flag, which `reduce.ts` enforces on the `switchPosition` action and
// `legalActions` leaves out of its list, and `combat.ts` checks for a switch made as an effect
// (R20, #48 5pek Controller: "Spikey Pillow stays ATK"). Nothing here re-implements it.
//
// §10.4 layer 5: an aura contributes stat layers while its card is in play and is computed on read,
// never stored, so the −2 is gone the instant the Pillow leaves. `layers.ts` floors the total
// attack at 0, which is why a 1-attack unit lands on 0 rather than −1 and why the Pillow's own
// 0 attack is unaffected by its own aura.
//
// `applies` reads INSTANCE fields only — controller, zone and defId — and never calls back into
// `unitView`, which `layers.ts` requires or the layers would recurse. "Your units" is the Pillow's
// controller (§8 Conventions), and "on the field" is the unit row: a card dormant under a Stack
// pile is not on the field for this (R13).

import type { AuraHook, Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-065-1");

/**
 * −2 attack to the controller's units in the unit row. `sparesOwnKind` is the whole of the radiant
 * text: "your NON-Spikey-Pillow units", i.e. every unit that is not a Spikey Pillow — this Pillow
 * itself included, so a radiant Pillow keeps whatever attack it has been given.
 *
 * A Spikey Pillow is the card this file defines, so the test is against `def.id` and never
 * `self.defId`: a Pillow #85 fused with another card carries this text in full (R102) but is a
 * transient definition named "A + Spikey Pillow", and its aura still spares every Spikey Pillow its
 * controller has while draining the fused card itself, which is not one.
 */
function attackDrainAura(sparesOwnKind: boolean): AuraHook {
  return ({ self }) => [
    {
      applies: (unit) =>
        unit.controller === self.controller &&
        unit.zone.z === "field" &&
        unit.zone.row === "units" &&
        !(sparesOwnKind && unit.defId === def.id),
      mod: { attack: -2 },
    },
  ];
}

export const base: Script = {
  staticFlags: { neverDefense: true },
  aura: attackDrainAura(false),
};

export const radiant: Script = {
  staticFlags: { neverDefense: true },
  aura: attackDrainAura(true),
};

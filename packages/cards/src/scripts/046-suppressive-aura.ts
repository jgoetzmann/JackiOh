// #46 Suppressive Aura (SPEC §8.2): "Aura: all units −2/−2 (paid 4: −5/−5)", radiant "Aura: enemy
// units −4/−4 (paid 4: −10/−10)".
//
// Reading the radiant cell (§8 Conventions): it restates the whole clause, so it replaces the base
// one — the radiant face touches enemy units only and carries its own two numbers. Neither face
// prints a keyword, so the keyword list stays empty on both.
//
// This is a pure §10.4 layer-5 contribution and nothing else. `Script.aura` is read on every stat
// read (`layers.unitView`), never applied once and stored, which is the whole of "leaving restores
// them" in the §8.2 Engine cell: when the Field Spell leaves the backrow `layers.auraSources` stops
// finding it and the next read of a survivor is its unmodified self again. Nothing in this file
// mutates anything (CLAUDE.md rule 5); an aura's `applies` predicate also reads instance data only
// and never calls back into `unitView`, or the layers would recurse.
//
// Attack floors at 0 but max health does not: §10.4 layer 5 lets it fall to 0 or less, and §4.5
// step 1 collects such a unit at the next state check — R69 spells out that this reaches an
// Indestructible unit too, because no destroy effect is involved: it dies, fires Death, may Reborn
// and counts toward Ceaseless Void's destroyed counter. So radiant paid 4 (−10/−10) kills The Rock
// (#66, 10/10 Indestructible) while no `destroy` verb appears anywhere below.
//
// The price is not a choice this card asks for. R81 lists #46: zone, X, embiggen, Tribute and the
// declared targets and modes all travel in the `play` action, and §10.6 adds that no Core card ever
// opens an `embiggen` prompt. `reduce.playCard` writes the answer to `instance.embiggened` and R65
// makes that the cost actually paid, so the aura simply reads the flag off `self` — no `targets`
// and no `modes` declaration belongs here.
//
// R78: `embiggened` is one of the fields leaving the field resets, so a Suppressive Aura that is
// bounced and replayed for 2 is a −2/−2 aura again, which is what "the chosen embiggen price" means.

import type { AuraHook, Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-046");

/** The two prices of §8.2's cell: the base price, then the embiggen price (R65). */
const BASE_PENALTIES = { paid2: 2, paid4: 5 };
const RADIANT_PENALTIES = { paid2: 4, paid4: 10 };

/**
 * "All units": every unit on either side, the controller's own included, at one of the two prices.
 * The mod is negative on both stats, so §10.4 subtracts it from attack (floored at 0 on read) and
 * from max health (not floored, R69).
 */
const allUnits: AuraHook = ({ self }) => {
  const penalty = self.embiggened === true ? BASE_PENALTIES.paid4 : BASE_PENALTIES.paid2;
  return [{ applies: () => true, mod: { attack: -penalty, maxHealth: -penalty } }];
};

/**
 * "Enemy units": enemy of this card's controller, which is control and not ownership (R12), so a
 * stolen or rotated Suppressive Aura suppresses the other board from its new side.
 */
const enemyUnits: AuraHook = ({ self }) => {
  const penalty = self.embiggened === true ? RADIANT_PENALTIES.paid4 : RADIANT_PENALTIES.paid2;
  return [
    {
      applies: (unit) => unit.controller !== self.controller,
      mod: { attack: -penalty, maxHealth: -penalty },
    },
  ];
};

export const base: Script = { aura: allUnits };

export const radiant: Script = { aura: enemyUnits };

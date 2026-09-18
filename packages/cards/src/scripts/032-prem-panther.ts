// #32 Prem Panther (SPEC §8.2 row 32): 5/4 "Rush; whenever this destroys a unit, draw 2",
// radiant 10/8 "Rush, Cleave; same".
//
// Rush and Cleave are printed on the catalog faces (`def.base.keywords`, `def.radiant.keywords`),
// so §10.4 layer 1 already grants them and nothing here re-grants them. The radiant cell says
// "same" for the text clause (§8 Conventions), so both faces carry the identical kill trigger; what
// changes is that a radiant Panther's Cleave produces more deaths, and R42 counts each one.
//
// R42: "destroys a unit" is a death whose lethal damage instance came from this unit, Cleave hits
// included, and it is per unit — two Cleave kills in one attack draw 4. The trigger therefore keys
// on the `destroyed` event and asks one question: was the killer this instance?
//
// `killerId` on the event is the only way to answer it, and it has to be: R89 runs every trigger
// but the Death hook after the instance has been reset, off the event it captured, and
// `resetInstance` (zones.ts) deletes `lastDamagedBy` on the way to the graveyard — so by the time
// this trigger runs the corpse no longer remembers who killed it. `stateCheck` fills the field in
// from `lastDamagedBy` just before the move, which is what makes it readable here.

import type { Script, TriggerDef } from "@jackioh/engine";
import { defOf } from "@jackioh/engine";
import { draw } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-032");

/**
 * R42, per unit: one `destroyed` event whose killer is this Panther draws 2. Cleave needs no special
 * case — each cleaved unit dies with its own event, so two kills queue two triggers.
 */
const killTrigger: TriggerDef = {
  id: "32-destroys-a-unit",
  on: ["destroyed"],
  run(ctx) {
    const self = ctx.self;
    const event = ctx.event;
    if (self === null || event.type !== "destroyed") return [];
    // A unit, not a backrow permanent that Sacrifice also reports as destroyed.
    if (defOf(ctx.state, event.defId).type !== "Unit") return [];
    if (event.instanceId === self.id) return [];
    if (event.killerId !== self.id) return [];
    return [draw({ count: 2 })];
  },
};

export const base: Script = { triggers: [killTrigger] };

// "Rush, Cleave; same": the keyword list is the radiant face's, the text clause is unchanged.
export const radiant: Script = { triggers: [killTrigger] };

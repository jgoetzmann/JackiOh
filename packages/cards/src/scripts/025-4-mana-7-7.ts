// #25 4-mana 7/7 (SPEC §8.2): a 7/7 → 14/14 Unit, base "Armor 7", radiant "Indestructible" (R275:
// the Radiant body doubles, and the keyword is the stronger one). The Engine cell is "Keywords
// only", so there is no script: the stats and both keywords are printed on the catalog faces
// (`base.keywords = [Armor 7]`, `radiant.keywords = [Indestructible]`) and §10.4 layer 1 reads them
// from the def, so granting them here would double the Armor (§10.4: "Armor sums across sources").
//
// Where the behaviour lives instead:
//   Armor 7        — §4.4 step 2 subtracts the unit's total Armor from every incoming hit, so a
//                    7-damage hit is reduced to 0 and the zero rule (R63) makes it a non-event.
//   Indestructible — §4.4 step 4 (takes no damage), §4.5 step 1 and R46 (destroy marks are
//                    ignored; a marked unit switches to Attack Position and loses Taunt for the
//                    turn), R69 (it still dies if its max health falls to 0 or less). §6.1: "can be
//                    exiled or sacrificed", so Tribute, Sacrifice and Exile still remove it.

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-025");

export const base: Script = {};

export const radiant: Script = {};

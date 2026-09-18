// #49 Snom Bunny Mind Control (SPEC §8.2): "Steal target enemy permanent", radiant "It also becomes
// Radiant".
//
// Reading the radiant cell (§8 Conventions): "Also" adds an effect and the base clause it does not
// restate is kept, so the radiant face steals the same permanent and then sets its flag.
//
// "Permanent" is §6.3's word (the Recruit row names them): Unit, Field Spell, Trap and Field Trap.
// Units sit in the units row and the other three in the backrow, so the declaration below offers
// both rows of the enemy board. It is a DECLARED play-time target travelling in the play action's
// `targets` (R81), validated by R90 — which also means a face-down enemy trap is a legal pick the
// client can name without ever seeing what it is (§9.1), and that only the top card of a Stack pile
// is on offer (R13). An empty enemy board fizzles and the spell still counts as played (§8
// Conventions).
//
// Everything about where the card lands is §6.3 Steal and R15, in `effects/steal.ts`: the same lane
// on this side when that zone is free, else the first free zone of the same row, and if the row has
// no free zone at all the card stays with the opponent. Control is a field-only notion (R12), so
// the steal moves `controller` and nothing else: the card keeps its owner and will still go to that
// owner's graveyard, hand or library when it later leaves the field, and because it never leaves
// the field it keeps its damage, buffs, counters and position (R78 is about leaving). R33 does the
// rest for a face-down trap: `faceUp` is untouched, so the new controller is the one who may read
// it and the previous controller stops seeing it.
//
// The radiant clause is `setRadiant`, which is the flag and nothing else (R74). On the field that
// means the base stat layer swaps at once while damage and buffs stay and no Cry re-fires (R22), so
// a stolen 4/3 that had taken 2 damage becomes an 8/6 that has taken 2. Order matters only for
// readability: both effects resolve the same selection, and `setRadiant` resolves it by instance id
// (`resolveTarget` → `findInstance`), so the steal having already moved the card between zones
// cannot make the second effect miss.

import type { Script } from "@jackioh/engine";
import { setRadiant, steal } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-049");

/** §6.3: a permanent is a Unit, Field Spell, Trap or Field Trap, so both enemy rows are on offer. */
const enemyPermanent: Script["targets"] = [
  { kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit", "backrow"] } },
];

export const base: Script = {
  targets: enemyPermanent,
  cry: () => [steal({ target: { of: "chosen" } })],
};

export const radiant: Script = {
  targets: enemyPermanent,
  cry: () => [steal({ target: { of: "chosen" } }), setRadiant({ target: { of: "chosen" } })],
};

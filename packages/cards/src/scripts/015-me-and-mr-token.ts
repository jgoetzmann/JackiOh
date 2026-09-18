// #15 Me and Mr Token (SPEC §8.1): 1/1 → 2/2 Unit, Human, cost 1. Base "Cry: summon a Rush Token",
// radiant "Cry: summon 3 Rush Tokens". §8's Engine cell is "Board full → fewer".
//
// The Rush Token is the §7 token `core-t-rush` (3/3, Rush), so the token's stats and keyword come
// from its own catalog face and are never restated here.
//
// "Board full → fewer" needs no check of its own: R64 gives a laneless summon the leftmost empty,
// unlocked, unreserved unit zone and `summon` fizzles silently when the row has none. So the radiant
// face is three independent summons — with two zones free it makes two tokens and the third does
// nothing, which is exactly what the row asks for. Nothing about the Cry is conditional, so no hook
// reads state at all.

import type { Effect, Script } from "@jackioh/engine";
import { summon } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-015");

/** §7: the Rush Token def, named through `cardDef` so a wrong id throws at load, not at play. */
const RUSH_TOKEN = cardDef("core-t-rush").id;

/** One Rush Token into the leftmost free unit zone of the controller's row (R64). */
function rushToken(): Effect {
  return summon({ defId: RUSH_TOKEN, player: "self" });
}

export const base: Script = {
  cry: () => [rushToken()],
};

export const radiant: Script = {
  cry: () => [rushToken(), rushToken(), rushToken()],
};

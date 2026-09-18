// #6 Mana Well (SPEC §8.1): a 3-cost Field Spell, "Start of turn: gain 1 mana", radiant "Gain 2" —
// a Radiant cell that changes only a number changes only that number (§8 Conventions), so the two
// faces are the same hook with a different amount.
//
// Everything else in the §8.1 Engine cell ("Temporary mana, may exceed 4") is already the engine's:
//   - `gainMana` (effects/mana.ts) calls `mana.gainMana`, which adds to `mana.current` and never
//     touches `mana.max`, so §2.3's "temporary mana adds to current mana and can exceed 4" holds
//     without this file saying anything. A turn-4 player refreshes to 4 and then sits at 5.
//   - it is temporary because nothing stores it: `refreshMana` sets `current = max` at every start
//     of turn (§2.3), so the gain never accumulates across turns — the Well grants it again.
//   - `startOfTurn` fires for the controller only, on their own turn, because `turn.startTurn`
//     asks `triggerOrder(sink, "startOfTurn", player)` for that one player (§2.2, §6.2, R68), and
//     it fires before the draw, which is the same §2.2 ordering.
//   - a Field Spell that has left the field is not in `triggerOrder`'s scan (units then backrow),
//     so "leaves → back to 4" needs nothing here either.
//
// The gain lands on the controller because `gainMana` defaults its `player` to "self" (§6.3).

import type { Script } from "@jackioh/engine";
import { gainMana } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-006");

/** The only difference between the two faces is how much mana the start of the turn gives. */
function manaWell(amount: number): Script {
  return {
    startOfTurn: () => [gainMana({ amount })],
  };
}

export const base: Script = manaWell(1);

export const radiant: Script = manaWell(2);

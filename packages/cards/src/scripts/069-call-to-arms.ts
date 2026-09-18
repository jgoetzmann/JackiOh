// #69 Call to Arms (SPEC §8.3, §6.3 Recruit, R1, R64, R65).
//
// Base cell: "Recruit 3 Units costing 1 or less". Radiant cell: "2 or less" — a cell that changes
// only a number changes only that number (§8 Conventions), so the count stays 3 and only the cost
// ceiling moves. Engine cell: "Three top-down scans; stops when the board is full".
//
// A Spell's script hangs off `cry`, which is the on-resolve hook for a Spell as well as the Cry of a
// permanent (§10.9).
//
// §6.3 Recruit: "Summon from library, scanning top down … first permanent card that matches the
// filter, summoned into its row per R64 … then the library keeps its order". The engine's `recruit`
// effect is exactly one scan, so "Recruit 3" is three of them in order, and because each one
// removes the card it found, the next scan finds the next match further down. A card a scan cannot
// place is never removed from the library (`summonExisting` looks for the zone before it takes the
// card out), which is both halves of the must-pass row: the board filling up stops the recruiting,
// and the library's order is otherwise untouched.
//
// R64: a summon with no named zone takes the leftmost empty, unlocked, unreserved zone of its row,
// so the three units line up left to right and a zone reserved for a dying Reborn unit is skipped.
// R1: Recruit never fires a Cry — `summon` does not run the hook at all, which is the whole reason
// #12 Duplicating Felinors cannot fill a board for 2 mana.
// R65: the filter reads each def's cost out of play, so an X-cost card counts as 0 and an embiggen
// card as its base price — `matchesFilter` routes through `queryCost` for exactly that.
//
// "Units costing 1 or less" is `type: "Unit"` plus `costRange: { max }`. The type filter matters as
// well as the cost: `recruit` will otherwise take any permanent (Field Spell, Trap, Field Trap).

import type { Effect, Script } from "@jackioh/engine";
import { recruit, type RecruitFilter } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-069");

/** §8.3: "Recruit 3", the same on both faces. */
const RECRUITS = 3;

function unitsCosting(max: number): RecruitFilter {
  return { type: "Unit", costRange: { max } };
}

/** `maxCost` is the whole of the radiant text: "2 or less" in place of "1 or less". */
function callToArms(maxCost: number): Script {
  const filter = unitsCosting(maxCost);
  return {
    // Three independent top-down scans, applied in order by `applyEffects`.
    cry: (): Effect[] => Array.from({ length: RECRUITS }, () => recruit({ filter, player: "self" })),
  };
}

export const base: Script = callToArms(1);

export const radiant: Script = callToArms(2);

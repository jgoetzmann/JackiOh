// #42 Eugenics (SPEC §8.2). Spell, cost 2, Common.
//   Base:    "Exile 8 random cards from your library; each remaining library card has a 30% chance
//             to become Radiant"
//   Radiant: "Lucky 1 at 40%" — §8 Conventions: a cell that changes only a number changes only that
//            number, and every clause it does not restate is kept. So the radiant face still exiles
//            8, and only the chance (30% → 40%) changes, with Lucky 1 added (§6.1: one extra roll,
//            keep the best, i.e. keep the success).
//   Engine:  "Fewer than 8 → exile all" — R60's "a random pick of N existing cards picks N
//            different cards, or all of them if fewer exist".
//
// NO DICE IN A CARD FILE. Rolling advances `rngCursor`, which is state (CLAUDE.md rules 4 and 5,
// §10.7), so both halves of this card are single effects that own their own randomness. Neither
// exists in `packages/engine/src/effects` yet; the signatures below are what the engine must add
// (see the agent report):
//
//   exileRandomFromLibrary({ count, player? })
//       R60: `count` DIFFERENT cards drawn uniformly from `player`'s library, or the whole library
//       when it holds fewer; each goes through the Exile verb (§6.3), so the exile counter moves
//       (R55) and a unit-token card ceases to exist instead of entering the pile (R11).
//
//   radiantChance({ zone, player?, chance, lucky? })
//       "each remaining library card has a 30% chance": ONE independent roll per card still in the
//       zone, in zone order (top down), through `rng.chance(chance)`. R60 makes the flag the whole
//       model and an already-Radiant card is skipped rather than rolled, so nothing is un-set and
//       the roll count is the number of non-Radiant cards. `lucky: n` routes the roll through
//       `rng.lucky(n, roll, better)` with "a success beats a failure" as the comparator (§6.1,
//       R32), which is what "Lucky 1 at 40%" means: two rolls per card, keep the success.
//
// ORDER MATTERS. The exile runs first and the chance rolls over what is LEFT ("each remaining
// library card"), so an exiled card is never rolled. Two effects in one list is the right shape for
// that: §4.5/R59 puts the state check after the whole list, never between two effects of it.

import type { Script } from "@jackioh/engine";
import { exileRandomFromLibrary, radiantChance } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-042");

/** §8.2: "Exile 8 random cards from your library", on both faces. */
const EXILE_COUNT = 8;

/** The faces differ only in the chance and in how many extra rolls Lucky keeps (§6.1). */
function eugenics(chance: number, lucky?: number): Script {
  return {
    // A Spell's script hangs off `cry`: that is its on-resolve hook (§10.9).
    cry: () => [
      exileRandomFromLibrary({ count: EXILE_COUNT }),
      radiantChance({ zone: "library", chance, ...(lucky === undefined ? {} : { lucky }) }),
    ],
  };
}

export const base: Script = eugenics(0.3);

export const radiant: Script = eugenics(0.4, 1);

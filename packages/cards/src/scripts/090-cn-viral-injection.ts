// #90 CN-Viral Injection (SPEC §8.5, §7, R11, R12, R57, R58, R80).
//
// Base: "Shuffle a CN-Virus into the opponent's library". Radiant: "A Radiant CN-Virus".
// Engine cell: "The opponent owns the token, so its cast-on-draw chain runs on their draws; a full
// library refuses the shuffle (R80)."
//
// §8's Conventions: the radiant cell restates only WHAT is shuffled, so the count (one), the
// destination (the opponent's library) and everything else are kept.
//
// OWNERSHIP IS THE WHOLE POINT. `shuffleInto` creates the token with `newInstance(state, defId,
// player, …)`, and `newInstance` sets both `owner` and `controller` to that player, so `player:
// "enemy"` makes the opponent the OWNER of the virus, not merely its controller. Off the field
// ownership is what decides everything (R12): the card sits in their library, feeds their draws,
// and its cast-on-draw chain therefore runs on their turn and damages their hero. A steal-style
// control change would have done none of that, which is why this is `player`, not a target.
//
// `shuffleIntoLibrary` (engine/src/draw.ts) puts it at `rng.int(library.length + 1)` — a uniformly
// random position in the whole pile, drawn from the match rng so a replay reproduces it (§9.2) —
// and emits `shuffledIn` carrying that position. R80: a library holds at most `LIBRARY_CAP` cards
// and a card that would be shuffled into a full one "is not created", so a full library simply
// refuses the shuffle and this spell fizzles; the spell still counts as played (§8 Conventions).
//
// THE RADIANT FLAG TRAVELS, NOTHING ELSE DOES. `shuffleInto`'s `radiant` sets the flag on the fresh
// instance, which is what R57 says a copy shuffled into a library carries. The flag then decides
// which face runs on the draw (§5.2): `flagsOf` reads `scriptOf(instance)`, so a Radiant CN-Virus
// casts its radiant text and shuffles 3 copies instead of 2 — and `shuffleCopiesOfSelf` copies the
// flag onto those, so the whole chain stays Radiant.
//
// The token's id comes from the catalog through `cardDef`, never a string literal: #90.1 is a real
// catalog entry and `cardDef` throws if it ever stops being one.

import type { Effect, Script } from "@jackioh/engine";
import { shuffleInto } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-090");

/** #90.1 CN-Virus, the token this card shuffles (§7). */
const VIRUS = cardDef("core-090-1");

/** `radiantVirus` is the whole of the radiant text. */
function injection(radiantVirus: boolean): Script {
  return {
    cry: (): Effect[] => [
      shuffleInto({ defId: VIRUS.id, count: 1, player: "enemy", radiant: radiantVirus }),
    ],
  };
}

export const base: Script = injection(false);

export const radiant: Script = injection(true);

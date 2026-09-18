// #51.1 KY's Empty Notebook (SPEC §8.3, §7, §5.1, §6.3 Draw; R4, R11, R50, R58, R60).
// Spell token, cost 1, tags KY + Token. The only generator is #51 KY's Private Tutor's
// "No match at all → add a KY's Empty Notebook".
//   Base:    "Draw 1"
//   Radiant: "Draw 2" — §8 Conventions: a cell that changes only a number changes only that number.
//
// The whole card is one Draw. Everything §2.4 hangs off a draw — cast-on-draw, fatigue, the hand
// cap of 10 (R4) and R58's chain cap — belongs to the draw pipeline (engine/src/draw.ts), so
// neither face counts cards or checks the library here.
//
// Being a token is data, not script (§7): `def.token` is true and `def.tags` carries "Token", and
// §5.1's one query is what keeps this card out of every random pool — "Random pools never include
// Token-tagged cards … unless the card names the pool itself" — so even `query({ tags: ["KY"] })`,
// the #57 Conjure KY pool, leaves it out while offering #31, #51 and #82. There is nothing for
// this file to opt out of; `test/051-1-kys-empty-notebook.test.ts` proves the exclusion against
// `packages/cards/src/query.ts`, which is §5.1's single pool source.
//
// R11 is the other half of being a token and also costs this file nothing: a SPELL token "goes to
// the GY like any spell", so this card behaves as an ordinary hand and library card (§3.2) and is
// then Discover-eligible out of the graveyard (R50, #72 Reminisce) — unlike a unit token, which
// ceases to exist when it leaves the field.

import type { Script } from "@jackioh/engine";
import { draw } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-051-1");

/** §8: base draws 1, radiant draws 2. */
const BASE_DRAW = 1;
const RADIANT_DRAW = 2;

/** A spell's script is its `cry` hook (§10.9): the on-resolve hook, fired by `runHook`. */
function notebook(count: number): Script {
  return {
    cry: () => [draw({ count })],
  };
}

export const base: Script = notebook(BASE_DRAW);

export const radiant: Script = notebook(RADIANT_DRAW);

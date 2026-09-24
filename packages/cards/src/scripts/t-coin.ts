// T-coin The Coin (SPEC §7, §2.1, §2.3; R244, R245). Spell, Token, cost 0.
//   Base:    "Gain 1 mana this turn"
//   Radiant: "Gain 2 mana this turn" — §8 Conventions: a cell that changes only a number changes
//            only that number, as #51.1's "Draw 2" does.
//
// No card generates it. §2.1 deals one to the seat going second once both mulligans are answered
// (R244), which is the engine's setup (`engine/src/setup.ts`, `dealCoins`), not this file: a card
// file owns what the card does when it is played and nothing about how it got into a hand.
//
// The mana is §2.3's temporary mana. `gainMana` (effects/mana.ts) adds to `mana.current` and never
// touches `max`, so it may go above the cap (4, or a handicapped seat's `manaCap`, R181) and the next
// refresh sets current back to max, which is all "this turn" means for mana. It lands on the caster,
// because `gainMana` defaults `player` to "self" (§6.3).
//
// Being a token is data, not script, exactly as for the other spell tokens (§7): `token: true` and the
// `Token` tag keep it out of every deck (§2.6, §9.4 L3, R184), every random pool and Discover (§5.1),
// and `isUnitToken` is false for a Spell, so it goes to the graveyard when it resolves (R11).

import type { Script } from "@jackioh/engine";
import { gainMana } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-t-coin");

/** §7: base gains 1, radiant 2. */
const BASE_MANA = 1;
const RADIANT_MANA = 2;

/** A spell's script is its `cry` hook (§10.9): the on-resolve hook, fired by `runHook`. */
function coin(amount: number): Script {
  return {
    cry: () => [gainMana({ amount })],
  };
}

export const base: Script = coin(BASE_MANA);

export const radiant: Script = coin(RADIANT_MANA);

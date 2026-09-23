// #10 Rapid Replenish (SPEC §8.1): a 0-cost Spell, "Combo 3: draw 3; otherwise nothing", radiant
// "Combo 3: draw 6" — a Radiant cell that changes only a number changes only that number (§8
// Conventions), so the two faces differ only in how many cards the Combo draws.
//
// §8.1's Engine cell is "Checks `turnLog.cardsPlayed >= 3`; always playable". Always playable needs
// nothing: the cost is 0 and the card declares no target, so a Combo that is not met simply draws
// nothing and the spell still counts as played and still goes to the graveyard (§8 Conventions,
// R40, R70).
//
// THE OFF-BY-ONE, which is the whole subtlety of this card: §6.2 defines "Combo X" as "X or more
// cards were played EARLIER this turn", and §10.5 step 4 increments `turnLog.cardsPlayed` before
// step 5 runs this script (engine/src/reduce.ts:78, and `resolve.countAsPlayed` for a cast, R70).
// Rapid Replenish is therefore already inside the count when its own hook asks, so the cards played
// earlier are `playsThisTurn - 1`. BUILD M4-T4's must-pass row says the same in numbers: two prior
// plays draw nothing, three prior plays draw 3.
//
// The count is read through `subsystems.playsThisTurn` (subsystems/comboIndex.ts:70), the one
// reader of `turnLog.cardsPlayed`, so no card file indexes `state.players` itself (BUILD M3-T1).
// It is read per player: `ctx.controller`'s own turn log, which is the only per-turn record there
// is, so a card the opponent cast during this turn counts on their log and not on this one.
//
// R195, the yellow glow: `conditionMet` answers the same question from the hand, before the card is
// played and so before it is counted — there the cards played earlier are `playsThisTurn` itself,
// with no −1. `comboMet` is the one predicate both read, so the glow and the draw cannot disagree.

import { subsystems, type GameState, type Script } from "@jackioh/engine";
import { draw } from "@jackioh/engine/effects";
import type { PlayerId } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-010");

/** "Combo 3" (§6.2): three or more cards played earlier this turn. */
const COMBO = 3;
const BASE_DRAW = 3;
const RADIANT_DRAW = 6;

/**
 * "Combo 3" is met: at least `COMBO` cards were played before this one this turn. `counted` says
 * whether this card is already inside `playsThisTurn` — true while its own Cry runs (§10.5 step 4),
 * false while it still sits in hand (R195) — so the plays before it are the count less itself.
 */
function comboMet(state: GameState, controller: PlayerId, counted: boolean): boolean {
  const played = subsystems.playsThisTurn(state, controller);
  const playedEarlier = counted ? played - 1 : played;
  return playedEarlier >= COMBO;
}

/** The only difference between the two faces is how many cards the met Combo draws. */
function rapidReplenish(count: number): Script {
  return {
    // −1 inside `comboMet`: this spell is already counted, and Combo counts the plays before it.
    cry: (ctx) => (comboMet(ctx.state, ctx.controller, true) ? [draw({ count })] : []),
    // R195: hand only. The condition is about a play; a Spell never sits on the field.
    conditionMet: (ctx) => ctx.zone === "hand" && comboMet(ctx.state, ctx.controller, false),
  };
}

export const base: Script = rapidReplenish(BASE_DRAW);

export const radiant: Script = rapidReplenish(RADIANT_DRAW);

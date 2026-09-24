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
// cards were played EARLIER this turn", and §10.5 step 4 counts the card before step 5 runs this
// script, so Rapid Replenish is already inside `turnLog.cardsPlayed` when its own hook asks. And
// step 5 runs /fullsend's granted Combo draw before this script, so a cast-on-draw card that draw
// casts (R70) is in the count too, though it was played after Rapid Replenish. §6.2 checks the
// count "at play time", so the script reads `playedEarlier`, this play's own place in the turn's
// log. BUILD M4-T4's must-pass row says the same in numbers: two prior plays draw
// nothing, three prior plays draw 3.
//
// It is read per player: `ctx.controller`'s own turn log, which is the only per-turn record there
// is, so a card the opponent cast during this turn counts on their log and not on this one.
//
// R195, the yellow glow: `conditionMet` answers the same question from the hand, before the card is
// played. `playedEarlier` answers it there too: a card still in hand has not been played, so every
// play this turn is earlier than the one it would be. One reader for both, so the glow and the draw
// cannot disagree.

import { playedEarlier, type Script } from "@jackioh/engine";
import { draw } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-010");

/** "Combo 3" (§6.2): three or more cards played earlier this turn. */
const COMBO = 3;
const BASE_DRAW = 3;
const RADIANT_DRAW = 6;

/** The only difference between the two faces is how many cards the met Combo draws. */
function rapidReplenish(count: number): Script {
  return {
    cry: (ctx) => {
      // The plays before this one, at play time: not this spell, and not a card its step 5 cast.
      const earlier = playedEarlier(ctx.state, ctx.controller, ctx.self);
      return earlier >= COMBO ? [draw({ count })] : [];
    },
    // R195: hand only. The condition is about a play; a Spell never sits on the field. In hand,
    // `playedEarlier` is every play this turn.
    conditionMet: (ctx) => ctx.zone === "hand" && playedEarlier(ctx.state, ctx.controller, ctx.self) >= COMBO,
  };
}

export const base: Script = rapidReplenish(BASE_DRAW);

export const radiant: Script = rapidReplenish(RADIANT_DRAW);

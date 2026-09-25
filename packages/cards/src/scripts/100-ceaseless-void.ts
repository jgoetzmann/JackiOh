// #100 Ceaseless Void (SPEC §8.5, §6.3 Cost and Exile, §10.4, R55, R65, R70, R275). Unit, cost 100,
// 10/10 → 20/20, Mythic.
//   Base:    "Cry: exile all other permanents on both sides. Costs 1 less per card drawn, played,
//             destroyed or exiled this game by either player"
//   Radiant: "Charge. Cry: …; same" — §8 Conventions: "Plus X" adds keyword X to the base keywords
//            and restates no clause, so both clauses above are kept unchanged. The differences are
//            catalog data on the radiant face: the printed Charge, and R275's doubled stats.
//   Engine:  "Four game-level counters; cost recomputed on read; floor 0".
//
// THE COST (R55, R65, §10.9). R55: "Count both players' draws, plays, destructions and exiles from
// the start of the game". Those four counters are `state.counters` — `{ drawn, played, destroyed,
// exiled }` — which §10.1 puts on `GameState` for this card alone, so the discount is one
// subtraction over the whole game rather than anything this card has to record. §10.9 gives it the
// one `cost` hook in the catalog ("`cost` is Ceaseless Void's computed cost, R55"), and R65 starts
// its calculation from it: "start from `costOverride`, else the printed cost (Ceaseless Void's
// computed cost, …); add `costMod`; add player discounts; apply Professor Curvature if the result is
// then 4; floor at 0". So the hook returns the printed 100 minus the four counters and nothing else:
// `costMod`, the player's discounts and #77's clamp are all `effectiveCost`'s, applied after this.
//
// "Cost recomputed on read" is what a hook *is* — `mana.printedCost` calls it on every read — so
// nothing is ever stored. The floor is here as well as in `printedCost` and `effectiveCost`,
// because §8.5's Engine cell puts it on this card ("floor 0") and a negative number should never
// leave the hook.
//
// The printed 100 is read from the catalog through `queryCost(def)` rather than written down: a
// script never restates its own cost, and `queryCost` is R65's out-of-play reading of a definition,
// which for a plain number is that number.
//
// WHICH PLAYS COUNT. `state.counters.played` is bumped by `resolve.countAsPlayed`, which every play
// and every Cast goes through, so R70's "a cast … counts as a play for every rule that counts or
// reacts to plays … (Ceaseless Void)" is already true, and `move.counter` rolls the counter back for
// a Countered card that "is treated as never played" (§6.3). Exiles likewise: `move.exile` bumps
// `counters.exiled` only when the card actually reaches an exile pile, so a unit token that ceased
// to exist instead is not counted (R11). None of that is this card's to enforce.
//
// PLAYING IT COUNTS TOO, but after the fact: §10.5 pays the cost at step 2 and increments the play
// counter at step 4, so the card is never 1 cheaper for having been played.
//
// THE CRY. "Exile all other permanents on both sides": both rows of §3.1 on both sides — §5.1's
// permanents are Unit, Field Spell, Trap and Field Trap, which is exactly "everything in the unit
// zones and the backrow" — with this unit itself excluded. Exile takes no Death trigger (§6.3) and
// Indestructible does not stop it ("can be exiled or sacrificed", §6.1), so there is nothing to
// filter and nothing to sequence: one effect, and the state check after it (R59).
//
// `exileAll({ side, rows, excludeSelf })` is the board-wide exile (`effects/move.ts`), written in
// the shared `BoardScope` of `effects/targets.ts` — the same scope #2, #17, #43 and #88 use for the
// destroy half of the same shape. It exiles every card the scope matches in R68's order, each one
// through the path `exile` itself uses: `moveToZone` to the exile pile, `state.counters.exiled`
// bumped per card that gets there, an `exiled` event each, a unit token ceasing to exist instead
// (R11). It matches only cards on the field, so a card dormant under a Stack pile is not one (R13);
// the promotion that leaves behind is a rule the spec has not made — see the report.

import type { Effect, GameState, Script } from "@jackioh/engine";
import { queryCost } from "@jackioh/engine";
import { exileAll } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-100");

/** R65's reading of the printed cost — 100 — taken from the catalog, never restated. */
const PRINTED_COST = queryCost(def);

/**
 * R55: "Costs 1 less per card drawn, played, destroyed or exiled this game by either player",
 * floored at 0 (§8.5's Engine cell). The four counters are game-level, so neither side's identity
 * is read and nothing is stored on the instance.
 */
function costNow(state: GameState): number {
  const counters = state.counters;
  const spent = counters.drawn + counters.played + counters.destroyed + counters.exiled;
  return Math.max(0, PRINTED_COST - spent);
}

/**
 * "Cry: exile all other permanents on both sides" — §3.1's two rows, both sides, this unit
 * excluded. `excludeSelf` is what "other" means here; R11 makes a unit token cease to exist
 * rather than reach the pile, so it is not counted (§3.2).
 */
function exileEveryOtherPermanent(): Effect[] {
  return [exileAll({ side: "any", rows: ["units", "backrow"], excludeSelf: true })];
}

/**
 * One script for both faces: "Plus Charge" is a printed keyword on the catalog's radiant face and
 * the 20/20 its printed stats, so both are §10.4 layer 1 and not a line of script, and both of the
 * row's clauses are kept.
 */
const void_: Script = {
  cost: ({ state }) => costNow(state),
  cry: () => exileEveryOtherPermanent(),
};

export const base: Script = void_;

export const radiant: Script = void_;

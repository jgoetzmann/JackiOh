// #94 Genn's Greed (SPEC §8.4, R4, R26, R65, R66, BUILD M4-T4 row 94).
//
// Base: "Draw every 2-cost card from your library; exile every odd-cost card in your library, hand
// and GY (X-cost cards exempt); gain 2 mana". Radiant: "Gain 6" — a cell that changes only a number
// changes only that number (§8 Conventions), so the draw and the exile are kept verbatim and only
// the mana moves from 2 to 6.
//
// R26 (decide, `GENN_GREED_EXILES = "odd"`) settles the garbled source line as "exile all odd-cost
// cards". R66 settles what "cost" means in both halves: "both the 2-cost draw and the odd-cost
// exile read each card's cost per R65 AT RESOLUTION; X-cost cards are exempt from both". So the
// number to read is `effectiveCost(state, instance)` — R65's one calculation for an instance:
// `costOverride`, else the printed cost, plus the instance's `costMod` (which persists in every
// zone, R78) plus the player's discounts. `queryCost` is the other half of R65 and is wrong here
// because it reads a DEFINITION and so cannot see the `costMod` #7 Jewelosco Scarab left on a card
// or the discount #95 Call to Chaos put across a whole library.
//
// Order matters and is §8's: the draw runs first, so the 2-cost cards are in hand before the exile
// looks at hands — and 2 is even, so nothing this card drew is then exiled. R4's hand cap applies to
// the draw, and a card burned to the graveyard by the cap is likewise even and survives the exile.
//
// !! BLOCKED — TWO MISSING VERBS (reported with this card) !!
// Both halves name specific existing cards, and no effect in `engine/src/effects` can:
//
//   1. The draw. `draw({ count })` takes the TOP of the library and `addToHand({ defId })` creates
//      a FRESH card of a definition rather than moving the one that is there. The engine needs the
//      verb #30 Archivist's header already asks for, which makes #94 its second caller:
//          drawFromLibrary({ instanceId?: string; defId?: string; player?: PlayerSpec }): Effect
//      (remove the named card from the library, push `drawn`, bump `state.counters.drawn`, then
//      `draw.addToHand` for the hand cap (R4) and the cast-on-draw path (R58)).
//
//   2. The exile. `exile({ target })` takes a `TargetSpec`, which is only
//      `self | selfHero | enemyHero | chosen` — there is no way to name a card a hook computed, and
//      `{ of: "chosen" }` reads the selections a PLAY carried (R81), which this card has none of.
//      The smallest fix is the shape `transform`, `vanilla`, `setRadiant` and `steal` already use:
//          | { of: "instance"; instanceId: string }      // added to TargetSpec in effects/targets.ts
//      `resolveTarget` already handles a `{ pick: "instance" }` selection, so this is a three-line
//      addition that also unblocks a dozen other cards. A zone-wide verb would be tidier still:
//          exileMatching({ zones: ("library"|"hand"|"graveyard")[]; filter; player? }): Effect
//
// Nothing stands in for either half. #30 Archivist ships `addToHand({ defId })` as a documented
// partial, which is defensible there because its whole effect is one card and the stand-in delivers
// the right one. Here a stand-in would copy an unbounded number of cards into a hand while leaving
// every original in the library, and the exile has no stand-in at all, so a half-built #94 would
// change the game state more wrongly than a #94 that only gains mana. The two clauses are left
// unwritten and their tests are `it.todo`.

import type { Hook, Script } from "@jackioh/engine";
import { gainMana } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-094");

/** §8: base "gain 2 mana"; radiant "Gain 6". */
const MANA = { base: 2, radiant: 6 } as const;

function greed(mana: number): Hook {
  return () => [
    // BLOCKED (§8 #94 "draw every 2-cost card from your library"): needs
    // `drawFromLibrary({ instanceId?, defId?, player? })` in engine/src/effects/draw.ts, matching
    // every library card whose `effectiveCost` is 2 and that is not X-cost (R66).

    // BLOCKED (§8 #94 "exile every odd-cost card in your library, hand and GY (X-cost cards
    // exempt)"): needs `{ of: "instance"; instanceId }` on `TargetSpec` in
    // engine/src/effects/targets.ts, or `exileMatching({ zones, filter, player? })` in
    // engine/src/effects/move.ts, matching every card in those three zones whose `effectiveCost` is
    // odd and that is not X-cost (R66).

    // §2.3: temporary mana, which may take current above max.
    gainMana({ amount: mana }),
  ];
}

export const base: Script = { cry: greed(MANA.base) };

export const radiant: Script = { cry: greed(MANA.radiant) };

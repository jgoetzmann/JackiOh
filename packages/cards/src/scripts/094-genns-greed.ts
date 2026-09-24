// #94 Genn's Greed (SPEC §8.4, R4, R26, R55, R65, R66, R135, BUILD M4-T4 row 94).
//
// Base: "Draw every 2-cost card from your library; exile every odd-cost card in your library, hand
// and GY (X-cost cards exempt); gain 2 mana". Radiant: "Gain 6" — a cell that changes only a number
// changes only that number (§8 Conventions), so the draw and the exile are kept verbatim and only
// the mana moves from 2 to 6.
//
// R26 (decide, `GENN_GREED_EXILES = "odd"`) settles the garbled source line as "exile all odd-cost
// cards". R66 settles what "cost" means in both halves: "both the 2-cost draw and the odd-cost
// exile read each card's cost per R65 AT RESOLUTION; X-cost cards are exempt from both". So the
// number both clauses read is `effectiveCost(state, instance)` — R65's one calculation for an
// instance: `costOverride`, else the printed cost, plus the instance's `costMod` (which persists in
// every zone, R78). The player's discounts are prices for a play from the hand, so they reach neither
// a library card nor a graveyard one (R65): /fullsend's "this turn your cards cost 1 less" does not
// make a 4 in the library a 3. `queryCost` is the other half of R65 and is wrong
// here because it reads a DEFINITION and so cannot see the `costMod` #7 Jewelosco Scarab left on a
// card or the discount #95 Call to Chaos put across a whole library. A printed 3 discounted to 2 is
// therefore drawn, and a printed 2 pushed to 3 is odd and exiled instead.
//
// THE ORDER IS §8's AND R135's. The draw runs first, so the 2-cost cards are in hand before the
// exile looks at hands — and 2 is even, so nothing this card drew is then exiled. R4's hand cap
// applies to the draw, and a card burned to the graveyard by the cap is likewise even and survives
// the exile. Inside the exile the zones go library, then hand, then graveyard, and each card is its
// own exile, so R55's counter moves once per card and anything watching an exile sees them one at a
// time: `exileMatching` is written to R135 and this file only names the order it already keeps.
//
// The draw clause reads its set once, as it begins, and keeps it (`forEachCard`): a drawn card that is
// cast on draw and asks has left the library by the answer, and the draws still owed are the ones
// the clause began with (R113). The exile reads its set once too (R135).
//
// The two clauses are one effect per card and one sweep, not a loop in this file that touches state:
// `drawFromLibrary` is the §6.3 Draw of a card a script named (the verb #30 Archivist asks for too),
// and `exileMatching` is §6.3 Exile over the three off-field zones by cost. Reading the library to
// name the cards is a read, not a mutation (CLAUDE.md rule 5), and it goes through `zoneCards`
// (engine/src/query.ts), which answers with a copy, so this file never names a field of PlayerState.

import type { CardInstance, EffectContext, Hook, Script } from "@jackioh/engine";
import { effectiveCost, isXCost, zoneCards } from "@jackioh/engine";
import { drawFromLibrary, exileMatching, forEachCard, gainMana } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-094");

/** §8: base "gain 2 mana"; radiant "Gain 6". */
const MANA = { base: 2, radiant: 6 } as const;

/** §8 #94: the one cost the draw clause names. */
const DRAWN_COST = 2;

/**
 * R66: every card in your library that costs 2 RIGHT NOW, X-cost cards exempt, in library order
 * (top down), which is the order they are drawn in.
 */
function drawnCards(ctx: EffectContext): readonly CardInstance[] {
  return zoneCards(ctx.state, ctx.controller, "library").filter(
    (card) => !isXCost(ctx.state, card) && effectiveCost(ctx.state, card) === DRAWN_COST,
  );
}

function greed(mana: number): Hook {
  return () => [
    // §8 "Draw every 2-cost card from your library": one draw per card, so each counts on the draw
    // counter, emits its own `drawn` event and meets the hand cap on its own (§2.4, R4, R55). The
    // set is read once, as the clause begins (R66), so a drawn card that is cast and asks does not
    // reshape the draws still owed after the answer (R113, `forEachCard`).
    forEachCard({ cards: drawnCards, each: (instanceId) => drawFromLibrary({ instanceId }) }),

    // §8 "exile every odd-cost card in your library, hand and GY (X-cost cards exempt)". R135's
    // order is `exileMatching`'s default — library, then hand, then graveyard — and it runs after
    // the draws, so a card this play just drew is in hand, even, and spared.
    exileMatching({ parity: "odd", exemptXCost: true }),

    // §2.3: temporary mana, which may take current above max.
    gainMana({ amount: mana }),
  ];
}

export const base: Script = { cry: greed(MANA.base) };

export const radiant: Script = { cry: greed(MANA.radiant) };

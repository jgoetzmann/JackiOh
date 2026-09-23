// A card's return to its hand: the price it returns with, and §5.1's end-of-turn return (SPEC §2.4,
// §5.1, §10.5 step 7, R4, R78, R153, R155). Found by the polish-4 edge-case hunt, round 3
// (docs/polish/4-edge-cases.md, lenses L2 and L8); every case here failed before its fix.
//
//  - R4: a price a card is given as it returns to a hand — #31's "+1", #37r's "costs 1 less" — is
//    its price in that hand. A full hand burns the card instead (§2.4), and the burned card keeps
//    its cost, as radiant #52's "costing 0" already did (re-entry.test.ts).
//  - R155: the end-of-turn return belongs to the Spell its own play landed in the graveyard, so a
//    card that left the graveyard and came back some other way the same turn stays there (R153).

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

const VANILLA = "core-008";
const STOCKPILE = "core-005";
const TIMMY = "core-011";
const DREAM = "core-023";
const SEVEN_SEVEN = "core-025";
const KY_MATH = "core-031";
const GRAVEDIGGER = "core-037";
const REMINISCE = "core-072";
const FIELD_OF_DREAMS = "core-076";

const AT_P2 = [{ pick: "hero", player: "p2" } as const];

describe("R4: a card a full hand burns keeps its cost, without the price of a return it never made", () => {
  it("R4 KY's Math Equation that a full hand burns at end of turn stays at its cost, without the +1 (§8 #31, R78)", () => {
    const fillers = Array.from({ length: 8 }, () => VANILLA);
    const g = scenario({
      p1: { hand: [KY_MATH, STOCKPILE, ...fillers], field: [TIMMY], library: [VANILLA, VANILLA, VANILLA, VANILLA] },
      p2: { field: [TIMMY], hand: [VANILLA], library: [VANILLA, VANILLA, VANILLA] },
    });
    const equation = g.card(KY_MATH);

    g.play(equation, { targets: AT_P2 });
    g.play(STOCKPILE); // hand 8 → draws 2 → 10: the hand is full when the turn ends
    expect(g.hand("p1")).toHaveLength(10);

    g.endTurn();

    // "Return to hand with cost +1": the hand is full, so the card is burned back to the graveyard
    // (§2.4) and never returns, and the +1 was the price of that return.
    g.expectInZone(equation, "graveyard");
    expect(g.card(equation).costMod).toBe(0);
  });

  it("R4 radiant Gravedigger's start-of-turn pick that a full hand burns stays at its cost, without the 1 less (§8 #37, R62, R78)", () => {
    const fillers = Array.from({ length: 10 }, () => VANILLA);
    const g = scenario({
      p1: {
        hand: fillers,
        field: [{ def: GRAVEDIGGER, radiant: true }],
        graveyard: [SEVEN_SEVEN],
        library: [VANILLA, VANILLA, VANILLA],
      },
      p2: { field: [TIMMY], hand: [VANILLA], library: [VANILLA, VANILLA, VANILLA] },
    });
    const seven = g.card(SEVEN_SEVEN);
    expect(g.hand("p1")).toHaveLength(10);

    g.endTurn(); // p2's turn
    g.endTurn(); // p1's start of turn: the Discover opens before the draw (R62)
    expect(g.state.pending?.playerId).toBe("p1");
    g.answer(seven.id);

    g.expectInZone(seven, "graveyard");
    expect(g.card(seven).costMod).toBe(0);
  });
});

describe("R155: the end-of-turn return belongs to the landing the Spell's own play made", () => {
  it("R155 Reoccurring Dream played, taken back to hand and then discarded into the graveyard the same turn does not return at end of turn (§5.1, R153)", () => {
    const g = scenario({
      p1: {
        hand: [DREAM, REMINISCE, FIELD_OF_DREAMS, VANILLA],
        field: [TIMMY],
        mana: 10,
        library: [VANILLA, VANILLA, VANILLA, VANILLA],
      },
      p2: { field: [TIMMY], hand: [VANILLA], library: [VANILLA, VANILLA, VANILLA] },
    });
    const dream = g.card(DREAM);

    g.play(dream); // §10.5 step 7 lands it in the graveyard, flagged to return (R155)
    g.expectInZone(dream, "graveyard");
    g.play(REMINISCE);
    g.answer(dream.id); // back to hand, never played again
    g.expectInZone(dream, "hand");
    g.play(FIELD_OF_DREAMS); // the hand is replaced: the Dream is discarded to the graveyard (R31)
    g.expectInZone(dream, "graveyard");

    g.endTurn();

    // What lies in the graveyard now arrived by a discard, not by its own play's step 7.
    g.expectInZone(dream, "graveyard");
  });
});

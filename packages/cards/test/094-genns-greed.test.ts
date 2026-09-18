// #94 Genn's Greed (SPEC §8 row 94, §2.3, §2.4; R4, R26, R65, R66).
//
// BUILD M4-T4 row 94: "Draws every 2-cost card; odd current-cost cards exiled from library, hand
// and GY, X-cost exempt (R26, R66); +2 mana (radiant +6)".
//
// §8: "Draw every 2-cost card from your library; exile every odd-cost card in your library, hand
// and GY (X-cost cards exempt); gain 2 mana", radiant "Gain 6" — a cell that changes only a number
// changes only that number (§8 Conventions), so the draw and the exile are identical on both faces
// and only the mana moves.
//
// R26 settles the garbled source line as "exile all ODD-cost cards". R66 settles what "cost" means
// in both halves: each card's cost per R65 read AT RESOLUTION, with X-cost cards exempt from both.
// §8's own order matters and is asserted: the draw runs first, so a drawn 2-cost card is in hand
// before the exile looks at hands — and 2 is even, so nothing this card drew is then exiled.
//
// STATUS: the script (`packages/cards/src/scripts/094-genns-greed.ts`) implements only the mana
// clause and documents both other clauses as BLOCKED on missing engine verbs. The tests below are
// written as the card SHOULD behave, so the draw and exile cases FAIL and name the gap rather than
// being weakened or skipped. The mana cases pass. See the report.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const GREED = "core-094";

/** Even, cost 2 — what the draw clause names. */
const TWO_COST = ["core-020", "core-045", "core-056"] as const; // Pointmaster, Deft Duelist, Jilliax
/** Odd — what the exile clause names. */
const ODD_COST = ["core-008", "core-005", "core-043", "core-019"] as const; // 1, 1, 3, 3
/** Even and not 2, so neither clause touches it. */
const FOUR_COST = "core-025";
/** X-cost, exempt from both clauses (R66). */
const X_COST = "core-074"; // #74 Adaptive UI
/**
 * A keyword-only unit parked on the board. §2.5 auto-ends a turn with nothing meaningful left, and
 * an auto-end starts the opponent's turn — with their draw — inside the same `play` step, which
 * would move cards these tests are watching. A unit that could still switch position prevents it.
 */
const KEEP_TURN = "core-008"; // #8 Mr. Vanilla

function defIds(cards: readonly { defId: string }[]): string[] {
  return cards.map((card) => card.defId);
}

function zones(s: Scenario): { hand: string[]; library: string[]; graveyard: string[]; exile: string[] } {
  return {
    hand: defIds(s.pile("p1", "hand")),
    library: defIds(s.pile("p1", "library")),
    graveyard: defIds(s.pile("p1", "graveyard")),
    exile: defIds(s.pile("p1", "exile")),
  };
}

/** The board every clause is read against: a 2-cost, an odd, an even non-2 and an X in each pile. */
function greedBoard(seed: string, radiant = false): Scenario {
  return scenario({
    seed,
    p1: {
      // A unit on the board keeps §2.5 from auto-ending the turn once the hand is spent or
      // exiled — an auto-end hands p2 a draw, which would move cards this test is watching.
      field: [KEEP_TURN],
      hand: [radiant ? { def: GREED, radiant: true } : GREED, ODD_COST[1], FOUR_COST],
      library: [TWO_COST[0], ODD_COST[0], ODD_COST[2], X_COST, FOUR_COST],
      graveyard: [ODD_COST[3], TWO_COST[1]],
    },
    p2: { hand: ["core-005"], library: ["core-016"] },
  });
}

// =============================================================================================
// the mana clause (§2.3) — implemented
// =============================================================================================

describe("#94 Genn's Greed — mana", () => {
  it("§2.3 base gains 2 temporary mana after paying its own 4", () => {
    const s = scenario({
      seed: "core-094-mana-base",
      p1: { hand: [GREED, "core-005"], library: ["core-016"] },
      p2: { hand: ["core-005"] },
    });
    s.expectMana("p1", 4);

    s.play(GREED);

    // 4 − 4 cost + 2 gained.
    s.expectMana("p1", 2);
    expect(s.state.players.p1.mana.max).toBe(4);
  });

  it("§2.3 the gain may take current mana ABOVE max", () => {
    const s = scenario({
      seed: "core-094-mana-above-max",
      p1: { hand: [GREED, "core-005"], library: ["core-016"], mana: 4 },
      p2: { hand: ["core-005"] },
    });

    s.play(GREED);

    s.expectMana("p1", 2);
    // Radiant's 6 is the case that really exceeds max; the base face proves `mana.max` is untouched.
    expect(s.state.players.p1.mana.max).toBe(4);
  });

  it("§3.2 the spell reaches the graveyard and counts as a card played", () => {
    const s = scenario({
      seed: "core-094-graveyard",
      p1: { hand: [GREED, "core-005"], library: ["core-016"] },
      p2: { hand: ["core-005"] },
    });

    s.play(GREED);

    s.expectInZone(GREED, "graveyard");
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
    s.expectEvents("cardPlayed", "manaChanged", "enteredGraveyard");
  });

  it("the mana goes to the CASTER, not the opponent", () => {
    const s = scenario({
      seed: "core-094-mana-side",
      p1: { hand: [GREED, "core-005"], library: ["core-016"] },
      p2: { hand: ["core-005"], mana: 4 },
    });

    s.play(GREED);

    s.expectMana("p1", 2);
    s.expectMana("p2", 4);
  });
});

describe("#94 Genn's Greed — radiant mana", () => {
  it('§8 "Gain 6": only the number changes, and 6 takes current mana past MAX_MANA', () => {
    const s = scenario({
      seed: "core-094-mana-radiant",
      p1: { hand: [{ def: GREED, radiant: true }, "core-005"], library: ["core-016"] },
      p2: { hand: ["core-005"] },
    });

    s.play(GREED);

    // 4 − 4 cost + 6 gained; §2.3 lets current sit above the max of 4.
    s.expectMana("p1", 6);
    expect(s.state.players.p1.mana.max).toBe(4);
  });

  it("radiant keeps the same cost of 4 (§8 Conventions: only the gain moved)", () => {
    const s = scenario({
      seed: "core-094-radiant-cost",
      p1: { hand: [{ def: GREED, radiant: true }, "core-005"], library: ["core-016"], mana: 3 },
      p2: { hand: ["core-005"] },
    });

    expect(() => s.play(GREED)).toThrow(/costs 4/);
  });
});

// =============================================================================================
// the draw clause — §8 "Draw every 2-cost card from your library"
// =============================================================================================

describe("#94 Genn's Greed — the 2-cost draw (R66)", () => {
  it("draws EVERY 2-cost card out of the library and leaves every other cost behind", () => {
    const s = greedBoard("core-094-draw");

    s.play(GREED);

    const after = zones(s);
    // The one 2-cost card in the library is now in hand; the library keeps the rest.
    expect(after.hand).toContain(TWO_COST[0]);
    expect(after.library).not.toContain(TWO_COST[0]);
    expect(after.library).toContain(FOUR_COST);
  });

  it("it is a DRAW, so each card emits `drawn` and counts on the draw counter (§2.4)", () => {
    const s = scenario({
      seed: "core-094-draw-events",
      p1: {
        // §2.5: a unit that could still switch keeps the turn from auto-ending, whose draw would
        // otherwise land on the global draw counter this test reads.
        field: [KEEP_TURN],
        hand: [GREED],
        library: [TWO_COST[0], TWO_COST[1], FOUR_COST],
      },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });
    const drawnBefore = s.state.counters.drawn;

    s.play(GREED);

    expect(defIds(s.pile("p1", "hand")).filter((id) => id === TWO_COST[0] || id === TWO_COST[1])).toHaveLength(2);
    expect(s.state.counters.drawn).toBe(drawnBefore + 2);
    expect(s.pile("p1", "library")).toHaveLength(1);
  });

  it("R66 the cost is read at resolution, so a card discounted TO 2 is drawn and a 2 pushed to 3 is not", () => {
    // HARNESS GAP (reported): no `SideSetup` key seeds `costMod`, and R66's whole point is that the
    // number is `effectiveCost` at resolution rather than the printed cost, so the test writes it.
    const s = scenario({
      seed: "core-094-r66",
      p1: {
        field: [KEEP_TURN],
        hand: [GREED],
        // A printed 3 discounted to 2, and a printed 2 pushed to 3.
        library: [ODD_COST[2], TWO_COST[0]],
      },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });
    const library = s.pile("p1", "library");
    const discounted = library[0];
    const inflated = library[1];
    expect(discounted?.defId).toBe(ODD_COST[2]);
    expect(inflated?.defId).toBe(TWO_COST[0]);
    if (discounted !== undefined) discounted.costMod = -1;
    if (inflated !== undefined) inflated.costMod = 1;

    s.play(GREED);

    // The printed-3 card now costs 2, so it is drawn; the printed-2 card now costs 3, so it is odd
    // and exiled instead.
    expect(defIds(s.pile("p1", "hand"))).toContain(ODD_COST[2]);
    expect(defIds(s.pile("p1", "exile"))).toContain(TWO_COST[0]);
  });

  it("R66 an X-cost card is exempt: it is never drawn by the 2-cost clause", () => {
    const s = scenario({
      seed: "core-094-x-draw",
      p1: { field: [KEEP_TURN], hand: [GREED], library: [X_COST, "core-024"] },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });

    s.play(GREED);

    // Both X-cost cards are still in the library; R65 reads them as 0 out of play, R66 exempts them.
    expect(defIds(s.pile("p1", "library")).sort()).toEqual([X_COST, "core-024"].sort());
    expect(s.pile("p1", "hand")).toHaveLength(0);
  });

  it("R4 the hand cap applies to the draw, and the burned card is a 2-cost so the exile spares it", () => {
    // Nine held cards plus Genn's Greed is a full hand; playing it leaves nine, so the first drawn
    // 2-cost fills the tenth slot and the second is burned to the graveyard (R4).
    const s = scenario({
      seed: "core-094-hand-cap",
      p1: {
        field: [KEEP_TURN],
        hand: [
          GREED,
          FOUR_COST,
          FOUR_COST,
          FOUR_COST,
          FOUR_COST,
          FOUR_COST,
          FOUR_COST,
          FOUR_COST,
          FOUR_COST,
          FOUR_COST,
        ],
        library: [TWO_COST[0], TWO_COST[1]],
      },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });

    s.play(GREED);

    expect(s.pile("p1", "hand")).toHaveLength(10);
    s.expectEvents("burned");
    // The burned card is a 2-cost, which is even, so the exile clause leaves it in the graveyard.
    expect(defIds(s.pile("p1", "graveyard"))).toContain(TWO_COST[1]);
    expect(defIds(s.pile("p1", "exile"))).not.toContain(TWO_COST[1]);
  });
});

// =============================================================================================
// the exile clause — §8 "exile every odd-cost card in your library, hand and GY"
// =============================================================================================

describe("#94 Genn's Greed — the odd-cost exile (R26, R66)", () => {
  it("R26 every odd-cost card in the LIBRARY is exiled", () => {
    const s = greedBoard("core-094-exile-library");

    s.play(GREED);

    const after = zones(s);
    expect(after.exile).toContain(ODD_COST[0]); // cost 1
    expect(after.exile).toContain(ODD_COST[2]); // cost 3
    expect(after.library).not.toContain(ODD_COST[0]);
    expect(after.library).not.toContain(ODD_COST[2]);
  });

  it("R26 every odd-cost card in the HAND is exiled", () => {
    const s = greedBoard("core-094-exile-hand");

    s.play(GREED);

    const after = zones(s);
    expect(after.exile).toContain(ODD_COST[1]); // the cost-1 card that was held
    expect(after.hand).not.toContain(ODD_COST[1]);
  });

  it("R26 every odd-cost card in the GRAVEYARD is exiled", () => {
    const s = greedBoard("core-094-exile-graveyard");

    s.play(GREED);

    const after = zones(s);
    expect(after.exile).toContain(ODD_COST[3]); // cost 3, in the graveyard
    expect(after.graveyard).not.toContain(ODD_COST[3]);
  });

  it("an EVEN-cost card is spared in all three zones", () => {
    const s = greedBoard("core-094-exile-spares-even");

    s.play(GREED);

    const after = zones(s);
    // The 4-cost cards in hand and library, and the 2-cost card in the graveyard, all stay put.
    expect(after.hand).toContain(FOUR_COST);
    expect(after.library).toContain(FOUR_COST);
    expect(after.graveyard).toContain(TWO_COST[1]);
    expect(after.exile).not.toContain(FOUR_COST);
    expect(after.exile).not.toContain(TWO_COST[1]);
  });

  it("R66 an X-cost card is exempt from the exile as well", () => {
    const s = greedBoard("core-094-exile-x");

    s.play(GREED);

    const after = zones(s);
    expect(after.library).toContain(X_COST);
    expect(after.exile).not.toContain(X_COST);
  });

  it("§8's order: the draw runs BEFORE the exile, so a drawn 2-cost card is never exiled", () => {
    const s = greedBoard("core-094-order");

    s.play(GREED);

    const after = zones(s);
    // The 2-cost card left the library, reached the hand, and the exile — which looks at hands —
    // left it alone because 2 is even.
    expect(after.hand).toContain(TWO_COST[0]);
    expect(after.exile).not.toContain(TWO_COST[0]);
  });

  it("the exile reaches YOUR three zones only: the opponent's cards are untouched", () => {
    const s = scenario({
      seed: "core-094-own-zones",
      // §2.5: a unit that could still switch keeps the turn from auto-ending and handing p2 a
      // draw off the library this test is watching.
      p1: { field: [KEEP_TURN], hand: [GREED], library: [ODD_COST[0]] },
      p2: { hand: [ODD_COST[1]], library: [ODD_COST[2]], graveyard: [ODD_COST[3]] },
    });

    s.play(GREED);

    expect(s.pile("p2", "exile")).toHaveLength(0);
    expect(defIds(s.pile("p2", "hand"))).toContain(ODD_COST[1]);
    expect(defIds(s.pile("p2", "library"))).toContain(ODD_COST[2]);
    expect(defIds(s.pile("p2", "graveyard"))).toContain(ODD_COST[3]);
  });

  it("R55 the exiles count, and the card itself is a 4-cost so it survives its own clause", () => {
    const s = greedBoard("core-094-self");

    s.play(GREED);

    // Genn's Greed costs 4 (even) and resolves from the `resolving` zone anyway.
    s.expectInZone(GREED, "graveyard");
    expect(s.state.counters.exiled).toBeGreaterThan(0);
  });
});

describe("#94 Genn's Greed — radiant keeps the draw and the exile", () => {
  it('§8 Conventions: "Gain 6" restates the mana only, so both other clauses still run', () => {
    const s = greedBoard("core-094-radiant-clauses", true);

    s.play(GREED);

    const after = zones(s);
    s.expectMana("p1", 6);
    expect(after.hand).toContain(TWO_COST[0]);
    expect(after.exile).toContain(ODD_COST[0]);
    expect(after.exile).toContain(ODD_COST[1]);
    expect(after.exile).toContain(ODD_COST[3]);
    expect(after.library).toContain(X_COST);
  });
});

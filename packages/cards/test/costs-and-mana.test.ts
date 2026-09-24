// What a card costs outside play, and what the refresh gives (SPEC §2.3, §6.3 Cost and Mana, R24,
// R48, R65, R66, R78). Found by the polish-4 edge-case hunt, round 4 (docs/polish/4-edge-cases.md,
// lenses "keywords and layers" and L8); every case here failed before its fix.
//
//  - R65 is one cost calculation for an instance, and it applies outside play too ("library, hand,
//    GY, pools, filters, comparisons"): #69's Recruit filter and #51's brackets read it off the
//    library card, as #30 Archivist and #94 Genn's Greed already did (R24, R66), so a `costMod` —
//    kept in every zone, R78 — moves a card between them. Two live Professor Curvatures both test the
//    cost the flat discounts leave, and neither reads what the other has already lowered.
//  - §2.3: max mana is min(turns, 4) plus persistent modifiers. The next refresh's one-shot rider
//    (#24's next-turn mana, #21's lower refresh) moves current mana only, as #6 Mana Well's gain does.
//  - Round 9, lens "keywords and layers". R65 (amended): a player's discounts (#35, #77, #78) are
//    prices for a play from the hand, so a library or a graveyard card is read at its own cost: #30
//    Archivist's "highest" and #94 Genn's Greed's parity do not see the turn's discounts.

import { effectiveCost } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";
import type { Selection } from "@jackioh/shared";

const STOCKPILE = "core-005";
const VANILLA = "core-008";
const FLOOD = "core-017"; // a printed 3-cost Spell
const SHREDDER = "core-013"; // Jlockeed Shredder-10, a printed 3-cost Unit
const MENACE = "core-019";
const RAPID = "core-010";
const TIMMY = "core-011"; // a unit on each board, so no turn auto-ends (R82)
const HIT_JOB = "core-016";
const HINDER = "core-021"; // cast on draw: the opponent's next refresh is 1 lower
const DIVIDEND = "core-024"; // X-cost Spell; the "mana" mode gains floor(X/2) next turn
const COST_4 = "core-025"; // 4-mana 7/7
const TUTOR = "core-051";
const CALL_TO_ARMS = "core-069";
const CURVATURE = "core-077";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA] as const;

function costInHand(s: Scenario, defId: string): number {
  const card = s.state.players.p1.hand.find((c) => c.defId === defId);
  if (card === undefined) throw new Error(`${defId} is not in p1's hand`);
  return effectiveCost(s.state, card);
}

describe("R65: one cost calculation, in play and out of it", () => {
  it("R65 two live Professor Curvature discounts both read the cost after the flat discounts, whichever was played first (R48)", () => {
    /** Play a base and a radiant Curvature in the given order, then read a 4-cost card next turn. */
    function nextTurnCost(radiantFirst: boolean): number {
      const s = scenario({
        p1: {
          hand: [CURVATURE, { def: CURVATURE, radiant: true }, COST_4, STOCKPILE],
          library: [...LIBRARY],
        },
        p2: { hand: [STOCKPILE], field: [MENACE], library: [...LIBRARY] },
      });
      for (const radiant of radiantFirst ? [true, false] : [false, true]) {
        const card = s.hand("p1").find((c) => c.defId === CURVATURE && c.radiant === radiant);
        if (card === undefined) throw new Error("setup");
        s.play(card);
      }
      s.endTurn().endTurn();
      expect(s.state.active).toBe("p1");
      return costInHand(s, COST_4);
    }
    // R65: "add player discounts; apply Professor Curvature if the result is then 4". The result
    // of the discounts is 4 for both modifiers, so both apply, 4 - 1 - 2 = 1, and the order the
    // two Curvatures were played in cannot change what a card costs.
    expect([nextTurnCost(false), nextTurnCost(true)]).toEqual([1, 1]);
  });

  it("R65 Call to Arms recruits a library Unit whose cost is 1, as Archivist and Genn's Greed read it (R24, R66, R78)", () => {
    const s = scenario({
      p1: {
        hand: [CALL_TO_ARMS, RAPID],
        // #95's "every card in your hand and library costs 2 less" leaves exactly this costMod.
        library: [{ def: SHREDDER, costMod: -2 }, STOCKPILE, STOCKPILE],
      },
      p2: { hand: [STOCKPILE], field: [MENACE], library: [...LIBRARY] },
    });
    const shredder = s.pile("p1", "library").find((c) => c.defId === SHREDDER);
    if (shredder === undefined) throw new Error("setup");
    // R65's one calculation for an instance, which #30 and #94 read for library cards: 3 - 2 = 1.
    expect(effectiveCost(s.state, shredder)).toBe(1);

    s.play(CALL_TO_ARMS);
    // "Recruit 3 Units costing 1 or less": the Shredder costs 1, so it is recruited.
    s.expectInZone(shredder, "field");
  });

  it("R65 KY's Private Tutor offers the bracket a library card's cost puts it in (§8 #51, R24)", () => {
    const s = scenario({
      p1: {
        hand: [TUTOR, RAPID],
        library: [{ def: FLOOD, costMod: -2 }],
      },
      p2: { hand: [STOCKPILE], field: [MENACE], library: [...LIBRARY] },
    });
    const flood = s.pile("p1", "library")[0];
    if (flood === undefined) throw new Error("setup");
    expect(effectiveCost(s.state, flood)).toBe(1);

    s.play(TUTOR);
    s.answer("Spell");
    const brackets = s.state.pending;
    if (brackets === null) throw new Error("the bracket prompt should be open");
    // The Flood costs 1, so the one bracket with a match is "0-1".
    const offered = brackets.options.map((o) => (o.selection.pick === "mode" ? o.selection.option : o.key));
    expect(offered).toEqual(["0-1"]);
  });
});

describe("§2.3: a one-shot refresh rider moves current mana, not max mana", () => {
  it("§2.3 Efficiency Dividend's next-turn mana and Hinder's lower refresh leave max mana at min(turns, 4), as Mana Well's gain does (§6.3 Mana)", () => {
    // Efficiency Dividend, X = 4, mana mode: floor(4/2) = 2 more at p1's next refresh.
    const dividend = scenario({
      seed: "edge-l8-dividend-max",
      p1: { hand: [DIVIDEND, HIT_JOB], field: [TIMMY] },
      p2: { hand: [STOCKPILE], field: [TIMMY] },
    });
    dividend.play(DIVIDEND, { x: 4, modes: ["mana"] });
    dividend.endTurn(); // p2's turn.
    dividend.endTurn(); // p1's turn: the refresh the rider was stored for.

    expect(dividend.state.active).toBe("p1");
    // The rider is temporary mana on top of the refresh (§2.3, §6.3)...
    dividend.expectMana("p1", 6);
    // ...and max mana is still min(turns started, 4), exactly as it is after Mana Well's gain.
    expect(dividend.view("p1").you.mana).toEqual({ current: 6, max: 4 });

    // Hinder, drawn and cast at p1's start of turn: p2's next refresh is 1 lower.
    const hinder = scenario({
      seed: "edge-l8-hinder-max",
      p1: { hand: [HIT_JOB], field: [TIMMY], library: [HINDER, TIMMY, TIMMY, TIMMY] },
      p2: { hand: [STOCKPILE], field: [TIMMY], library: [STOCKPILE, STOCKPILE, STOCKPILE] },
    });
    hinder.endTurn(); // p2's turn.
    hinder.endTurn(); // p1's turn: the draw casts Hinder.
    hinder.endTurn(); // p2's turn: the lowered refresh.

    expect(hinder.state.active).toBe("p2");
    hinder.expectMana("p2", 3);
    expect(hinder.view("p2").you.mana).toEqual({ current: 3, max: 4 });
  });
});

// ---------------------------------------------------------------------------
// Round 9: a play-time discount is not a library or graveyard card's cost (R65, R48, §8 #35, #77, #78)
// ---------------------------------------------------------------------------

const RAPID_REPLENISH = "core-010"; // Spell, 0
const SEVEN_SEVEN = "core-025"; // Unit, 4
const ARCHIVIST = "core-030";
const LUNAR_ECLIPSE = "core-035";
const FULLSEND = "core-078"; // Spell, 4
const GREED = "core-094";

const AT_P2 = [{ pick: "hero", player: "p2" } as const] satisfies Selection[];

describe("A play-time discount is not a library or graveyard card's cost (§6.3 Cost, R48, R65, §8 #35, #77, #78)", () => {
  it("R65 Archivist on the Curvature turn draws the 4-cost card as the library's highest, not a 3-cost one nearer the top (R48, R24)", () => {
    const g = scenario({
      p1: {
        hand: [CURVATURE, ARCHIVIST, HINDER],
        field: [{ def: VANILLA, lane: 1 }],
        // The turn's draw takes the top Vanilla; Archivist then reads a 3-cost Unit above a 4-cost one.
        library: [VANILLA, SHREDDER, SEVEN_SEVEN],
      },
      p2: { hand: [HINDER, HINDER], field: [{ def: VANILLA, lane: 1 }], library: LIBRARY },
    });
    g.play(CURVATURE, { zone: 2 });
    g.endTurn().endTurn();
    expect(g.state.active).toBe("p1");
    expect(g.pile("p1", "library").map((card) => card.defId)).toEqual([SHREDDER, SEVEN_SEVEN]);

    g.play(ARCHIVIST, { zone: 3, modes: ["highest"] });

    // R24: "highest" is the 7/7 at 4. Curvature prices a 4-cost card PLAYED this turn (R48); it does
    // not make the 7/7 in the library a 3 that ties with Shredder and loses to its place in the pile.
    expect(g.hand("p1").map((card) => card.defId)).toContain(SEVEN_SEVEN);
    expect(g.pile("p1", "library").map((card) => card.defId)).toEqual([SHREDDER]);
  });

  it("R65 Archivist after Lunar Eclipse still reads a library Spell at its own cost: a 4-cost Spell is higher than a 3-cost Unit (§8 #35, R24)", () => {
    const g = scenario({
      p1: {
        hand: [LUNAR_ECLIPSE, ARCHIVIST, HINDER],
        library: [SHREDDER, FULLSEND],
      },
      p2: { hand: [HINDER], library: LIBRARY },
    });
    g.play(LUNAR_ECLIPSE, { targets: AT_P2 });
    g.play(ARCHIVIST, { zone: 1, modes: ["highest"] });

    // "The next Spell you play this turn costs 1 less" is a price for playing /fullsend, not what it
    // costs lying in the library, so /fullsend at 4 is the highest card there.
    expect(g.hand("p1").map((card) => card.defId)).toContain(FULLSEND);
    expect(g.pile("p1", "library").map((card) => card.defId)).toEqual([SHREDDER]);
  });

  it("R65 Genn's Greed played under /fullsend exiles no even-cost card from the library or the graveyard, /fullsend itself included (§8 #78, #94, R66)", () => {
    const g = scenario({
      p1: {
        hand: [FULLSEND, GREED],
        // A unit that can still switch keeps §2.5's auto-end from passing the turn mid-test.
        field: [VANILLA],
        // /fullsend's granted "Combo: draw 1" takes the 0-cost Spell on top before Genn's text runs;
        // a 0 reads 0 in the hand whatever the discount, so the hand's parity is not in question.
        library: [RAPID_REPLENISH, SEVEN_SEVEN],
      },
      p2: { hand: [HINDER], field: [VANILLA], library: LIBRARY },
    });
    g.play(FULLSEND);
    g.play(GREED);

    expect(g.hand("p1").map((card) => card.defId)).toEqual([RAPID_REPLENISH]);
    // "Exile every odd-cost card in your library, hand and GY": the 7/7 costs 4 in the library, and
    // /fullsend, which step 7 landed in the graveyard, costs 4 there. "This turn your cards cost 1
    // less" is what they would cost to PLAY this turn; it does not make either of them a 3.
    expect(g.pile("p1", "exile").map((card) => card.defId)).toEqual([]);
    expect(g.pile("p1", "library").map((card) => card.defId)).toEqual([SEVEN_SEVEN]);
    expect(g.pile("p1", "graveyard").map((card) => card.defId)).toContain(FULLSEND);
  });
});

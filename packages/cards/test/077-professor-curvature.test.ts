// #77 Professor Curvature — SPEC §8.3, R48, R65.
//
// BUILD M4-T4: "Next turn only: current-cost-4 cards −1 (radiant −2); not this turn; expires (R48)".
//
// The three clauses are read off the hand's own cost, which `viewFor` computes with
// `mana.effectiveCost` (§10.8, R65) — the same number the play validator charges — and confirmed by
// actually paying for the cost-4 card on the turn the discount is live.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const CURVATURE = "core-077";

/** The probes, in hand and never played except where a test says so. */
const COST_3 = "core-017"; // Flood
const COST_4 = "core-025"; // 4-mana 7/7 — a Unit, so it has a lane to enter
const COST_6 = "core-029"; // GIGA Glowy Jelly Bean

/** There is no printed cost-5 card in Core, so "untouched above 4" is read at 6 (§8.3). */
const PROBES = [COST_3, COST_4, COST_6] as const;

/** Both sides keep a card and a unit, so no turn auto-ends underneath a cross-turn test (R82). */
const LIBRARY = ["core-008", "core-008", "core-008", "core-008"] as const;

/** The cost a card in the viewer's own hand shows now (§10.8, R65). */
function handCost(s: Scenario, defId: string): number {
  const hand = s.view("p1").you.hand;
  if (!Array.isArray(hand)) throw new Error("§10.8: the viewer's own hand is a list of cards");
  const card = hand.find((entry) => entry.defId === defId);
  if (card === undefined) throw new Error(`${defId} is not in p1's hand`);
  return card.cost;
}

/**
 * Harness gap (reported): there is no `mods()` accessor, so the modifier is read off the state in
 * the test file. REVIEW B1.7's purity grep covers `src` only, so this is fine here.
 */
function discounts(s: Scenario): unknown[] {
  return s.state.players.p1.mods.filter((mod) => mod.kind === "costDiscount");
}

function board(radiant: boolean): Scenario {
  return scenario({
    p1: {
      hand: [{ def: CURVATURE, radiant }, ...PROBES],
      library: [...LIBRARY],
    },
    p2: { hand: ["core-005"], field: ["core-019"], library: [...LIBRARY] },
  });
}

/** Two `endTurn()`s: the opponent really takes a turn in between, so this is p1's NEXT turn. */
function toMyNextTurn(s: Scenario): Scenario {
  return s.endTurn().endTurn();
}

describe("#77 Professor Curvature — base", () => {
  it("R48 the discount does nothing on the turn Professor Curvature was played", () => {
    const s = board(false);

    s.play(CURVATURE);

    expect(handCost(s, COST_4)).toBe(4);
    expect(handCost(s, COST_3)).toBe(3);
    expect(handCost(s, COST_6)).toBe(6);
    // It is installed all the same: R48 is `modifierIsLive`'s "not on `fromTurn`", not an absent mod.
    expect(discounts(s)).toHaveLength(1);
    expect(s.state.players.p1.mods[0]).toMatchObject({
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: 9 },
    });
  });

  it("R48 + R65 on the controller's next turn a cost-4 card costs 3 and nothing else moves", () => {
    const s = board(false);
    s.play(CURVATURE);

    toMyNextTurn(s);

    expect(handCost(s, COST_4)).toBe(3);
    // R65 applies Curvature only when the cost is 4 after every other modifier.
    expect(handCost(s, COST_3)).toBe(3);
    expect(handCost(s, COST_6)).toBe(6);
  });

  it("R48 the discount is really charged: the cost-4 card is paid at 3", () => {
    const s = board(false);
    s.play(CURVATURE);
    toMyNextTurn(s);

    // Mana refreshed to MAX_MANA (4) at the start of this turn (§2.3).
    s.expectMana("p1", 4);
    s.play(COST_4);
    s.expectMana("p1", 1);
  });

  it("R48 the discount expires at that turn's cleanup", () => {
    const s = board(false);
    s.play(CURVATURE);
    toMyNextTurn(s);
    expect(handCost(s, COST_4)).toBe(3);

    // Ending the turn it covered is the cleanup that drops it (§2.2).
    s.endTurn();

    expect(discounts(s)).toHaveLength(0);
    expect(handCost(s, COST_4)).toBe(4);
  });

  it("the Cry fires on play from hand, and the body is the printed 4/5 (§8.3)", () => {
    const s = board(false);

    s.play(CURVATURE);

    s.expectEvents("cardPlayed", "modifierChanged");
    s.expectStats(CURVATURE, { attack: 4, maxHealth: 5, health: 5 });
  });
});

/**
 * R169, BUILD M5-T4 ("badge list equals the view's modifiers"). Until R169 the discount existed
 * only in `state.players[p].mods`, which no view carried and no component drew, so a player had no
 * way to know Professor Curvature was on them — least of all on the turn it was played, where R48
 * makes it change no card's cost either. The proof is the view, not the state.
 */
describe("#77 Professor Curvature — visible to the player while active (R169, §10.8)", () => {
  it("shows a badge on the controller's seat the moment it resolves, saying it waits for next turn", () => {
    const s = board(false);

    s.play(CURVATURE);

    const badges = s.view("p1").you.modifiers;
    expect(badges, "the discount is on the board and so is its badge").toHaveLength(1);
    expect(badges[0]?.label).toBe("Cost-4 cards cost 1 less (next turn)");
    // §10.3 names the badge by id, so the animation lands on the element the view carries.
    expect(badges[0]?.id).toBe(s.state.players.p1.mods[0]?.id);
  });

  it("the badge drops its hedge on the turn the discount bites, and goes at that turn's cleanup", () => {
    const s = board(false);
    s.play(CURVATURE);

    toMyNextTurn(s);

    expect(s.view("p1").you.modifiers.map((modifier) => modifier.label)).toEqual(["Cost-4 cards cost 1 less"]);
    // R48: the same cleanup that ends the discount ends the badge, so neither outlives the other.
    s.endTurn();
    expect(s.view("p1").you.modifiers).toEqual([]);
  });

  it("the opponent sees it too: a Cry resolved face-up is public (§10.5 step 4)", () => {
    const s = board(true);

    s.play(CURVATURE);

    expect(s.view("p2").opponent.modifiers.map((modifier) => modifier.label)).toEqual([
      "Cost-4 cards cost 2 less (next turn)",
    ]);
  });
});

describe("#77 Professor Curvature — radiant", () => {
  it("R48 radiant does nothing on the turn it was played either", () => {
    const s = board(true);

    s.play(CURVATURE);

    expect(handCost(s, COST_4)).toBe(4);
    expect(s.state.players.p1.mods[0]).toMatchObject({
      kind: "costDiscount",
      amount: 2,
      onlyCurrentCost: 4,
    });
  });

  it("R48 + R65 radiant takes a cost-4 card to 2 next turn, cost 3 and cost 6 untouched", () => {
    const s = board(true);
    s.play(CURVATURE);

    toMyNextTurn(s);

    expect(handCost(s, COST_4)).toBe(2);
    expect(handCost(s, COST_3)).toBe(3);
    expect(handCost(s, COST_6)).toBe(6);
    s.play(COST_4);
    s.expectMana("p1", 2);
  });

  it("R48 radiant expires at that turn's cleanup too", () => {
    const s = board(true);
    s.play(CURVATURE);
    toMyNextTurn(s);

    s.endTurn();

    expect(discounts(s)).toHaveLength(0);
  });

  it("the radiant body is the printed 8/10 (§8.3)", () => {
    const s = board(true);

    s.play(CURVATURE);

    s.expectStats(CURVATURE, { attack: 8, maxHealth: 10, health: 10 });
  });
});

// #31 KY's Math Equation — SPEC §8.2 row 31, BUILD M4-T4 must-pass row 31:
// "Cost 1 → 1 damage, returns at cost 2 → 2, cost 3 → 3, cost 4 → 5; clamps at 89 (R25); player
//  discounts don't change the damage (R67); radiant Fib(cost+2)".
//
// Every side gets a unit on the board so §2.5's auto-end-turn does not run the turn on by itself
// (see the harness header): a unit with an unspent exertion is always a meaningful action.

import { describe, expect, it } from "vitest";
import { effectiveCost } from "@jackioh/engine";
import { scenario } from "./_harness";

const AT_ENEMY_HERO = [{ pick: "hero", player: "p2" } as const];

/** A board where p1 can play the equation and neither side auto-ends its turn. */
function board(): ReturnType<typeof scenario> {
  return scenario({
    seed: "ky-math",
    p1: { hand: ["31"], field: ["15"], library: ["15", "15", "15", "15"] },
    p2: { field: ["15"], library: ["15", "15", "15", "15"] },
  });
}

describe("#31 KY's Math Equation — base", () => {
  it("R67 at cost 1 deals Fib(1 + 0 + 1) = Fib(2) = 1 damage to the target", () => {
    const s = board();
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 29);
    s.expectEvents("cardPlayed", "damage");
  });

  it("R67 at cost 2 (one return behind it) deals Fib(3) = 2", () => {
    const s = board();
    s.card("31").costMod = 1;
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 28);
  });

  it("R67 at cost 3 deals Fib(4) = 3", () => {
    const s = board();
    s.card("31").costMod = 2;
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 27);
  });

  it("R67 at cost 4 deals Fib(5) = 5", () => {
    const s = board();
    s.card("31").costMod = 3;
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 25);
  });

  it("R25 the Fib index clamps at 11, so the damage clamps at 89", () => {
    const s = scenario({
      seed: "ky-math-clamp",
      // Enough mana to pay the 21 a costMod of 20 asks for: the index is what is being tested,
      // and R67 reads it off `costMod`, not off what was affordable.
      p1: { hand: ["31"], field: ["15"], library: ["15", "15"], mana: 30 },
      p2: { field: ["15"], library: ["15", "15"], health: 200 },
    });
    // Index 1 + 20 + 1 = 22, far past the table's last entry.
    s.card("31").costMod = 20;
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 111);
  });

  it("R67 a player discount changes the cost paid but not the damage", () => {
    const s = board();
    s.state.players.p1.mods.push({
      id: "test-spell-discount",
      kind: "costDiscount",
      amount: 1,
      onlyType: "Spell",
      expiry: { until: "never" },
    });
    s.play("31", { targets: AT_ENEMY_HERO });
    // The discount made it free — and the index still read the printed cost, so Fib(2) = 1.
    s.expectMana("p1", 4);
    s.expectHealth("p2", 29);
  });

  it("R78 end of turn: it returns to hand and its costMod is permanently +1", () => {
    const s = board();
    const equation = s.card("31");
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectInZone(equation, "graveyard");

    s.endTurn();

    s.expectInZone(equation, "hand");
    expect(s.hand("p1").map((card) => card.id)).toContain(equation.id);
    expect(s.card(equation).costMod).toBe(1);
  });

  it("R67/R78 the returned copy costs 2 and deals Fib(3) = 2 on its second play", () => {
    const s = board();
    const equation = s.card("31");
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 29);

    // p1's end of turn returns it; p2 takes a turn; p1's turn comes back around.
    s.endTurn();
    s.endTurn();

    expect(s.state.active).toBe("p1");

    // §8 row 31's Engine cell: "cost = printed + `costMod` (R67); the return adds +1 to the
    // instance's permanent `costMod`". ONE return has happened, so `costMod` is 1 and the price
    // R65 computes is the printed 1 plus that 1 — the "costs 2" of this case's name. `costMod`
    // reaches 2 only after the SECOND return, at the end of the turn this play is on.
    expect(s.card(equation).costMod).toBe(1);
    expect(effectiveCost(s.state, s.card(equation))).toBe(2);

    const manaBefore = s.state.players.p1.mana.current;
    s.play(equation, { targets: AT_ENEMY_HERO });
    // It really charged 2, and R67's index read printed 1 + costMod 1 + 1 = Fib(3) = 2 damage:
    // 1 from the first play, 2 from the second.
    s.expectMana("p1", manaBefore - 2);
    s.expectHealth("p2", 27);

    // And the second return puts the instance at cost 3 for its next play (1 → 2 → 3 → 5).
    s.endTurn();
    expect(s.card(equation).costMod).toBe(2);
    expect(effectiveCost(s.state, s.card(equation))).toBe(3);
  });

  it("the return belongs to the turn it was played on, not to every graveyard copy", () => {
    // A copy that was already in the graveyard when the turn began was not played this turn, so
    // ending the turn leaves it there — otherwise it would climb a cost every turn for the game.
    const s = scenario({
      seed: "ky-math-stale",
      p1: { hand: ["15"], field: ["15"], graveyard: ["31"], library: ["15", "15"] },
      p2: { field: ["15"], library: ["15", "15"] },
    });
    const stale = s.card("31");

    s.endTurn();

    s.expectInZone(stale, "graveyard");
    expect(s.card(stale).costMod).toBe(0);
  });
});

describe("#31 KY's Math Equation — radiant", () => {
  it("R67 radiant reads printed cost + costMod + 2, so cost 1 deals Fib(3) = 2", () => {
    const s = board();
    s.card("31").radiant = true;
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 28);
  });

  it("R67 radiant at cost 2 deals Fib(4) = 3", () => {
    const s = board();
    const equation = s.card("31");
    equation.radiant = true;
    equation.costMod = 1;
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 27);
  });

  it("R25 radiant clamps at 89 too", () => {
    const s = scenario({
      seed: "ky-math-clamp-radiant",
      // Enough mana to pay the 21 a costMod of 20 asks for: the index is what is being tested,
      // and R67 reads it off `costMod`, not off what was affordable.
      p1: { hand: ["31"], field: ["15"], library: ["15", "15"], mana: 30 },
      p2: { field: ["15"], library: ["15", "15"], health: 200 },
    });
    const equation = s.card("31");
    equation.radiant = true;
    equation.costMod = 20;
    s.play("31", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 111);
  });

  it("§8 Conventions: the radiant cell changes only the number, so the return clause is kept", () => {
    const s = board();
    const equation = s.card("31");
    equation.radiant = true;
    s.play("31", { targets: AT_ENEMY_HERO });
    s.endTurn();
    s.expectInZone(equation, "hand");
    expect(s.card(equation).costMod).toBe(1);
    expect(s.card(equation).radiant).toBe(true);
  });
});

describe("#31 KY's Math Equation — a cost below 0 (round 10 of the polish-4 edge-case hunt)", () => {
  it("R67 reads the cost floored at 0: Call to Chaos's -2 on a 1-cost Equation still deals Fib(0 + 1) = 1 (§2.3, §6.3 Cost, R65)", () => {
    // §8 #31: "Deal Fib(cost+1) damage", with cost = printed + costMod (R67). §2.3 and §6.3's Cost
    // row floor every cost at 0 — "Cost modifiers stack additively and floor at 0" — so a 1-cost
    // Equation that #95's "every card in your hand and library costs 2 less" took to costMod -2
    // costs 0 (the engine's own `effectiveCost` says so), and Fib(0 + 1) is 1, not Fib(-1 + 1) = 0.
    const s = scenario({
      p1: { hand: [{ def: "core-031", costMod: -2 }, "core-005"] },
      p2: { hand: ["core-005"] },
    });
    const equation = s.card("core-031");
    expect(effectiveCost(s.state, equation)).toBe(0);

    s.play(equation, { targets: AT_ENEMY_HERO });

    s.expectHealth("p2", 29);
  });

  it("R67 radiant: a costMod of -3 on the 1-cost Equation deals Fib(0 + 2) = 1, not Fib(-2 + 2) = 0", () => {
    const s = scenario({
      p1: { hand: [{ def: "core-031", costMod: -3, radiant: true }, "core-005"] },
      p2: { hand: ["core-005"] },
    });
    s.play("core-031", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 29);
  });
});

// #9 Moths to the Flame — SPEC §8.1 row 9, BUILD M4-T4 must-pass: "Each enemy unit attacks it in
// lane order at controller's start of turn, no exertion spent, sick units included, each attack is
// its own combat, stops when Moths dies (R53); radiant Armor 1 reduces each hit (R53)".
//
// `startTurn()` is the controller's own start of turn, so it is the whole trigger here. The
// attackers are picked for their arithmetic rather than their text: #7 (1/1), #12 (3/4), #2 (6/1)
// and #13 (8/10) have Cry or end-of-turn text only, and nothing they do fires when the harness
// places them on the field or when they are forced to attack.
//
// "Sick units included" is the one clause no card test can reach: `isSick` is
// `summonedTurn === state.turn` (combat.ts:63), and a unit the opponent summoned on their own turn
// is one turn old by the time this card's controller starts a turn, so a summoning-sick ENEMY unit
// cannot exist at this moment on any legal line of play. `forceAttack` never asks the question at
// all — it skips §4.2 steps 1-3 entirely — which is what the tests below assert in the reachable
// form (a Defense Position unit, which also cannot legally attack, is forced all the same), and
// `packages/engine/test/combat-resolution.test.ts` covers the sick attacker directly.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const LIBRARY = ["core-011", "core-011", "core-011"];

/** Who attacked whom, in the order the step declared it, and whether the attack was forced. */
function attacks(s: Scenario) {
  return s.lastEvents.flatMap((event) => (event.type === "attackDeclared" ? [event] : []));
}

describe("#9 Moths to the Flame (§8.1 row 9)", () => {
  it("R53 every enemy unit attacks it in lane order, each its own combat, and it strikes back", () => {
    const s = scenario({
      seed: "core-009-base",
      p1: { field: ["core-009"], library: [...LIBRARY] },
      // Lane order: 1/1, then 3/4, then 6/1 (§4.2, R53).
      p2: { field: ["core-007", "core-012", "core-002"] },
    });
    const scarab = s.card("core-007");
    const felinors = s.card("core-012");
    const bigot = s.card("core-002");

    s.startTurn();

    // Three separate forced combats, in enemy lane order.
    const declared = attacks(s);
    expect(declared.map((event) => event.attackerId)).toEqual([scarab.id, felinors.id, bigot.id]);
    expect(declared.map((event) => event.forced)).toEqual([true, true, true]);
    expect(declared.map((event) => event.targetId)).toEqual([
      s.card("core-009").id,
      s.card("core-009").id,
      s.card("core-009").id,
    ]);

    // 1 + 3 + 6 landed on a 1/14.
    s.expectStats("core-009", { attack: 1, health: 4, maxHealth: 14 });
    // The target still strikes back: its 1 attack killed the 1-health attackers and damaged the rest.
    s.expectInZone(scarab, "graveyard");
    s.expectStats(felinors, { health: 3, maxHealth: 4 });
    s.expectInZone(bigot, "graveyard");
  });

  it("R53 the forced attacks spend no exertion and ignore position and the validator", () => {
    const s = scenario({
      seed: "core-009-exertion",
      p1: { field: ["core-009"], library: [...LIBRARY] },
      // A Defense Position unit cannot legally attack at all (§4.2 step 1), and its position gives
      // it Armor 1, which absorbs Moths' whole strike-back.
      p2: { field: [{ def: "core-012", position: "DEF" }] },
    });
    const felinors = s.card("core-012");

    s.startTurn();

    expect(attacks(s).map((event) => event.attackerId)).toEqual([felinors.id]);
    s.expectStats("core-009", { health: 11, maxHealth: 14 });
    // Position Armor 1 reduced the 1 strike-back to nothing (§4.4 step 2, R63).
    s.expectStats(felinors, { health: 4, maxHealth: 4 });
    // R53: no exertion was spent, so the unit is untouched for its own controller's turn.
    expect(s.card(felinors).exertion).toEqual({ attacked: false, switched: false });
    expect(s.card(felinors).position).toBe("DEF");
  });

  it("R53 the run stops once Moths has left the field", () => {
    const s = scenario({
      seed: "core-009-stops",
      p1: { field: ["core-009"], library: [...LIBRARY] },
      // 6 then 8 is lethal to a 1/14 after two combats; lane 3 never gets to attack.
      p2: { field: ["core-002", "core-013", "core-007"] },
    });
    const moths = s.card("core-009");
    const bigot = s.card("core-002");
    const shredder = s.card("core-013");
    const scarab = s.card("core-007");

    s.startTurn();

    expect(attacks(s).map((event) => event.attackerId)).toEqual([bigot.id, shredder.id]);
    s.expectInZone(moths, "graveyard");
    // Each forced attack was its own combat with its own state check: the 6/1 died to the
    // strike-back of the combat it started, before the 8/10 attacked.
    s.expectInZone(bigot, "graveyard");
    s.expectStats(shredder, { health: 9, maxHealth: 10 });
    // Lane 3 was never asked: undamaged, unexerted, still on the field.
    s.expectInZone(scarab, "field");
    s.expectStats(scarab, { health: 1, maxHealth: 1 });
    expect(s.card(scarab).exertion).toEqual({ attacked: false, switched: false });
  });

  it("R53 radiant Armor 1 reduces each hit, and the radiant body is a 2/28", () => {
    const s = scenario({
      seed: "core-009-radiant",
      p1: { field: [{ def: "core-009", radiant: true }], library: [...LIBRARY] },
      p2: { field: ["core-012", "core-002"] },
    });
    const felinors = s.card("core-012");
    const bigot = s.card("core-002");

    s.startTurn();

    // 3 and 6 attack, each reduced by 1: 2 + 5 = 7, not 9 - 1 (§4.4 step 2).
    s.expectStats("core-009", { attack: 2, health: 21, maxHealth: 28 });
    // The radiant face strikes back with 2.
    s.expectStats(felinors, { health: 2, maxHealth: 4 });
    s.expectInZone(bigot, "graveyard");
  });
});


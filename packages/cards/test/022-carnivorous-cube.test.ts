// #22 Carnivorous Cube — SPEC §8.2, BUILD M4-T4 row 22: "The Tribute choice travels in the play
// action (R81) and excludes itself, chosen permanent sacrificed and remembered; Death → 2 copies
// (radiant fills board), backrow permanents copy to backrow, copies keep `statsOverride` (R41);
// nothing eaten → Death does nothing (R41)".
//
// The base Cube is 4/6, so one 7-attack hit kills it. The radiant Cube is 8/12, so it takes a 7 and
// a 6 in the same turn; Bigot (6/1) dies to the strike-back, which is not what any assertion reads.
//
// HARNESS GAP: `FieldSetup` has no `statsOverride`, so §7 stats cannot be seeded. The one fixture
// that needs an eaten card with them sets the field instance's `statsOverride` itself, the way
// `015-me-and-mr-token.test.ts` sets a radiant flag it cannot seed.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";
import { base, radiant } from "../src/scripts/022-carnivorous-cube";

const CUBE = "core-022"; // 4/6, radiant 8/12, cost 3.
const TIMMY = "core-011"; // Tempo Timmy, a plain 3/3 unit.
const MANA_WELL = "core-006"; // A Field Spell: a backrow permanent.
const HITTER = "core-025"; // 4-mana 7/7.
const BIGOT = "core-002"; // 6/1: the second hit that finishes the radiant Cube.
const FILLER = "core-005"; // A card in hand, so no turn auto-ends mid-fixture.

/** The controller's unit row as def ids, lane 1 to 5. */
function row(s: Scenario, player: "p1" | "p2"): (string | null)[] {
  return [1, 2, 3, 4, 5].map((lane) => s.unit(player, lane)?.defId ?? null);
}

function backrow(s: Scenario, player: "p1" | "p2"): (string | null)[] {
  return [1, 2, 3, 4, 5].map((lane) => s.backrow(player, lane)?.defId ?? null);
}

function graveyard(s: Scenario, player: "p1" | "p2"): string[] {
  return s.pile(player, "graveyard").map((card) => card.defId);
}

describe("#22 Carnivorous Cube", () => {
  it("R81 the meal is a declared play-time choice that excludes the Cube itself", () => {
    const decl = base.targets?.[0];
    expect(base.targets).toHaveLength(1);
    expect(decl?.kind).toBe("tribute");
    expect(decl?.min).toBe(1);
    expect(decl?.max).toBe(1);
    expect(decl?.filter?.side).toBe("ally");
    // R41: "cannot eat itself", and a backrow permanent is an eligible meal.
    expect(decl?.filter?.excludeSelf).toBe(true);
    expect(decl?.filter?.of).toEqual(["unit", "backrow"]);
    // §6.3: this card's tribute is a Sacrifice its own script performs, not a Tribute *cost*, so
    // the declaration carries no `amount` — `playChoices.tributeCostOf` would read that as a cost
    // paid from the play's `tributes` list, which reaches units only and refuses an unpayable play.
    expect(decl?.amount).toBeUndefined();
    // The radiant cell restates the Death clause only, so the Cry's choice is unchanged.
    expect(radiant.targets).toEqual(base.targets);
  });

  describe("base", () => {
    it("R81 Cry sacrifices the chosen permanent with no prompt", () => {
      const s = scenario({
        seed: "cube-eat",
        p1: { hand: [CUBE, FILLER], field: [TIMMY] },
        p2: { hand: [FILLER] },
      });
      const meal = s.card(TIMMY);
      s.play(CUBE, { targets: [{ pick: "instance", instanceId: meal.id }] });

      // R81: a declared choice never pauses resolution.
      expect(s.state.pending).toBeNull();
      expect(row(s, "p1")).toEqual([null, CUBE, null, null, null]);
      s.expectInZone(meal, "graveyard");
      s.expectEvents("cardPlayed", "destroyed", "enteredGraveyard");
    });

    it("R41, R57, R64 Death summons 2 copies of the remembered card", () => {
      const s = scenario({
        seed: "cube-death",
        p1: { hand: [CUBE, FILLER], field: [TIMMY] },
        p2: { hand: [FILLER], field: [HITTER] },
      });
      s.play(CUBE, { targets: [{ pick: "instance", instanceId: s.card(TIMMY).id }] });
      const cube = s.card(CUBE);

      s.endTurn();
      s.attack(HITTER, cube); // 7 through a 4/6.

      s.expectInZone(cube, "graveyard");
      // R64: laneless summons take the leftmost free zones.
      expect(row(s, "p1")).toEqual([TIMMY, TIMMY, null, null, null]);
      const copy = s.unit("p1", 1);
      if (copy === null) throw new Error("expected a copy in lane 1");
      // R57: a copy is a fresh card at full health, not the corpse.
      s.expectStats(copy, { attack: 3, maxHealth: 3, health: 3 });
      expect(copy.radiant).toBe(false);
    });

    it("R41 copies of an eaten backrow card go to the backrow", () => {
      const s = scenario({
        seed: "cube-backrow",
        p1: { hand: [CUBE, FILLER], backrow: [MANA_WELL] },
        p2: { hand: [FILLER], field: [HITTER] },
      });
      s.play(CUBE, { targets: [{ pick: "instance", instanceId: s.card(MANA_WELL).id }] });
      const cube = s.card(CUBE);

      s.endTurn();
      s.attack(HITTER, cube);

      expect(backrow(s, "p1")).toEqual([MANA_WELL, MANA_WELL, null, null, null]);
      expect(row(s, "p1")).toEqual([null, null, null, null, null]);
    });

    it("R41, R57 copies keep the eaten card's radiant flag and statsOverride", () => {
      const s = scenario({
        seed: "cube-stats",
        p1: { hand: [CUBE, FILLER], field: [{ def: TIMMY, radiant: true }] },
        p2: { hand: [FILLER], field: [HITTER] },
      });
      // HARNESS GAP (see the header): §7 stats, which R41 says the copies inherit.
      s.card(TIMMY).statsOverride = { attack: 5, health: 5 };
      s.play(CUBE, { targets: [{ pick: "instance", instanceId: s.card(TIMMY).id }] });
      const cube = s.card(CUBE);

      s.endTurn();
      s.attack(HITTER, cube);

      const copies = [s.unit("p1", 1), s.unit("p1", 2)];
      expect(copies.map((copy) => copy?.defId)).toEqual([TIMMY, TIMMY]);
      for (const copy of copies) {
        if (copy === null) throw new Error("expected two copies");
        expect(copy.radiant).toBe(true);
        s.expectStats(copy, { attack: 5, maxHealth: 5 });
      }
    });

    it("R41 nothing to tribute → the Cry fizzles and the Cube still enters", () => {
      const s = scenario({
        seed: "cube-hungry",
        p1: { hand: [CUBE, FILLER] },
        p2: { hand: [FILLER] },
      });
      s.play(CUBE);

      expect(row(s, "p1")).toEqual([CUBE, null, null, null, null]);
      expect(graveyard(s, "p1")).toEqual([]);
      expect(s.card(CUBE).memory).toEqual({});
    });

    it("R41 nothing eaten → Death does nothing", () => {
      const s = scenario({
        seed: "cube-hungry-death",
        p1: { hand: [CUBE, FILLER] },
        p2: { hand: [FILLER], field: [HITTER] },
      });
      s.play(CUBE);
      const cube = s.card(CUBE);

      s.endTurn();
      s.attack(HITTER, cube);

      expect(row(s, "p1")).toEqual([null, null, null, null, null]);
      expect(backrow(s, "p1")).toEqual([null, null, null, null, null]);
      expect(graveyard(s, "p1")).toEqual([CUBE]);
    });
  });

  describe("radiant", () => {
    it("R41, R64 Death fills your board with copies", () => {
      const s = scenario({
        seed: "cube-radiant-fill",
        p1: { hand: [{ def: CUBE, radiant: true }, FILLER], field: [TIMMY] },
        // 7 + 6 = 13 gets through the radiant Cube's 12 health in one turn.
        p2: { hand: [FILLER], field: [HITTER, BIGOT] },
      });
      s.play(CUBE, { targets: [{ pick: "instance", instanceId: s.card(TIMMY).id }] });
      const cube = s.card(CUBE);
      s.expectStats(cube, { attack: 8, maxHealth: 12 });

      s.endTurn();
      s.attack(HITTER, cube);
      s.expectInZone(cube, "field"); // 7 of 12.
      s.attack(BIGOT, cube);

      s.expectInZone(cube, "graveyard");
      // R64: "fill your board" takes every empty, unlocked unit zone, the Cube's own included.
      expect(row(s, "p1")).toEqual([TIMMY, TIMMY, TIMMY, TIMMY, TIMMY]);
    });

    it("R41 an eaten backrow card fills the backrow instead", () => {
      const s = scenario({
        seed: "cube-radiant-backrow",
        p1: { hand: [{ def: CUBE, radiant: true }, FILLER], backrow: [MANA_WELL] },
        p2: { hand: [FILLER], field: [HITTER, BIGOT] },
      });
      s.play(CUBE, { targets: [{ pick: "instance", instanceId: s.card(MANA_WELL).id }] });
      const cube = s.card(CUBE);

      s.endTurn();
      s.attack(HITTER, cube);
      s.attack(BIGOT, cube);

      s.expectInZone(cube, "graveyard");
      expect(backrow(s, "p1")).toEqual([MANA_WELL, MANA_WELL, MANA_WELL, MANA_WELL, MANA_WELL]);
      expect(row(s, "p1")).toEqual([null, null, null, null, null]);
    });

    it("R41 nothing eaten → Death does nothing", () => {
      const s = scenario({
        seed: "cube-radiant-hungry",
        p1: { hand: [{ def: CUBE, radiant: true }, FILLER] },
        p2: { hand: [FILLER], field: [HITTER, BIGOT] },
      });
      s.play(CUBE);
      const cube = s.card(CUBE);

      s.endTurn();
      s.attack(HITTER, cube);
      s.attack(BIGOT, cube);

      s.expectInZone(cube, "graveyard");
      expect(row(s, "p1")).toEqual([null, null, null, null, null]);
      expect(graveyard(s, "p1")).toEqual([CUBE]);
    });

    it("the Cry is kept: the radiant face still eats and remembers (§8 Conventions)", () => {
      const s = scenario({
        seed: "cube-radiant-eat",
        p1: { hand: [{ def: CUBE, radiant: true }, FILLER], field: [TIMMY] },
        p2: { hand: [FILLER] },
      });
      const meal = s.card(TIMMY);
      s.play(CUBE, { targets: [{ pick: "instance", instanceId: meal.id }] });

      s.expectInZone(meal, "graveyard");
      expect(s.card(CUBE).memory).toMatchObject({ eaten: { defId: TIMMY, row: "units" } });
    });
  });
});

// #13 Jlockeed Shredder-10 (SPEC §8.1, BUILD M4-T4 row 13): "Controller's end of turn: 2 to every
// enemy unit and hero as separate instances; units it kills die after all hits land (R59); not on
// the opponent's end; radiant 5 (R51)".
//
// R51 fixes what "each enemy unit and the enemy hero" means: every enemy unit plus the enemy hero,
// ONE damage instance each. R59 fixes when they die: the state check "never runs between the hits
// of one effect", so a unit the first hit kills is still standing while the later hits land and dies
// only when the whole end-of-turn hook has finished.
//
// The board: p2 lane 1 is Pointmaster (7/2), which 2 damage kills, and lane 2 is Mr. Vanilla (3/3),
// which survives at 1. A lane-1 death is what makes R59 observable — the lane-2 hit and the hero
// hit still have to land after it.
//
// Every scenario gives both sides a library, so nobody takes §2.4 fatigue damage when `endTurn`
// hands the turn over and the opponent draws, and a spare hand card, so the fresh turn always has a
// meaningful action and cannot auto-end onwards (§2.5).

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

/** Every `damage` event of the most recent step, narrowed so `amount` and `targetId` are readable. */
function hits(s: Scenario): { targetId: string; amount: number }[] {
  return s.lastEvents.flatMap((event) =>
    event.type === "damage" ? [{ targetId: event.targetId, amount: event.amount }] : [],
  );
}

function shredderBoard(radiant: boolean): Scenario {
  return scenario({
    p1: {
      field: [{ def: "core-013", radiant }],
      hand: ["core-005"],
      library: ["core-005"],
    },
    p2: {
      field: ["core-020", "core-008"],
      hand: ["core-005"],
      library: ["core-005"],
    },
  });
}

describe("#13 Jlockeed Shredder-10", () => {
  describe("base", () => {
    it("R51 deals 2 to every enemy unit and the enemy hero at its controller's end of turn", () => {
      const s = shredderBoard(false);
      const pointmaster = s.card("core-020");

      s.endTurn();

      s.expectInZone(pointmaster, "graveyard"); // 7/2 took 2
      s.expectStats("core-008", { health: 1, maxHealth: 3 }); // 3/3 took 2
      s.expectHealth("p2", 28);
      s.expectHealth("p1", 30); // "each ENEMY unit and the enemy hero": nothing of its own
    });

    it("R51 lands one separate damage instance per target, the hero last", () => {
      const s = shredderBoard(false);

      s.endTurn();

      // Three instances, not one area effect: two units in lane order, then the hero.
      expect(hits(s).map((hit) => hit.amount)).toEqual([2, 2, 2]);
      expect(hits(s)[2]?.targetId).toBe("hero-p2");
    });

    it("R59 kills land before anything dies: the state check runs after the whole hook", () => {
      const s = shredderBoard(false);

      s.endTurn();

      // Lane 1 was dead on the first hit, yet the lane-2 unit and the hero were still hit, and the
      // `destroyed` event comes after the last `damage` — the state check never ran between them.
      s.expectEvents("damage", "damage", "damage", "destroyed");
      const types = s.lastEvents.map((event) => event.type);
      expect(types.indexOf("destroyed")).toBeGreaterThan(types.lastIndexOf("damage"));
    });

    it("does nothing on the opponent's end of turn (§6.2: its controller's turn alone)", () => {
      const s = scenario({
        p1: { field: ["core-008"], hand: ["core-005"], library: ["core-005"] },
        // The Shredder belongs to the player who is NOT ending a turn here.
        p2: { field: ["core-013"], hand: ["core-005"], library: ["core-005"] },
      });

      s.endTurn();

      s.expectHealth("p1", 30);
      s.expectStats("core-008", { health: 3, maxHealth: 3 });
      expect(s.events.flatMap((event) => (event.type === "damage" ? [event] : []))).toEqual([]);
    });
  });

  describe("radiant", () => {
    it("R51 deals 5 to every enemy unit and the enemy hero", () => {
      const s = shredderBoard(true);
      const pointmaster = s.card("core-020");
      const vanilla = s.card("core-008");

      s.endTurn();

      s.expectInZone(pointmaster, "graveyard"); // 7/2
      s.expectInZone(vanilla, "graveyard"); // 3/3, which 2 would have survived
      s.expectHealth("p2", 25);
      expect(hits(s).map((hit) => hit.amount)).toEqual([5, 5, 5]);
    });
  });
});

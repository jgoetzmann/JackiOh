// #12 Duplicating Felinors (SPEC §8.1, BUILD M4-T4 row 12): "Copy lands in the leftmost free zone
// (R64), its Cry does not fire, buffs copied, damage not (R57); board full → no copy".
//
// R57: a copy of a unit on the field keeps its radiant flag, buffs, granted keywords, Vanilla state
// and `statsOverride`, and resets damage, exertion and counters.
// R64: with no zone named the copy takes the leftmost empty, unlocked, unreserved unit zone, and
// the summon fizzles when the row has none.
// R1 / §6.2: a copy fires no Cry — the ruling names this very card ("#12 would fill the board for
// 2 mana otherwise").
//
// Radiant (R275): the body is a 6/9 and the cell is "Same", so the copy — which keeps the radiant
// flag (R57) — is a Radiant 6/9 as well: the effect doubles with the stats.
//
// HARNESS GAP, worked around here and reported: there is no way to seed layer-4 buffs or damage.
// They cannot be reached through play either: a Cry fires the instant the unit enters, so the played
// body has no history yet. R78 resets both on leaving the field and `reduce`'s play path resets
// neither on entering, so seeding them on the hand instance is the one route to the "buffs copied,
// damage not" clause.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

/** The controller's unit row as def ids, lane 1 to 5, with `null` for an empty zone. */
function row(s: Scenario, player: "p1" | "p2"): (string | null)[] {
  return [1, 2, 3, 4, 5].map((lane) => s.unit(player, lane)?.defId ?? null);
}

function lane(s: Scenario, player: "p1" | "p2", at: number): NonNullable<ReturnType<Scenario["unit"]>> {
  const unit = s.unit(player, at);
  if (unit === null) throw new Error(`no unit in ${player} lane ${at}`);
  return unit;
}

describe("#12 Duplicating Felinors", () => {
  describe("base", () => {
    it("R64 puts the copy in the leftmost free unit zone, not the lane next to it", () => {
      const s = scenario({
        // Lanes 1 and 3 are taken, so lane 2 is the leftmost free zone for the Felinors itself and
        // lane 4 for its copy: placement is "leftmost free", never "adjacent" (§3.1 lanes).
        p1: {
          field: [
            { def: "core-008", lane: 1 },
            { def: "core-020", lane: 3 },
          ],
          hand: ["core-012", "core-005"],
          library: ["core-005"],
        },
      });

      s.play("core-012");

      expect(row(s, "p1")).toEqual(["core-008", "core-012", "core-020", "core-012", null]);
    });

    it("R1 the copy's Cry does not fire, so exactly one copy is made", () => {
      const s = scenario({ p1: { hand: ["core-012", "core-005"], library: ["core-005"] } });

      s.play("core-012");

      // Two bodies, not a full board: the copy is a summon, and a summon fires no Cry (§6.2).
      expect(row(s, "p1")).toEqual(["core-012", "core-012", null, null, null]);
    });

    it("R57 copies buffs and does not copy damage, exertion or counters", () => {
      const s = scenario({ p1: { hand: ["core-012", "core-005"], library: ["core-005"] } });
      // HARNESS GAP (see the header): layer-4 buffs and damage, seeded on the hand instance
      // because a Cry leaves no window to apply them on the field.
      const felinors = s.card("core-012");
      felinors.buffs.attack = 2;
      felinors.buffs.health = 2;
      felinors.damage = 3;

      s.play("core-012");

      // The original: printed 3/4 plus the +2/+2 buff, three damage still on it.
      s.expectStats(lane(s, "p1", 1), { attack: 5, health: 3, maxHealth: 6 });
      // The copy: the same buff, no damage.
      s.expectStats(lane(s, "p1", 2), { attack: 5, health: 6, maxHealth: 6 });
      const copy = lane(s, "p1", 2);
      expect(copy.damage).toBe(0);
      expect(copy.exertion).toEqual({ attacked: false, switched: false });
      expect(copy.id).not.toBe(felinors.id);
    });

    it("R64 makes no copy when the board is full", () => {
      const s = scenario({
        p1: {
          field: ["core-008", "core-008", "core-008", "core-008"],
          hand: ["core-012", "core-005"],
          library: ["core-005"],
        },
      });

      s.play("core-012");

      // The Felinors took the last zone itself, so the copy found none and fizzled silently.
      expect(row(s, "p1")).toEqual(["core-008", "core-008", "core-008", "core-008", "core-012"]);
    });
  });

  describe("radiant", () => {
    const RADIANT_HAND = [{ def: "core-012", radiant: true }, "core-005"] as const;

    it("R275, R57 the Radiant body is a 6/9, and so is its copy, which keeps the radiant flag", () => {
      const s = scenario({ p1: { hand: RADIANT_HAND, library: ["core-005"] } });

      s.play("core-012");

      expect(row(s, "p1")).toEqual(["core-012", "core-012", null, null, null]);
      s.expectStats(lane(s, "p1", 1), { attack: 6, health: 9, maxHealth: 9 });
      s.expectStats(lane(s, "p1", 2), { attack: 6, health: 9, maxHealth: 9 });
      expect(lane(s, "p1", 1).radiant).toBe(true);
      expect(lane(s, "p1", 2).radiant).toBe(true);
      expect(lane(s, "p1", 2).id).not.toBe(lane(s, "p1", 1).id);
    });

    it("R1 the radiant copy's Cry does not fire either", () => {
      const s = scenario({ p1: { hand: RADIANT_HAND, library: ["core-005"] } });

      s.play("core-012");

      expect(row(s, "p1").filter((defId) => defId === "core-012")).toHaveLength(2);
    });

    it("R57 the Radiant copy keeps buffs and not damage, on the 6/9 face", () => {
      const s = scenario({ p1: { hand: RADIANT_HAND, library: ["core-005"] } });
      // HARNESS GAP (see the header): seeded on the hand instance.
      const felinors = s.card("core-012");
      felinors.buffs.attack = 1;
      felinors.buffs.health = 1;
      felinors.damage = 4;

      s.play("core-012");

      s.expectStats(lane(s, "p1", 1), { attack: 7, health: 6, maxHealth: 10 });
      s.expectStats(lane(s, "p1", 2), { attack: 7, health: 10, maxHealth: 10 });
    });

    it("R64 the Radiant face makes no copy on a full board either", () => {
      const s = scenario({
        p1: {
          field: ["core-008", "core-008", "core-008", "core-008"],
          hand: RADIANT_HAND,
          library: ["core-005"],
        },
      });

      s.play("core-012");

      expect(row(s, "p1")).toEqual(["core-008", "core-008", "core-008", "core-008", "core-012"]);
    });
  });
});

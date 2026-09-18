// #15 Me and Mr Token (SPEC §8.1, BUILD M4-T4 row 15): "1 Rush Token; radiant 3; fewer when the
// board is nearly full".
//
// The "fewer" clause is R64: a laneless summon takes the leftmost empty, unlocked, unreserved unit
// zone and fizzles silently when the row has none, so three independent summons produce however
// many zones were free.
//
// HARNESS GAP: `SideSetup.hand` is `string[]`, so a RADIANT card cannot be seeded in a hand and a
// radiant Cry can only be reached by playing one. Until `hand` takes `{ def, radiant }` the radiant
// tests set the flag on the hand instance themselves; see `playRadiant`.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const RUSH_TOKEN = "core-t-rush";

/** HARNESS GAP (see the header): make the hand copy radiant, then play it. */
function playRadiant(s: Scenario, card: string): Scenario {
  s.card(card).radiant = true;
  return s.play(card);
}

/** The controller's unit row as def ids, lane 1 to 5, with `null` for an empty zone. */
function row(s: Scenario, player: "p1" | "p2"): (string | null)[] {
  return [1, 2, 3, 4, 5].map((lane) => s.unit(player, lane)?.defId ?? null);
}

function tokenCount(s: Scenario, player: "p1" | "p2"): number {
  return row(s, player).filter((defId) => defId === RUSH_TOKEN).length;
}

describe("#15 Me and Mr Token", () => {
  describe("base", () => {
    it("summons one Rush Token into the next free zone (R64)", () => {
      const s = scenario({ p1: { hand: ["core-015", "core-005"], library: ["core-005"] } });

      s.play("core-015");

      expect(row(s, "p1")).toEqual(["core-015", RUSH_TOKEN, null, null, null]);
      // §7: the token's stats and its Rush come from its own catalog face, never from this card.
      s.expectStats("core-015", { attack: 1, health: 1 });
      s.expectStats(s.card(RUSH_TOKEN), { attack: 3, health: 3 });
    });

    it("summons nothing extra when the unit itself takes the last zone (R64)", () => {
      const s = scenario({
        p1: {
          field: ["core-008", "core-008", "core-008", "core-008"],
          hand: ["core-015", "core-005"],
          library: ["core-005"],
        },
      });

      s.play("core-015");

      expect(row(s, "p1")).toEqual(["core-008", "core-008", "core-008", "core-008", "core-015"]);
      expect(tokenCount(s, "p1")).toBe(0);
    });
  });

  describe("radiant", () => {
    it("summons 3 Rush Tokens", () => {
      const s = scenario({ p1: { hand: ["core-015", "core-005"], library: ["core-005"] } });

      playRadiant(s, "core-015");

      expect(row(s, "p1")).toEqual(["core-015", RUSH_TOKEN, RUSH_TOKEN, RUSH_TOKEN, null]);
      s.expectStats("core-015", { attack: 2, health: 2 });
      expect(tokenCount(s, "p1")).toBe(3);
    });

    it("R64 makes fewer tokens when the board is nearly full, and the extras fizzle silently", () => {
      const s = scenario({
        p1: {
          field: ["core-008", "core-008", "core-008"],
          hand: ["core-015", "core-005"],
          library: ["core-005"],
        },
      });

      playRadiant(s, "core-015");

      // One zone was left after the unit itself landed, so one token; the other two summons found
      // no zone and did nothing — no error, no burn, no replacement.
      expect(row(s, "p1")).toEqual(["core-008", "core-008", "core-008", "core-015", RUSH_TOKEN]);
      expect(tokenCount(s, "p1")).toBe(1);
    });
  });
});

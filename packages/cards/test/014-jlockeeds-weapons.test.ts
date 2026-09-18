// #14 Jlockeed's Weapons (SPEC §8.1, BUILD M4-T4 row 14): "Allies +4 attack, Rush, First Strike
// while present; later summons get it; gone when destroyed; radiant +10".
//
// The keywords are tested through the rules rather than through a keyword list, which is what the
// row is really about:
//   Rush         — §4.1: a unit summoned this turn attacking a unit at all.
//   First Strike — §4.3 step 1: the ally kills Bigot (6/1) and takes nothing back, where without
//                  the keyword the simultaneous step would kill a 3-health ally outright.
// Bigot is seeded on the field, so its own Cry never fires (R1: only when played).
//
// The aura is §10.4 layer 5, recomputed on every read from the permanents in play, so "gone when it
// leaves" is not a clause this card scripts — the test proves it by removing the Field Spell.
//
// CROSS-CARD DEPENDENCY: the removal test plays #36 Magic Jammed ("Destroy target backrow card"),
// whose target is unnarrowed and may therefore be an ally card (§8 Conventions). It is the only
// in-game way a test can take a Field Spell off the board; a harness step that removed a permanent
// would make this test self-contained.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

function lane(s: Scenario, player: "p1" | "p2", at: number): NonNullable<ReturnType<Scenario["unit"]>> {
  const unit = s.unit(player, at);
  if (unit === null) throw new Error(`no unit in ${player} lane ${at}`);
  return unit;
}

describe("#14 Jlockeed's Weapons", () => {
  describe("base", () => {
    it("gives allied units +4 attack while it is on the field", () => {
      const s = scenario({
        p1: { backrow: ["core-014"], field: ["core-008"], hand: ["core-005"], library: ["core-005"] },
        p2: { field: ["core-002"], hand: ["core-005"], library: ["core-005"] },
      });

      // Mr. Vanilla is printed 3/3.
      s.expectStats("core-008", { attack: 7, health: 3, maxHealth: 3 });
      // "Your units": the enemy's Bigot (6/1) is untouched.
      s.expectStats("core-002", { attack: 6, health: 1, maxHealth: 1 });
    });

    it("grants First Strike, so a 3-health ally kills Bigot and takes nothing back (§4.3)", () => {
      const s = scenario({
        p1: { backrow: ["core-014"], field: ["core-008"], hand: ["core-005"], library: ["core-005"] },
        p2: { field: ["core-002"], hand: ["core-005"], library: ["core-005"] },
      });
      const bigot = s.card("core-002");

      s.attack("core-008", "core-002");

      s.expectInZone(bigot, "graveyard");
      // Without the granted First Strike the exchange is simultaneous and Bigot's 6 kills the ally.
      s.expectStats("core-008", { health: 3 });
    });

    it("covers a unit summoned after it, Rush included (§10.4 layer 5, R83)", () => {
      const s = scenario({
        p1: { backrow: ["core-014"], hand: ["core-015", "core-005"], library: ["core-005"] },
        p2: { field: ["core-002"], hand: ["core-005"], library: ["core-005"] },
      });

      // #15 Me and Mr Token is printed 1/1 and its Cry summons a 3/3 Rush Token: both land after
      // the Field Spell did, and both are covered.
      s.play("core-015");
      s.expectStats(lane(s, "p1", 1), { attack: 5, health: 1 });
      s.expectStats(lane(s, "p1", 2), { attack: 7, health: 3 });

      // Summoning sick this turn, and it attacks a unit anyway: that is the granted Rush.
      const bigot = s.card("core-002");
      s.attack("core-015", "core-002");

      s.expectInZone(bigot, "graveyard");
      s.expectStats("core-015", { health: 1 }); // and the granted First Strike kept it alive
    });

    it("takes the whole aura away when it is destroyed", () => {
      const s = scenario({
        p1: {
          backrow: ["core-014"],
          field: ["core-008"],
          hand: ["core-036", "core-005"],
          library: ["core-005"],
        },
        p2: { field: ["core-002"], hand: ["core-005"], library: ["core-005"] },
      });
      const weapons = s.card("core-014");
      s.expectStats("core-008", { attack: 7 });

      // #36 Magic Jammed, aimed at the ally Field Spell (see the header).
      s.play("core-036", { targets: [{ pick: "instance", instanceId: weapons.id }] });

      s.expectInZone(weapons, "graveyard");
      s.expectStats("core-008", { attack: 3, health: 3, maxHealth: 3 });
      // The keywords went with it: the ally is summoning-sick-free but has no First Strike, so
      // Bigot's 6 now kills it in the simultaneous step.
      const ally = s.card("core-008");
      s.attack("core-008", "core-002");
      s.expectInZone(ally, "graveyard");
    });
  });

  describe("radiant", () => {
    it("gives +10 attack and keeps both keywords (§8 Conventions: only the number changes)", () => {
      const s = scenario({
        p1: {
          backrow: [{ def: "core-014", radiant: true }],
          field: ["core-008"],
          hand: ["core-005"],
          library: ["core-005"],
        },
        p2: { field: ["core-002"], hand: ["core-005"], library: ["core-005"] },
      });

      s.expectStats("core-008", { attack: 13, health: 3, maxHealth: 3 });

      const bigot = s.card("core-002");
      s.attack("core-008", "core-002");

      s.expectInZone(bigot, "graveyard");
      s.expectStats("core-008", { health: 3 }); // First Strike still granted
    });

    it("covers a unit summoned after it at +10, Rush included", () => {
      const s = scenario({
        p1: {
          backrow: [{ def: "core-014", radiant: true }],
          hand: ["core-015", "core-005"],
          library: ["core-005"],
        },
        p2: { field: ["core-002"], hand: ["core-005"], library: ["core-005"] },
      });

      s.play("core-015");

      s.expectStats(lane(s, "p1", 1), { attack: 11, health: 1 });
      s.expectStats(lane(s, "p1", 2), { attack: 13, health: 3 });
      const bigot = s.card("core-002");
      s.attack("core-015", "core-002");
      s.expectInZone(bigot, "graveyard");
      expect(s.unit("p2", 1)).toBeNull();
    });
  });
});

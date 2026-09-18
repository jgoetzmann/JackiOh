// #25 4-mana 7/7 — SPEC §8.2, BUILD M4-T4 row 25: "Armor 7 zeroes a 7 hit; radiant Indestructible:
// no damage, sacrifice and exile still remove it".
//
// The §8.2 Engine cell is "Keywords only", so both scripts are empty and these fixtures prove the
// keywords printed on the catalog faces do the work through §4.4 and §4.5. The removals need a
// source: the sacrifice is #22 Carnivorous Cube, whose Cry sacrifices one of your other permanents
// (§6.3 Tribute), and the exile is #34 Collateral Damage, the Core card that exiles a target
// permanent — so those two fixtures depend on those cards' scripts as well as on these keywords.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";
import { base, def, radiant } from "../src/scripts/025-4-mana-7-7";

const BIG = "core-025";
const CUBE = "core-022"; // Cry: Tribute one of your other permanents.
const EXILER = "core-034"; // Collateral Damage: exile target permanent, cost 3.
const FILLER = "core-005";

function unitViewOf(s: Scenario, player: "p1" | "p2", lane: number) {
  const side = player === "p1" ? s.view("p1").you : s.view("p1").opponent;
  return side.units[lane - 1];
}

describe("#25 4-mana 7/7", () => {
  it("the keywords are printed on the catalog faces, so neither script grants anything", () => {
    // §10.4: Armor sums across sources, so a script that re-granted Armor 7 would show 14.
    expect(def.base.keywords).toEqual([{ kind: "Armor", n: 7 }]);
    expect(def.radiant.keywords).toEqual([{ kind: "Indestructible" }]);
    expect(base).toEqual({});
    expect(radiant).toEqual({});
  });

  describe("base", () => {
    it("§4.4 step 2: Armor 7 zeroes a 7 hit", () => {
      const s = scenario({
        seed: "big-armor",
        p1: { hand: [FILLER], field: [BIG], library: [FILLER] },
        p2: { hand: [FILLER], field: [BIG], library: [FILLER] },
      });
      const mine = s.unit("p1", 1);
      const theirs = s.unit("p2", 1);
      if (mine === null || theirs === null) throw new Error("both 7/7s should be on the board");

      s.endTurn(); // p2 attacks into p1.
      s.attack(theirs, mine);

      // §4.3 step 2 is simultaneous, and 7 − 7 is 0 on each side, which R63 makes a non-event.
      s.expectStats(mine, { attack: 7, maxHealth: 7, health: 7 });
      s.expectStats(theirs, { attack: 7, maxHealth: 7, health: 7 });
      expect(unitViewOf(s, "p1", 1)?.armor).toBe(7);
      // R63: a hit reduced to 0 emits nothing, so neither unit ever took a damage instance.
      const hits = s.events.filter(
        (event) => event.type === "damage" && [mine.id, theirs.id].includes(event.targetId),
      );
      expect(hits).toHaveLength(0);
    });
  });

  describe("radiant", () => {
    it("§4.4 step 4: Indestructible takes no damage at all", () => {
      const s = scenario({
        seed: "big-indestructible",
        p1: { hand: [FILLER], field: [{ def: BIG, radiant: true }] },
        p2: { hand: [FILLER], field: [BIG] },
      });
      const mine = s.unit("p1", 1);
      const theirs = s.unit("p2", 1);
      if (mine === null || theirs === null) throw new Error("both 7/7s should be on the board");

      s.endTurn();
      s.attack(theirs, mine);

      s.expectStats(mine, { health: 7, maxHealth: 7 });
      s.expectInZone(mine, "field");
      // It has no Armor of its own, so it is step 4 and not step 2 that stopped the hit.
      expect(unitViewOf(s, "p1", 1)?.armor).toBe(0);
      expect(unitViewOf(s, "p1", 1)?.keywords).toEqual([{ kind: "Indestructible" }]);
      // The radiant 7/7 struck back for 7, which the attacker's own Armor 7 absorbed.
      s.expectStats(theirs, { health: 7 });
    });

    it("§6.1, §6.3 a sacrifice still removes it", () => {
      const s = scenario({
        seed: "big-sacrifice",
        p1: { hand: [CUBE, FILLER], field: [{ def: BIG, radiant: true }] },
        p2: { hand: [FILLER] },
      });
      const big = s.card(BIG);
      s.play(CUBE, { targets: [{ pick: "instance", instanceId: big.id }] });

      // §6.3 Sacrifice "bypasses Indestructible" and counts as a death.
      s.expectInZone(big, "graveyard");
      s.expectEvents("destroyed", "enteredGraveyard");
    });

    it("§6.1, §6.3 an exile still removes it", () => {
      const s = scenario({
        seed: "big-exile",
        p1: { hand: [EXILER, FILLER], field: ["core-008"] },
        p2: { hand: [FILLER], field: [{ def: BIG, radiant: true }] },
      });
      const big = s.card(BIG);
      s.play(EXILER, { targets: [{ pick: "instance", instanceId: big.id }] });

      // §6.3 Exile: from anywhere to the exile pile, with no Death trigger (R55 counts it).
      s.expectInZone(big, "exile");
      expect(s.pile("p2", "graveyard").map((card) => card.defId)).not.toContain(BIG);
      expect(s.unit("p2", 1)).toBeNull();
    });
  });
});

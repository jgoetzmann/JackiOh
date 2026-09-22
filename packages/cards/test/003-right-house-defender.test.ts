// SPEC §8.1 #3 Right-house defender. BUILD M4-T4 row 3: "Shield eats first hit; dies → returns at
// 1 without Reborn; radiant Death summons a base Right-house defender on both deaths while Reborn
// keeps its zone (R8, R64)".
//
// Every death here is a combat death, so each one needs its own attacker: #8 Mr. Vanilla (3/3,
// Immutable, no hooks, 3 attack) survives the 1- or 2-point retaliation, so four of them on p2's
// board give four clean hits in one turn.
//
// Divine Shield absorbs a whole hit (§4.4 step 1), so each death costs two hits: one to burn the
// shield, one to kill. The reborn body's shield is back — §4.5 step 4 returns it "as a reset
// instance (R78)", and R78's reset is what clears `divineShieldSpent` — while Reborn itself does
// not come back (the state check marks it used). See the report: R78's enumerated list does not
// name Divine Shield, so this reading deserves its own ruling row.

import { keywordsOf } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

/** p2's attacker in `lane`, as an instance id: a string reference survives every later step. */
function foe(s: Scenario, lane: number): string {
  const unit = s.unit("p2", lane);
  if (unit === null) throw new Error(`the test needs a p2 unit in lane ${lane}`);
  return unit.id;
}

const FOUR_VANILLAS = ["core-008", "core-008", "core-008", "core-008"];

describe("#3 Right-house defender", () => {
  /**
   * Taunt on BOTH faces, added by the Core Set balance pass (issue #1, "it just makes sense").
   * A 1-mana Divine Shield + Reborn body that could be walked past was a defender that did not
   * defend; with Taunt the enemy has to spend the shield before anything behind it is reachable.
   */
  it("§6.1 Taunt is printed on both faces, so the enemy must come through it", () => {
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: "core-003", lane: 1 }, { def: "core-008", lane: 2 }] },
      p2: { field: ["core-008"] },
    });

    expect(keywordsOf(s.state, s.card("core-003"))).toContainEqual({ kind: "Taunt" });

    // The ally behind it cannot be reached while the Taunt stands (§4.2).
    const ally = s.unit("p1", 2);
    expect(ally).toBeDefined();
    expect(() => s.attack(foe(s, 1), ally ?? "core-008")).toThrow(/Taunt/);
  });

  it("§6.1 the radiant face keeps Taunt too", () => {
    const s = scenario({ p1: { field: [{ def: "core-003", radiant: true }] } });

    expect(s.unit("p1", 1)?.radiant).toBe(true);
    expect(keywordsOf(s.state, s.card("core-003"))).toContainEqual({ kind: "Taunt" });
  });

  it("the Divine Shield eats the first hit", () => {
    const s = scenario({
      active: "p2",
      p1: { field: ["core-003"] },
      p2: { field: ["core-008"] },
    });
    s.attack(foe(s, 1), "core-003");
    s.expectInZone("core-003", "field").expectStats("core-003", { health: 1, maxHealth: 1 });
  });

  it("R64/R83 dies → returns at 1 health in its own reserved zone", () => {
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: "core-003", lane: 3 }] },
      p2: { field: FOUR_VANILLAS },
    });
    const rhd = s.card("core-003").id;

    s.attack(foe(s, 1), rhd); // burns the shield
    s.attack(foe(s, 2), rhd); // kills it; Reborn brings it straight back

    s.expectInZone(rhd, "field").expectStats(rhd, { health: 1, maxHealth: 1 });
    expect(s.unit("p1", 3)?.id).toBe(rhd);
    expect(s.unit("p1", 1)).toBeNull();
  });

  it("R78 the reborn body has no Reborn, so its next death is final", () => {
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: "core-003", lane: 3 }] },
      p2: { field: FOUR_VANILLAS },
    });
    const rhd = s.card("core-003").id;

    s.attack(foe(s, 1), rhd);
    s.attack(foe(s, 2), rhd); // first death: Reborn returns it at 1 health
    s.attack(foe(s, 3), rhd); // the returned body's shield takes this one
    s.attack(foe(s, 4), rhd); // second death: nothing brings it back

    s.expectInZone(rhd, "graveyard");
    expect(s.unit("p1", 3)).toBeNull();
  });

  it("R8/R64 radiant: Death summons a base Right-house defender beside the reserved zone", () => {
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: "core-003", radiant: true, lane: 1 }] },
      p2: { field: FOUR_VANILLAS },
    });
    const rhd = s.card("core-003").id;

    s.attack(foe(s, 1), rhd); // burns the shield on the 2/2
    s.attack(foe(s, 2), rhd); // first death → Death fires

    // Lane 1 is reserved for the Reborn return (R64), so the summon takes lane 2, and what it
    // summons is a new BASE Right-house defender, not a copy of the radiant one.
    const reborn = s.unit("p1", 1);
    const summoned = s.unit("p1", 2);
    if (summoned === null) throw new Error("the radiant Death trigger summoned nothing in lane 2");
    expect(reborn?.id).toBe(rhd);
    expect(reborn?.radiant).toBe(true); // R78: the radiant flag survives leaving the field
    s.expectStats(rhd, { health: 1, maxHealth: 2 });
    expect(summoned.defId).toBe("core-003");
    expect(summoned.radiant).toBe(false);
    s.expectStats(summoned, { attack: 1, maxHealth: 1 });
  });

  it("R8 radiant: Death fires on the second death too, for two base bodies in all", () => {
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: "core-003", radiant: true, lane: 1 }] },
      p2: { field: FOUR_VANILLAS },
    });
    const rhd = s.card("core-003").id;

    s.attack(foe(s, 1), rhd);
    s.attack(foe(s, 2), rhd); // first death  → base body #1 in lane 2
    s.attack(foe(s, 3), rhd); // the returned body's shield
    s.attack(foe(s, 4), rhd); // second death → base body #2, lane 1 being free again

    s.expectInZone(rhd, "graveyard");
    const bodies = [1, 2, 3, 4, 5].flatMap((lane) => {
      const unit = s.unit("p1", lane);
      return unit === null ? [] : [unit];
    });
    expect(bodies.map((unit) => unit.defId)).toEqual(["core-003", "core-003"]);
    // Both are base bodies, so neither has a Death hook and the chain ends (§8 Engine cell).
    expect(bodies.map((unit) => unit.radiant)).toEqual([false, false]);
    expect(bodies.some((unit) => unit.id === rhd)).toBe(false);
  });
});

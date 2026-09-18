// #56 Jilliax (SPEC §8.3, BUILD M4-T4 row 56: "All four keywords; radiant Charge and
// Indestructible"). A keywords-only card, so every test asserts either the computed keyword set
// (§10.4's keyword layer, read through `viewFor`) or the rule each keyword names in §6.1.
//
// §8 Conventions: the radiant cell lists keywords with no "Plus", so it is the radiant form's
// COMPLETE list — Rush and Divine Shield are gone on the radiant face and Charge and Indestructible
// replace them. The first two tests of each face are that swap.

import { describe, expect, it } from "vitest";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

/** The keyword kinds §10.4 computes for the unit in `lane`, sorted so the set is order-free. */
function keywordKinds(g: Scenario, player: PlayerId, lane: number): string[] {
  const unit = g.view(player).you.units[lane - 1];
  if (unit === null || unit === undefined) throw new Error(`no unit in ${player} lane ${lane}`);
  return unit.keywords.map((keyword) => keyword.kind).sort();
}

describe("#56 Jilliax — base", () => {
  it("§6.1 prints Rush, Taunt, Lifesteal and Divine Shield, and nothing else", () => {
    const g = scenario({ p1: { field: [{ def: "core-056", lane: 1 }] } });

    expect(keywordKinds(g, "p1", 1)).toEqual(["Divine Shield", "Lifesteal", "Rush", "Taunt"]);
    g.expectStats("core-056", { attack: 3, maxHealth: 2, health: 2 });
  });

  it("§4.1 Rush lets it attack a unit on its summon turn but not the hero", () => {
    const g = scenario({
      p1: { hand: ["core-056", "core-005"] },
      p2: { field: [{ def: "core-008", lane: 1 }] },
    });

    g.play("core-056", { zone: 1 });

    // §4.2 step 2: "Rush cannot hit the hero on its summon turn" — the sickness lift is for units.
    expect(() => g.attack("core-056", "hero")).toThrow(/Rush cannot hit the hero/);
    g.expectHealth("p2", 30);

    // The same sick unit may attack a unit: 3 into Mr. Vanilla's 3/3.
    g.attack("core-056", "core-008").expectStats("core-008", { health: 0, maxHealth: 3 });
  });

  it("§4.2 step 3 Taunt forces the attacker onto it while any other enemy unit stands", () => {
    const g = scenario({
      p1: { field: [{ def: "core-025", lane: 1 }] },
      p2: {
        field: [
          { def: "core-008", lane: 1 },
          { def: "core-056", lane: 2 },
        ],
      },
    });

    expect(() => g.attack("core-025", "core-008")).toThrow(/Taunt unit must be attacked first/);
    expect(() => g.attack("core-025", "hero")).toThrow(/Taunt unit must be attacked first/);

    g.attack("core-025", "core-056").expectEvents("attackDeclared");
  });

  it("§4.4 step 1 Divine Shield eats the whole strike-back and is then gone", () => {
    const g = scenario({
      p1: { field: [{ def: "core-056", lane: 1 }] },
      p2: { field: [{ def: "core-019", lane: 1 }] },
    });

    // Midrange Menace is 9/9 with Taunt, so it is both a legal target and lethal on the strike-back.
    g.attack("core-056", "core-019");

    g.expectEvents("divineShieldLost").expectInZone("core-056", "field");
    g.expectStats("core-056", { health: 2, maxHealth: 2 });
    expect(keywordKinds(g, "p1", 1)).toEqual(["Lifesteal", "Rush", "Taunt"]);
  });

  it("§4.4 step 8 Lifesteal heals its controller's hero by the amount dealt (R63)", () => {
    const g = scenario({
      p1: { field: [{ def: "core-056", lane: 1 }], health: 20 },
      p2: { field: [{ def: "core-008", lane: 1 }] },
    });

    g.attack("core-056", "core-008");

    // 3 dealt to Mr. Vanilla, so 3 back to the hero — the amount DEALT, not the printed attack.
    g.expectHealth("p1", 23).expectEvents("damage", "healed");
  });

  it("§4.4 step 8 Lifesteal heals nothing when the hit dealt nothing", () => {
    const g = scenario({
      p1: { field: [{ def: "core-056", lane: 1 }], health: 20 },
      // The Rock is Indestructible, so pipeline step 4 stops the hit and 0 is dealt (R63's zero rule).
      p2: { field: [{ def: "core-066", lane: 1 }] },
    });

    g.attack("core-056", "core-066").expectHealth("p1", 20);
  });
});

describe("#56 Jilliax — radiant", () => {
  it("§8 Conventions: the radiant cell replaces the list, so Rush and Divine Shield are gone", () => {
    const g = scenario({ p1: { field: [{ def: "core-056", radiant: true, lane: 1 }] } });

    expect(keywordKinds(g, "p1", 1)).toEqual(["Charge", "Indestructible", "Lifesteal", "Taunt"]);
    g.expectStats("core-056", { attack: 6, maxHealth: 4, health: 4 });
  });

  it("§4.1 Charge lifts sickness for the hero too", () => {
    const g = scenario({ p1: { hand: ["core-056", "core-005"] } });

    // The setup builder takes `radiant` on the field and the backrow only, so a radiant card that
    // has to be PLAYED is flagged on the hand instance (reported as a harness gap).
    g.card("core-056").radiant = true;
    g.play("core-056", { zone: 1 }).attack("core-056", "hero");

    g.expectHealth("p2", 24);
  });

  it("§4.4 step 4 and R46: Indestructible takes no damage from a lethal strike-back and stays", () => {
    const g = scenario({
      p1: { field: [{ def: "core-056", radiant: true, lane: 1 }], health: 20 },
      p2: { field: [{ def: "core-019", lane: 1 }] },
    });

    g.attack("core-056", "core-019");

    // 9 into a 4-health unit, and none of it lands: no damage event for it, no death.
    g.expectInZone("core-056", "field").expectStats("core-056", { health: 4, maxHealth: 4 });
    // Its own 6 still landed, so Lifesteal still healed 6 (R85's "the amount actually dealt").
    g.expectHealth("p1", 26).expectStats("core-019", { health: 3, maxHealth: 9 });
  });

  it("§4.4 step 1 is gone with Divine Shield: the radiant face keeps no shield to spend", () => {
    const g = scenario({
      p1: { field: [{ def: "core-056", radiant: true, lane: 1 }] },
      p2: { field: [{ def: "core-019", lane: 1 }] },
    });

    g.attack("core-056", "core-019");

    expect(g.events.some((event) => event.type === "divineShieldLost")).toBe(false);
  });

  it("§4.2 step 3 Taunt is still on the radiant face", () => {
    const g = scenario({
      p1: { field: [{ def: "core-025", lane: 1 }] },
      p2: {
        field: [
          { def: "core-008", lane: 1 },
          { def: "core-056", radiant: true, lane: 2 },
        ],
      },
    });

    expect(() => g.attack("core-025", "core-008")).toThrow(/Taunt unit must be attacked first/);
  });
});

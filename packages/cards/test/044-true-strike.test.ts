// #44 True Strike (SPEC §8.2, §4.4, §5.1, §6.3 Exile; R63, R65, R81, R90).
//
// The must-pass row (BUILD M4-T4 #44): "4 damage through Armor 7; Divine Shield still blocks;
// exiled; radiant 9."
//
// "Ignoring Armor" skips §4.4 step 2 and only step 2, so the two halves of the row are one test
// each: #25 4-mana 7/7 (Armor 7) takes the full hit, and #56 Jilliax (Divine Shield) takes none
// because step 1 comes first and negates the whole instance.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { base as trueStrikeBase, radiant as trueStrikeRadiant } from "../src/scripts/044-true-strike";

/** The declared play-time pick (R81): a `Selection` naming the enemy unit in lane 1. */
function atUnit(s: ReturnType<typeof scenario>, lane: number) {
  const target = s.unit("p2", lane);
  if (target === null) throw new Error(`no p2 unit in lane ${lane}`);
  return { targets: [{ pick: "instance" as const, instanceId: target.id }] };
}

/** p1 holds True Strike; #21 Hinder rides along so the turn does not auto-end (R82). */
function spell(enemy: { def: string; radiant?: boolean }, radiantSpell = false): ReturnType<typeof scenario> {
  const s = scenario({
    seed: "true-strike",
    p1: { hand: ["core-044", "core-021"] },
    p2: { field: [{ ...enemy, lane: 1 }], health: 30 },
  });
  // The builder only takes `radiant` on the board, so a radiant spell is flagged in hand by hand.
  if (radiantSpell) s.card("core-044").radiant = true;
  return s;
}

describe("#44 True Strike — base", () => {
  it("deals 4 damage through Armor 7, skipping §4.4 step 2 and only step 2", () => {
    const s = spell({ def: "core-025" });
    s.play("core-044", atUnit(s, 1));

    // 7 health − 4 = 3. With Armor applied the hit would have been 0 and nothing would show.
    s.expectStats("core-025", { attack: 7, health: 3, maxHealth: 7 });
    s.expectEvents("cardPlayed", "damage");
  });

  it("R63 Divine Shield still blocks the whole hit and is spent (§4.4 step 1 runs before Armor)", () => {
    const s = spell({ def: "core-056" });
    s.play("core-044", atUnit(s, 1));

    s.expectStats("core-056", { attack: 3, health: 2, maxHealth: 2 });
    s.expectInZone("core-056", "field");
    expect(s.unit("p2", 1)?.divineShieldSpent).toBe(true);
    s.expectEvents("cardPlayed", "divineShieldLost");
    expect(s.events.some((event) => event.type === "damage")).toBe(false);
  });

  it("§5.1 and §6.3: 'exile this' sends the spell to exile, not to the graveyard", () => {
    const s = spell({ def: "core-025" });
    s.play("core-044", atUnit(s, 1));

    s.expectInZone("core-044", "exile");
    s.expectEvents("exiled");
    expect(s.pile("p1", "graveyard").some((card) => card.defId === "core-044")).toBe(false);
  });

  it("§8 Conventions: 'a target' includes a hero on either side", () => {
    const s = spell({ def: "core-025" });
    s.play("core-044", { targets: [{ pick: "hero", player: "p2" }] });

    s.expectHealth("p2", 26);
  });

  it("ignores a hero's Armor too (§4.4 step 2 reads the hero's own armor value)", () => {
    const s = scenario({
      seed: "true-strike",
      p1: { hand: ["core-044", "core-021"] },
      p2: { health: 30, armor: 5 },
    });
    s.play("core-044", { targets: [{ pick: "hero", player: "p2" }] });

    // With Armor applied, 4 − 5 would floor at 0 and the hero would still be at 30.
    s.expectHealth("p2", 26);
  });

  it("R81 declares exactly one target, any side, unit or hero, as a play-time choice", () => {
    expect(trueStrikeBase.targets).toEqual([
      { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } },
    ]);
    expect(trueStrikeBase.modes).toBeUndefined();
  });
});

describe("#44 True Strike — radiant", () => {
  it("deals 9 damage, ignoring Armor: only the number changed (§8 Conventions)", () => {
    // Radiant #43 Big Felinor is a 6/20 with no Armor, so the damage dealt is visible exactly.
    const s = spell({ def: "core-043", radiant: true }, true);
    s.play("core-044", atUnit(s, 1));

    s.expectStats("core-043", { attack: 6, health: 11, maxHealth: 20 });
  });

  it("9 through Armor 7 kills the 4-mana 7/7 outright", () => {
    const s = spell({ def: "core-025" }, true);
    s.play("core-044", atUnit(s, 1));

    s.expectInZone("core-025", "graveyard");
    s.expectEvents("cardPlayed", "damage", "destroyed");
  });

  it("R63 Divine Shield still blocks all 9", () => {
    const s = spell({ def: "core-056" }, true);
    s.play("core-044", atUnit(s, 1));

    s.expectStats("core-056", { attack: 3, health: 2, maxHealth: 2 });
    s.expectInZone("core-056", "field");
    expect(s.unit("p2", 1)?.divineShieldSpent).toBe(true);
  });

  it("still exiles itself: the unrestated clause is kept", () => {
    const s = spell({ def: "core-025" }, true);
    s.play("core-044", atUnit(s, 1));

    s.expectInZone("core-044", "exile");
    expect(s.pile("p1", "graveyard").some((card) => card.defId === "core-044")).toBe(false);
  });

  it("9 to a hero, ignoring its Armor", () => {
    const s = scenario({
      seed: "true-strike",
      p1: { hand: ["core-044", "core-021"] },
      p2: { health: 30, armor: 5 },
    });
    s.card("core-044").radiant = true;
    s.play("core-044", { targets: [{ pick: "hero", player: "p2" }] });

    s.expectHealth("p2", 21);
  });

  it("R81 the radiant face declares the same single target", () => {
    expect(trueStrikeRadiant.targets).toEqual(trueStrikeBase.targets);
  });
});

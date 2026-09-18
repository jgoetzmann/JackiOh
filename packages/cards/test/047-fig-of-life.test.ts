// #47 Fig of Life — SPEC §8.2, BUILD M4-T4: "Heals a unit up to max or the hero without cap (R19);
// radiant 50".
//
// R19 is the §8.2 Engine cell in full: "Fig of Life may target any unit or hero", so the
// declaration says `side: "any"` with `of: ["unit", "hero"]` and the tests below heal an ally unit,
// an enemy unit, an own hero and an enemy hero.
//
// §8's "an empty target set fizzles" cannot arise for this card: both heroes are always legal
// targets, so there is always something to pick. What is asserted instead is the §6.3 Heal split —
// a unit never rises past its max health because healing only removes damage, while a hero has no
// maximum (§3) and goes straight past 30.
//
// The props are cards with no script beyond printed keywords, so nothing but the heal moves a
// number: #25 4-mana 7/7 (7/7, Armor 7) and #20 Pointmaster (7/2, First Strike).

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { base, def, radiant } from "../src/scripts/047-fig-of-life";

const FIG = "core-047";
/** The radiant face in hand, so the radiant text is the one that resolves (§5.2). */
const RADIANT_FIG = { def: FIG, radiant: true } as const;
const SEVEN_SEVEN = "core-025";
const POINTMASTER = "core-020";
/** A unit that does nothing, kept on the board so a turn never runs out of legal actions (R82). */
const BYSTANDER = SEVEN_SEVEN;

describe("#47 Fig of Life", () => {
  it("R19 base: heals an ally unit, and never past its max health (§6.3)", () => {
    const g = scenario({
      p1: { hand: [FIG], field: [{ def: SEVEN_SEVEN, lane: 1, damage: 5 }] },
    });
    const ally = g.unit("p1", 1);
    if (ally === null) throw new Error("setup: p1 should hold the 7/7");
    g.expectStats(ally, { health: 2, maxHealth: 7 });

    g.play(FIG, { targets: [{ pick: "instance", instanceId: ally.id }] });

    // 20 healing onto 5 damage takes off 5: healing never raises max health.
    g.expectStats(ally, { health: 7, maxHealth: 7 });
    g.expectEvents("cardPlayed", "healed", "enteredGraveyard");
    g.expectInZone(FIG, "graveyard");
    g.expectMana("p1", 1);
  });

  it("R19 base: heals an ENEMY unit — the target set is either side", () => {
    const g = scenario({
      p1: { hand: [FIG] },
      p2: { field: [{ def: POINTMASTER, lane: 3, damage: 1 }] },
    });
    const theirs = g.unit("p2", 3);
    if (theirs === null) throw new Error("setup: p2 should hold Pointmaster");
    g.expectStats(theirs, { health: 1, maxHealth: 2 });

    g.play(FIG, { targets: [{ pick: "instance", instanceId: theirs.id }] });

    g.expectStats(theirs, { health: 2, maxHealth: 2 });
  });

  it("R19 base: heals your own hero with no cap — 30 becomes 50 (§3, §6.3)", () => {
    // Both sides keep a unit on the board: a turn with nothing meaningful left auto-ends (R82),
    // and a cascade of empty turns would add fatigue damage to the number under test.
    const g = scenario({ p1: { hand: [FIG], field: [BYSTANDER] }, p2: { field: [BYSTANDER] } });
    g.expectHealth("p1", 30);

    g.play(FIG, { targets: [{ pick: "hero", player: "p1" }] });

    g.expectHealth("p1", 50);
    g.expectEvents("healed");
  });

  it("R19 base: an enemy hero is a legal target too, and is healed the same way", () => {
    const g = scenario({
      p1: { hand: [FIG], field: [BYSTANDER] },
      p2: { health: 12, field: [BYSTANDER] },
    });

    g.play(FIG, { targets: [{ pick: "hero", player: "p2" }] });

    g.expectHealth("p2", 32);
    g.expectHealth("p1", 30);
  });

  it("radiant: 50 onto a unit is still capped by its max health (§8 Conventions: only the number)", () => {
    const g = scenario({
      p1: { hand: [RADIANT_FIG], field: [{ def: SEVEN_SEVEN, lane: 1, damage: 6 }] },
    });
    const ally = g.unit("p1", 1);
    if (ally === null) throw new Error("setup: p1 should hold the 7/7");
    g.expectStats(ally, { health: 1 });

    g.play(FIG, { targets: [{ pick: "instance", instanceId: ally.id }] });

    g.expectStats(ally, { health: 7, maxHealth: 7 });
  });

  it("radiant: 50 onto a hero has no cap — 30 becomes 80", () => {
    const g = scenario({ p1: { hand: [RADIANT_FIG], field: [BYSTANDER] }, p2: { field: [BYSTANDER] } });

    g.play(FIG, { targets: [{ pick: "hero", player: "p1" }] });

    g.expectHealth("p1", 80);
  });

  it("radiant: an undamaged unit is healed for nothing and the spell still resolves", () => {
    const g = scenario({ p1: { hand: [RADIANT_FIG], field: [{ def: SEVEN_SEVEN, lane: 2 }] } });
    const ally = g.unit("p1", 2);
    if (ally === null) throw new Error("setup: p1 should hold the 7/7");

    g.play(FIG, { targets: [{ pick: "instance", instanceId: ally.id }] });

    g.expectStats(ally, { health: 7, maxHealth: 7 });
    g.expectInZone(FIG, "graveyard");
  });

  it("R19, R81: both faces declare one play-time target — any unit or hero, either side", () => {
    expect(def.id).toBe(FIG);
    expect(def.type).toBe("Spell");
    expect(def.tags).toContain("Fruit");
    for (const face of [base, radiant]) {
      expect(face.targets).toEqual([
        { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit", "hero"] } },
      ]);
      // A declared target is not a prompt (R81), so nothing here opens one.
      expect(face.modes).toBeUndefined();
    }
  });
});

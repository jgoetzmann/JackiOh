// #55 Lava Golem (SPEC §8.3, §6.3 Tribute/Sacrifice, §3.2, §6.1, §4.2, §4.4; R11, R12, R46, R65,
// R69, R81, R90, R101).
// BUILD M4-T4 row 55: "Tribute 3 counts enemy units and Sheep as 2, enemies sacrificed; Taunt and
// Armor 3; radiant Indestructible; Sheepish's free copy still needs tributes".

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

/** A unit on the board, so a test can name it in `tributes` without a non-null assertion. */
function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const unit = s.unit(player, lane);
  if (unit === null) throw new Error(`no unit in ${player}'s lane ${lane}`);
  return unit;
}

function idsAt(s: Scenario, player: PlayerId, lanes: readonly number[]): string[] {
  return lanes.map((lane) => unitAt(s, player, lane).id);
}

/** Three of an inert 4/6 unit: keywords none, a Cry that never fires because it is placed, not played. */
const FODDER = [
  { def: "core-053", lane: 1 },
  { def: "core-053", lane: 2 },
  { def: "core-053", lane: 3 },
];

describe("#55 Lava Golem — Tribute 3 (§6.3, R81, R90)", () => {
  it("§6.3 is paid with three of your own units, which are sacrificed to your graveyard", () => {
    const s = scenario({ p1: { hand: ["core-055"], field: FODDER } });
    const paid = idsAt(s, "p1", [1, 2, 3]);

    s.play("core-055", { tributes: paid });

    s.expectInZone("core-055", "field");
    for (const id of paid) s.expectInZone(id, "graveyard");
    expect(s.pile("p1", "graveyard")).toHaveLength(3);
    // §6.3 Sacrifice "counts as a death", so each one emits `destroyed` before it lands.
    s.expectEvents("destroyed", "destroyed", "destroyed", "cardPlayed", "summoned");
    // §6.3: the Tribute is an ADDITIONAL cost, so the 3 mana is still paid too.
    s.expectMana("p1", 1);
  });

  it("R90 a play with too few units is refused outright (§6.3: Tribute is a cost)", () => {
    const s = scenario({ p1: { hand: ["core-055"], field: [{ def: "core-053", lane: 1 }] } });

    expect(() => s.play("core-055", { tributes: idsAt(s, "p1", [1]) })).toThrow(/Tribute 3/);
    expect(() => s.play("core-055")).toThrow(/Tribute 3/);
    s.expectInZone("core-055", "hand");
  });

  it("R90 the same unit cannot pay twice", () => {
    const s = scenario({ p1: { hand: ["core-055"], field: FODDER } });
    const one = unitAt(s, "p1", 1).id;

    expect(() => s.play("core-055", { tributes: [one, one, one] })).toThrow(/same unit twice/);
  });

  it("§6.3 tributes exactly 3: a fourth unit on top of a paying set is refused", () => {
    const s = scenario({
      p1: { hand: ["core-055"], field: [...FODDER, { def: "core-053", lane: 4 }] },
    });

    expect(() => s.play("core-055", { tributes: idsAt(s, "p1", [1, 2, 3, 4]) })).toThrow(/no more/);
  });
});

describe("#55 Lava Golem — the Sheep Token counts 2 (§3.2, §6.3)", () => {
  it("§3.2 one Sheep plus one other unit pays the 3", () => {
    const s = scenario({
      p1: { hand: ["core-055"], field: [{ def: "core-t-sheep", lane: 1 }, { def: "core-053", lane: 2 }] },
    });
    const sheep = unitAt(s, "p1", 1).id;
    const other = unitAt(s, "p1", 2).id;

    s.play("core-055", { tributes: [sheep, other] });

    s.expectInZone("core-055", "field");
    // R11: a unit token that leaves the field ceases to exist and never reaches a graveyard.
    s.expectInZone(sheep, "gone");
    s.expectInZone(other, "graveyard");
  });

  it("§3.2 the Sheep is worth 2, not 3: one Sheep alone does not pay this cost", () => {
    const s = scenario({ p1: { hand: ["core-055"], field: [{ def: "core-t-sheep", lane: 1 }] } });

    expect(() => s.play("core-055", { tributes: idsAt(s, "p1", [1]) })).toThrow(/Tribute 3/);
  });

  it("§6.3 two Sheep pay 4 for a cost of 3, and nothing smaller would do", () => {
    // `isMinimalTribute`: dropping either Sheep leaves 2, under the cost, so the pair is minimal
    // even though it overshoots — the one case §6.3's Sheep clause creates.
    const s = scenario({
      p1: { hand: ["core-055"], field: [{ def: "core-t-sheep", lane: 1 }, { def: "core-t-sheep", lane: 2 }] },
    });
    const sheep = idsAt(s, "p1", [1, 2]);

    s.play("core-055", { tributes: sheep });

    s.expectInZone("core-055", "field");
    for (const id of sheep) s.expectInZone(id, "gone");
  });

  it("§6.3 a tribute written into a SCRIPT ignores the 2 — which is why this card has no hook", () => {
    // "A tribute written into a card's script is an ordinary Sacrifice of the permanent that script
    // names, where the Sheep Token's 2 never applies" (§6.3, #22 Carnivorous Cube). Lava Golem's
    // Tribute is the play COST instead, so the 2 does apply here and nowhere in this file.
    const s = scenario({ p1: { hand: ["core-055"], field: [{ def: "core-t-sheep", lane: 1 }] } });

    expect(() => s.play("core-055", { tributes: idsAt(s, "p1", [1]) })).toThrow(/Tribute 3/);
  });
});

describe("#55 Lava Golem — may tribute enemy units (R101)", () => {
  it("R101 an enemy unit is legal fodder, and it is SACRIFICED, not destroyed", () => {
    // #66 The Rock is Indestructible, so a destroy would be ignored (§4.5 step 1, R46) — a
    // Sacrifice bypasses it (§6.3), which is what makes this the sharp test of the verb used.
    const s = scenario({
      p1: { hand: ["core-055"], field: [{ def: "core-053", lane: 1 }, { def: "core-053", lane: 2 }] },
      p2: { field: [{ def: "core-066", lane: 1 }] },
    });
    const mine = idsAt(s, "p1", [1, 2]);
    const theirs = unitAt(s, "p2", 1).id;

    s.play("core-055", { tributes: [...mine, theirs] });

    s.expectInZone("core-055", "field");
    // R12: off the field a card is always its OWNER's, so The Rock lands in p2's graveyard.
    s.expectInZone(theirs, "graveyard");
    expect(s.pile("p2", "graveyard").map((card) => card.id)).toContain(theirs);
    expect(s.pile("p1", "graveyard").map((card) => card.id)).toEqual(mine);
    s.expectEvents("destroyed", "cardPlayed");
  });

  it("R101 three enemy units alone can pay the whole cost", () => {
    const s = scenario({
      p1: { hand: ["core-055"] },
      p2: { field: FODDER },
    });

    s.play("core-055", { tributes: idsAt(s, "p2", [1, 2, 3]) });

    s.expectInZone("core-055", "field");
    expect(s.pile("p2", "graveyard")).toHaveLength(3);
  });

  it("R101 an enemy Sheep Token also counts 2 (§3.2 does not name a side)", () => {
    const s = scenario({
      p1: { hand: ["core-055"], field: [{ def: "core-053", lane: 1 }] },
      p2: { field: [{ def: "core-t-sheep", lane: 1 }] },
    });

    s.play("core-055", { tributes: [unitAt(s, "p1", 1).id, unitAt(s, "p2", 1).id] });

    s.expectInZone("core-055", "field");
  });
});

describe("#55 Lava Golem — printed keywords (§6.1, §10.4 layer 1)", () => {
  it("§4.4 step 2 Armor 3 takes 3 off every damage instance", () => {
    const s = scenario({
      p1: { field: [{ def: "core-055", lane: 1 }] },
      // 3 attack, then 4 attack: the first is absorbed whole, the second leaves exactly 1.
      p2: { field: [{ def: "core-t-rush", lane: 1 }, { def: "core-053", lane: 2 }], hand: ["core-010"] },
    });

    s.endTurn();
    s.attack("core-t-rush", "core-055");
    s.expectStats("core-055", { health: 5 });

    s.attack("core-053", "core-055");
    s.expectStats("core-055", { health: 4, attack: 10, maxHealth: 5 });
  });

  it("§4.2 step 3 Taunt: the enemy cannot go past it to the hero", () => {
    const s = scenario({
      p1: { field: [{ def: "core-055", lane: 2 }] },
      p2: { field: [{ def: "core-t-rush", lane: 1 }], hand: ["core-010"] },
    });

    s.endTurn();
    expect(() => s.attack("core-t-rush", "hero")).toThrow(/Taunt/);
    // The same attack aimed at the Taunt unit is legal.
    s.attack("core-t-rush", "core-055");
    s.expectHealth("p1", 30);
  });
});

describe("#55 Lava Golem — radiant", () => {
  it("§8 'Plus Indestructible': §4.4 step 4 means it takes no damage at all", () => {
    const s = scenario({
      p1: { field: [{ def: "core-055", radiant: true, lane: 1 }] },
      // 8 attack: a base Golem would take 8 − 3 = 5, so 0 damage is Indestructible, not Armor.
      p2: { field: [{ def: "core-054", lane: 1 }], hand: ["core-010"] },
    });

    s.endTurn();
    s.attack("core-054", "core-055");

    s.expectStats("core-055", { health: 10, attack: 20, maxHealth: 10 });
    // The 20-attack retaliation still kills the 8/8 attacker.
    s.expectInZone("core-054", "graveyard");
  });

  it("§8 Conventions keep every unrestated clause: Taunt, Armor 3 and Tribute 3 all survive", () => {
    const s = scenario({
      p1: { hand: ["core-055"], field: [{ def: "core-053", lane: 1 }] },
    });
    // HARNESS GAP (reported): `SideSetup.hand` takes no `{ def, radiant }` form.
    s.card("core-055").radiant = true;

    expect(() => s.play("core-055", { tributes: idsAt(s, "p1", [1]) })).toThrow(/Tribute 3/);
  });

  it("§6.1 Sacrifice still removes an Indestructible unit, so a radiant Golem is legal fodder", () => {
    const s = scenario({
      p1: {
        hand: ["core-055"],
        field: [{ def: "core-055", radiant: true, lane: 1 }, { def: "core-053", lane: 2 }, { def: "core-053", lane: 3 }],
      },
    });

    s.play("core-055", { tributes: idsAt(s, "p1", [1, 2, 3]) });

    expect(s.pile("p1", "graveyard")).toHaveLength(3);
  });
});

describe("#55 Lava Golem — Sheepish's free copy (§8 Engine cell, R65)", () => {
  it("R65 a `costOverride` of 0 pays no mana but still owes the Tribute", () => {
    const s = scenario({ p1: { hand: ["core-055"], field: [{ def: "core-053", lane: 1 }], mana: 0 } });
    // #41 Sheepish's radiant text is `addToHand({ defId: "core-055", costOverride: 0 })`; this is
    // the card that verb creates, and a Tribute is an additional cost that no price touches (§6.3).
    s.card("core-055").costOverride = 0;

    expect(() => s.play("core-055", { tributes: idsAt(s, "p1", [1]) })).toThrow(/Tribute 3/);
  });

  it("R65 with three units the free copy plays for 0 mana and still sacrifices all three", () => {
    const s = scenario({ p1: { hand: ["core-055"], field: FODDER, mana: 0 } });
    s.card("core-055").costOverride = 0;
    const paid = idsAt(s, "p1", [1, 2, 3]);

    s.play("core-055", { tributes: paid });

    s.expectInZone("core-055", "field").expectMana("p1", 0);
    for (const id of paid) s.expectInZone(id, "graveyard");
  });
});

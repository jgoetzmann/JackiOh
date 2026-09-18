// #49 Snom Bunny Mind Control — SPEC §8.2, BUILD M4-T4: "Steal placement per R15; radiant sets the
// flag on the stolen card".
//
// R15 has three clauses and each gets its own case: the same lane when that zone is free, the first
// free zone of the row when it is not, and "excess remain with the opponent" when the row is full.
// R12 is asserted alongside every steal: `controller` moves and `owner` never does.
//
// The radiant clause is R22/R74: the flag swaps the base stat layer at once while damage and buffs
// stay and no Cry re-fires, and a card that is already Radiant is untouched (§6.3 Make Radiant).
// The order inside the script (steal, then setRadiant) is proved safe here: `setRadiant` resolves
// the same selection by instance id, so the card having already changed zone cannot make it miss.
//
// Props with no script beyond printed keywords: #25 4-mana 7/7, #20 Pointmaster, #45 Deft Duelist
// (4/3 → 8/6, the damage-and-radiant case), #11 Tempo Timmy, #8 Mr. Vanilla. #15 Me and Mr Token
// carries a Cry that would summon a Rush Token, which is how "no Cry re-fires" is checked, and
// #41 Sheepish is the face-down Trap: a Trap that fires on a UNIT play, so playing this Spell can
// never set it off.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { base, def, radiant } from "../src/scripts/049-snom-bunny-mind-control";

const MIND_CONTROL = "core-049";
/** The radiant face in hand, so the radiant text is the one that resolves (§5.2). */
const RADIANT_MIND_CONTROL = { def: MIND_CONTROL, radiant: true } as const;
const SEVEN_SEVEN = "core-025";
const POINTMASTER = "core-020";
const DUELIST = "core-045";
const TIMMY = "core-011";
const VANILLA = "core-008";
const TOKEN_MAKER = "core-015";
const SHEEPISH = "core-041";

describe("#49 Snom Bunny Mind Control", () => {
  it("R15 base: the stolen unit lands in the same lane when that zone is free", () => {
    const g = scenario({
      p1: { hand: [MIND_CONTROL] },
      p2: { field: [{ def: SEVEN_SEVEN, lane: 3 }] },
    });
    const prey = g.unit("p2", 3);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 3");

    g.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: prey.id }] });

    expect(g.unit("p1", 3)?.id).toBe(prey.id);
    expect(g.unit("p2", 3)).toBeNull();
    // R12: control is a field-only notion; ownership never moves.
    expect(g.card(prey).controller).toBe("p1");
    expect(g.card(prey).owner).toBe("p2");
    g.expectEvents("cardPlayed", "controlChanged", "enteredGraveyard");
    g.expectMana("p1", 1);
  });

  it("R15 base: the first free zone of the row when the same lane is taken", () => {
    const g = scenario({
      p1: { hand: [MIND_CONTROL], field: [{ def: VANILLA, lane: 3 }] },
      p2: { field: [{ def: SEVEN_SEVEN, lane: 3 }] },
    });
    const prey = g.unit("p2", 3);
    if (prey === null) throw new Error("setup: p2 should hold the 7/7 in lane 3");

    g.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: prey.id }] });

    // Lane 3 is occupied, so `firstFreeZone` scans lanes 1..5 and lane 1 wins.
    expect(g.unit("p1", 1)?.id).toBe(prey.id);
    expect(g.unit("p1", 3)?.defId).toBe(VANILLA);
    expect(g.unit("p2", 3)).toBeNull();
  });

  it("R15 base: a full row leaves the card with the opponent, and the spell still resolves", () => {
    const g = scenario({
      p1: {
        hand: [MIND_CONTROL],
        field: [
          { def: SEVEN_SEVEN, lane: 1 },
          { def: POINTMASTER, lane: 2 },
          { def: DUELIST, lane: 3 },
          { def: TIMMY, lane: 4 },
          { def: VANILLA, lane: 5 },
        ],
      },
      p2: { field: [{ def: TOKEN_MAKER, lane: 3 }] },
    });
    const prey = g.unit("p2", 3);
    if (prey === null) throw new Error("setup: p2 should hold the target");

    g.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: prey.id }] });

    expect(g.unit("p2", 3)?.id).toBe(prey.id);
    expect(g.card(prey).controller).toBe("p2");
    g.expectInZone(MIND_CONTROL, "graveyard");
    expect(g.events.some((event) => event.type === "controlChanged")).toBe(false);
  });

  it("R15, R33 base: a face-down enemy trap is a permanent, and it stays face-down", () => {
    const g = scenario({
      p1: { hand: [MIND_CONTROL] },
      p2: { backrow: [{ def: SHEEPISH, lane: 2 }] },
    });
    const trap = g.backrow("p2", 2);
    if (trap === null) throw new Error("setup: p2 should hold Sheepish in backrow lane 2");
    expect(trap.faceUp).not.toBe(true);

    g.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: trap.id }] });

    // §6.3's "permanent" is Unit, Field Spell, Trap or Field Trap, and R15 places it in its row.
    expect(g.backrow("p1", 2)?.id).toBe(trap.id);
    expect(g.backrow("p2", 2)).toBeNull();
    expect(g.card(trap).controller).toBe("p1");
    expect(g.card(trap).owner).toBe("p2");
    // R33: `faceUp` is untouched — who may READ it follows the controller, in `viewFor`.
    expect(g.card(trap).faceUp).not.toBe(true);
  });

  it("R22, R74 radiant: the stolen card becomes Radiant, keeping its damage", () => {
    const g = scenario({
      p1: { hand: [RADIANT_MIND_CONTROL] },
      p2: { field: [{ def: DUELIST, lane: 2, damage: 2 }] },
    });
    const prey = g.unit("p2", 2);
    if (prey === null) throw new Error("setup: p2 should hold Deft Duelist");
    g.expectStats(prey, { attack: 4, maxHealth: 3, health: 1 });

    g.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: prey.id }] });

    expect(g.unit("p1", 2)?.id).toBe(prey.id);
    expect(g.card(prey).radiant).toBe(true);
    // R22: the base layer swaps at once (4/3 → 8/6) and the 2 damage stays.
    g.expectStats(prey, { attack: 8, maxHealth: 6, health: 4 });
    expect(g.card(prey).damage).toBe(2);
    // The steal moved the card first; `setRadiant` still found it, because it resolves by id.
    g.expectEvents("controlChanged", "radiantSet");
  });

  it("R22 radiant: the flag fires no Cry — nothing is summoned alongside the steal", () => {
    const g = scenario({
      p1: { hand: [RADIANT_MIND_CONTROL] },
      p2: { field: [{ def: TOKEN_MAKER, lane: 1 }] },
    });
    const prey = g.unit("p2", 1);
    if (prey === null) throw new Error("setup: p2 should hold Me and Mr Token");

    g.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: prey.id }] });

    expect(g.card(prey).radiant).toBe(true);
    // Me and Mr Token's Cry summons a Rush Token; setting a flag is not an entry to the field.
    const mine = [1, 2, 3, 4, 5].flatMap((lane) => {
      const unit = g.unit("p1", lane);
      return unit === null ? [] : [unit.defId];
    });
    expect(mine).toEqual([prey.defId]);
  });

  it("§6.3 radiant: a card that is already Radiant is stolen and left alone", () => {
    const g = scenario({
      p1: { hand: [RADIANT_MIND_CONTROL] },
      p2: { field: [{ def: DUELIST, lane: 4, radiant: true }] },
    });
    const prey = g.unit("p2", 4);
    if (prey === null) throw new Error("setup: p2 should hold a radiant Deft Duelist");

    g.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: prey.id }] });

    expect(g.unit("p1", 4)?.id).toBe(prey.id);
    expect(g.card(prey).radiant).toBe(true);
    // §6.3 Make Radiant: no effect on a Radiant card, so the flag change emits nothing.
    expect(g.events.filter((event) => event.type === "radiantSet")).toHaveLength(0);
  });

  it("R81: both faces declare one enemy permanent, and the radiant face adds the flag", () => {
    expect(def.id).toBe(MIND_CONTROL);
    expect(def.type).toBe("Spell");
    expect(def.cost).toBe(3);
    for (const face of [base, radiant]) {
      expect(face.targets).toEqual([
        { kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit", "backrow"] } },
      ]);
      expect(face.modes).toBeUndefined();
    }
  });
});

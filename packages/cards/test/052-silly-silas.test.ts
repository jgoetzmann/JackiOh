// #52 Silly Silas (SPEC §8.3, §3.1's rotation-topology ruling, §3.2, §6.3 Rotate; R4, R11, R12,
// R14, R33, R78, R81, R88).
// BUILD M4-T4 row 52: "Rotate both rings either direction, control changes on crossing, damage
// travels, Silas moves too; Locked destination bounces; radiant bounces crossing cards to their
// owner's hand at cost 0 (R14)".
//
// The ring, from p1's seat (§3.1): p1 lanes 1→5, then p2 lanes 5→1, and back to p1 lane 1. So
// "right" is one step forward along that order — p1 lane 5 becomes p2 lane 5 and p2 lane 1 becomes
// p1 lane 1 — and "left" is one step back.
//
// The zone is locked with the engine's own `lockZone`, the very function the §6.3 Lock effect calls
// (`effects/counters.ts`), because `SideSetup` has no `locks` option — reported as a harness gap.

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import { lockZone } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const unit = s.unit(player, lane);
  if (unit === null) throw new Error(`no unit in ${player}'s lane ${lane}`);
  return unit;
}

function backrowAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const card = s.backrow(player, lane);
  if (card === null) throw new Error(`no backrow card in ${player}'s lane ${lane}`);
  return card;
}

/** Where a card sits now, as the one thing a rotation test is about. */
function slotOf(card: CardInstance): string {
  return card.zone.z === "field"
    ? `${card.zone.player} ${card.zone.row} ${card.zone.lane}`
    : card.zone.z;
}

describe("#52 Silly Silas — base, rotating right", () => {
  it("R14 turns both rings one step, and Silas rotates with them", () => {
    const s = scenario({
      p1: {
        hand: ["core-052"],
        field: [{ def: "core-053", lane: 5, damage: 2, position: "DEF" }],
        backrow: [{ def: "core-058", lane: 1 }],
      },
      p2: {
        field: [{ def: "core-t-felinor", lane: 1 }],
        backrow: [{ def: "core-071", lane: 1 }],
      },
    });
    const reno = unitAt(s, "p1", 5).id;
    const felinor = unitAt(s, "p2", 1).id;
    const farm = backrowAt(s, "p1", 1).id;
    const stimmy = backrowAt(s, "p2", 1).id;

    s.play("core-052", { zone: 1, modes: ["right"] });

    // The Engine cell's "Silas rotates too": he is on the field for his own Cry (§10.5 step 4).
    expect(unitAt(s, "p1", 2).defId).toBe("core-052");
    // The unit ring: p1 lane 5 → p2 lane 5, p2 lane 1 → p1 lane 1.
    expect(slotOf(s.card(reno))).toBe("p2 units 5");
    expect(slotOf(s.card(felinor))).toBe("p1 units 1");
    // The backrow ring turns with it: p1 lane 1 → p1 lane 2, p2 lane 1 → p1 lane 1.
    expect(slotOf(s.card(farm))).toBe("p1 backrow 2");
    expect(slotOf(s.card(stimmy))).toBe("p1 backrow 1");
    s.expectEvents("cardPlayed", "rotated", "controlChanged");
  });

  it("R12 a card that crosses the centre line changes controller and never owner", () => {
    const s = scenario({
      p1: { hand: ["core-052"], field: [{ def: "core-053", lane: 5 }] },
      p2: { field: [{ def: "core-t-felinor", lane: 1 }] },
    });
    const reno = unitAt(s, "p1", 5).id;
    const felinor = unitAt(s, "p2", 1).id;

    s.play("core-052", { zone: 1, modes: ["right"] });

    expect(s.card(reno).controller).toBe("p2");
    expect(s.card(reno).owner).toBe("p1");
    expect(s.card(felinor).controller).toBe("p1");
    expect(s.card(felinor).owner).toBe("p2");
    // Silas did not cross, so nothing about him changed but the lane.
    expect(s.card("core-052").controller).toBe("p1");
  });

  it("R14/R78 damage and every other part of the instance travel with the card", () => {
    const s = scenario({
      p1: { hand: ["core-052"], field: [{ def: "core-053", lane: 5, damage: 2, position: "DEF" }] },
    });
    const reno = unitAt(s, "p1", 5).id;

    s.play("core-052", { zone: 1, modes: ["right"] });

    // A rotation never takes a card off the field, so R78's reset never runs: 4/6 with 2 damage.
    s.expectStats(reno, { attack: 4, health: 4, maxHealth: 6 });
    expect(s.card(reno).damage).toBe(2);
    expect(s.card(reno).position).toBe("DEF");
    expect(slotOf(s.card(reno))).toBe("p2 units 5");
  });

  it("R33 a face-down trap that crosses is read by its new controller alone", () => {
    const s = scenario({
      p1: { hand: ["core-052"] },
      p2: { backrow: [{ def: "core-071", lane: 1, faceUp: false }] },
    });
    const stimmy = backrowAt(s, "p2", 1).id;

    s.play("core-052", { zone: 1, modes: ["right"] });

    // Identity follows `controller` and nothing else, so the flip is not a flip: `faceUp` is
    // untouched and p1 now sees the card because p1 controls it.
    expect(s.card(stimmy).controller).toBe("p1");
    expect(s.card(stimmy).owner).toBe("p2");
    expect(s.card(stimmy).faceUp).not.toBe(true);
    expect(slotOf(s.card(stimmy))).toBe("p1 backrow 1");
  });
});

describe("#52 Silly Silas — base, rotating left", () => {
  it("R81 the declared direction turns the ring the other way", () => {
    const s = scenario({
      p1: { hand: ["core-052"], field: [{ def: "core-053", lane: 1 }] },
      p2: { field: [{ def: "core-t-felinor", lane: 5 }] },
    });
    const reno = unitAt(s, "p1", 1).id;
    const felinor = unitAt(s, "p2", 5).id;

    s.play("core-052", { zone: 3, modes: ["left"] });

    // One step back along the ring: p1 lane 3 → p1 lane 2, p1 lane 1 → p2 lane 1 (crossing),
    // p2 lane 5 → p1 lane 5 (crossing the other way).
    expect(unitAt(s, "p1", 2).defId).toBe("core-052");
    expect(slotOf(s.card(reno))).toBe("p2 units 1");
    expect(s.card(reno).controller).toBe("p2");
    expect(slotOf(s.card(felinor))).toBe("p1 units 5");
    expect(s.card(felinor).controller).toBe("p1");
  });

  it("R11 a unit token that crosses stays on the field: it changed control, it did not leave", () => {
    const s = scenario({
      p1: { hand: ["core-052"] },
      p2: { field: [{ def: "core-t-felinor", lane: 5 }] },
    });
    const felinor = unitAt(s, "p2", 5).id;

    s.play("core-052", { zone: 3, modes: ["left"] });

    s.expectInZone(felinor, "field");
    expect(s.card(felinor).controller).toBe("p1");
  });
});

describe("#52 Silly Silas — a Locked destination (R14, R88)", () => {
  it("R14 bounces the card to its owner's hand instead, reset per R78", () => {
    const s = scenario({
      p1: { hand: ["core-052"], field: [{ def: "core-053", lane: 5, damage: 2, position: "DEF" }] },
    });
    const reno = unitAt(s, "p1", 5).id;
    // §3.2 Lock, the destination of p1 lane 5 under a rightward rotation.
    lockZone(s.state, { player: "p2", row: "units", lane: 5 });

    s.play("core-052", { zone: 1, modes: ["right"] });

    s.expectInZone(reno, "hand");
    expect(s.card(reno).owner).toBe("p1");
    // R78: leaving the field resets damage, position and controller; the base bounce is not free.
    expect(s.card(reno).damage).toBe(0);
    expect(s.card(reno).costOverride).toBeUndefined();
    s.expectEvents("rotated", "bounced");
    // Silas still rotated: the bounce is one zone's outcome, not a cancelled rotation.
    expect(unitAt(s, "p1", 2).defId).toBe("core-052");
  });

  it("R11/R88 a unit token bounced off a Locked destination ceases to exist", () => {
    const s = scenario({
      p1: { hand: ["core-052"], field: [{ def: "core-t-felinor", lane: 5 }] },
    });
    const felinor = unitAt(s, "p1", 5).id;
    lockZone(s.state, { player: "p2", row: "units", lane: 5 });

    s.play("core-052", { zone: 1, modes: ["right"] });

    s.expectInZone(felinor, "gone");
  });
});

describe("#52 Silly Silas — radiant", () => {
  it("R14 every card that would cross is bounced to its owner's hand costing 0 instead", () => {
    const s = scenario({
      p1: { hand: ["core-052"], field: [{ def: "core-053", lane: 5, damage: 2 }] },
      p2: { field: [{ def: "core-019", lane: 1 }] },
    });
    // HARNESS GAP (reported): `SideSetup.hand` takes no `{ def, radiant }` form, and a radiant Cry
    // only fires if the card is PLAYED, so the flag goes on the hand instance (§5.2).
    s.card("core-052").radiant = true;
    const reno = unitAt(s, "p1", 5).id;
    const menace = unitAt(s, "p2", 1).id;

    s.play("core-052", { zone: 1, modes: ["right"] });

    // Both would have crossed; instead both go home, at cost 0 (R12: the OWNER's hand, R65).
    s.expectInZone(reno, "hand");
    expect(s.card(reno).owner).toBe("p1");
    expect(s.card(reno).costOverride).toBe(0);
    s.expectInZone(menace, "hand");
    expect(s.card(menace).owner).toBe("p2");
    expect(s.card(menace).costOverride).toBe(0);
    // So nothing changed control at all on this face.
    expect(s.lastEvents.filter((event) => event.type === "controlChanged")).toHaveLength(0);
    s.expectEvents("rotated", "bounced", "bounced");
  });

  it("§8 Conventions keep the rest: the rotation still happens and Silas still moves", () => {
    const s = scenario({
      p1: { hand: ["core-052"], field: [{ def: "core-053", lane: 3 }] },
    });
    s.card("core-052").radiant = true;

    s.play("core-052", { zone: 1, modes: ["right"] });

    // Neither card crosses, so the radiant clause never applies and both simply step one lane.
    expect(unitAt(s, "p1", 2).defId).toBe("core-052");
    expect(unitAt(s, "p1", 4).defId).toBe("core-053");
    s.expectStats("core-052", { attack: 8, maxHealth: 8 });
  });

  it("R11 a crossing unit token is bounced, so it ceases to exist (§3.2)", () => {
    const s = scenario({
      p1: { hand: ["core-052"], field: [{ def: "core-t-felinor", lane: 5 }] },
    });
    s.card("core-052").radiant = true;
    const felinor = unitAt(s, "p1", 5).id;

    s.play("core-052", { zone: 1, modes: ["right"] });

    s.expectInZone(felinor, "gone");
  });

  it("R14 the direction is still declared: leftward crossings bounce the same way", () => {
    const s = scenario({
      p1: { hand: ["core-052"], field: [{ def: "core-053", lane: 1 }] },
    });
    s.card("core-052").radiant = true;
    const reno = unitAt(s, "p1", 1).id;

    s.play("core-052", { zone: 3, modes: ["left"] });

    s.expectInZone(reno, "hand");
    expect(s.card(reno).costOverride).toBe(0);
  });
});

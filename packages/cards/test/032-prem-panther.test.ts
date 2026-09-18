// #32 Prem Panther — SPEC §8.2 row 32, BUILD M4-T4 must-pass row 32:
// "Rush; draw 2 on a combat kill, none when it dies without killing; radiant Cleave kills draw per
//  kill (R42)".
//
// R42: "destroys a unit" is a death whose lethal damage instance came from this unit, Cleave hits
// included, and it is per unit — three Cleave kills draw 6.
//
// The sparring partners: #15 Me and Mr Token is a 1/1 with no keywords (its Cry does not fire from a
// `field` setup), and #13 Jlockeed Shredder-10 is an 8/10 with no keywords, so it kills a 5/4
// Panther on the swing back and survives.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import type { CardInstance } from "@jackioh/engine";

function must(card: CardInstance | null, what: string): CardInstance {
  if (card === null) throw new Error(`the scenario has no ${what}`);
  return card;
}

describe("#32 Prem Panther — base", () => {
  it("§6.1 Rush: a Panther played this turn may attack a unit but not the hero", () => {
    const s = scenario({
      seed: "panther-rush",
      p1: { hand: ["32"], field: ["15"], library: ["15", "15", "15"] },
      p2: { field: ["15", "15"] },
    });
    s.play("32");

    expect(() => s.attack("32", "hero")).toThrow(/Rush cannot hit the hero/);
    s.attack("32", must(s.unit("p2", 1), "p2 lane 1"));
    s.expectInZone(must(s.unit("p1", 2), "the Panther"), "field");
  });

  it("R42 draws 2 when its own combat damage kills a unit", () => {
    const s = scenario({
      seed: "panther-kill",
      p1: { field: ["32", "15"], library: ["15", "15", "15"] },
      p2: { field: ["15"] },
    });
    const prey = must(s.unit("p2", 1), "p2 lane 1");
    expect(s.hand("p1")).toHaveLength(0);

    s.attack("32", prey);

    s.expectInZone(prey, "graveyard");
    expect(s.hand("p1")).toHaveLength(2);
    expect(s.pile("p1", "library")).toHaveLength(1);
    s.expectEvents("damage", "destroyed", "drawn", "drawn");
  });

  it("R42 draws nothing when it dies without killing", () => {
    const s = scenario({
      seed: "panther-trade",
      p1: { field: ["32"], library: ["15", "15", "15"] },
      p2: { field: ["13"] },
    });
    const wall = must(s.unit("p2", 1), "p2 lane 1");
    const panther = must(s.unit("p1", 1), "p1 lane 1");

    s.attack(panther, wall);

    // 5 into an 8/10 is not lethal; 8 back into a 5/4 is.
    s.expectInZone(panther, "graveyard");
    s.expectInZone(wall, "field");
    expect(s.hand("p1")).toHaveLength(0);
    expect(s.pile("p1", "library")).toHaveLength(3);
  });

  it("R42 is per unit, and a base Panther has no Cleave, so only the defender dies", () => {
    const s = scenario({
      seed: "panther-no-cleave",
      p1: { field: ["32"], library: ["15", "15", "15", "15", "15", "15", "15"] },
      p2: { field: ["15", "15", "15"] },
    });
    const middle = must(s.unit("p2", 2), "p2 lane 2");

    s.attack("32", middle);

    s.expectInZone(middle, "graveyard");
    s.expectInZone(must(s.unit("p2", 1), "p2 lane 1"), "field");
    s.expectInZone(must(s.unit("p2", 3), "p2 lane 3"), "field");
    expect(s.hand("p1")).toHaveLength(2);
  });

  it("R42 a kill by something else does not draw", () => {
    const s = scenario({
      seed: "panther-someone-else",
      p1: { field: ["32", "13"], library: ["15", "15", "15"] },
      p2: { field: ["15"] },
    });
    const prey = must(s.unit("p2", 1), "p2 lane 1");

    // The Shredder swings, not the Panther.
    s.attack(must(s.unit("p1", 2), "p1 lane 2"), prey);

    s.expectInZone(prey, "graveyard");
    expect(s.hand("p1")).toHaveLength(0);
  });
});

describe("#32 Prem Panther — radiant", () => {
  it("R42 radiant Cleave draws 2 per unit it kills: three kills draw 6", () => {
    const s = scenario({
      seed: "panther-cleave",
      p1: {
        field: [{ def: "32", radiant: true }],
        library: ["15", "15", "15", "15", "15", "15", "15", "15"],
      },
      p2: { field: ["15", "15", "15"] },
    });
    const left = must(s.unit("p2", 1), "p2 lane 1");
    const middle = must(s.unit("p2", 2), "p2 lane 2");
    const right = must(s.unit("p2", 3), "p2 lane 3");

    s.attack("32", middle);

    // §4.4 step 10: Cleave hits the same-side neighbours as separate instances of 10.
    s.expectInZone(left, "graveyard");
    s.expectInZone(middle, "graveyard");
    s.expectInZone(right, "graveyard");
    expect(s.hand("p1")).toHaveLength(6);
    expect(s.pile("p1", "library")).toHaveLength(2);
  });

  it("§3.1 Cleave never crosses sides, so the Panther's own neighbours are not kills", () => {
    const s = scenario({
      seed: "panther-cleave-sides",
      p1: {
        field: [{ def: "32", radiant: true, lane: 2 }, { def: "15", lane: 1 }, { def: "15", lane: 3 }],
        library: ["15", "15", "15", "15", "15"],
      },
      p2: { field: [{ def: "15", lane: 2 }] },
    });
    const ally1 = must(s.unit("p1", 1), "p1 lane 1");
    const ally3 = must(s.unit("p1", 3), "p1 lane 3");

    s.attack(must(s.unit("p1", 2), "the Panther"), must(s.unit("p2", 2), "p2 lane 2"));

    s.expectInZone(ally1, "field");
    s.expectInZone(ally3, "field");
    expect(s.hand("p1")).toHaveLength(2);
  });

  it("radiant is 10/8 and its text is unchanged (\"same\"), so one kill still draws 2", () => {
    const s = scenario({
      seed: "panther-radiant-same",
      p1: { field: [{ def: "32", radiant: true }], library: ["15", "15", "15"] },
      p2: { field: ["43"] },
    });
    const panther = must(s.unit("p1", 1), "p1 lane 1");
    s.expectStats(panther, { attack: 10, maxHealth: 8 });

    // 10 into #43's 3/10 is lethal; 3 back into a 10/8 is not.
    s.attack(panther, must(s.unit("p2", 1), "p2 lane 1"));

    s.expectInZone(panther, "field");
    expect(s.hand("p1")).toHaveLength(2);
  });
});

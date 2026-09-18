// SPEC §8.1 #5 Stockpile. BUILD M4-T4 row 5: "Draw 2, heal 2 (hero may exceed 30); hand cap burns;
// radiant 5/5".
//
// §3 gives a hero no maximum health, so the heal runs past 30; R4 caps a hand at 10 and burns what
// a draw cannot fit to the graveyard. `library[0]` is the top of the library (the next card drawn).

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

/** Nine simple cards, enough to fill a hand to the cap next to the Stockpile being played. */
const NINE_FILLERS = [
  "core-001",
  "core-002",
  "core-003",
  "core-004",
  "core-008",
  "core-011",
  "core-012",
  "core-015",
  "core-020",
];

describe("#5 Stockpile", () => {
  it("draws 2 and heals the hero 2", () => {
    const s = scenario({
      p1: { hand: ["core-005"], health: 20, library: ["core-025", "core-007", "core-012"] },
    });
    s.play("core-005");

    s.expectHealth("p1", 22);
    s.expectInZone("core-025", "hand");
    s.expectInZone("core-007", "hand");
    s.expectInZone("core-012", "library");
    s.expectInZone("core-005", "graveyard");
    expect(s.hand("p1")).toHaveLength(2);
  });

  it("the hero may go above 30: it has no maximum health (§3)", () => {
    const s = scenario({ p1: { hand: ["core-005"], health: 30, library: ["core-025", "core-007"] } });
    s.play("core-005");
    s.expectHealth("p1", 32);
  });

  it("R4 the hand cap burns the extra draw to the graveyard", () => {
    const s = scenario({
      // The Stockpile plus nine fillers is a hand of 10; playing it leaves 9, so the first draw
      // fills the hand back to the cap and the second is burned.
      p1: { hand: ["core-005", ...NINE_FILLERS], health: 20, library: ["core-025", "core-007"] },
    });
    s.play("core-005");

    expect(s.hand("p1")).toHaveLength(10);
    s.expectInZone("core-025", "hand");
    s.expectInZone("core-007", "graveyard");
    s.expectHealth("p1", 22);
    s.expectEvents("cardPlayed", "burned");
  });

  it("radiant draws 5 and heals 5", () => {
    const s = scenario({
      p1: {
        hand: [{ def: "core-005", radiant: true }],
        health: 20,
        library: ["core-025", "core-007", "core-012", "core-011", "core-020", "core-008"],
      },
    });
    s.play("core-005");

    s.expectHealth("p1", 25);
    expect(s.hand("p1")).toHaveLength(5);
    s.expectInZone("core-020", "hand");
    s.expectInZone("core-008", "library");
  });
});

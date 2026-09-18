// #10 Rapid Replenish — SPEC §8.1 row 10, BUILD M4-T4 must-pass: "2 prior plays → no draw; 3 →
// draw 3; radiant 6; counts as played either way".
//
// The boundary is the point of this card. §6.2 counts the cards played EARLIER this turn, and
// §10.5 step 4 has already counted this spell by the time its script runs, so "2 prior plays" and
// "3 prior plays" are `turnLog.cardsPlayed` of 3 and 4. The tests below never read that counter:
// they play real cards first and then assert the draw, which is the only thing a player can see.
//
// "Counts as played either way" (R40, R70) is proved the same way — with a second copy. A Rapid
// Replenish that drew nothing still raised the count, so the copy played right after it is the one
// that finds three earlier plays.
//
// Nothing in the libraries here is cast-on-draw (#21, #27, #90.1 are), so a draw is just a draw.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const LIBRARY = [
  "core-020",
  "core-020",
  "core-020",
  "core-011",
  "core-011",
  "core-011",
  "core-016",
  "core-016",
];

/** The first copy of a def still in hand, as an instance (several copies share a def id). */
function inHand(s: Scenario, defId: string) {
  const found = s.hand("p1").find((card) => card.defId === defId);
  if (found === undefined) throw new Error(`p1 holds no ${defId}`);
  return found;
}

describe("#10 Rapid Replenish (§8.1 row 10)", () => {
  it("R40 two prior plays draw nothing, and the spell still counts as played (R70)", () => {
    const s = scenario({
      seed: "core-010-boundary",
      p1: { hand: ["core-011", "core-011", "core-010", "core-010"], mana: 10, library: [...LIBRARY] },
      p2: { field: ["core-020"] },
    });

    s.play("core-011");
    s.play("core-011");
    const library = s.pile("p1", "library").length;
    const first = inHand(s, "core-010");

    s.play(first);

    // Combo 3 is not met at two earlier plays: no draw, and the library is untouched.
    expect(s.pile("p1", "library")).toHaveLength(library);
    expect(s.hand("p1")).toHaveLength(1);
    // It resolved and was spent all the same (§8 Conventions: the spell still counts as played).
    s.expectInZone(first, "graveyard");

    // R40/R70: because that copy counted, the next one finds three cards played earlier.
    s.play("core-010");
    expect(s.hand("p1")).toHaveLength(3);
    expect(s.pile("p1", "library")).toHaveLength(library - 3);
  });

  it("three prior plays draw 3", () => {
    const s = scenario({
      seed: "core-010-combo",
      p1: { hand: ["core-011", "core-011", "core-011", "core-010"], mana: 10, library: [...LIBRARY] },
      p2: { field: ["core-020"] },
    });

    s.play("core-011");
    s.play("core-011");
    s.play("core-011");
    const library = s.pile("p1", "library").length;
    const spell = inHand(s, "core-010");

    s.play(spell);

    expect(s.hand("p1")).toHaveLength(3);
    expect(s.pile("p1", "library")).toHaveLength(library - 3);
    s.expectInZone(spell, "graveyard");
    // Three separate draws (§2.4), each its own event.
    expect(s.lastEvents.filter((event) => event.type === "drawn")).toHaveLength(3);
  });

  it("radiant draws 6 at Combo 3", () => {
    const s = scenario({
      seed: "core-010-radiant",
      // #26 Glowy Jelly Bean makes the spell Radiant in hand, and counts as one of the plays.
      p1: { hand: ["core-026", "core-011", "core-011", "core-010"], mana: 10, library: [...LIBRARY] },
      p2: { field: ["core-020"] },
    });
    const spell = inHand(s, "core-010");

    s.play("core-026", { targets: [{ pick: "instance", instanceId: spell.id }] });
    s.play("core-011");
    s.play("core-011");
    const library = s.pile("p1", "library").length;

    s.play(spell);

    expect(s.hand("p1")).toHaveLength(6);
    expect(s.pile("p1", "library")).toHaveLength(library - 6);
    s.expectInZone(spell, "graveyard");
  });

  it("the play is legal at 0 mana with no prior plays, and draws nothing", () => {
    const s = scenario({
      seed: "core-010-always-playable",
      p1: { hand: ["core-010", "core-011"], mana: 0, library: [...LIBRARY] },
      p2: { field: ["core-020"] },
    });
    const library = s.pile("p1", "library").length;

    // §8.1: "always playable" — cost 0, no declared choices, no Combo requirement to play it.
    s.play("core-010");

    expect(s.pile("p1", "library")).toHaveLength(library);
    expect(s.hand("p1")).toHaveLength(1);
    s.expectInZone("core-010", "graveyard");
  });
});

// #33 Unstable Clone Machine — SPEC §8.2 row 33, BUILD M4-T4 must-pass row 33:
// "After each play, library +3 fresh copies with the radiant flag preserved; token spells copied
//  (R34); nothing is added to a 60-card library (R80); radiant one radiant copy".
//
// R57: a copy shuffled into a library is a fresh instance carrying only the radiant flag (and
// `statsOverride`, which `shuffleInto` cannot carry yet — reported as an engine gap).
// R80: `LIBRARY_CAP` is 60 and a copy that would overflow is never created.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import type { CardInstance } from "@jackioh/engine";

/** The copies of one def sitting in a library. */
function copiesIn(cards: CardInstance[], defId: string): CardInstance[] {
  return cards.filter((card) => card.defId === defId);
}

const FULL_LIBRARY = Array.from({ length: 60 }, () => "15");

describe("#33 Unstable Clone Machine — base", () => {
  it("after you play a unit, 3 fresh copies of it are shuffled into your library", () => {
    const s = scenario({
      seed: "clone-unit",
      p1: { hand: ["15"], backrow: ["33"], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });

    s.play("15");

    const copies = copiesIn(s.pile("p1", "library"), "core-015");
    expect(copies).toHaveLength(3);
    // R57: fresh instances — no damage, no buffs, not radiant, distinct ids.
    expect(copies.every((card) => card.damage === 0)).toBe(true);
    expect(copies.every((card) => card.buffs.attack === 0 && card.buffs.health === 0)).toBe(true);
    expect(copies.every((card) => !card.radiant)).toBe(true);
    expect(new Set(copies.map((card) => card.id)).size).toBe(3);
    s.expectEvents("cardPlayed", "shuffledIn", "shuffledIn", "shuffledIn");
  });

  it("after you play a spell, 3 copies of the spell are shuffled in", () => {
    const s = scenario({
      seed: "clone-spell",
      p1: { hand: ["31"], backrow: ["33"], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });

    s.play("31", { targets: [{ pick: "hero", player: "p2" }] });

    expect(copiesIn(s.pile("p1", "library"), "core-031")).toHaveLength(3);
  });

  it("R57 the played card's radiant flag is preserved on all 3 copies", () => {
    const s = scenario({
      seed: "clone-radiant-source",
      p1: { hand: ["15"], backrow: ["33"], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });
    s.card("15").radiant = true;

    s.play("15");

    const copies = copiesIn(s.pile("p1", "library"), "core-015");
    expect(copies).toHaveLength(3);
    expect(copies.every((card) => card.radiant)).toBe(true);
  });

  it("R34 a token spell is copied like any other card", () => {
    const s = scenario({
      seed: "clone-token",
      p1: { hand: ["93.1"], backrow: ["33"], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });
    const tokenDefId = s.card("93.1").defId;

    // Combo-Fodder declares a target (R81), so the play carries one.
    s.play("93.1", { targets: [{ pick: "hero", player: "p2" }] });

    expect(copiesIn(s.pile("p1", "library"), tokenDefId)).toHaveLength(3);
  });

  it("R80 nothing is added to a 60-card library", () => {
    const s = scenario({
      seed: "clone-cap",
      p1: { hand: ["31"], backrow: ["33"], field: ["43"], library: FULL_LIBRARY },
      p2: { field: ["15"] },
    });
    expect(s.pile("p1", "library")).toHaveLength(60);

    s.play("31", { targets: [{ pick: "hero", player: "p2" }] });

    expect(s.pile("p1", "library")).toHaveLength(60);
    expect(copiesIn(s.pile("p1", "library"), "core-031")).toHaveLength(0);
  });

  it("copies go in after each play, so two plays leave 6", () => {
    const s = scenario({
      seed: "clone-two-plays",
      p1: { hand: ["15", "31"], backrow: ["33"], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });

    s.play("15");
    s.play("31", { targets: [{ pick: "hero", player: "p2" }] });

    expect(copiesIn(s.pile("p1", "library"), "core-015")).toHaveLength(3);
    expect(copiesIn(s.pile("p1", "library"), "core-031")).toHaveLength(3);
  });

  it("R119 a permanent does not answer its own arrival: it starts counting from the next play", () => {
    const s = scenario({
      seed: "clone-self",
      p1: { hand: ["33"], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });

    s.play("33");

    expect(s.pile("p1", "library")).toHaveLength(0);
  });

  it("\"you play a card\" is the controller's own plays, not the opponent's", () => {
    const s = scenario({
      seed: "clone-opponent",
      active: "p2",
      p1: { backrow: ["33"], field: ["43"], library: [] },
      p2: { hand: ["15"], field: ["15"], library: [] },
    });

    s.play("15");

    expect(s.pile("p1", "library")).toHaveLength(0);
    expect(s.pile("p2", "library")).toHaveLength(0);
  });
});

describe("#33 Unstable Clone Machine — radiant", () => {
  it("one of the 3 copies is Radiant and the other two are not", () => {
    const s = scenario({
      seed: "clone-radiant",
      p1: { hand: ["15"], backrow: [{ def: "33", radiant: true }], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });

    s.play("15");

    const copies = copiesIn(s.pile("p1", "library"), "core-015");
    expect(copies).toHaveLength(3);
    expect(copies.filter((card) => card.radiant)).toHaveLength(1);
    expect(copies.filter((card) => !card.radiant)).toHaveLength(2);
  });

  it("a Radiant card played into a radiant copier still makes 3 radiant copies", () => {
    const s = scenario({
      seed: "clone-radiant-both",
      p1: { hand: ["15"], backrow: [{ def: "33", radiant: true }], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });
    s.card("15").radiant = true;

    s.play("15");

    const copies = copiesIn(s.pile("p1", "library"), "core-015");
    expect(copies).toHaveLength(3);
    expect(copies.every((card) => card.radiant)).toBe(true);
  });

  it("R80 the radiant form adds nothing to a 60-card library either", () => {
    const s = scenario({
      seed: "clone-radiant-cap",
      p1: {
        hand: ["31"],
        backrow: [{ def: "33", radiant: true }],
        field: ["43"],
        library: FULL_LIBRARY,
      },
      p2: { field: ["15"] },
    });

    s.play("31", { targets: [{ pick: "hero", player: "p2" }] });

    expect(s.pile("p1", "library")).toHaveLength(60);
  });
});

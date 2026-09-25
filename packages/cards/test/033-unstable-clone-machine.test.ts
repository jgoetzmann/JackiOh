// #33 Unstable Clone Machine — SPEC §8.2 row 33, BUILD M4-T4 must-pass row 33:
// "After each play, library +3 fresh copies with the radiant flag preserved; token spells copied
//  (R34); nothing is added to a 60-card library (R80)". Radiant (R275): "shuffle 3 Radiant copies",
// so all three are Radiant whatever the played card was, and R80 still caps the library.
//
// R57: a copy shuffled into a library is a fresh instance carrying only the radiant flag (and
// `statsOverride`, which `shuffleInto` cannot carry yet — reported as an engine gap).
// R80: `LIBRARY_CAP` is 60 and a copy that would overflow is never created.
// R119 (hunt round 8): a Clone Machine a play's own resolution put onto the field (#98's Recruit)
// starts counting from the next play, as the played Clone Machine itself does.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { LIBRARY_CAP, subsystems, type CardInstance } from "@jackioh/engine";

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
  it("R275 all 3 copies of a non-Radiant card are Radiant", () => {
    const s = scenario({
      seed: "clone-radiant",
      p1: { hand: ["15"], backrow: [{ def: "33", radiant: true }], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });

    s.play("15");

    const copies = copiesIn(s.pile("p1", "library"), "core-015");
    expect(copies).toHaveLength(3);
    expect(copies.every((card) => card.radiant)).toBe(true);
    // R57: still fresh instances, three of them.
    expect(copies.every((card) => card.damage === 0)).toBe(true);
    expect(new Set(copies.map((card) => card.id)).size).toBe(3);
    // The played card itself is untouched: only the copies are Radiant.
    expect(s.unit("p1", 2)?.radiant).toBe(false);
  });

  it("R275 a spell's copies are Radiant too", () => {
    const s = scenario({
      seed: "clone-radiant-spell",
      p1: { hand: ["31"], backrow: [{ def: "33", radiant: true }], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });

    s.play("31", { targets: [{ pick: "hero", player: "p2" }] });

    const copies = copiesIn(s.pile("p1", "library"), "core-031");
    expect(copies).toHaveLength(3);
    expect(copies.every((card) => card.radiant)).toBe(true);
  });

  it("a Radiant card played into a radiant copier makes 3 Radiant copies", () => {
    const s = scenario({
      seed: "clone-radiant-both",
      p1: { hand: [{ def: "15", radiant: true }], backrow: [{ def: "33", radiant: true }], field: ["43"], library: [] },
      p2: { field: ["15"] },
    });

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

    expect(s.pile("p1", "library")).toHaveLength(LIBRARY_CAP);
    expect(copiesIn(s.pile("p1", "library"), "core-031")).toHaveLength(0);
  });

  it("R80 a library one short of the cap takes one copy, and it is Radiant", () => {
    const s = scenario({
      seed: "clone-radiant-near-cap",
      p1: {
        hand: ["31"],
        backrow: [{ def: "33", radiant: true }],
        field: ["43"],
        library: FULL_LIBRARY.slice(1),
      },
      p2: { field: ["15"] },
    });
    expect(s.pile("p1", "library")).toHaveLength(LIBRARY_CAP - 1);

    s.play("31", { targets: [{ pick: "hero", player: "p2" }] });

    expect(s.pile("p1", "library")).toHaveLength(LIBRARY_CAP);
    const copies = copiesIn(s.pile("p1", "library"), "core-031");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.radiant).toBe(true);
  });
});

describe("R119: a permanent does not answer the play that put it onto the field", () => {
  it("R119 a Clone Machine a played Heroic Power's Recruit put on the field does not answer that play", () => {
    const s = scenario({
      seed: "edge-r8-hp-clone",
      p1: { hand: ["core-098", "core-008"], library: ["core-033", "core-008", "core-008", "core-008"], mana: 8 },
      p2: { hand: ["core-008"], library: ["core-008", "core-008", "core-008", "core-008", "core-008", "core-008"] },
    });
    // R43: the power lives on the instance; "(3) Recruit a permanent".
    const hp = s.hand("p1")[0];
    if (hp === undefined) throw new Error("expected the Heroic Power in hand");
    hp.memory[subsystems.POWER_KEY] = "recruit";

    s.play(hp);

    // Playing it activated the power once (R43): the Recruit put the Clone Machine on p1's backrow
    // while the Heroic Power's play was resolving.
    const backrow = [1, 2, 3, 4, 5].flatMap((lane) => {
      const card = s.backrow("p1", lane);
      return card === null ? [] : [card.defId];
    });
    expect(backrow).toContain("core-033");
    // R119: "does not fire on the play that put it onto the field: it starts counting from the next
    // play". No copies of the Heroic Power are shuffled in.
    expect(copiesIn(s.pile("p1", "library"), "core-098")).toHaveLength(0);
  });
});

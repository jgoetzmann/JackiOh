// #30 Archivist (SPEC §8.2, BUILD M4-T4 row 30): "Mode chosen with the play (R81); highest/lowest
// by current cost, ties nearest top, X counts 0 (R24); radiant draws both".
//
// Costs used below, per R65 read out of play: #10 Rapid Replenish 0, #5 Stockpile 1, #28 Knockoff
// Temu 2, #13 Jlockeed Shredder-10 3, #17 Flood 3, #25 "4-mana 7/7" 4, #24 Efficiency Dividend X
// (counts 0), #46 Suppressive Aura "2 embiggen 4" (counts 2, its base price).
//
// NOTE — one case here is RED on purpose: "draws the card out of the library" fails until the
// engine gains a verb that moves an existing library card to a hand (`drawFromLibrary`). See the
// BLOCKED note at the top of src/scripts/030-archivist.ts.

import { describe, expect, it } from "vitest";
import type { Scenario } from "./_harness";
import { scenario } from "./_harness";

function archivist(library: string[], radiant = false): Scenario {
  return scenario({ p1: { hand: [{ def: "core-030", radiant }], library, mana: 2 } });
}

function handDefs(s: Scenario): string[] {
  return s.state.players.p1.hand.map((card) => card.defId);
}

describe("#30 Archivist — base", () => {
  it("R81 draws the highest-cost card in your library, with the mode carried by the play", () => {
    const s = archivist(["core-005", "core-025", "core-010"]);

    s.play("core-030", { modes: ["highest"] });

    // R81: the mode travelled in the play action, so resolution never paused.
    expect(s.state.pending).toBeNull();
    expect(handDefs(s)).toEqual(["core-025"]); // #25 at 4 is the dearest
    expect(s.unit("p1", 1)?.defId).toBe("core-030");
  });

  it("R81 draws the lowest-cost card when the play carries that mode instead", () => {
    const s = archivist(["core-005", "core-025", "core-010"]);

    s.play("core-030", { modes: ["lowest"] });

    expect(handDefs(s)).toEqual(["core-010"]); // #10 Rapid Replenish at 0
  });

  it("R24 ties go to the card nearest the top", () => {
    // #13 and #17 both cost 3, and #13 is nearer the top, so #13 wins the highest.
    const highest = archivist(["core-013", "core-017", "core-005"]);
    highest.play("core-030", { modes: ["highest"] });
    expect(handDefs(highest)).toEqual(["core-013"]);

    // The same tie on the other side: #5 and #51 both cost 1, and #5 is nearer the top.
    const lowest = archivist(["core-025", "core-005", "core-051"]);
    lowest.play("core-030", { modes: ["lowest"] });
    expect(handDefs(lowest)).toEqual(["core-005"]);
  });

  it("R24/R65 an X-cost card in a library counts 0, so it is the lowest and never the highest", () => {
    const lowest = archivist(["core-005", "core-024", "core-025"]);
    lowest.play("core-030", { modes: ["lowest"] });
    expect(handDefs(lowest)).toEqual(["core-024"]); // #24 Efficiency Dividend, X → 0

    const highest = archivist(["core-024", "core-005"]);
    highest.play("core-030", { modes: ["highest"] });
    expect(handDefs(highest)).toEqual(["core-005"]); // 1 beats X's 0
  });

  it("R65 an embiggen card counts its base price out of play, not its embiggen price", () => {
    // #46 Suppressive Aura is "2 embiggen 4". At its base price of 2 it loses to #13's 3; if the
    // embiggen price counted it would be a 4 and would win.
    const s = archivist(["core-046", "core-013"]);

    s.play("core-030", { modes: ["highest"] });

    expect(handDefs(s)).toEqual(["core-013"]);
  });

  it("§8 conventions: an empty library fizzles the Cry and the unit still enters", () => {
    const s = archivist([]);

    s.play("core-030", { modes: ["highest"] });

    expect(handDefs(s)).toEqual([]);
    expect(s.unit("p1", 1)?.defId).toBe("core-030");
    expect(s.state.players.p1.hero.health).toBe(30); // no fatigue: nothing was drawn
  });

  // §6.3 Draw: "take the top card of your library" is the one Draw, and Archivist's names the card,
  // so the card leaves the library as a draw (`drawFromLibrary`) rather than a copy landing in hand.
  it("R24 draws the card OUT of the library, so the library no longer holds it and it arrives as a draw (§6.3 Draw, §2.4, R55)", () => {
    const s = archivist(["core-005", "core-025", "core-010"]);
    const dearest = s.pile("p1", "library")[1];
    const drawnBefore = s.state.counters.drawn;

    s.play("core-030", { modes: ["highest"] });

    expect(s.state.players.p1.library.map((card) => card.defId)).toEqual(["core-005", "core-010"]);
    // The library card itself, not a fresh copy of its definition, and counted as a draw.
    expect(s.hand("p1").map((card) => card.id)).toContain(dearest?.id);
    expect(s.lastEvents.filter((event) => event.type === "drawn")).toHaveLength(1);
    expect(s.state.counters.drawn).toBe(drawnBefore + 1);
  });
});

describe("#30 Archivist — radiant", () => {
  it("draws both the highest-cost and the lowest-cost card, and asks nothing (§8 conventions)", () => {
    const s = archivist(["core-005", "core-025", "core-010"], true);

    s.play("core-030", { modes: [] });

    expect(s.state.pending).toBeNull();
    expect(handDefs(s).sort()).toEqual(["core-010", "core-025"]); // 0 and 4
    // The radiant face is an 8/10 (§8.2).
    s.expectStats(s.unit("p1", 1)?.id ?? "", { attack: 8, maxHealth: 10 });
  });

  it("draws one card when the library holds only one, which is both the highest and the lowest", () => {
    const s = archivist(["core-005"], true);

    s.play("core-030", { modes: [] });

    expect(handDefs(s)).toEqual(["core-005"]);
  });

  it("R24 applies the same tie rule to both ends", () => {
    // #13 and #17 both cost 3 (the highest); #5 and #51 both cost 1 (the lowest). Top-down wins.
    const s = archivist(["core-013", "core-017", "core-005", "core-051"], true);

    s.play("core-030", { modes: [] });

    expect(handDefs(s).sort()).toEqual(["core-005", "core-013"]);
  });

  it("§8 conventions: an empty library fizzles both draws and the unit still enters", () => {
    const s = archivist([], true);

    s.play("core-030", { modes: [] });

    expect(handDefs(s)).toEqual([]);
    expect(s.unit("p1", 1)?.defId).toBe("core-030");
  });
});

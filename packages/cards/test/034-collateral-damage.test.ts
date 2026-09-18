// #34 Collateral Damage — SPEC §8.2 row 34, BUILD M4-T4 must-pass row 34:
// "Exiles an Indestructible permanent and a random opponent library card; radiant same-row
//  neighbours too".
//
// #66 The Rock is a 10/10 with printed Indestructible, so it is the must-pass's Indestructible
// permanent (it is placed by the setup, so its Tribute cost is not in the way).
//
// RED UNTIL TWO VERBS LAND: the script imports `exileRandomFromLibrary({ count, player? })` (the
// same verb #42 Eugenics imports) and `exileAdjacentTo({ target })` (the mirror of #16 Hit Job's
// `destroyAdjacentTo`). Neither is in `effects/index.ts` yet, so this whole file fails to load until
// they are added; the script file's header carries the exact signatures.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import type { CardInstance } from "@jackioh/engine";

function must(card: CardInstance | null, what: string): CardInstance {
  if (card === null) throw new Error(`the scenario has no ${what}`);
  return card;
}

function at(instance: CardInstance): { pick: "instance"; instanceId: string }[] {
  return [{ pick: "instance", instanceId: instance.id }];
}

describe("#34 Collateral Damage — base", () => {
  it("§6.3 Exile bypasses Indestructible: The Rock goes to exile", () => {
    const s = scenario({
      seed: "collateral",
      p1: { hand: ["34"], field: ["15"], library: ["15"] },
      p2: { field: ["66"], library: ["15", "43", "13"] },
    });
    const rock = must(s.unit("p2", 1), "p2 lane 1");

    s.play("34", { targets: at(rock) });

    s.expectInZone(rock, "exile");
    s.expectEvents("cardPlayed", "exiled");
  });

  it("R55 the exile counter counts the permanent", () => {
    const s = scenario({
      seed: "collateral-counter",
      p1: { hand: ["34"], field: ["15"], library: ["15"] },
      p2: { field: ["66"], library: ["15", "43", "13"] },
    });
    expect(s.state.counters.exiled).toBe(0);

    s.play("34", { targets: at(must(s.unit("p2", 1), "p2 lane 1")) });

    // One for the permanent, one for the library card.
    expect(s.state.counters.exiled).toBe(2);
  });

  it("a backrow permanent is a legal target too", () => {
    const s = scenario({
      seed: "collateral-backrow",
      p1: { hand: ["34"], field: ["15"], library: ["15"] },
      p2: { backrow: ["18"], field: ["15"], library: ["15", "43", "13"] },
    });
    const trap = must(s.backrow("p2", 1), "p2 backrow 1");

    s.play("34", { targets: at(trap) });

    s.expectInZone(trap, "exile");
  });

  it("it also exiles one random card from the opponent's library", () => {
    const library = ["15", "43", "13"];
    const run = (): ReturnType<typeof scenario> => {
      const s = scenario({
        seed: "collateral-library",
        p1: { hand: ["34"], field: ["15"], library: ["15"] },
        p2: { field: ["66"], library },
      });
      s.play("34", { targets: at(must(s.unit("p2", 1), "p2 lane 1")) });
      return s;
    };

    const s = run();
    expect(s.pile("p2", "library")).toHaveLength(2);
    // The permanent and exactly one library card.
    expect(s.pile("p2", "exile")).toHaveLength(2);

    // §9.3: the pick comes from the seeded rng, so the same seed exiles the same card every time.
    const exiled = (scene: ReturnType<typeof scenario>): string[] =>
      scene.pile("p2", "library").map((card) => card.defId);
    expect(exiled(run())).toEqual(exiled(s));
  });

  it("an empty opponent library costs it nothing", () => {
    const s = scenario({
      seed: "collateral-empty-library",
      p1: { hand: ["34"], field: ["15"], library: ["15"] },
      p2: { field: ["66"], library: [] },
    });
    const rock = must(s.unit("p2", 1), "p2 lane 1");

    s.play("34", { targets: at(rock) });

    s.expectInZone(rock, "exile");
    expect(s.pile("p2", "exile")).toHaveLength(1);
  });
});

describe("#34 Collateral Damage — radiant", () => {
  it("§3.1 also the permanents adjacent to the target in its row", () => {
    const s = scenario({
      seed: "collateral-radiant",
      p1: { hand: ["34"], field: ["15"], library: ["15"] },
      p2: { field: ["15", "66", "43"], library: ["15", "43", "13"] },
    });
    s.card("34").radiant = true;
    const left = must(s.unit("p2", 1), "p2 lane 1");
    const middle = must(s.unit("p2", 2), "p2 lane 2");
    const right = must(s.unit("p2", 3), "p2 lane 3");

    s.play("34", { targets: at(middle) });

    s.expectInZone(left, "exile");
    s.expectInZone(middle, "exile");
    s.expectInZone(right, "exile");
  });

  it("§3.1 adjacency does not wrap and never crosses sides", () => {
    const s = scenario({
      seed: "collateral-radiant-edge",
      p1: { hand: ["34"], field: [{ def: "15", lane: 1 }], library: ["15"] },
      p2: {
        field: [{ def: "66", lane: 1 }, { def: "15", lane: 2 }, { def: "43", lane: 5 }],
        library: ["15", "43", "13"],
      },
    });
    s.card("34").radiant = true;
    const edge = must(s.unit("p2", 1), "p2 lane 1");
    const neighbour = must(s.unit("p2", 2), "p2 lane 2");
    const faraway = must(s.unit("p2", 5), "p2 lane 5");
    const ally = must(s.unit("p1", 1), "p1 lane 1");

    s.play("34", { targets: at(edge) });

    s.expectInZone(edge, "exile");
    s.expectInZone(neighbour, "exile");
    // Lane 1 has no lane 0, so nothing wraps round to lane 5, and p1's own lane 1 is another side.
    s.expectInZone(faraway, "field");
    s.expectInZone(ally, "field");
  });

  it("the radiant form keeps the base library clause (\"Also …\")", () => {
    const s = scenario({
      seed: "collateral-radiant-library",
      p1: { hand: ["34"], field: ["15"], library: ["15"] },
      p2: { field: ["66"], library: ["15", "43", "13"] },
    });
    s.card("34").radiant = true;

    s.play("34", { targets: at(must(s.unit("p2", 1), "p2 lane 1")) });

    expect(s.pile("p2", "library")).toHaveLength(2);
  });

  it("the radiant form still exiles the target itself", () => {
    const s = scenario({
      seed: "collateral-radiant-target",
      p1: { hand: ["34"], field: ["15"], library: ["15"] },
      p2: { field: ["66"], library: ["15", "43", "13"] },
    });
    s.card("34").radiant = true;
    const rock = must(s.unit("p2", 1), "p2 lane 1");

    s.play("34", { targets: at(rock) });

    s.expectInZone(rock, "exile");
  });
});

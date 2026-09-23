// A Tribute's deaths and the targets they take with them (SPEC §6.3 Tribute, §10.5 steps 1, 2 and 5,
// R68, R90, R101, R174). Found by the polish-4 edge-case hunt, round 3 (docs/polish/4-edge-cases.md,
// lens L9: `legalActions` and `reduce` disagreeing); both cases failed before their fix.
//
//  - R68, R101: the tributed set is one payment and dies together, its Death hooks in R68's order,
//    so the order a play lists it in means nothing: `legalActions` offers each set once and `reduce`
//    accepts any listing of it, and every listing is the same play.
//  - R174: a target the play's own Tribute sacrificed has left the field, so the effect aimed at it
//    fizzles (§8 Conventions) instead of landing on a card in a graveyard.

import { describe, expect, it } from "vitest";
import type { Selection } from "@jackioh/shared";
import { type CardInstance } from "@jackioh/engine";
import { scenario, type Scenario } from "./_harness";

const STOCKPILE = "core-005"; // keeps a hand non-empty, so no turn auto-ends (§2.5)
const GARY = "core-004";
const RENO = "core-053";
const LAVA_GOLEM = "core-055";
const TWISTED_SORCERER = "core-068";
const RADIANT_SAINTESS = "core-081";
const MISS_MROW = "core-086";
const CRAFT_A_CARD = "core-099";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing: ${what}`);
  return value;
}

describe("R68: a Tribute's Deaths resolve in lane order, whatever order the play lists them in", () => {
  /** Radiant Saintess in lane 1 and "Miss" Mrow in lane 2 pay Lava Golem's Tribute with a Gary. */
  function tributeGame(order: (ids: { saintess: string; mrow: string; gary: string }) => string[]): Scenario {
    const g = scenario({
      p1: {
        hand: [LAVA_GOLEM, STOCKPILE],
        field: [
          { def: RADIANT_SAINTESS, lane: 1 }, // Death: all your other units become Radiant
          { def: MISS_MROW, lane: 2 }, // Death: steal all enemy units
          { def: GARY, lane: 3 },
          { def: GARY, lane: 4 },
        ],
      },
      p2: { hand: [STOCKPILE], field: [{ def: RENO, lane: 2 }] },
    });
    const ids = {
      saintess: must(g.unit("p1", 1), "Saintess").id,
      mrow: must(g.unit("p1", 2), "Mrow").id,
      gary: must(g.unit("p1", 3), "Gary").id,
    };
    g.play(LAVA_GOLEM, { zone: 5, tributes: order(ids) });
    return g;
  }

  it("R68 Radiant Saintess (lane 1) dies before \"Miss\" Mrow (lane 2) whether the play lists them in lane order or not, so the Reno Mrow steals is not made Radiant (R101)", () => {
    const inLaneOrder = tributeGame(({ saintess, mrow, gary }) => [saintess, mrow, gary]);
    const mrowFirst = tributeGame(({ saintess, mrow, gary }) => [mrow, saintess, gary]);

    for (const g of [inLaneOrder, mrowFirst]) {
      const stolen = g.unit("p1", 2);
      expect({ stolen: stolen?.defId, controller: stolen?.controller, radiant: stolen?.radiant }).toEqual({
        stolen: RENO,
        controller: "p1",
        radiant: false,
      });
    }
    expect(mrowFirst.lastEvents).toEqual(inLaneOrder.lastEvents);
  });
});

describe("R174: a target the play's own Tribute sacrificed is no longer a target", () => {
  it("R174 a crafted Lava Golem + Twisted Sorcerer that tributes its own target leaves that card in the graveyard undamaged (§8 Conventions, R78)", () => {
    const g = scenario({
      seed: "r3craft-36", // the first Discover offers Lava Golem, the second Twisted Sorcerer
      p1: {
        hand: [CRAFT_A_CARD, RENO],
        mana: 4,
        field: [
          { def: GARY, lane: 1 },
          { def: GARY, lane: 2 },
        ],
      },
      p2: { hand: [RENO], field: [{ def: RENO, lane: 1 }] },
    });
    g.play(CRAFT_A_CARD);
    g.answer(LAVA_GOLEM);
    g.answer(TWISTED_SORCERER);
    const card: CardInstance = must(
      g.hand("p1").find((held) => held.defId.startsWith("t-")),
      "the crafted card",
    );
    const first = must(g.unit("p1", 1), "Gary").id;
    const second = must(g.unit("p1", 2), "Gary").id;
    const reno = must(g.unit("p2", 1), "p2's Reno");
    const target: Selection[] = [{ pick: "instance", instanceId: reno.id }];
    const before = g.events.length;

    // Lava Golem may tribute enemy units (§8 #55), and the Sorcerer may target any unit. Step 1
    // checks the two declarations each on its own (R90), so the play is legal; step 2 sacrifices
    // the Reno before step 5 resolves the Sorcerer's damage, which then has no unit to hit.
    g.play(card, { zone: 3, tributes: [first, second, reno.id], targets: target });

    const hits = g.events.slice(before).filter((event) => event.type === "damage" && event.targetId === reno.id);
    expect({ zone: g.card(reno).zone.z, damage: g.card(reno).damage, hits: hits.length }).toEqual({
      zone: "graveyard",
      damage: 0,
      hits: 0,
    });
  });
});

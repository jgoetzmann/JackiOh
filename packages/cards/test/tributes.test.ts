// A Tribute's deaths and the targets they take with them (SPEC §6.3 Tribute, §10.5 steps 1, 2 and 5,
// R68, R90, R101, R174). Found by the polish-4 edge-case hunt, round 3 (docs/polish/4-edge-cases.md,
// lens L9: `legalActions` and `reduce` disagreeing); both cases failed before their fix.
//
//  - R68, R101: the tributed set is one payment and dies together, its Death hooks in R68's order,
//    so the order a play lists it in means nothing: `legalActions` offers each set once and `reduce`
//    accepts any listing of it, and every listing is the same play.
//  - R174: a target the play's own Tribute sacrificed has left the field, so the effect aimed at it
//    fizzles (§8 Conventions) instead of landing on a card in a graveyard.
//  - Round 5 (lenses L9 and "keywords and layers"). §6.3 Vanilla, §7: a Sheep Token's "worth 2
//    Tributes" is its text, so a Vanilla copy of one is worth 1 like any other unit.
//  - Round 9, lens "card by card". R119, R210: a play's arrivals are counted from the moment it
//    begins, so the copies a tributed Cube's Death puts on the field at step 2 answer neither its step
//    4 (#41), its step 5 (#38) nor its step 7 (#33).

import { describe, expect, it } from "vitest";
import type { Selection, GameEvent } from "@jackioh/shared";
import { legalActions, reduce, tributeValueOf, type CardInstance } from "@jackioh/engine";
import { scenario, type Scenario } from "./_harness";

const STOCKPILE = "core-005"; // keeps a hand non-empty, so no turn auto-ends (§2.5)
const GARY = "core-004";
const RENO = "core-053";
const LAVA_GOLEM = "core-055";
const TWISTED_SORCERER = "core-068";
const RADIANT_SAINTESS = "core-081";
const MISS_MROW = "core-086";
const CRAFT_A_CARD = "core-099";
const POSTDOC = "core-061"; // radiant: "choose any unit on the field; summon a Vanilla copy"
const SHEEP = "core-t-sheep"; // "Worth 2 Tributes while on the field."

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

describe("§6.3 Vanilla: a Vanilla Sheep Token has no text, so it is worth 1 Tribute", () => {
  it("§6.3 a Vanilla copy of a Sheep Token and one other unit do not pay Lava Golem's Tribute 3 (§7, R101)", () => {
    const s = scenario({
      p1: {
        hand: [{ def: POSTDOC, radiant: true }, LAVA_GOLEM, STOCKPILE],
        mana: 9,
        field: [
          { def: SHEEP, lane: 1 },
          { def: GARY, lane: 2 },
        ],
      },
      p2: { hand: [STOCKPILE] },
    });
    const sheep = must(s.unit("p1", 1), "Sheep Token");
    const gary = must(s.unit("p1", 2), "Gary");
    expect(tributeValueOf(s.state, sheep)).toBe(2);

    // Radiant Prejudiced Postdoc: "any unit" → a Vanilla copy of the Sheep in lane 3.
    s.play(POSTDOC, { zone: 4, targets: [{ pick: "instance", instanceId: sheep.id }] });
    const copy = must(s.unit("p1", 3), "the Vanilla copy");
    expect({ def: copy.defId, vanilla: copy.vanilla }).toEqual({ def: SHEEP, vanilla: true });

    // §6.3 Vanilla "removes a unit's text", and "Worth 2 Tributes while on the field" is the Sheep's
    // text (§7), so the copy is worth 1 (§3.2 reads the worth off the face that is up).
    expect(tributeValueOf(s.state, s.card(copy))).toBe(1);

    // The copy and Gary pay 2 of the 3: R101 refuses the play, and `legalActions` does not offer it.
    const golem = must(s.hand("p1").find((card) => card.defId === LAVA_GOLEM), "Lava Golem in hand");
    const pair = [copy.id, gary.id].sort().join();
    const offered = legalActions(s.state, "p1").some(
      (action) =>
        action.type === "play" &&
        action.instanceId === golem.id &&
        [...(action.tributes ?? [])].sort().join() === pair,
    );
    expect(offered).toBe(false);

    const result = reduce(s.state, {
      type: "play",
      playerId: "p1",
      nonce: "vanilla-sheep",
      instanceId: golem.id,
      zone: { row: "units", lane: 5 },
      tributes: [copy.id, gary.id],
    });
    expect(result.error).toMatch(/Tribute 3/);
  });
});

const VANILLA = "core-008";
const TIMMY = "core-011";
const EXPERIMENTATION = "core-085";
const TRIBUTE_LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

describe("R102, §3.2: a Sheep's worth is its text, and a Fuse keeps it", () => {
  it("R102 a Sheep Token fused by Unlicensed Experimentation is still worth 2 Tributes (§3.2, §7, R77)", () => {
    const g = scenario({
      active: "p2",
      turn: 10,
      p1: {
        // Mr. Vanilla is Immutable, so #85 never picks it (R23): the Sheep is the Fuse target.
        field: [
          { def: SHEEP, lane: 1 },
          { def: VANILLA, lane: 2 },
        ],
        backrow: [{ def: EXPERIMENTATION, lane: 3 }],
        hand: [LAVA_GOLEM, STOCKPILE],
        library: [...TRIBUTE_LIBRARY],
      },
      p2: { hand: [TIMMY, STOCKPILE], library: [...TRIBUTE_LIBRARY] },
    });
    const sheep = unitAt(g, "p1", 1);
    const vanilla = unitAt(g, "p1", 2);
    expect(tributeValueOf(g.state, sheep)).toBe(2);

    g.play(TIMMY, { zone: 1 });
    const fused = g.card(sheep);
    expect(fused.defId).not.toBe(SHEEP);
    expect(g.unit("p2", 1)).toBeNull();

    // R77/R102: the fused card's text is both texts joined, and "nothing about an ingredient is
    // silently dropped" — the Sheep's "worth 2 Tributes" (§7, §3.2) is part of that text.
    expect(tributeValueOf(g.state, fused)).toBe(2);

    g.endTurn();
    expect(g.state.active).toBe("p1");
    const golem = g.hand("p1").find((card) => card.defId === LAVA_GOLEM);
    if (golem === undefined) throw new Error("setup: Lava Golem in hand");
    const pair = [fused.id, vanilla.id].sort().join();
    const offered = legalActions(g.state, "p1").some(
      (action) =>
        action.type === "play" &&
        action.instanceId === golem.id &&
        [...(action.tributes ?? [])].sort().join() === pair,
    );
    expect(offered).toBe(true);
    g.play(golem, { zone: 3, tributes: [fused.id, vanilla.id] });
    expect(g.unit("p1", 3)?.defId).toBe(LAVA_GOLEM);
  });
});

// ---------------------------------------------------------------------------
// Round 9: what a Tribute's Death puts on the field is an arrival (R119, R210)
// ---------------------------------------------------------------------------

const MR_VANILLA = "core-008";
const TEMPO_TIMMY = "core-011";
const MIDRANGE_MENACE = "core-019";
const CARNIVOROUS_CUBE = "core-022";
const UNSTABLE_CLONE_MACHINE = "core-033";
const QUICKSTRIKER = "core-038";
const SHEEPISH = "core-041";
const THE_ROCK = "core-066";
const SHEEP_TOKEN = "core-t-sheep";

const R119_LIBRARY = [MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA];


function ofType<T extends GameEvent["type"]>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }>[] {
  return events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function backrowDefs(s: Scenario, player: "p1" | "p2"): (string | null)[] {
  return s.state.players[player].backrow.map((card) => card?.defId ?? null);
}

function quickstrikersOf(s: Scenario, player: "p1" | "p2"): string[] {
  return s.state.players[player].backrow.flatMap((card) => (card?.defId === QUICKSTRIKER ? [card.id] : []));
}

describe("R119, R210: what a Tribute's Death puts on the field does not answer the play that paid it (§10.5 step 2)", () => {
  it("R119 a Sheepish a tributed Carnivorous Cube's Death copies at step 2 does not turn the Lava Golem being played into a Sheep (R210)", () => {
    // p2's Cube eats p2's own face-down Sheepish (§8 #22: "any of your other permanents, backrow
    // included", R41), so its Death summons two Sheepish copies into p2's backrow.
    const s = scenario({
      active: "p2",
      p1: {
        hand: [LAVA_GOLEM, STOCKPILE],
        field: [
          { def: MR_VANILLA, lane: 1 },
          { def: MR_VANILLA, lane: 2 },
        ],
        mana: 10,
        library: [...R119_LIBRARY],
      },
      p2: {
        hand: [CARNIVOROUS_CUBE, STOCKPILE],
        backrow: [SHEEPISH],
        field: [{ def: MIDRANGE_MENACE, lane: 5 }],
        mana: 10,
        library: [...R119_LIBRARY],
      },
    });
    const sheepish = must(s.backrow("p2", 1), "p2's face-down Sheepish");
    s.play(CARNIVOROUS_CUBE, { zone: 1, targets: [{ pick: "instance", instanceId: sheepish.id }] });
    const cube = must(s.unit("p2", 1), "p2's Carnivorous Cube");
    s.endTurn();
    expect(s.state.active).toBe("p1");
    expect(backrowDefs(s, "p2")).toEqual([null, null, null, null, null]);

    // §8 #55: Lava Golem "may tribute enemy units", so the Cube is one of its three.
    const golem = must(s.hand("p1").find((card) => card.defId === LAVA_GOLEM), "p1's Lava Golem");
    const first = must(s.unit("p1", 1), "p1's lane-1 Mr. Vanilla");
    const second = must(s.unit("p1", 2), "p1's lane-2 Mr. Vanilla");
    s.play(golem, { zone: 4, tributes: [cube.id, first.id, second.id] });

    // Step 2 paid the Tribute and the Cube's Death summoned its two Sheepish copies (R41, R210).
    expect(backrowDefs(s, "p2").filter((defId) => defId === SHEEPISH).length).toBeGreaterThanOrEqual(1);
    expect(ofType(s.lastEvents, "summoned").filter((event) => event.defId === SHEEPISH)).toHaveLength(2);
    // R119: those copies arrived while this play resolved, so they start counting from the next play:
    // no trap fires on the Golem's `cardPlayed`, and the Golem lands as itself.
    expect(ofType(s.lastEvents, "trapFired")).toEqual([]);
    expect(s.unit("p1", 4)?.defId).toBe(LAVA_GOLEM);
    expect(s.unit("p1", 4)?.defId).not.toBe(SHEEP_TOKEN);
  });

  it("R119 an Unstable Clone Machine a tributed Cube's Death copies at step 2 does not shuffle copies of the card that paid the Tribute (R210)", () => {
    const s = scenario({
      p1: {
        hand: [CARNIVOROUS_CUBE, THE_ROCK],
        field: [{ def: MR_VANILLA, lane: 3 }],
        backrow: [UNSTABLE_CLONE_MACHINE],
        mana: 20,
        library: [...R119_LIBRARY],
      },
      p2: { hand: [STOCKPILE], field: [MIDRANGE_MENACE], library: [...R119_LIBRARY] },
    });
    const machine = must(s.backrow("p1", 1), "p1's Unstable Clone Machine");
    // The Cube eats the Clone Machine (R41), so none is on the field when The Rock is played.
    s.play(CARNIVOROUS_CUBE, { zone: 1, targets: [{ pick: "instance", instanceId: machine.id }] });
    const cube = must(s.unit("p1", 1), "p1's Carnivorous Cube");
    expect(backrowDefs(s, "p1")).toEqual([null, null, null, null, null]);
    const library = s.pile("p1", "library").length;

    // §8 #66: The Rock's Tribute 1 is the Cube, whose Death summons two Clone Machine copies.
    s.play(THE_ROCK, { zone: 4, tributes: [cube.id] });

    expect(backrowDefs(s, "p1").filter((defId) => defId === UNSTABLE_CLONE_MACHINE)).toHaveLength(2);
    // R119: "After you play a card" — both copies arrived during this play, so neither answers it.
    expect(ofType(s.lastEvents, "shuffledIn")).toEqual([]);
    expect(s.pile("p1", "library")).toHaveLength(library);
  });

  it("R119 a Quickstriker a tributed Cube's Death copies at step 2 grants the card that paid the Tribute no Combo damage (R210)", () => {
    const s = scenario({
      p1: {
        hand: [CARNIVOROUS_CUBE, TEMPO_TIMMY, THE_ROCK],
        field: [{ def: MR_VANILLA, lane: 3 }],
        backrow: [QUICKSTRIKER],
        mana: 20,
        library: [...R119_LIBRARY],
      },
      p2: { hand: [STOCKPILE], field: [MIDRANGE_MENACE], library: [...R119_LIBRARY] },
    });
    const quickstriker = must(s.backrow("p1", 1), "p1's Quickstriker");
    s.play(CARNIVOROUS_CUBE, { zone: 1, targets: [{ pick: "instance", instanceId: quickstriker.id }] });
    const cube = must(s.unit("p1", 1), "p1's Carnivorous Cube");
    s.play(TEMPO_TIMMY, { zone: 2 });
    expect(quickstrikersOf(s, "p1")).toEqual([]);
    const rock = s.card(THE_ROCK);

    s.play(THE_ROCK, { zone: 4, tributes: [cube.id] });

    // Two Quickstrikers arrived at step 2; The Rock is the third card played this turn (X = 2).
    expect(quickstrikersOf(s, "p1")).toHaveLength(2);
    // R119: they start counting from the next play, so The Rock's step 5 deals no Combo damage.
    const hits = ofType(s.lastEvents, "damage").filter((hit) => hit.sourceId === rock.id && hit.targetId === "hero-p2");
    expect(hits).toEqual([]);
    s.expectHealth("p2", 30);
  });
});

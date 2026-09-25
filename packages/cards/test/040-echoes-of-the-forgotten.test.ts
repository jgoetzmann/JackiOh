// #40 Echoes of the Forgotten — SPEC §8.2 row 40, BUILD M4-T4 row 40: "Start of turn: damage =
// exile count, then bottom card exiled; empty library → no exile, no fatigue"; the Radiant face deals
// twice the exile count (R275 raised it from "+3").
// The damage it would deal now, its R280 `preview`, is proved in test/preview.test.ts.
//
// The rulings these tests are named after:
//   R72  "cards in exile" means YOUR OWN exile pile — never the opponent's and never the game-wide
//        `counters.exiled`;
//   R62  start-of-turn triggers run before the draw, so the bottom card this exiles is gone before
//        the top card is drawn;
//   R63  a hit of 0 is not a damage instance: an empty exile pile emits no `damage` event at all,
//        on either face (twice 0 is 0);
//   §2.4/R3  fatigue belongs to the DRAW. "Empty library → no fatigue" means this card's exile
//        clause adds none, so a turn that starts on an empty library shows exactly ONE fatigue
//        instance (the draw's, FATIGUE_DAMAGE(1) = 1) and not two.
//
// Every test drives the hook with `startTurn()`, which is the engine's own start of turn for the
// player who is active now: turn counter, mana, delayed effects, start-of-turn triggers, one draw.

import { describe, expect, it } from "vitest";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const ECHOES = "core-040"; // Field Spell, 2
const MENACE = "core-019"; // library filler — not cast-on-draw, so a draw is just a draw
const TIMMY = "core-011";
const POSTDOC = "core-061";
const BIG_D = "core-001";
const STOCKPILE = "core-005";

/** `library[0]` is the top, so the LAST entry is the bottom card this card exiles. */
const LIBRARY = [MENACE, TIMMY, POSTDOC] as const;

/** Three cards in p1's exile, so the base face deals 3 and the radiant face 6. */
const EXILE_THREE = [STOCKPILE, TIMMY, MENACE] as const;

function damageTo(s: Scenario, targetId: string): number[] {
  return s.events
    .flatMap((event) => (event.type === "damage" ? [event] : []))
    .filter((event) => event.targetId === targetId)
    .map((event) => event.amount);
}

function defsIn(s: Scenario, player: PlayerId, zone: "exile" | "library" | "hand"): string[] {
  return s.pile(player, zone).map((card) => card.defId);
}

function exiledEvents(s: Scenario): string[] {
  return s.events.flatMap((event) => (event.type === "exiled" ? [event.defId] : []));
}

describe("#40 Echoes of the Forgotten — base", () => {
  it("deals damage to the enemy hero equal to your exile count, then exiles the bottom card", () => {
    const s = scenario({
      p1: { backrow: [ECHOES], exile: [...EXILE_THREE], library: [...LIBRARY] },
      p2: {},
    });

    s.startTurn();

    s.expectHealth("p2", 27);
    expect(damageTo(s, "hero-p2")).toEqual([3]);
    // The bottom card (#61) left the library for the exile pile; the top card (#19) was drawn.
    expect(defsIn(s, "p1", "exile")).toEqual([STOCKPILE, TIMMY, MENACE, POSTDOC]);
    expect(defsIn(s, "p1", "library")).toEqual([TIMMY]);
    expect(exiledEvents(s)).toEqual([POSTDOC]);
  });

  it("the count is read BEFORE the new card enters exile, so an empty pile deals nothing (R63)", () => {
    const s = scenario({
      p1: { backrow: [ECHOES], library: [...LIBRARY] },
      p2: {},
    });

    s.startTurn();

    // The card this turn exiles brings the pile to 1, and yet the hit was 0: the order is the rule.
    expect(damageTo(s, "hero-p2")).toEqual([]);
    s.expectHealth("p2", 30);
    expect(defsIn(s, "p1", "exile")).toEqual([POSTDOC]);
  });

  it("the exile this turn pays out next turn: 0 damage, then 1", () => {
    const s = scenario({
      p1: { backrow: [ECHOES], hand: [STOCKPILE, TIMMY], library: [MENACE, TIMMY, POSTDOC, BIG_D] },
      p2: { hand: [STOCKPILE, TIMMY], library: [MENACE, TIMMY] },
    });

    s.startTurn(); // exile 0 → no damage; #1 (the bottom) is exiled
    s.expectHealth("p2", 30);

    s.endTurn(); // p2's turn starts
    s.endTurn(); // back to p1: exile 1 → 1 damage, and #61 (the new bottom) is exiled

    s.expectHealth("p2", 29);
    expect(defsIn(s, "p1", "exile")).toEqual([BIG_D, POSTDOC]);
  });

  it("R72 it counts your own exile pile, not the opponent's", () => {
    const s = scenario({
      p1: { backrow: [ECHOES], exile: [STOCKPILE], library: [...LIBRARY] },
      p2: { exile: [STOCKPILE, TIMMY, MENACE, POSTDOC, BIG_D] },
    });

    s.startTurn();

    s.expectHealth("p2", 29); // 1, your own pile — not 5 and not 6
    expect(damageTo(s, "hero-p2")).toEqual([1]);
  });

  it("§8.2 an empty library exiles nothing and adds no fatigue of its own", () => {
    const s = scenario({
      p1: { backrow: [ECHOES], exile: [STOCKPILE, TIMMY] },
      p2: {},
    });

    s.startTurn();

    s.expectHealth("p2", 28);
    expect(exiledEvents(s)).toEqual([]);
    expect(s.pile("p1", "exile")).toHaveLength(2);
    // §2.4/R3: the turn's own draw fatigues for FATIGUE_DAMAGE(1) = 1 and nothing else does, so a
    // second fatigue instance from this card's exile clause would show as 30 − 1 − 2 = 27.
    s.expectHealth("p1", 29);
    expect(damageTo(s, "hero-p1")).toEqual([1]);
  });

  it("§6.2 'start of YOUR turn': the opponent's turn start does not fire it", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [ECHOES], exile: [...EXILE_THREE], library: [...LIBRARY] },
      p2: { library: [MENACE, TIMMY] },
    });

    s.startTurn(); // p2's turn

    s.expectHealth("p2", 30);
    s.expectHealth("p1", 30);
    expect(s.pile("p1", "exile")).toHaveLength(3);
    expect(defsIn(s, "p1", "library")).toEqual([...LIBRARY]);
  });

  it("it stays on the board and fires again every one of your turns", () => {
    const s = scenario({
      p1: { backrow: [ECHOES], exile: [...EXILE_THREE], hand: [STOCKPILE, TIMMY], library: [MENACE, TIMMY, POSTDOC, BIG_D] },
      p2: { hand: [STOCKPILE, TIMMY], library: [MENACE, TIMMY] },
    });

    s.startTurn(); // 3 in exile → 3 damage, pile becomes 4
    s.endTurn();
    s.endTurn(); // 4 in exile → 4 damage

    s.expectHealth("p2", 23);
    expect(damageTo(s, "hero-p2")).toEqual([3, 4]);
    s.expectInZone(ECHOES, "field");
  });
});

describe("#40 Echoes of the Forgotten — radiant", () => {
  it("'twice the cards in your exile': three exiled cards deal 6", () => {
    const s = scenario({
      p1: { backrow: [{ def: ECHOES, radiant: true }], exile: [...EXILE_THREE], library: [...LIBRARY] },
      p2: {},
    });

    s.startTurn();

    s.expectHealth("p2", 24); // 2 × 3
    expect(damageTo(s, "hero-p2")).toEqual([6]);
  });

  it("R63 an empty exile pile deals nothing on the radiant face either: twice 0 is 0", () => {
    const s = scenario({
      p1: { backrow: [{ def: ECHOES, radiant: true }], library: [...LIBRARY] },
      p2: {},
    });

    s.startTurn();

    s.expectHealth("p2", 30);
    expect(damageTo(s, "hero-p2")).toEqual([]);
    // The exile clause still runs, so next turn pays out 2.
    expect(defsIn(s, "p1", "exile")).toEqual([POSTDOC]);
  });

  it("the radiant face changes only the multiple, so the bottom card is still exiled", () => {
    const s = scenario({
      p1: { backrow: [{ def: ECHOES, radiant: true }], exile: [STOCKPILE], library: [...LIBRARY] },
      p2: {},
    });

    s.startTurn();

    s.expectHealth("p2", 28); // 2 × 1
    expect(defsIn(s, "p1", "exile")).toEqual([STOCKPILE, POSTDOC]);
    expect(exiledEvents(s)).toEqual([POSTDOC]);
  });

  it("the exile this turn pays out twice next turn: 0 damage, then 2", () => {
    const s = scenario({
      p1: {
        backrow: [{ def: ECHOES, radiant: true }],
        hand: [STOCKPILE, TIMMY],
        library: [MENACE, TIMMY, POSTDOC, BIG_D],
      },
      p2: { hand: [STOCKPILE, TIMMY], library: [MENACE, TIMMY] },
    });

    s.startTurn();
    s.expectHealth("p2", 30);

    s.endTurn();
    s.endTurn();

    s.expectHealth("p2", 28);
    expect(damageTo(s, "hero-p2")).toEqual([2]);
  });

  it("R72 the radiant face counts your own pile too", () => {
    const s = scenario({
      p1: { backrow: [{ def: ECHOES, radiant: true }], exile: [STOCKPILE], library: [...LIBRARY] },
      p2: { exile: [STOCKPILE, TIMMY, MENACE] },
    });

    s.startTurn();

    s.expectHealth("p2", 28); // 2 × 1, not 2 × 3 or 2 × 4
  });

  it("§8.2 an empty library still exiles nothing on the radiant face", () => {
    const s = scenario({
      p1: { backrow: [{ def: ECHOES, radiant: true }], exile: [STOCKPILE, TIMMY] },
      p2: {},
    });

    s.startTurn();

    s.expectHealth("p2", 26); // 2 × 2
    expect(exiledEvents(s)).toEqual([]);
    expect(s.pile("p1", "exile")).toHaveLength(2);
    s.expectHealth("p1", 29);
  });
});

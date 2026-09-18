// #39 Recycling Initiative — SPEC §8.2 row 39, BUILD M4-T4 row 39: "Exiled on play; end of turn
// adds copies of every other card played this turn, including later ones (R71); radiant copies
// cost 1 less".
//
// The rulings these tests are named after:
//   R71  the log is read at END of turn, so cards played AFTER this one are copied too;
//   R62  end-of-turn triggers → the trap window → delayed effects → cleanup, so the copies arrive
//        after a `turnEnded` trap has fired and before the next turn starts. `turnEnded` itself is
//        emitted BEFORE the window (`turn.ts`), so it is no use as a "just before cleanup" marker:
//        `turnStarted` is the first event after cleanup and that is what these tests key on;
//   R86  an id in `turnLog.playedIds` whose instance has ceased to exist is skipped, not fizzled on;
//   R57  a copy is a fresh instance carrying the radiant flag and nothing else;
//   R65  radiant's "costs 1 less" is a `costMod`, so the copy's price is what `effectiveCost`
//        reports to the client in `viewFor` and what the player actually pays.

import { describe, expect, it } from "vitest";
import type { GameEvent, PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const RECYCLING = "core-039"; // Spell, 0
const TIMMY = "core-011"; // Unit, 1 — 3/3 Rush, First Strike, no Cry
const MR_TOKEN = "core-015"; // Unit, 1 — Cry: summon a Rush Token
const BIG_D = "core-001"; // Unit, 2 — 0/8, an aura and no Cry: nothing to fire on a replay
const BREAD = "core-018"; // Field Trap, 1 — fires in the end-of-turn trap window (R62)
const FELINORS = "core-012"; // Unit, 2 — 3/4, the body that kills a Rush Token on the strike-back
const RUSH_TOKEN = "core-t-rush"; // the unit-token CARD, playable from a hand (#75), 3/3 Rush
const STOCKPILE = "core-005"; // Spell, 1 — the spare card that keeps a turn meaningful (§2.5)
const MENACE = "core-019"; // library filler
const POSTDOC = "core-061"; // library filler

/** Both sides keep a card in hand and cards in the library, so no turn auto-ends (§2.5, R82). */
const SPARE = { hand: [STOCKPILE, TIMMY], library: [MENACE, POSTDOC] } as const;

function defsIn(s: Scenario, player: PlayerId, zone: "hand" | "graveyard" | "exile"): string[] {
  return s.pile(player, zone).map((card) => card.defId);
}

function countIn(s: Scenario, player: PlayerId, zone: "hand" | "graveyard" | "exile", defId: string): number {
  return defsIn(s, player, zone).filter((id) => id === defId).length;
}

/** The index in the cumulative log of the first event matching, or -1. */
function indexOf(s: Scenario, match: (event: GameEvent) => boolean): number {
  return s.events.findIndex(match);
}

function addedToHandOf(player: PlayerId, defId: string) {
  return (event: GameEvent): boolean =>
    event.type === "addedToHand" && event.player === player && event.defId === defId;
}

/** What the client is told a hand card costs (§10.8): `effectiveCost`, so R65's `costMod` is in it. */
function viewCost(s: Scenario, player: PlayerId, instanceId: string): number {
  const hand = s.view(player).you.hand;
  if (!Array.isArray(hand)) throw new Error("viewCost: the viewer's own hand should be cards, not a count");
  const card = hand.find((entry) => entry.instanceId === instanceId);
  if (card === undefined) throw new Error(`viewCost: ${instanceId} is not in ${player}'s hand view`);
  return card.cost;
}

describe("#39 Recycling Initiative — base", () => {
  it("§8.2 'Exile this on play': the spell goes to exile, never to the graveyard", () => {
    const s = scenario({
      p1: { hand: [RECYCLING, TIMMY], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });
    const spell = s.hand("p1")[0]!;

    s.play(spell);

    s.expectInZone(spell, "exile").expectEvents("cardPlayed", "exiled");
    expect(defsIn(s, "p1", "graveyard")).toEqual([]);
  });

  it("R71 at end of turn it copies every other card played this turn, including one played after it", () => {
    const s = scenario({
      p1: { hand: [TIMMY, RECYCLING, MR_TOKEN, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(TIMMY, { zone: 1 });
    s.play(RECYCLING);
    s.play(MR_TOKEN, { zone: 2 }); // played AFTER the spell, and still copied (R71)
    s.endTurn();

    // The originals are on the field, so a copy is the only way either def reaches the hand.
    expect(countIn(s, "p1", "hand", TIMMY)).toBe(1);
    expect(countIn(s, "p1", "hand", MR_TOKEN)).toBe(1);
  });

  it("§8.2 'every OTHER card': it never copies itself", () => {
    const s = scenario({
      p1: { hand: [TIMMY, RECYCLING, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(TIMMY, { zone: 1 });
    s.play(RECYCLING);
    s.endTurn();

    expect(countIn(s, "p1", "hand", RECYCLING)).toBe(0);
    expect(countIn(s, "p1", "hand", TIMMY)).toBe(1);
  });

  it("R57 the copy is a fresh instance, so the original stays where it is", () => {
    const s = scenario({
      p1: { hand: [TIMMY, RECYCLING, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(TIMMY, { zone: 1 });
    const original = s.unit("p1", 1)!;
    s.play(RECYCLING);
    s.endTurn();

    s.expectInZone(original, "field");
    const copy = s.pile("p1", "hand").find((card) => card.defId === TIMMY);
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe(original.id);
    expect(copy!.radiant).toBe(false);
  });

  it("R62 the copies arrive during the turn that ends, before the next turn starts", () => {
    const s = scenario({
      p1: { hand: [TIMMY, RECYCLING, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(TIMMY, { zone: 1 });
    s.play(RECYCLING);
    s.endTurn();

    const copied = indexOf(s, addedToHandOf("p1", TIMMY));
    const nextTurn = indexOf(s, (event) => event.type === "turnStarted");
    expect(copied).toBeGreaterThanOrEqual(0);
    expect(nextTurn).toBeGreaterThanOrEqual(0);
    // `turnStarted` is the first event after cleanup, so this pins the delayed effect inside the
    // ending turn rather than at the head of the next one.
    expect(copied).toBeLessThan(nextTurn);
  });

  it("R62 the end-of-turn trap window fires first, then this delayed effect", () => {
    const s = scenario({
      p1: { hand: [TIMMY, RECYCLING, STOCKPILE], backrow: [BREAD], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(TIMMY, { zone: 1 }); // 1 of 4 mana, so the turn ends with 3 unspent for #18 to read
    s.play(RECYCLING);
    s.endTurn();

    const fired = indexOf(s, (event) => event.type === "trapFired");
    const copied = indexOf(s, addedToHandOf("p1", TIMMY));
    expect(fired).toBeGreaterThanOrEqual(0);
    expect(copied).toBeGreaterThanOrEqual(0);
    expect(fired).toBeLessThan(copied);
  });

  it("R86 an instance that has ceased to exist is skipped, and the rest of the pool still arrives", () => {
    const s = scenario({
      p1: { hand: [RUSH_TOKEN, TIMMY, RECYCLING, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { field: [FELINORS], ...SPARE },
    });

    s.play(RUSH_TOKEN, { zone: 1 }); // a unit-token card played from hand (§5, #75)
    s.play(TIMMY, { zone: 2 });
    s.play(RECYCLING);

    const token = s.unit("p1", 1)!;
    // Rush lets it attack a unit the turn it arrives; the 3/4 body kills it on the strike-back, and
    // R11 makes a unit token that leaves the field cease to exist.
    s.attack(token, s.unit("p2", 1)!);
    s.expectInZone(token, "gone");

    s.endTurn();

    expect(countIn(s, "p1", "hand", RUSH_TOKEN)).toBe(0);
    expect(countIn(s, "p1", "hand", TIMMY)).toBe(1);
  });

  it("the base face gives no discount: the copy costs the printed price", () => {
    const s = scenario({
      p1: { hand: [BIG_D, RECYCLING, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(BIG_D, { zone: 1 }); // #1 Big D-fender, printed cost 2
    s.play(RECYCLING);
    s.endTurn();

    const copy = s.pile("p1", "hand").find((card) => card.defId === BIG_D)!;
    expect(copy.costMod).toBe(0);
    expect(viewCost(s, "p1", copy.id)).toBe(2);
  });
});

describe("#39 Recycling Initiative — radiant", () => {
  it("§8 Conventions: the radiant cell restates only the price, so it is still exiled on play", () => {
    const s = scenario({
      p1: { hand: [{ def: RECYCLING, radiant: true }, TIMMY], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });
    const spell = s.hand("p1")[0]!;

    s.play(spell);

    s.expectInZone(spell, "exile");
    expect(defsIn(s, "p1", "graveyard")).toEqual([]);
  });

  it("§8 Conventions: it still copies every other card played this turn", () => {
    const s = scenario({
      p1: { hand: [TIMMY, { def: RECYCLING, radiant: true }, MR_TOKEN, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(TIMMY, { zone: 1 });
    s.play(RECYCLING);
    s.play(MR_TOKEN, { zone: 2 });
    s.endTurn();

    expect(countIn(s, "p1", "hand", TIMMY)).toBe(1);
    expect(countIn(s, "p1", "hand", MR_TOKEN)).toBe(1);
    expect(countIn(s, "p1", "hand", RECYCLING)).toBe(0);
  });

  it("R65 'Copies cost 1 less' is a costMod, so the copy is offered at one less than its price", () => {
    const s = scenario({
      p1: { hand: [BIG_D, { def: RECYCLING, radiant: true }, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(BIG_D, { zone: 1 }); // printed cost 2
    s.play(RECYCLING);
    s.endTurn();

    const copy = s.pile("p1", "hand").find((card) => card.defId === BIG_D)!;
    expect(copy.costMod).toBe(-1);
    expect(viewCost(s, "p1", copy.id)).toBe(1);
  });

  it("R65 the discount is what the player actually pays on a later turn", () => {
    const s = scenario({
      p1: { hand: [BIG_D, { def: RECYCLING, radiant: true }, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(BIG_D, { zone: 1 });
    s.play(RECYCLING);
    s.endTurn(); // p1's copies arrive; p2's turn starts
    const copy = s.pile("p1", "hand").find((card) => card.defId === BIG_D)!;
    s.endTurn(); // p2 ends; p1's turn starts, mana back to MAX_MANA 4

    s.expectMana("p1", 4);
    s.play(copy, { zone: 2 });
    s.expectMana("p1", 3); // 2 printed − 1 = 1 paid (R65, R78: the costMod survived the zone change)
  });

  it("R57 the copy of a Radiant card is Radiant, and the flag is all it carries", () => {
    const s = scenario({
      p1: { hand: [{ def: BIG_D, radiant: true }, { def: RECYCLING, radiant: true }, STOCKPILE], library: [MENACE, POSTDOC] },
      p2: { ...SPARE },
    });

    s.play(BIG_D, { zone: 1 });
    s.play(RECYCLING);
    s.endTurn();

    const copy = s.pile("p1", "hand").find((card) => card.defId === BIG_D)!;
    expect(copy.radiant).toBe(true);
    expect(copy.damage).toBe(0);
    expect(copy.buffs).toEqual({ attack: 0, health: 0 });
  });
});

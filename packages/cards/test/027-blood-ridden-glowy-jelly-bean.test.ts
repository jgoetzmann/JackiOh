// #27 Blood Ridden Glowy Jelly Bean (SPEC §8.2, BUILD M4-T4 row 27): "Cast on draw; a random
// non-Radiant hand card becomes Radiant (R60); 5 health lost ignoring Going Long (R18); radiant
// 2 cards".

import { describe, expect, it } from "vitest";
import type { GameState } from "@jackioh/engine";
import { scenario } from "./_harness";
import type { PileSetup } from "./_harness";

const SEED = "core-027";

/** The hand cards the random pick reached. R60 narrows the pool to the non-Radiant ones. */
function radiantHand(state: GameState): string[] {
  return state.players.p1.hand.filter((card) => card.radiant).map((card) => card.id);
}

/**
 * A game whose next draw is the Blood Ridden Glowy Jelly Bean. `library[0]` is the top, so one
 * `startTurn()` draws exactly this card, which casts itself (§2.4). #5 Stockpile sits under it as
 * the card R58's repeated draw brings up.
 */
function drawing(hand: PileSetup[], opts: { radiant?: boolean; armor?: number } = {}) {
  return scenario({
    seed: SEED,
    p1: {
      hand,
      library: [{ def: "core-027", radiant: opts.radiant === true }, "core-005"],
      health: 30,
      ...(opts.armor === undefined ? {} : { armor: opts.armor }),
    },
  });
}

describe("#27 Blood Ridden Glowy Jelly Bean — base", () => {
  it("R40/R70 casts itself on the draw, free, counted as a play, and never enters the hand", () => {
    const s = drawing(["core-005", "core-016"]);

    s.startTurn();

    s.expectInZone("core-027", "graveyard");
    expect(s.state.players.p1.hand.map((card) => card.defId)).not.toContain("core-027");
    // R70: a cast is free and counts as a play — which is what feeds Combo (R40).
    const played = s.lastEvents.filter((event) => event.type === "cardPlayed");
    expect(played).toHaveLength(1);
    expect(played[0]).toMatchObject({ defId: "core-027", costPaid: 0 });
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
    // R58: the draw repeats after the cast, so the card under it reaches the hand.
    expect(s.state.players.p1.hand.filter((card) => card.defId === "core-005")).toHaveLength(2);
  });

  it("R60 flags exactly one random non-Radiant hand card, the same one on the same seed", () => {
    const first = drawing(["core-005", "core-016", "core-010"]).startTurn();
    const flagged = radiantHand(first.state);
    expect(flagged).toHaveLength(1);

    // §9.3: (seed, cursor) reproduces the draw, so the same setup flags the same card.
    const second = drawing(["core-005", "core-016", "core-010"]).startTurn();
    expect(radiantHand(second.state)).toEqual(flagged);
  });

  it("R60 never picks a card that is already Radiant, and does nothing when none are left", () => {
    const s = drawing([
      { def: "core-005", radiant: true },
      { def: "core-016", radiant: true },
    ]);
    const already = s.state.players.p1.hand.map((card) => card.id);

    s.startTurn();

    // The pool was empty at resolution, so nothing was flagged and no event fired; the card R58's
    // repeated draw brings up arrives afterwards and is untouched.
    for (const id of already) expect(s.card(id).radiant).toBe(true);
    expect(s.lastEvents.filter((event) => event.type === "radiantSet")).toHaveLength(0);
    expect(radiantHand(s.state).sort()).toEqual([...already].sort());
  });

  it("R18 loses 5 health: not damage, so Armor pays nothing and is left untouched", () => {
    const s = drawing(["core-005"], { armor: 2 });

    s.startTurn();

    s.expectHealth("p1", 25);
    expect(s.state.players.p1.hero.armor).toBe(2);
    expect(s.lastEvents.filter((event) => event.type === "healthLost")).toMatchObject([
      { player: "p1", amount: 5 },
    ]);
    // R18: "lose health" never goes through §4.4, so there is no damage instance to cap or absorb.
    expect(s.lastEvents.filter((event) => event.type === "damage")).toHaveLength(0);
  });
});

describe("#27 Blood Ridden Glowy Jelly Bean — radiant", () => {
  it("flags 2 different random cards, and still loses 5 health (§8 keeps the clause it does not restate)", () => {
    const s = drawing(["core-005", "core-016", "core-010"], { radiant: true });

    s.startTurn();

    const flagged = radiantHand(s.state);
    expect(flagged).toHaveLength(2);
    expect(new Set(flagged).size).toBe(2);
    s.expectHealth("p1", 25);
  });

  it("R60 takes all of them when the hand holds fewer than 2 non-Radiant cards", () => {
    const s = drawing(["core-016"], { radiant: true });

    s.startTurn();

    expect(radiantHand(s.state)).toHaveLength(1);
    s.expectHealth("p1", 25);
  });

  it("keeps Cast on draw on the radiant face, so a Radiant copy is still cast from the library", () => {
    const s = drawing(["core-016"], { radiant: true });

    s.startTurn();

    s.expectInZone("core-027", "graveyard");
    expect(s.state.players.p1.hand.map((card) => card.defId)).not.toContain("core-027");
  });
});

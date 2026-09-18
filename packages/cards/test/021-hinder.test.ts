// #21 Hinder — SPEC §8.2, BUILD M4-T4 row 21: "Auto-casts on draw and draws again; opponent's next
// refresh −1 floored at 0; counts as played (R40, R70); radiant −2".
//
// The harness default board is turn 9 with p1 active, so both sides sit at MAX_MANA (4/4) and the
// refresh Hinder lowers is a concrete number: 4 − 1 = 3 base, 4 − 2 = 2 radiant. The floor needs a
// refresh smaller than 2, which only the opening turns have, so that fixture starts at turn 1 and
// uses `startTurn()` to take p1's draw before p2 has ever refreshed: p2's first refresh is 1, and
// 1 − 2 floors at 0 rather than going negative (§2.3 `maxManaFor`).
//
// Both sides keep a unit on the board and a card in hand throughout, or the engine's "nothing
// meaningful left" rule would auto-end turns the fixture means to take (harness header).

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";
import { base, radiant } from "../src/scripts/021-hinder";

const HINDER = "core-021";
/** Tempo Timmy: drawn into a hand it does nothing, and on the board it keeps the turn alive. */
const CONTROL = "core-011";
const P1_FILLER = "core-016"; // Hit Job, a spell with no hand trigger.
const P2_FILLER = "core-005"; // Stockpile, likewise.

function hinderOnTop(seed: string, isRadiant: boolean, turn?: number): Scenario {
  return scenario({
    seed,
    ...(turn === undefined ? {} : { turn }),
    p1: {
      hand: [P1_FILLER],
      field: [CONTROL],
      library: [{ def: HINDER, radiant: isRadiant }, CONTROL, CONTROL, CONTROL],
    },
    p2: { hand: [P2_FILLER], field: [CONTROL], library: [P2_FILLER, P2_FILLER, P2_FILLER] },
  });
}

describe("#21 Hinder", () => {
  describe("base", () => {
    it("R58, R70 casts itself on draw, draws again, and never reaches the hand", () => {
      const s = hinderOnTop("hinder-cast", false);
      s.endTurn(); // p2's turn.
      s.endTurn(); // p1's turn: the draw that casts Hinder.

      // R58: the cast-on-draw card is cast, the draw repeats and the next card goes to the hand.
      expect(s.hand("p1").map((card) => card.defId)).not.toContain(HINDER);
      expect(s.hand("p1").filter((card) => card.defId === CONTROL)).toHaveLength(1);
      // §5.1: a Spell that has resolved is in the graveyard.
      s.expectInZone(HINDER, "graveyard");
      s.expectEvents("drawn", "cardPlayed", "drawn");
    });

    it("R40, R70 counts as a card played this turn, at cost 0", () => {
      const s = hinderOnTop("hinder-played", false);
      s.endTurn();
      s.endTurn();

      const played = s.events.filter((event) => event.type === "cardPlayed" && event.defId === HINDER);
      expect(played).toHaveLength(1);
      expect(played[0]).toMatchObject({ player: "p1", costPaid: 0 });
      // R40: the cast is in the turn log every Combo card counts.
      expect(s.state.players.p1.turnLog.playedIds).toContain(s.card(HINDER).id);
    });

    it("the opponent's next mana refresh is 1 lower", () => {
      const s = hinderOnTop("hinder-refresh", false);
      s.endTurn();
      s.endTurn(); // Hinder resolves here.
      s.endTurn(); // p2's turn: the lowered refresh.

      expect(s.state.active).toBe("p2");
      s.expectMana("p2", 3);
      expect(s.view("p2").you.mana.max).toBe(3);
    });

    it("the modifier is one-shot: the refresh after that is back to 4 (§2.3)", () => {
      const s = hinderOnTop("hinder-oneshot", false);
      s.endTurn();
      s.endTurn();
      s.endTurn(); // p2's lowered refresh.
      s.expectMana("p2", 3);
      s.endTurn(); // p1.
      s.endTurn(); // p2 again, with nothing owed.

      s.expectMana("p2", 4);
      expect(s.state.players.p2.mana.nextTurnMod).toBe(0);
    });
  });

  describe("radiant", () => {
    it("the opponent's next mana refresh is 2 lower", () => {
      const s = hinderOnTop("hinder-radiant", true);
      s.endTurn();
      s.endTurn();
      s.endTurn();

      s.expectMana("p2", 2);
      expect(s.view("p2").you.mana.max).toBe(2);
    });

    it("still casts itself on draw and draws again", () => {
      const s = hinderOnTop("hinder-radiant-cast", true);
      s.endTurn();
      s.endTurn();

      expect(s.hand("p1").map((card) => card.defId)).not.toContain(HINDER);
      s.expectInZone(HINDER, "graveyard");
      s.expectEvents("drawn", "cardPlayed", "drawn");
    });

    it("§2.3 the refresh floors at 0 rather than going negative", () => {
      // Turn 1: p2 has started no turn yet, so their first refresh is 1 and −2 would be −1.
      const s = hinderOnTop("hinder-floor", true, 1);
      s.startTurn(); // p1's draw, which casts Hinder; the turn does not change hands.
      expect(s.state.players.p2.mana.nextTurnMod).toBe(-2);

      s.endTurn(); // p2's first turn: the refresh.
      expect(s.state.active).toBe("p2");
      s.expectMana("p2", 0);
      expect(s.view("p2").you.mana.max).toBe(0);
    });
  });

  it("both faces are Cast on draw and declare nothing else (§8.2 Engine)", () => {
    expect(base.staticFlags?.castOnDraw).toBe(true);
    expect(radiant.staticFlags?.castOnDraw).toBe(true);
    // The repeat draw and the 0 floor belong to `drawOne` and `maxManaFor`, not to this card.
    expect(base.targets).toBeUndefined();
    expect(base.modes).toBeUndefined();
    expect(radiant.targets).toBeUndefined();
  });
});

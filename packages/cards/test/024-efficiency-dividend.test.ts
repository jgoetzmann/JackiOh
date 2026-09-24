// #24 Efficiency Dividend — SPEC §8.2, BUILD M4-T4 row 24: "X chosen with the play, bounded by
// mana (R81); three modes; next-turn mana +floor(X/2); returns to hand; radiant uses X+1".
//
// R81: X, the mode and the target all travel in the `play` action, so no fixture answers a prompt —
// there is none, and `state.pending` is asserted to stay null.
//
// The harness default board is turn 9, so p1 has 4 mana and their next refresh is MAX_MANA 4; a
// positive `mana.nextTurnMod` shows up as current mana above that, while max mana stays 4: §2.3 lists
// Efficiency Dividend as temporary mana, which "adds to current mana and can exceed 4", and max mana
// is min(turns, 4) plus persistent modifiers only. Both sides keep a unit and a card in hand so no
// turn auto-ends.

import { describe, expect, it } from "vitest";
import { MAX_MANA } from "@jackioh/engine";
import { scenario, type Scenario } from "./_harness";
import { base, radiant } from "../src/scripts/024-efficiency-dividend";

const DIVIDEND = "core-024"; // X-cost Spell.
const TIMMY = "core-011"; // 3/3, the unit target.
const FILLER = "core-005";

function dividendIn(seed: string, isRadiant: boolean, health?: number): Scenario {
  return scenario({
    seed,
    p1: {
      hand: [{ def: DIVIDEND, radiant: isRadiant }, FILLER],
      field: [TIMMY],
      ...(health === undefined ? {} : { health }),
    },
    p2: { hand: [FILLER], field: ["core-008"] },
  });
}

/** p1's mana at their next refresh, two turn hand-overs away; max mana is untouched (§2.3). */
function nextRefresh(s: Scenario): number {
  s.endTurn(); // p2's turn.
  s.endTurn(); // p1's turn: the refresh.
  expect(s.state.players.p1.mana.max).toBe(MAX_MANA);
  return s.state.players.p1.mana.current;
}

describe("#24 Efficiency Dividend", () => {
  it("R81 declares three modes and the damage and heal modes' target, both read off the play", () => {
    expect(base.modes).toEqual([{ kind: "mode", options: ["damage", "heal", "mana"] }]);
    const decl = base.targets?.[0];
    expect(base.targets).toHaveLength(1);
    expect(decl?.kind).toBe("target");
    // The target belongs to the damage and heal modes, which must name one (§8 Conventions: a hero
    // is always a legal target); the mana mode names none (R90).
    expect(decl?.forModes).toEqual(["damage", "heal"]);
    expect(decl?.min).toBe(1);
    expect(decl?.max).toBe(1);
    expect(decl?.filter?.side).toBe("any");
    expect(decl?.filter?.of).toEqual(["unit", "hero"]);
    // "Uses X+1" restates the arithmetic only, so both declarations are kept (§8 Conventions).
    expect(radiant.modes).toEqual(base.modes);
    expect(radiant.targets).toEqual(base.targets);
  });

  describe("base", () => {
    it("R65, R81 X travels with the play, bounded by current mana, and costs exactly X", () => {
      const s = dividendIn("dividend-x", false);
      // §2.3: 0 ≤ X ≤ current mana, so X = 5 on 4 mana is refused.
      expect(() =>
        s.play(DIVIDEND, { x: 5, modes: ["damage"], targets: [{ pick: "hero", player: "p2" }] }),
      ).toThrow(/mana/);

      s.play(DIVIDEND, { x: 3, modes: ["damage"], targets: [{ pick: "hero", player: "p2" }] });

      s.expectMana("p1", 1);
      expect(s.state.pending).toBeNull();
    });

    it("the damage mode deals X damage to the chosen hero", () => {
      const s = dividendIn("dividend-damage", false);
      s.play(DIVIDEND, { x: 3, modes: ["damage"], targets: [{ pick: "hero", player: "p2" }] });

      s.expectHealth("p2", 27);
    });

    it("the damage mode can pick a unit instead (§8 Conventions: any unit or hero)", () => {
      const s = dividendIn("dividend-damage-unit", false);
      const timmy = s.card(TIMMY);
      s.play(DIVIDEND, { x: 2, modes: ["damage"], targets: [{ pick: "instance", instanceId: timmy.id }] });

      s.expectStats(timmy, { health: 1, maxHealth: 3 });
    });

    it("R19 the heal mode heals the chosen target 2X", () => {
      const s = dividendIn("dividend-heal", false, 20);
      s.play(DIVIDEND, { x: 2, modes: ["heal"], targets: [{ pick: "hero", player: "p1" }] });

      // §3: a hero has no maximum health, so the heal is a flat 2X.
      s.expectHealth("p1", 24);
    });

    it("the mana mode gains floor(X/2) mana next turn (§2.3)", () => {
      const s = dividendIn("dividend-mana", false);
      s.play(DIVIDEND, { x: 3, modes: ["mana"] });

      expect(s.state.players.p1.mana.nextTurnMod).toBe(1);
      expect(nextRefresh(s)).toBe(5);
      s.expectMana("p1", 5);
    });

    it("the mana mode rounds down, so X = 1 gains nothing", () => {
      const s = dividendIn("dividend-mana-odd", false);
      s.play(DIVIDEND, { x: 1, modes: ["mana"] });

      expect(s.state.players.p1.mana.nextTurnMod).toBe(0);
      expect(nextRefresh(s)).toBe(4);
    });

    it("§5.1, R68 at the end of the turn it returns to your hand", () => {
      const s = dividendIn("dividend-return", false);
      s.play(DIVIDEND, { x: 2, modes: ["damage"], targets: [{ pick: "hero", player: "p2" }] });
      const spell = s.card(DIVIDEND);
      s.expectInZone(spell, "graveyard");

      s.endTurn();

      s.expectInZone(spell, "hand");
    });
  });

  describe("radiant", () => {
    it("the damage mode uses X+1", () => {
      const s = dividendIn("dividend-radiant-damage", true);
      s.play(DIVIDEND, { x: 2, modes: ["damage"], targets: [{ pick: "hero", player: "p2" }] });

      // R65: X = 2 is what it cost; 3 is what it dealt.
      s.expectHealth("p2", 27);
      s.expectMana("p1", 2);
    });

    it("the heal mode heals 2(X+1)", () => {
      const s = dividendIn("dividend-radiant-heal", true, 20);
      s.play(DIVIDEND, { x: 2, modes: ["heal"], targets: [{ pick: "hero", player: "p1" }] });

      s.expectHealth("p1", 26);
    });

    it("the mana mode gains floor((X+1)/2)", () => {
      const s = dividendIn("dividend-radiant-mana", true);
      s.play(DIVIDEND, { x: 3, modes: ["mana"] });

      // floor(4/2) = 2, where the base face gains floor(3/2) = 1.
      expect(s.state.players.p1.mana.nextTurnMod).toBe(2);
      expect(nextRefresh(s)).toBe(6);
    });

    it("the return to hand is kept (§8 Conventions)", () => {
      const s = dividendIn("dividend-radiant-return", true);
      s.play(DIVIDEND, { x: 1, modes: ["damage"], targets: [{ pick: "hero", player: "p2" }] });
      const spell = s.card(DIVIDEND);

      s.endTurn();

      s.expectInZone(spell, "hand");
      expect(s.hand("p1").filter((card) => card.id === spell.id)[0]?.radiant).toBe(true);
    });
  });
});

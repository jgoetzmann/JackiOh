// SPEC §8.1 #4 Gary the Gambler. BUILD M4-T4 row 4: "Fixed seed → fixed stats; heads+tails = 5
// (radiant 7 at +2 each); Lucky has no effect (R32)".
//
// The flips land as ONE permanent layer-4 buff (§10.4), so `buffs.attack` is the heads total and
// `buffs.health` the tails total: the invariant the row asks for is that those two always account
// for exactly 5 flips (radiant 7) at the card's per-flip rate, whatever the seed rolled. The exact
// numbers under a fixed seed are asserted as determinism — the same seed twice gives the same
// stats — because the seeded values themselves only exist once `flipCoins` does (see the report:
// the verb is missing from the effects library, so this file cannot be green yet, and the literal
// heads/tails for seed "core-004-base" should be pinned here as soon as it lands).

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

/** The buff the Cry left, read back off the live instance (never off a captured one). */
function gains(s: Scenario, ref: string): { attack: number; health: number } {
  const gary = s.card(ref);
  return { attack: gary.buffs.attack, health: gary.buffs.health };
}

describe("#4 Gary the Gambler", () => {
  it("flips 5 coins: +1 attack per heads and +1 max health per tails, so the two gains total 5", () => {
    const s = scenario({ seed: "core-004-base", p1: { hand: ["core-004"] } });
    s.play("core-004");

    const { attack: heads, health: tails } = gains(s, "core-004");
    expect(heads + tails).toBe(5);
    expect(heads).toBeGreaterThanOrEqual(0);
    expect(tails).toBeGreaterThanOrEqual(0);
    // Base 1/1 plus the buff, read through the layers.
    s.expectStats("core-004", { attack: 1 + heads, maxHealth: 1 + tails });
  });

  it("a fixed seed gives fixed stats", () => {
    const first = scenario({ seed: "core-004-fixed", p1: { hand: ["core-004"] } });
    first.play("core-004");
    const second = scenario({ seed: "core-004-fixed", p1: { hand: ["core-004"] } });
    second.play("core-004");

    expect(gains(second, "core-004")).toEqual(gains(first, "core-004"));
  });

  it("radiant flips 7 coins at +2 a side, so the two gains total 14", () => {
    const s = scenario({
      seed: "core-004-radiant",
      p1: { hand: [{ def: "core-004", radiant: true }] },
    });
    s.play("core-004");

    const { attack, health } = gains(s, "core-004");
    expect(attack + health).toBe(14);
    expect(attack % 2).toBe(0);
    expect(health % 2).toBe(0);
    // Radiant 2/2 plus the buff.
    s.expectStats("core-004", { attack: 2 + attack, maxHealth: 2 + health });
  });

  it("R32 Lucky has no effect: 5 coins take exactly 5 seeded rolls, with no reroll for a best", () => {
    // Lucky is `rng.lucky(x, roll, better)` (rng.ts): it rolls x extra times and keeps the best, so
    // a Lucky flip would show up as extra draws on the cursor. No Core card can put Lucky on a unit
    // before its own Cry resolves, so counting the draws is what R32 is actually about: the flip
    // never asks for a reroll. The control play cancels whatever a play costs in draws by itself.
    const control = scenario({ seed: "core-004-r32", p1: { hand: ["core-008"] } });
    const controlBefore = control.state.rngCursor;
    control.play("core-008");
    const overhead = control.state.rngCursor - controlBefore;

    const s = scenario({ seed: "core-004-r32", p1: { hand: ["core-004"] } });
    const before = s.state.rngCursor;
    s.play("core-004");
    expect(s.state.rngCursor - before - overhead).toBe(5);
  });
});

// #64 Gifted Program — SPEC §8.3, §10.5 step 3, BUILD M4-T4 row 64.
//
// Must-pass: "First ≤1-cost card each turn is radiant before it resolves (its Cry uses radiant
// text); second is not; radiant threshold 2 (R56)."
//
// The whole card is its `giftedProgram` static flag, which `playSteps.ts` reads as §10.5 step 3:
// "the Gifted Program hook may set `radiant` now" (R213, R214). Nothing else on the card exists,
// which is what the first test pins down, and `backrow: [GIFTED]` is enough to arm it — the flag
// needs the card on the field, not a Cry.

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { PlayerId, Selection } from "@jackioh/shared";
import { base, radiant } from "../src/scripts/064-gifted-program";
import { scenario, type Scenario } from "./_harness";

const GIFTED = "core-064"; // Field Spell, 2
const FRIEND = "core-062"; // Spell, 1 — radiant adds +2/+2, so the face it ran is visible
const SURGERY = "core-063"; // Spell, 1 — +3/+3 base, +6/+6 radiant
const POINTMASTER = "core-020"; // Unit, 2 — 7/2 base, 14/4 radiant: the threshold probe
const TIMMY = "core-011"; // Unit, 3/3
const MENACE = "core-019"; // Unit, 9/9 — filler so a turn never auto-ends (§2.5, R82)
const FELINOR = "core-t-felinor";

function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const found = s.unit(player, lane);
  if (found === null) throw new Error(`expected a unit in ${player} lane ${lane}, found none`);
  return found;
}

function sel(card: CardInstance): Selection {
  return { pick: "instance", instanceId: card.id };
}

describe("#64 Gifted Program", () => {
  it("§10.5 step 3 both faces carry the pre-resolution threshold and nothing else", () => {
    // The card is its flag: it has no Cry, no trigger, no hook and no aura, so if step 3 did not read
    // `giftedProgram` the card would do nothing at all. The faces differ only in the threshold.
    expect(base.staticFlags).toEqual({ giftedProgram: 1 });
    expect(radiant.staticFlags).toEqual({ giftedProgram: 2 });
    expect(base.onPlayHook).toBeUndefined();
    expect(base.cry).toBeUndefined();
    expect(base.startOfTurn).toBeUndefined();
    expect(base.aura).toBeUndefined();
  });

  it("it enters the backrow and never makes its own play Radiant", () => {
    const s = scenario({ p1: { hand: [GIFTED], mana: 4 } });

    s.play(GIFTED);

    s.expectInZone(GIFTED, "field");
    // Step 3 runs before step 4 puts the card on the board, so it is not among its own hooks —
    // which matters for the radiant face, whose own cost of 2 is inside its own threshold.
    expect(s.card(GIFTED).radiant).toBe(false);
  });

  it("R56 a card the opponent plays is never made Radiant", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [GIFTED], field: [MENACE] },
      p2: { hand: [FRIEND], field: [TIMMY], mana: 4 },
    });
    const timmy = s.card(TIMMY);

    s.play(FRIEND);

    // "you play": p1's Gifted Program ignores p2's play, so p2's spell runs its base text and
    // p2's units are not buffed.
    s.expectStats(timmy, { attack: 3, maxHealth: 3 });
  });

  it("R56 the first card costing 1 or less becomes Radiant before it resolves", () => {
    const s = scenario({ p1: { backrow: [GIFTED], hand: [FRIEND], field: [TIMMY], mana: 4 } });
    const timmy = s.card(TIMMY);

    s.play(FRIEND);

    // §10.5 step 3 sets the flag before step 5 runs the script, so the RADIANT text is what ran:
    // "Then your units get +2/+2" on top of the fill.
    s.expectStats(timmy, { attack: 5, maxHealth: 5 });
    s.expectStats(unitAt(s, "p1", 2), { attack: 3, maxHealth: 3 });
  });

  it("R56 the second cheap card of the same turn is not made Radiant", () => {
    const s = scenario({
      p1: { backrow: [GIFTED], hand: [SURGERY, FRIEND], field: [TIMMY], mana: 4 },
    });
    const timmy = s.card(TIMMY);

    s.play(SURGERY, { targets: [sel(timmy)] });
    s.expectStats(timmy, { attack: 9, maxHealth: 9 });

    // The turn's first cheap card has been played (R213), so this one resolves its base text: fill
    // only, no +2/+2.
    s.play(FRIEND);

    s.expectStats(timmy, { attack: 9, maxHealth: 9 });
    expect(unitAt(s, "p1", 2).defId).toBe(FELINOR);
    s.expectStats(unitAt(s, "p1", 2), { attack: 1, maxHealth: 1 });
  });

  it("R56 a card above the threshold is left alone", () => {
    const s = scenario({ p1: { backrow: [GIFTED], hand: [POINTMASTER], mana: 4 }, p2: {} });

    s.play(POINTMASTER);

    // Pointmaster costs 2, over the base threshold of 1, so it enters on its base face.
    s.expectStats(POINTMASTER, { attack: 7, maxHealth: 2 });
    expect(s.card(POINTMASTER).radiant).toBe(false);
  });

  it("R56 radiant's threshold of 2 catches a 2-cost card the base one does not", () => {
    const s = scenario({
      p1: { backrow: [{ def: GIFTED, radiant: true }], hand: [POINTMASTER], mana: 4 },
      p2: {},
    });

    s.play(POINTMASTER);

    expect(s.card(POINTMASTER).radiant).toBe(true);
    s.expectStats(POINTMASTER, { attack: 14, maxHealth: 4 });
  });

  it("R56 the count starts again each turn, so the next turn's first cheap card is Radiant too", () => {
    const s = scenario({
      p1: {
        backrow: [GIFTED],
        hand: [SURGERY, FRIEND],
        field: [TIMMY],
        library: [MENACE, MENACE],
        mana: 4,
      },
      p2: { hand: [MENACE], field: [MENACE], library: [MENACE] },
    });
    const timmy = s.card(TIMMY);

    s.play(SURGERY, { targets: [sel(timmy)] });
    s.expectStats(timmy, { attack: 9, maxHealth: 9 });

    // Over to p2 and back: one endTurn hands the turn over, the second comes back around.
    s.endTurn();
    s.endTurn();

    s.play(FRIEND);

    // A fresh turn, so Friend of Felinors is the first cheap card again and runs its radiant text.
    s.expectStats(timmy, { attack: 11, maxHealth: 11 });
    s.expectStats(unitAt(s, "p1", 2), { attack: 3, maxHealth: 3 });
  });
});

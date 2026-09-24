// #38 Quickstriker (SPEC §8.2, BUILD M4-T4): "First play deals 0, second 1, third 2 to the enemy
// hero; nothing when not on the field; no radiant change."

import { describe, expect, it } from "vitest";
import { base, def, radiant } from "../src/scripts/038-quickstriker";
import { scenario } from "./_harness";

const QUICKSTRIKER = "core-038";
/** Three plays whose own texts never touch a hero's health, so the damage read is Quickstriker's. */
const RAPID_REPLENISH = "core-010"; // 0-cost Spell; Combo 3, so nothing at one play
const TEMPO_TIMMY = "core-011"; // 1-cost Unit
const BIG_D_FENDER = "core-001"; // 2-cost Unit
const SPARE = "core-005";

const HERO = 30;

describe("#38 Quickstriker", () => {
  it("is §8.2's #38: a 3-cost Field Spell with no radiant form (BUILD M4-T1)", () => {
    expect(def.index).toBe("38");
    expect(def.type).toBe("Field Spell");
    expect(def.cost).toBe(3);
    // §8 prints no radiant text, so the catalog's two faces are identical.
    expect(def.radiant).toEqual(def.base);
  });

  it("has no radiant script either: the radiant face IS the base face", () => {
    expect(radiant).toBe(base);
    // §10.5 step 5 resolves it for every play and cast, off this flag (R70).
    expect(base.staticFlags).toEqual({ quickstriker: true });
  });

  it("base deals 0 on the first play, 1 on the second and 2 on the third (Combo X)", () => {
    const s = scenario({
      p1: {
        backrow: [QUICKSTRIKER],
        hand: [RAPID_REPLENISH, TEMPO_TIMMY, BIG_D_FENDER],
        library: [SPARE, SPARE, SPARE, SPARE],
      },
      p2: { hand: [SPARE], library: [SPARE] },
    });

    // "X = cards you played EARLIER this turn", so the first play of the turn is X = 0.
    s.play(RAPID_REPLENISH).expectHealth("p2", HERO);
    s.play(TEMPO_TIMMY).expectHealth("p2", HERO - 1);
    s.play(BIG_D_FENDER).expectHealth("p2", HERO - 1 - 2);
  });

  it("base counts each turn on its own: the turn log resets at the start of a turn", () => {
    const s = scenario({
      p1: {
        backrow: [QUICKSTRIKER],
        hand: [RAPID_REPLENISH, TEMPO_TIMMY, BIG_D_FENDER],
        library: [SPARE, SPARE, SPARE],
      },
      p2: { hand: [SPARE, SPARE], library: [SPARE, SPARE, SPARE] },
    });

    s.play(RAPID_REPLENISH).play(TEMPO_TIMMY).expectHealth("p2", HERO - 1);

    // Round the turn back to p1. `startTurn` clears `turnLog` (§2.2), so the count starts over.
    s.endTurn().endTurn().play(BIG_D_FENDER);

    s.expectHealth("p2", HERO - 1);
  });

  it("base fires on your plays only, never on the opponent's", () => {
    const s = scenario({
      p1: { backrow: [QUICKSTRIKER], hand: [SPARE], library: [SPARE, SPARE] },
      p2: { hand: [RAPID_REPLENISH, TEMPO_TIMMY, BIG_D_FENDER], library: [SPARE, SPARE] },
      active: "p2",
    });

    s.play(RAPID_REPLENISH).play(TEMPO_TIMMY).play(BIG_D_FENDER);

    // "Your cards gain …": the controller of Quickstriker is p1, so p2's plays do nothing.
    s.expectHealth("p1", HERO).expectHealth("p2", HERO);
  });

  it("does nothing when Quickstriker is not on the field", () => {
    const s = scenario({
      p1: { hand: [QUICKSTRIKER, RAPID_REPLENISH, TEMPO_TIMMY], library: [SPARE, SPARE] },
      p2: { hand: [SPARE], library: [SPARE] },
    });

    // Quickstriker stays in hand: §10.5 step 5 reads the permanents on the field alone.
    s.play(RAPID_REPLENISH).play(TEMPO_TIMMY);

    s.expectHealth("p2", HERO);
  });

  it("R119 does not answer its own arrival: the play that puts it on the field deals nothing", () => {
    const s = scenario({
      p1: {
        hand: [RAPID_REPLENISH, QUICKSTRIKER, TEMPO_TIMMY],
        library: [SPARE, SPARE, SPARE],
      },
      p2: { hand: [SPARE], library: [SPARE] },
    });

    // §10.5 step 4 places the card and counts the play before step 5 resolves the granted Combos,
    // so Quickstriker is already on the field for its OWN play. R119: it does not answer its own
    // arrival, so this second play of the turn deals 0 rather than 1.
    s.play(RAPID_REPLENISH).play(QUICKSTRIKER).expectHealth("p2", HERO);

    // The arrival still COUNTS as a card played earlier, so the next play deals 2 (R119 excludes
    // the arriving card from answering, not from the count §6.2 reads).
    s.play(TEMPO_TIMMY).expectHealth("p2", HERO - 2);
  });

  it("R119 holds for the radiant face too: it is the same flag, so the same arrival is silent", () => {
    const s = scenario({
      p1: {
        hand: [RAPID_REPLENISH, { def: QUICKSTRIKER, radiant: true }, TEMPO_TIMMY],
        library: [SPARE, SPARE, SPARE],
      },
      p2: { hand: [SPARE], library: [SPARE] },
    });

    s.play(RAPID_REPLENISH).play(QUICKSTRIKER).expectHealth("p2", HERO);
    s.play(TEMPO_TIMMY).expectHealth("p2", HERO - 2);
  });

  it("radiant behaves exactly as the base face does: 0, then 1", () => {
    const s = scenario({
      p1: {
        backrow: [{ def: QUICKSTRIKER, radiant: true }],
        hand: [RAPID_REPLENISH, TEMPO_TIMMY],
        library: [SPARE, SPARE, SPARE],
      },
      p2: { hand: [SPARE], library: [SPARE] },
    });

    s.play(RAPID_REPLENISH).expectHealth("p2", HERO);
    s.play(TEMPO_TIMMY).expectHealth("p2", HERO - 1);
  });
});

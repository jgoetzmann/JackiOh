// #38 Quickstriker (SPEC §8.2, BUILD M4-T4): "First play deals 0, second 1, third 2 to the enemy
// hero; nothing when not on the field". The Radiant face (R275) grants "Combo X: deal 2X damage to
// the enemy hero", and R281 makes 2X one hit: Armor and the Anti-oneshot cap apply to it once, and a
// base and a Radiant Quickstriker together deal X and then 2X.
// The X its next play would count, its R280 `preview`, is proved in test/preview.test.ts.

import { createRng, subsystems } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { base, def, radiant } from "../src/scripts/038-quickstriker";
import { scenario, type Scenario } from "./_harness";

const QUICKSTRIKER = "core-038";
/** Three plays whose own texts never touch a hero's health, so the damage read is Quickstriker's. */
const RAPID_REPLENISH = "core-010"; // 0-cost Spell; Combo 3, so nothing at one play
const TEMPO_TIMMY = "core-011"; // 1-cost Unit
const BIG_D_FENDER = "core-001"; // 2-cost Unit
const SPARE = "core-005";

const POINTMASTER = "core-020"; // 2-cost Unit, no text
const ANTI_ONESHOT = "core-073"; // Field Spell: p2's hero takes at most 5 in one instance
const GOING_LONG = "core-084"; // Field Spell: p2's hero has Armor 2 (paid 2)

const HERO = 30;

/** The amounts of every `damage` event on p2's hero so far, in order: one entry per hit. */
function hitsOnP2(s: Scenario): number[] {
  return s.events.flatMap((event) =>
    event.type === "damage" && event.targetId === "hero-p2" ? [event.amount] : [],
  );
}

describe("#38 Quickstriker", () => {
  it("is §8.2's #38: a 3-cost Field Spell whose Radiant face deals 2X (R275)", () => {
    expect(def.index).toBe("38");
    expect(def.type).toBe("Field Spell");
    expect(def.cost).toBe(3);
    expect(def.base.text).toContain('"Combo X: deal X damage to the enemy hero"');
    expect(def.radiant.text).toContain('"Combo X: deal 2X damage to the enemy hero"');
  });

  it("R281 both faces carry the one grant; the multiple of X is the granting face's, read by the engine", () => {
    // §10.5 step 5 resolves it for every play and cast, off this flag (R70); the pipeline picks the
    // multiple, 1 or 2, off the Quickstriker's own face (`QUICKSTRIKER_COMBO_MULTIPLE`).
    expect(radiant).toBe(base);
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
    // X = 2 (Replenish and the Quickstriker itself), so the Radiant grant deals 2X = 4.
    s.play(TEMPO_TIMMY).expectHealth("p2", HERO - 4);
  });

  it("R281 the base face is unchanged: X, one hit per play", () => {
    const s = scenario({
      p1: {
        backrow: [QUICKSTRIKER],
        hand: [RAPID_REPLENISH, TEMPO_TIMMY, BIG_D_FENDER],
        library: [SPARE, SPARE, SPARE, SPARE],
      },
      p2: { hand: [SPARE], library: [SPARE] },
    });

    s.play(RAPID_REPLENISH).play(TEMPO_TIMMY).play(BIG_D_FENDER);

    expect(hitsOnP2(s)).toEqual([1, 2]);
    s.expectHealth("p2", HERO - 3);
  });

  it("R281 the radiant face deals 2X, as ONE hit per play: 0, then 2, then 4", () => {
    const s = scenario({
      p1: {
        backrow: [{ def: QUICKSTRIKER, radiant: true }],
        hand: [RAPID_REPLENISH, TEMPO_TIMMY, BIG_D_FENDER],
        library: [SPARE, SPARE, SPARE, SPARE],
      },
      p2: { hand: [SPARE], library: [SPARE] },
    });

    s.play(RAPID_REPLENISH).expectHealth("p2", HERO);
    s.play(TEMPO_TIMMY).expectHealth("p2", HERO - 2);
    s.play(BIG_D_FENDER).expectHealth("p2", HERO - 2 - 4);
    // One damage event per play, never X hits of 2 or two hits of X.
    expect(hitsOnP2(s)).toEqual([2, 4]);
  });

  it("R281 Going Long's hero Armor 2 comes off the Radiant 2X once: X = 2 deals 4 - 2 = 2, not 2 × (2 - 2) = 0", () => {
    const s = scenario({
      p1: {
        backrow: [{ def: QUICKSTRIKER, radiant: true }],
        hand: [RAPID_REPLENISH, TEMPO_TIMMY, BIG_D_FENDER],
        library: [SPARE, SPARE, SPARE, SPARE],
      },
      p2: { backrow: [GOING_LONG], hand: [SPARE], library: [SPARE] },
    });

    s.play(RAPID_REPLENISH);
    // X = 1: 2X = 2, and Armor 2 takes the whole hit (R63: no damage event at all).
    s.play(TEMPO_TIMMY).expectHealth("p2", HERO);
    // X = 2: 2X = 4 as one instance, less Armor 2 once.
    s.play(BIG_D_FENDER).expectHealth("p2", HERO - 2);
    expect(hitsOnP2(s)).toEqual([2]);
  });

  it("R281 Anti-oneshot Armor's cap clamps the Radiant 2X once: X = 3 deals 6 capped to 5, not 3 + 3", () => {
    const s = scenario({
      p1: {
        backrow: [{ def: QUICKSTRIKER, radiant: true }],
        hand: [RAPID_REPLENISH, TEMPO_TIMMY, BIG_D_FENDER, POINTMASTER],
        library: [SPARE, SPARE, SPARE, SPARE],
        mana: 10,
      },
      p2: { backrow: [ANTI_ONESHOT], hand: [SPARE], library: [SPARE] },
    });

    s.play(RAPID_REPLENISH).play(TEMPO_TIMMY).play(BIG_D_FENDER).play(POINTMASTER);

    // X = 1, 2 and 3: 2, 4 and 6, and the cap (5 on the base face of #73) takes the last down to 5.
    expect(hitsOnP2(s)).toEqual([2, 4, 5]);
    s.expectHealth("p2", HERO - 11);
  });

  it("R281 a base and a Radiant Quickstriker together deal X and then 2X, each its own hit", () => {
    const s = scenario({
      p1: {
        backrow: [QUICKSTRIKER, { def: QUICKSTRIKER, radiant: true }],
        hand: [RAPID_REPLENISH, TEMPO_TIMMY, BIG_D_FENDER],
        library: [SPARE, SPARE, SPARE, SPARE],
      },
      p2: { hand: [SPARE], library: [SPARE] },
    });

    s.play(RAPID_REPLENISH).play(TEMPO_TIMMY).play(BIG_D_FENDER);

    // Board order: the base one in lane 1 grants X, the Radiant one in lane 2 grants 2X.
    expect(hitsOnP2(s)).toEqual([1, 2, 2, 4]);
    s.expectHealth("p2", HERO - 9);
  });

  it("R281 a Radiant card fused from two Quickstrikers (R102) keeps both grants, each 2X", () => {
    const s = scenario({
      p1: {
        backrow: [{ def: QUICKSTRIKER, radiant: true }],
        hand: [QUICKSTRIKER, RAPID_REPLENISH, TEMPO_TIMMY],
        library: [SPARE, SPARE, SPARE, SPARE],
      },
      p2: { hand: [SPARE], library: [SPARE] },
    });
    const kept = s.backrow("p1", 1);
    const ingredient = s.hand("p1").find((card) => card.defId === QUICKSTRIKER);
    if (kept === null || ingredient === undefined) throw new Error("the two Quickstrikers are not in place");
    const sink = { state: s.state, events: [], rng: createRng(s.state.seed, s.state.rngCursor) };
    // #85's path: a Quickstriker fused onto the Radiant one on the field, which the Fuse keeps.
    expect(subsystems.fuse(sink, { ingredients: [ingredient], target: kept })?.id).toBe(kept.id);

    s.play(RAPID_REPLENISH).play(TEMPO_TIMMY);

    // X = 1, and the kept card runs its Radiant face: both texts' grants, 2X each.
    expect(hitsOnP2(s)).toEqual([2, 2]);
  });
});

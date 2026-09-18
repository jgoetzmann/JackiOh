// #76 Field of Dreams — SPEC §8.3, R31, R4, R11, R50.
//
// BUILD M4-T4: "Hand of N → N Reminisce, old cards in GY (R31); exiled; radiant gives radiant
// Reminisce". Covered here for base and radiant separately, plus N = 0 and the R4 hand cap.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const FIELD_OF_DREAMS = "core-076";
const REMINISCE = "core-072";

/** Four cards that are only ever hand filler here; none of them is played. */
const FILLER = ["core-001", "core-002", "core-003", "core-004"] as const;
/** Nine, so the hand is exactly HAND_CAP (10) with Field of Dreams in it (R4). */
const NINE = [
  "core-001",
  "core-002",
  "core-003",
  "core-004",
  "core-005",
  "core-006",
  "core-007",
  "core-008",
  "core-009",
] as const;

/** A unit on each side and a library, so no turn auto-ends underneath the assertions (R82). */
const KEEP_BUSY = { field: ["core-019"], library: ["core-008", "core-008"] } as const;

function handDefIds(s: Scenario): string[] {
  return s.pile("p1", "hand").map((card) => card.defId);
}

function graveyardDefIds(s: Scenario): string[] {
  return s.pile("p1", "graveyard").map((card) => card.defId);
}

describe("#76 Field of Dreams — base", () => {
  it("R31 replaces a hand of N with N Reminisce and puts the replaced cards in the graveyard", () => {
    const s = scenario({
      p1: { ...KEEP_BUSY, hand: [FIELD_OF_DREAMS, ...FILLER] },
      p2: KEEP_BUSY,
    });

    s.play(FIELD_OF_DREAMS);

    // N = 4: the four filler cards are replaced, Field of Dreams never counts itself (§10.5 step 4).
    expect(handDefIds(s)).toEqual([REMINISCE, REMINISCE, REMINISCE, REMINISCE]);
    // R31: "Replaced cards go to the GY", which is the pool Reminisce discovers from (R50).
    expect(graveyardDefIds(s).sort()).toEqual([...FILLER].sort());
  });

  it("R31 the new Reminisce are not Radiant on the base face", () => {
    const s = scenario({
      p1: { ...KEEP_BUSY, hand: [FIELD_OF_DREAMS, ...FILLER] },
      p2: KEEP_BUSY,
    });

    s.play(FIELD_OF_DREAMS);

    expect(s.pile("p1", "hand").map((card) => card.radiant)).toEqual([false, false, false, false]);
  });

  it("exiles itself rather than going to the graveyard", () => {
    const s = scenario({
      p1: { ...KEEP_BUSY, hand: [FIELD_OF_DREAMS, ...FILLER] },
      p2: KEEP_BUSY,
    });
    const self = s.card(FIELD_OF_DREAMS);

    s.play(FIELD_OF_DREAMS);

    s.expectInZone(self, "exile");
    expect(graveyardDefIds(s)).not.toContain(FIELD_OF_DREAMS);
    // The order the card states: the hand is discarded, then replaced, then this is exiled.
    s.expectEvents("cardPlayed", "discarded", "enteredGraveyard", "exiled");
  });

  it("N = 0: an empty hand gets no Reminisce and Field of Dreams is still exiled", () => {
    const s = scenario({
      p1: { ...KEEP_BUSY, hand: [FIELD_OF_DREAMS] },
      p2: KEEP_BUSY,
    });
    const self = s.card(FIELD_OF_DREAMS);

    s.play(FIELD_OF_DREAMS);

    expect(handDefIds(s)).toEqual([]);
    expect(graveyardDefIds(s)).toEqual([]);
    s.expectInZone(self, "exile");
  });

  it("R4 a full hand of 10 becomes 9 Reminisce and nothing is burned", () => {
    const s = scenario({
      p1: { ...KEEP_BUSY, hand: [FIELD_OF_DREAMS, ...NINE] },
      p2: KEEP_BUSY,
    });

    s.play(FIELD_OF_DREAMS);

    // N ≤ HAND_CAP − 1 because Field of Dreams held a slot, and the copies arrive into an empty
    // hand, so the cap never bites: exactly 9 in hand and exactly the 9 originals in the GY.
    expect(handDefIds(s)).toEqual(Array.from({ length: 9 }, () => REMINISCE));
    expect(graveyardDefIds(s).sort()).toEqual([...NINE].sort());
  });
});

describe("#76 Field of Dreams — radiant", () => {
  it("gives Radiant Reminisce and still buries the replaced hand (R31)", () => {
    const s = scenario({
      p1: { ...KEEP_BUSY, hand: [{ def: FIELD_OF_DREAMS, radiant: true }, ...FILLER] },
      p2: KEEP_BUSY,
    });

    s.play(FIELD_OF_DREAMS);

    const hand = s.pile("p1", "hand");
    expect(hand.map((card) => card.defId)).toEqual([REMINISCE, REMINISCE, REMINISCE, REMINISCE]);
    // §5.2, R74: "Radiant Reminisce" is the radiant flag on each created copy and nothing else.
    expect(hand.map((card) => card.radiant)).toEqual([true, true, true, true]);
    expect(graveyardDefIds(s).sort()).toEqual([...FILLER].sort());
  });

  it("radiant still exiles itself, and N = 0 still creates nothing", () => {
    const s = scenario({
      p1: { ...KEEP_BUSY, hand: [{ def: FIELD_OF_DREAMS, radiant: true }] },
      p2: KEEP_BUSY,
    });
    const self = s.card(FIELD_OF_DREAMS);

    s.play(FIELD_OF_DREAMS);

    expect(handDefIds(s)).toEqual([]);
    s.expectInZone(self, "exile");
  });
});

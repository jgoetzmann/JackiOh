// #23 Reoccurring Dream — SPEC §8.2, BUILD M4-T4 row 23: "Seeded 30% roll on a non-Radiant hand
// card (R60); returns to hand at end of turn; hand full → burned; radiant two rolls at 40% keeping
// a success".
//
// Every roll goes through the seeded rng, so each fixture pins its seed and asserts the outcome
// that seed produces. The gate itself is asserted across one fixed seed list used by both faces,
// which is also how "Lucky 1 at 40%" is proved to be strictly luckier than "30%": at the same seed
// and the same rng cursor a base hit (roll < 0.3) is always a radiant hit (roll < 0.4), and the
// radiant face rolls a second time on top of that, so its hit set is a strict superset of the base
// one. Whether any individual seed hits is not asserted: that would pin the rng's internals, not
// the card.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";
import { base, radiant } from "../src/scripts/023-reoccurring-dream";

const DREAM = "core-023"; // cost 1.
const OTHERS = ["core-002", "core-003", "core-004", "core-011"];

/** Ten other cards: playing the Dream leaves the hand exactly at HAND_CAP. */
const FULL_HAND = [
  "core-002",
  "core-003",
  "core-004",
  "core-005",
  "core-008",
  "core-010",
  "core-011",
  "core-012",
  "core-013",
  "core-016",
];

const SEEDS = [
  "dream-01",
  "dream-02",
  "dream-03",
  "dream-04",
  "dream-05",
  "dream-06",
  "dream-07",
  "dream-08",
  "dream-09",
  "dream-10",
  "dream-11",
  "dream-12",
];

function dreamIn(seed: string, isRadiant: boolean, others: string[] = OTHERS): Scenario {
  return scenario({
    seed,
    p1: { hand: [{ def: DREAM, radiant: isRadiant }, ...others] },
    p2: { hand: ["core-005"] },
  });
}

/** Plays the Dream and counts the Radiant cards left in the hand. */
function radiantsAfterPlaying(seed: string, isRadiant: boolean): number {
  const s = dreamIn(seed, isRadiant);
  s.play(DREAM);
  return s.hand("p1").filter((card) => card.radiant).length;
}

describe("#23 Reoccurring Dream", () => {
  describe("base", () => {
    it("R60 the 30% roll gates it, and a hit makes exactly one hand card Radiant", () => {
      const results = SEEDS.map((seed) => radiantsAfterPlaying(seed, false));

      // R60: one random card, never two, and nothing at all on a miss.
      expect(results.every((count) => count === 0 || count === 1)).toBe(true);
      expect(results.some((count) => count === 1)).toBe(true);
      expect(results.some((count) => count === 0)).toBe(true);
    });

    it("the roll is seeded: one seed always replays to the same outcome", () => {
      for (const seed of SEEDS.slice(0, 4)) {
        expect(radiantsAfterPlaying(seed, false)).toBe(radiantsAfterPlaying(seed, false));
      }
    });

    it("R60 a hand whose other cards are all Radiant is left alone", () => {
      // R60: "a random 'becomes Radiant' pick chooses among non-Radiant cards and does nothing if
      // none are left" — so this must hold at every seed, hit or miss.
      for (const seed of SEEDS.slice(0, 4)) {
        const s = scenario({
          seed,
          p1: { hand: [{ def: DREAM }, ...OTHERS.map((def) => ({ def, radiant: true }))] },
          p2: { hand: ["core-005"] },
        });
        s.play(DREAM);

        expect(s.hand("p1")).toHaveLength(OTHERS.length);
        expect(s.hand("p1").every((card) => card.radiant)).toBe(true);
      }
    });

    it("§5.1, R68 at the end of the turn it returns from the graveyard to your hand", () => {
      const s = dreamIn("dream-return", false);
      s.play(DREAM);
      const dream = s.card(DREAM);
      s.expectInZone(dream, "graveyard");

      s.endTurn();

      s.expectInZone(dream, "hand");
      expect(s.pile("p1", "graveyard").map((card) => card.defId)).not.toContain(DREAM);
    });

    it("R4 a full hand burns the returning card instead", () => {
      const s = scenario({
        seed: "dream-burn",
        // Eleven cards: playing the Dream leaves the hand at HAND_CAP.
        p1: { hand: [DREAM, ...FULL_HAND] },
        p2: { hand: ["core-005"] },
      });
      s.play(DREAM);
      const dream = s.card(DREAM);
      expect(s.hand("p1")).toHaveLength(FULL_HAND.length);

      s.endTurn();

      s.expectInZone(dream, "graveyard");
      s.expectEvents("burned");
    });
  });

  describe("radiant", () => {
    it("Lucky 1 at 40% hits wherever the base 30% hits, and at more seeds besides", () => {
      const baseHits = SEEDS.filter((seed) => radiantsAfterPlaying(seed, false) === 1);
      const radiantHits = SEEDS.filter((seed) => radiantsAfterPlaying(seed, true) === 1);

      expect(baseHits.length).toBeGreaterThan(0);
      for (const seed of baseHits) expect(radiantHits).toContain(seed);
      // Two rolls at 40% beat one at 30%: 64% against 30% over enough seeds.
      expect(radiantHits.length).toBeGreaterThan(baseHits.length);
      // R60: still one card at a time.
      expect(SEEDS.every((seed) => radiantsAfterPlaying(seed, true) <= 1)).toBe(true);
    });

    it("the return from the graveyard is kept, Radiant flag and all (§8 Conventions, R74)", () => {
      const s = dreamIn("dream-radiant-return", true);
      s.play(DREAM);
      const dream = s.card(DREAM);

      s.endTurn();

      s.expectInZone(dream, "hand");
      expect(s.hand("p1").filter((card) => card.id === dream.id)[0]?.radiant).toBe(true);
    });
  });

  it("neither face declares a play-time choice: R60's pick is random, not chosen", () => {
    expect(base.targets).toBeUndefined();
    expect(base.modes).toBeUndefined();
    expect(radiant.targets).toBeUndefined();
    expect(radiant.modes).toBeUndefined();
    expect(typeof base.endOfTurn).toBe("function");
    expect(typeof radiant.endOfTurn).toBe("function");
  });
});

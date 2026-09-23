// AI decks (SPEC §9.9 "Decks", R184; docs/polish/3-ai.md B22, B23).
//
// B22: `buildAiDeck(rng, size, options)` deals exactly `size` distinct non-token Core ids, every
// `include`d id and no banned one, and the same seed always deals the same deck. B23: over many
// seeds the cost curve sits within AI_DECK.curveTolerance of `curveTargets`, units make up at least
// AI_DECK.minUnitShare, and a Human-themed deck is at least AI_DECK.themeMinShare Human.
//
// Seeds are `createRng("deck-test:<size>:<n>")`, n = 1..200, so a failing seed is reproducible.

import { describe, expect, it } from "vitest";
import type { CardDef } from "@jackioh/shared";
import {
  AI_DIFFICULTY,
  DECK_SIZE,
  MAX_MANA,
  createGame,
  createRng,
  defOf,
  query,
  queryCost,
  registeredCatalog,
  validateDeck,
} from "@jackioh/engine";
import {
  AI_DECK,
  SHADOW_BAN_IDS,
  buildAiDeck,
  costBucket,
  curveTargets,
  type AiDeckOptions,
  type CostBucket,
} from "../src/index";
import { corePool } from "./_support";

const SEEDS = 200;
const SIZES = [20, 25, 30] as const;
const BUCKETS: readonly CostBucket[] = ["0-1", "2", "3", "4+"];

function decks(size: number, options?: AiDeckOptions, label = "default"): string[][] {
  return Array.from({ length: SEEDS }, (_, i) =>
    buildAiDeck(createRng(`deck-test:${label}:${size}:${i + 1}`), size, options),
  );
}

function defsOf(deck: readonly string[]): CardDef[] {
  return deck.map((id) => defOf(null, id));
}

/** Mean share per bucket over a set of decks. */
function meanShares(all: readonly string[][]): Record<CostBucket, number> {
  const sums: Record<CostBucket, number> = { "0-1": 0, "2": 0, "3": 0, "4+": 0 };
  for (const deck of all) {
    for (const def of defsOf(deck)) sums[costBucket(def)] += 1 / deck.length;
  }
  for (const bucket of BUCKETS) sums[bucket] /= all.length;
  return sums;
}

function meanShareWhere(all: readonly string[][], test: (def: CardDef) => boolean): number {
  const total = all.reduce((sum, deck) => sum + defsOf(deck).filter(test).length / deck.length, 0);
  return total / all.length;
}

// ---------------------------------------------------------------------------------------------
// B22
// ---------------------------------------------------------------------------------------------

describe("buildAiDeck (B22)", () => {
  for (const size of SIZES) {
    it(`B22: deals exactly ${size} distinct non-token Core ids with no banned card, over ${SEEDS} seeds`, { timeout: 60_000 }, () => {
      const pool = new Set(corePool());
      const banned = new Set(SHADOW_BAN_IDS);
      for (const [at, deck] of decks(size).entries()) {
        expect(deck, `seed ${at + 1}`).toHaveLength(size);
        expect(new Set(deck).size, `seed ${at + 1}`).toBe(size);
        for (const id of deck) {
          expect(pool.has(id), `seed ${at + 1}: ${id}`).toBe(true);
          expect(banned.has(id), `seed ${at + 1}: ${id} is shadow-banned`).toBe(false);
        }
      }
    });
  }

  it("B22: the same seed deals the same deck, and different seeds deal different decks", () => {
    for (const size of SIZES) {
      const one = buildAiDeck(createRng("deck-test-same"), size);
      const two = buildAiDeck(createRng("deck-test-same"), size);
      expect(two).toEqual(one);
    }
    const distinct = new Set(decks(20).map((deck) => [...deck].sort().join(",")));
    expect(distinct.size).toBeGreaterThan(SEEDS / 2);
  });

  it("B22: every include id is dealt, over 200 seeds", () => {
    // Only unbanned ids may be forced in, so pick three the shadow ban leaves alone.
    const include = ["core-019", "core-044", "core-072", "core-008", "core-011", "core-020", "core-025"]
      .filter((id) => !SHADOW_BAN_IDS.includes(id))
      .slice(0, 3);
    expect(include).toHaveLength(3);
    for (const [at, deck] of decks(25, { include }, "include").entries()) {
      for (const id of include) expect(deck, `seed ${at + 1}`).toContain(id);
      expect(new Set(deck).size).toBe(25);
    }
  });

  it("B22: an explicit ban list is honoured instead of the default", () => {
    const banned = corePool().slice(0, 15);
    for (const [at, deck] of decks(30, { banned }, "banned").entries()) {
      for (const id of banned) expect(deck, `seed ${at + 1}`).not.toContain(id);
      expect(deck).toHaveLength(30);
    }
  });

  it("B22: `banned: []` lifts the ban, so a card a ban would keep out can be dealt", () => {
    const target = "core-087";
    const kept = decks(20, { banned: [target] }, "lift-kept");
    expect(kept.every((deck) => !deck.includes(target))).toBe(true);
    const lifted = buildAiDeck(createRng("deck-test-lift"), 20, { banned: [], include: [target] });
    expect(lifted).toContain(target);
    // And with no ban at all, every dealt card is still a non-token Core card.
    const pool = new Set(corePool());
    for (const deck of decks(30, { banned: [] }, "lift")) {
      for (const id of deck) expect(pool.has(id)).toBe(true);
    }
  });

  it("B22: throws when the unbanned pool is too small to fill the deck", () => {
    const pool = corePool();
    const banned = pool.slice(0, pool.length - 10);
    expect(() => buildAiDeck(createRng("deck-test-small"), 20, { banned })).toThrow();
  });

  it("B22: throws for a deck larger than the whole Core pool", () => {
    expect(() => buildAiDeck(createRng("deck-test-huge"), corePool().length + 1, { banned: [] })).toThrow();
  });

  it("R184 B22: every dealt deck is a legal deck for its tier's handicap", () => {
    const catalog = registeredCatalog();
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const h = AI_DIFFICULTY[difficulty];
      for (let n = 1; n <= 20; n += 1) {
        const deck = buildAiDeck(createRng(`deck-test-legal:${difficulty}:${n}`), h.deckSize, { manaCap: h.manaCap });
        expect(() => validateDeck(deck, catalog, "p2", h.deckSize)).not.toThrow();
      }
    }
    const human = buildAiDeck(createRng("deck-test-legal-human"), DECK_SIZE, { banned: [] });
    const hard = buildAiDeck(createRng("deck-test-legal-hard"), AI_DIFFICULTY.hard.deckSize, {
      manaCap: AI_DIFFICULTY.hard.manaCap,
    });
    expect(() =>
      createGame({ seed: "deck-test-legal", decks: [human, hard], handicaps: { p2: AI_DIFFICULTY.hard } }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// B23
// ---------------------------------------------------------------------------------------------

describe("the curve and the theme (B23)", () => {
  it("B23: costBucket reads queryCost: X is 0, an embiggen card is its base price", () => {
    expect(costBucket(defOf(null, "core-008"))).toBe("0-1"); // 1
    expect(costBucket(defOf(null, "core-020"))).toBe("2"); // 2
    expect(costBucket(defOf(null, "core-019"))).toBe("3"); // 3
    expect(costBucket(defOf(null, "core-025"))).toBe("4+"); // 4
    expect(costBucket(defOf(null, "core-029"))).toBe("4+"); // 6
    expect(costBucket(defOf(null, "core-024"))).toBe("0-1"); // X
    expect(costBucket(defOf(null, "core-084"))).toBe("2"); // { base: 2, embiggen: 4 }
    expect(costBucket(defOf(null, "core-021"))).toBe("0-1"); // 0
  });

  it("B23: curveTargets are whole numbers summing to the deck size, each within one card of its share", () => {
    for (const size of SIZES) {
      for (const manaCap of [MAX_MANA, 5, 7]) {
        const targets = curveTargets(size, manaCap);
        const shift = AI_DECK.curveShiftPerMana * Math.max(0, manaCap - MAX_MANA);
        const shares: Record<CostBucket, number> = {
          "0-1": AI_DECK.curve["0-1"] - shift,
          "2": AI_DECK.curve["2"],
          "3": AI_DECK.curve["3"],
          "4+": AI_DECK.curve["4+"] + shift,
        };
        let sum = 0;
        for (const bucket of BUCKETS) {
          const target = targets[bucket];
          expect(Number.isInteger(target), `${size}/${manaCap} ${bucket}`).toBe(true);
          expect(target).toBeGreaterThanOrEqual(0);
          expect(Math.abs(target - shares[bucket] * size), `${size}/${manaCap} ${bucket}`).toBeLessThan(1);
          sum += target;
        }
        expect(sum, `${size}/${manaCap}`).toBe(size);
      }
    }
  });

  it("B23: a higher mana cap moves share from the cheap bucket to the expensive one", () => {
    const low = curveTargets(30, MAX_MANA);
    const high = curveTargets(30, 7);
    expect(high["0-1"]).toBeLessThan(low["0-1"]);
    expect(high["4+"]).toBeGreaterThan(low["4+"]);
  });

  for (const size of SIZES) {
    for (const manaCap of [MAX_MANA, 5, 7]) {
      it(`B23: size ${size}, mana cap ${manaCap}: each bucket's mean share is within curveTolerance of its target`, { timeout: 60_000 }, () => {
        const all = decks(size, { manaCap }, `curve-${manaCap}`);
        const shares = meanShares(all);
        const targets = curveTargets(size, manaCap);
        for (const bucket of BUCKETS) {
          expect(
            Math.abs(shares[bucket] - targets[bucket] / size),
            `${bucket}: mean ${shares[bucket].toFixed(3)} vs target ${(targets[bucket] / size).toFixed(3)}`,
          ).toBeLessThanOrEqual(AI_DECK.curveTolerance);
        }
      });
    }
  }

  for (const size of SIZES) {
    it(`B23: size ${size}: units make up at least minUnitShare on average`, { timeout: 60_000 }, () => {
      const share = meanShareWhere(decks(size), (def) => def.type === "Unit");
      expect(share).toBeGreaterThanOrEqual(AI_DECK.minUnitShare);
    });
  }

  it("B23: a Human-themed deck is at least themeMinShare Human, well above the pool's own share", { timeout: 60_000 }, () => {
    const pool = query({ set: "Core" });
    const poolShare = pool.filter((def) => def.tags.includes("Human")).length / pool.length;
    for (const size of SIZES) {
      const share = meanShareWhere(decks(size, { theme: "Human" }, "human"), (def) => def.tags.includes("Human"));
      expect(share, `size ${size}`).toBeGreaterThanOrEqual(AI_DECK.themeMinShare);
      expect(share, `size ${size}`).toBeGreaterThan(poolShare);
    }
  });

  it("B23: at the human mana cap a card that can never be cast is rarely dealt", { timeout: 60_000 }, () => {
    const pool = query({ set: "Core" });
    const uncastable = (def: CardDef): boolean => queryCost(def) > MAX_MANA + AI_DECK.costSlack;
    const poolShare = pool.filter(uncastable).length / pool.length;
    expect(poolShare).toBeGreaterThan(0);
    const dealt = meanShareWhere(decks(20, { manaCap: MAX_MANA }, "uncastable"), uncastable);
    expect(dealt).toBeLessThan(poolShare);
  });

  it("B23: a theme whose every card is banned cannot lean the deck, which is still dealt whole", () => {
    const humans = query({ set: "Core", tags: ["Human"] }).map((def) => def.id);
    expect(humans.length).toBeGreaterThanOrEqual(AI_DECK.minThemeSize);
    for (let n = 1; n <= 20; n += 1) {
      const deck = buildAiDeck(createRng(`deck-test-banned-theme:${n}`), 20, { theme: "Human", banned: humans });
      expect(deck).toHaveLength(20);
      expect(new Set(deck).size).toBe(20);
      for (const id of deck) expect(humans, `seed ${n}: ${id}`).not.toContain(id);
    }
  });

  it("B23: `theme: null` rolls no theme, so the Human share stays below a themed deck's", { timeout: 60_000 }, () => {
    const themed = meanShareWhere(decks(20, { theme: "Human" }, "themed"), (def) => def.tags.includes("Human"));
    const plain = meanShareWhere(decks(20, { theme: null }, "plain"), (def) => def.tags.includes("Human"));
    expect(plain).toBeLessThan(themed);
  });
});

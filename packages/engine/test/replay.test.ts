import { describe, expect, it } from "vitest";
import { fold, hashState } from "../src/replay";
import { playRandomGame, setupCatalog } from "./fixtures/harness";

const SEEDS = Array.from({ length: 100 }, (_, i) => `smoke-${i + 1}`);

/** M1 gate: folding a recorded log reaches exactly the same state. */
describe("replay (M1 gate)", () => {
  it("folds 100 recorded games to the same state hash", { timeout: 180_000 }, () => {
    for (const seed of SEEDS) {
      const live = playRandomGame(seed);
      setupCatalog();
      const replayed = fold({ seed, decks: live.decks, log: live.log });

      expect(replayed.errors, seed).toEqual([]);
      expect(hashState(replayed.state), seed).toBe(hashState(live.state));
      expect(replayed.state.result, seed).toEqual(live.state.result);
    }
  });

  it("a different seed gives a different hash", () => {
    const a = playRandomGame("hash-a");
    const b = playRandomGame("hash-b");
    expect(hashState(a.state)).not.toBe(hashState(b.state));
  });
});

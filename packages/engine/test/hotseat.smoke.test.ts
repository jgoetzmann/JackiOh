import { describe, expect, it } from "vitest";
import { TURN_CAP_PLAYER_TURNS } from "../src/config";
import { playRandomGame } from "./fixtures/harness";

const SEEDS = Array.from({ length: 100 }, (_, i) => `smoke-${i + 1}`);

/** M1 gate: 100 random-policy games between script-less decks, start to finish. */
describe("hotseat smoke (M1 gate)", () => {
  it("finishes 100 seeded games by hero death or the turn cap, without throwing", { timeout: 120_000 }, () => {
    const reasons = new Map<string, number>();

    for (const seed of SEEDS) {
      const { state } = playRandomGame(seed);
      expect(state.result, seed).not.toBeNull();
      const reason = state.result?.reason as string;
      expect(["hero-death", "both-heroes-dead", "turn-cap"], seed).toContain(reason);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

      expect(state.turn).toBeLessThanOrEqual(TURN_CAP_PLAYER_TURNS);
      expect(state.phase).toBe("over");
      for (const player of ["p1", "p2"] as const) {
        const side = state.players[player];
        expect(side.hand.length).toBeLessThanOrEqual(10);
        // Nothing dead is left standing, and no pile is a stray empty array.
        for (const pile of side.units) expect(pile === null || pile.length > 0).toBe(true);
      }
    }

    expect([...reasons.values()].reduce((a, b) => a + b, 0)).toBe(SEEDS.length);
  });
});

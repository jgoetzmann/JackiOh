import { describe, expect, it } from "vitest";
import * as config from "../src/config";

describe("config constants (BUILD §2)", () => {
  it("matches the BUILD §2 table", () => {
    expect(config.DECK_SIZE).toBe(20);
    expect(config.MAX_COPIES).toBe(1);
    expect(config.MAX_MANA).toBe(4);
    expect(config.HERO_HEALTH).toBe(30);
    expect(config.OPENING_DRAW).toEqual([3, 4]);
    expect(config.OPENING_COINS).toEqual([0, 1]);
    expect(config.COIN_DEF_ID).toBe("core-t-coin");
    expect(config.UNIT_ZONES).toBe(5);
    expect(config.BACKROW_ZONES).toBe(5);
    expect(config.DRAW_OFFERS_PER_TURN).toBe(1);
    expect(config.DRAW_OFFER_BLOCK_TURNS).toBe(3);
    expect(config.CALL_TO_CHAOS_CHAIN_CAP).toBe(20);
    expect(config.CAST_ON_DRAW_CHAIN_CAP).toBe(20);
    expect(config.ANTI_ONESHOT_CAP).toEqual({ base: 5, radiant: 3 });
    expect(config.FUSE_COST_CAP).toBe(4);
    expect(config.LIBRARY_CAP).toBe(60);
    expect(config.MULLIGAN_ORDER).toBe("draw-then-shuffle");
    expect(config.AI_END_TURN_PROBABILITY).toBe(0.1);
  });

  it("holds the SPEC §11 'decide' rows at their recommended values", () => {
    expect(config.CRY_ON_PLAY_ONLY).toBe(true); // R1
    expect(config.TURN_CAP_PLAYER_TURNS).toBe(30); // R2
    expect(config.HAND_CAP).toBe(10); // R4
    expect(config.LANE_RESTRICTED_ATTACKS).toBe(false); // R5
    expect(config.ROTATION_RING).toBe("two-rings"); // R14
    expect(config.GENN_GREED_EXILES).toBe("odd"); // R26
    expect(config.FIENDER_STATS_MODE).toBe("printed-plus-sum"); // R39
  });

  it("R3 fatigue deals N on the Nth empty draw", () => {
    expect([1, 2, 3].map(config.FATIGUE_DAMAGE)).toEqual([1, 2, 3]);
  });

  it("R21 random keyword pool has the eleven listed keywords", () => {
    expect(config.RANDOM_KEYWORD_POOL).toEqual([
      "Taunt", "Armor 1", "Rush", "Charge", "First Strike", "Poisonous",
      "Lifesteal", "Reborn", "Divine Shield", "Trample", "Cleave",
    ]);
  });

  it("R25 Fib index clamps at 11 (89)", () => {
    expect([0, 1, 2, 3, 4, 5, 11].map(config.fib)).toEqual([0, 1, 1, 2, 3, 5, 89]);
    expect(config.fib(12)).toBe(89);
    expect(config.fib(40)).toBe(89);
    expect(config.fib(-1)).toBe(0);
  });
});

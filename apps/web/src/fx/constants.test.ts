// docs/polish/1-animations.md S2: the effects layer's constants, whose values the design fixes
// ("values binding"). Every planner, director and CSS bound in the doc is stated in these names, and
// task 7's settings panel reads the speed steps and intensity scale, so a silent change to one of
// them is a contract change. The table below is S2 verbatim.

import { describe, expect, it } from "vitest";

import * as constants from "./constants.ts";

const S2 = {
  FX_MAX_TAIL_MS: 900,
  FX_MAX_PARTICLE_LIFE_MS: 900,
  FX_SPLAT_HOLD_MS: 650,
  FX_RAYS_TAIL_MS: 600,
  FX_ARROWS_TAIL_MS: 300,
  FX_CRACK_TAIL_MS: 400,
  FX_BANNER_TAIL_MS: 900,
  FX_RING_MS: 500,
  FX_HANDOVER_BANNER_MS: 1400,
  FX_RESULT_MS: 3200,
  FX_PROJECTILE_FLIGHT_FRACTION: 0.55,
  FX_MIND_CONTROL_FLIGHT_FRACTION: 0.7,
  FX_FUSE_FLIGHT_FRACTION: 0.5,
  FX_SLAM_AT: 0.6,
  FX_HOLD_MAX_MS: 6000,
  FX_CONCEAL_AT: 0.9,
  FX_LUNGE_STANDOFF: 0.55,
  FX_LUNGE_MIN_PX: 26,
  FX_LUNGE_MAX_PX: 520,
  FX_LUNGE_CONTACT_AT: 0.7,
  FX_HEAL_SPLAT_AT: 0.2,
  FX_DEATH_EMBER_AT: 0.3,
  FX_DEATH_SMOKE_AT: 0.5,
  FX_RADIANT_BURST_AT: 0.4,
  FX_TRAP_BURST_AT: 0.2,
  FX_BURN_AT: 0.25,
  FX_FATIGUE_STREAK_AT: 0.35,
  FX_FATIGUE_FLIGHT_FRACTION: 0.6,
  FX_OVERFLOW_FIZZLE_AT: 0.45,
  FX_MANA_STAGGER_MS: 40,
  FX_MANA_MAX_SPARKS: 10,
  FX_SHAKE_MIN_DAMAGE: 3,
  FX_TRAUMA_PER_DAMAGE: 0.15,
  FX_SHAKE_MAX_TRAUMA: 0.8,
  FX_HERO_TRAUMA_MULT: 1.25,
  FX_SLAM_STATS_MIN: 10,
  FX_SLAM_TRAUMA_PER_STAT: 0.06,
  FX_SLAM_MAX_TRAUMA: 0.5,
  FX_LEGENDARY_TRAUMA: 0.5,
  FX_TRAP_TRAUMA: 0.4,
  FX_RESULT_TRAUMA: 0.9,
  FX_LETHAL_LEAD_MAX_MS: 600,
  FX_SHAKE_MAX_PX: 18,
  FX_SHAKE_MAX_DEG: 1.2,
  FX_SHAKE_FREQ_HZ: 18,
  FX_TRAUMA_DECAY: 1.2,
  FX_PARTICLE_CAP: 600,
  FX_PARTICLE_CAP_MOBILE: 260,
  FX_PARTICLE_CAP_MIN: 120,
  FX_MOBILE_WIDTH: 600,
  FX_MAX_DPR: 2,
  FX_MAX_DT_MS: 50,
  FX_ADAPT_WINDOW: 30,
  FX_ADAPT_SLOW_MS: 24,
  FX_ADAPT_SLOW_FACTOR: 1.4,
  FX_ADAPT_DISPLAY_MAX_MS: 34,
  FX_ADAPT_MIN_INTERVAL_MS: 4,
  FX_ADAPT_RECOVER_WINDOWS: 3,
  FX_DEFAULT_SEED: 0x5eed,
  FX_MEMORY_LIMIT: 64,
  FX_SPEED_MIN: 0.5,
  FX_SPEED_MAX: 2,
  FX_SPEED_DEFAULT: 1,
  FX_SPEED_STEPS: [0.5, 1, 1.5, 2],
  FX_INTENSITY_SCALE: { off: 0, low: 0.45, normal: 1, high: 1.6 },
  FX_SETTINGS_KEY: "jackioh.fx.v1",
  FX_CENTER: { x: 0.5, y: 0.45 },
  FX_TEXT: {
    yourTurn: "Your turn",
    opponentTurn: "Opponent's turn",
    autoEnded: "No moves left",
    victory: "Victory",
    defeat: "Defeat",
    draw: "Draw",
  },
};

describe("S2 the effects constants", () => {
  it("S2 constants.ts exports exactly the S2 table, with S2's values", () => {
    expect({ ...constants }).toEqual(S2);
  });

  it("S2 no particle outlives the tail, and every fraction of D lands inside the entry", () => {
    expect(constants.FX_MAX_PARTICLE_LIFE_MS).toBeLessThanOrEqual(constants.FX_MAX_TAIL_MS);
    const fractions = [
      constants.FX_PROJECTILE_FLIGHT_FRACTION,
      constants.FX_MIND_CONTROL_FLIGHT_FRACTION,
      constants.FX_FUSE_FLIGHT_FRACTION,
      constants.FX_SLAM_AT,
      constants.FX_HEAL_SPLAT_AT,
      constants.FX_DEATH_EMBER_AT,
      constants.FX_DEATH_SMOKE_AT,
      constants.FX_RADIANT_BURST_AT,
      constants.FX_TRAP_BURST_AT,
      constants.FX_BURN_AT,
      constants.FX_FATIGUE_STREAK_AT,
      constants.FX_FATIGUE_FLIGHT_FRACTION,
      constants.FX_OVERFLOW_FIZZLE_AT,
      constants.FX_CONCEAL_AT,
      constants.FX_LUNGE_STANDOFF,
      constants.FX_LUNGE_CONTACT_AT,
    ];
    for (const fraction of fractions) {
      expect(fraction).toBeGreaterThan(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
    // R318: the fatigue streak leaves the library and lands on the hero inside its entry.
    expect(constants.FX_FATIGUE_STREAK_AT + constants.FX_FATIGUE_FLIGHT_FRACTION).toBeLessThan(1);
  });

  it("S2 the speed steps offered to task 7's panel lie in [FX_SPEED_MIN, FX_SPEED_MAX] and include the default", () => {
    for (const step of constants.FX_SPEED_STEPS) {
      expect(step).toBeGreaterThanOrEqual(constants.FX_SPEED_MIN);
      expect(step).toBeLessThanOrEqual(constants.FX_SPEED_MAX);
    }
    expect(constants.FX_SPEED_STEPS).toContain(constants.FX_SPEED_DEFAULT);
    expect([...constants.FX_SPEED_STEPS]).toEqual([...constants.FX_SPEED_STEPS].sort((a, b) => a - b));
  });

  it("S2 the particle caps shrink from desktop to phone to the adaptive floor", () => {
    expect(constants.FX_PARTICLE_CAP_MIN).toBeLessThan(constants.FX_PARTICLE_CAP_MOBILE);
    expect(constants.FX_PARTICLE_CAP_MOBILE).toBeLessThan(constants.FX_PARTICLE_CAP);
  });

  it("S2 the shake caps stay inside [0, 1] trauma", () => {
    for (const trauma of [
      constants.FX_SHAKE_MAX_TRAUMA,
      constants.FX_SLAM_MAX_TRAUMA,
      constants.FX_LEGENDARY_TRAUMA,
      constants.FX_TRAP_TRAUMA,
      constants.FX_RESULT_TRAUMA,
    ]) {
      expect(trauma).toBeGreaterThan(0);
      expect(trauma).toBeLessThanOrEqual(1);
    }
  });

  it("S2 the fullest shake (trauma 1) is spent inside FX_MAX_TAIL_MS, so a shake started inside an entry ends inside its tail (R200)", () => {
    expect((1 / constants.FX_TRAUMA_DECAY) * 1000).toBeLessThanOrEqual(constants.FX_MAX_TAIL_MS);
  });

  it("S2 a typical hit reads: 4 or 5 damage moves the board several pixels and keeps it moving for a third of a second (B52)", () => {
    // Peak offset is FX_SHAKE_MAX_PX · trauma² (shake.ts). Review: at 8 px and 0.1 per damage point a
    // 5-damage hit peaked under 1 px on screen, which no player notices.
    const trauma = (damage: number): number => Math.min(constants.FX_SHAKE_MAX_TRAUMA, damage * constants.FX_TRAUMA_PER_DAMAGE);
    const peak = (t: number): number => constants.FX_SHAKE_MAX_PX * t * t;
    expect(peak(trauma(4))).toBeGreaterThanOrEqual(6);
    expect(peak(trauma(5))).toBeGreaterThanOrEqual(9);
    // How long it stays above one pixel of amplitude.
    const visibleMs = (t: number): number => ((t - Math.sqrt(1 / constants.FX_SHAKE_MAX_PX)) / constants.FX_TRAUMA_DECAY) * 1000;
    expect(visibleMs(trauma(5))).toBeGreaterThanOrEqual(300);
    // The result thumps hardest of all, and a trap reveal is still felt.
    expect(peak(constants.FX_RESULT_TRAUMA)).toBeGreaterThanOrEqual(12);
    expect(peak(constants.FX_TRAP_TRAUMA)).toBeGreaterThanOrEqual(2);
  });
});

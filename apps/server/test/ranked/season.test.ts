/**
 * Seasons (SPEC §9.12, R609): the season a patch plays in, and the soft reset that opens one.
 */

import { describe, expect, it } from "vitest";

import { RATING_DEVIATION_START, SEASON_RESET_DEVIATION_BOOST, SEASON_RESET_STRENGTH } from "../../src/config";
import { resetGlicko, seasonIdOf, softReset, type ResetPlayer } from "../../src/ranked/season";

describe("R609 a season per minor version", () => {
  it("R609 names the season by the patch version's major and minor", () => {
    expect(seasonIdOf("v0.1.1")).toBe("v0.1");
    expect(seasonIdOf("v0.1.0-r3")).toBe("v0.1");
    expect(seasonIdOf("v0.2.6")).toBe("v0.2");
    expect(seasonIdOf("v0.2")).toBe("v0.2");
    expect(seasonIdOf("v1.10.0")).toBe("v1.10");
    expect(seasonIdOf("v0.3.0")).not.toBe(seasonIdOf("v0.2.9"));
  });

  it("R609 refuses a version it cannot read rather than guessing a season", () => {
    for (const bad of ["core-1", "0.2.6", "v0", "", "v0.x.1"]) expect(() => seasonIdOf(bad)).toThrow(/patch version/);
  });
});

describe("R609 the soft reset", () => {
  const players: ResetPlayer[] = [
    { profileId: "c", glicko: { rating: 1400, deviation: 60, volatility: 0.059 } },
    { profileId: "a", glicko: { rating: 800, deviation: 200, volatility: 0.06 } },
    { profileId: "b", glicko: { rating: 1100, deviation: 340, volatility: 0.061 } },
  ];

  it("R609 pulls each rating SEASON_RESET_STRENGTH of the way to the players' mean, which it keeps", () => {
    expect(SEASON_RESET_STRENGTH).toBe(0.5);
    const { changes, report } = softReset(players);
    expect(report.mean).toBeCloseTo(1100, 9);
    expect(changes.map((change) => [change.profileId, change.after.rating])).toEqual([
      ["a", 950],
      ["b", 1100],
      ["c", 1250],
    ]);
    expect(report.spreadAfter).toBeCloseTo(report.spreadBefore * (1 - SEASON_RESET_STRENGTH), 9);
    expect([report.lowestBefore, report.highestBefore, report.lowestAfter, report.highestAfter]).toEqual([800, 1400, 950, 1250]);
  });

  it("R609 widens every deviation in quadrature, never past a new player's, and keeps volatility", () => {
    const { changes, report } = softReset(players);
    const byId = new Map(changes.map((change) => [change.profileId, change.after]));
    expect(byId.get("c")?.deviation).toBeCloseTo(Math.sqrt(60 * 60 + SEASON_RESET_DEVIATION_BOOST ** 2), 9);
    expect(byId.get("a")?.deviation).toBeCloseTo(Math.sqrt(200 * 200 + SEASON_RESET_DEVIATION_BOOST ** 2), 9);
    expect(byId.get("b")?.deviation).toBe(RATING_DEVIATION_START);
    for (const change of changes) {
      expect(change.after.deviation).toBeGreaterThanOrEqual(change.before.deviation);
      expect(change.after.volatility).toBe(change.before.volatility);
    }
    expect(report.deviationAfter).toBeGreaterThan(report.deviationBefore);
  });

  it("R609 gives the same reset whatever order the players arrive in", () => {
    expect(softReset([...players].reverse())).toEqual(softReset(players));
    expect(resetGlicko(players[0]?.glicko ?? { rating: 0, deviation: 0, volatility: 0 }, 1400).rating).toBe(1400);
  });

  it("R609 resets nobody when nobody has played", () => {
    expect(softReset([])).toMatchObject({ changes: [], report: { players: 0 } });
  });
});

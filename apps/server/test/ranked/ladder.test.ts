/**
 * The visible ladder (SPEC §9.12, R605–R608), as pure functions: where a position sits, what the
 * hidden rating calls for, how one game moves it, the floor, and Jlorious.
 */

import { describe, expect, it } from "vitest";

import {
  JLORIOUS_SIZE,
  RANK_CONVERGENCE_GAP_PIPS,
  RANK_DIVISIONS_PER_TIER,
  RANK_PIPS_PER_DIVISION,
  RANK_PLACEMENT_GAMES,
  RANK_STREAK_LENGTH,
  RANK_TIER_PERCENTS,
} from "../../src/config";
import {
  GRAPE_TIERS,
  LADDER_TOP,
  PIPS_PER_TIER,
  applyRankedGame,
  freshRank,
  jloriousOrder,
  peakBadge,
  percentileOf,
  pipDelta,
  placeOf,
  targetLadder,
  tierBottom,
  tierIndexOf,
  visibleRank,
  withJloriousPeak,
  type GameResult,
  type SeasonRank,
  type Standing,
} from "../../src/ranked/ladder";

const AT = 1_700_000_000_000;

/** A placed player's row at `ladder`. */
function placed(ladder: number, extra: Partial<SeasonRank> = {}): SeasonRank {
  return {
    ...freshRank("v0.1", "p", AT),
    games: RANK_PLACEMENT_GAMES,
    ladder,
    floor: tierIndexOf(ladder),
    peakLadder: ladder,
    ...extra,
  };
}

/** Plays `results` on `rank`, each with the target `target`. */
function play(rank: SeasonRank, results: readonly GameResult[], target: number): SeasonRank {
  return results.reduce((row, result) => applyRankedGame(row, { result, target, at: AT }), rank);
}

describe("R605 the ladder's shape", () => {
  it("R605 has five Grape tiers of three divisions, III up to I, each of RANK_PIPS_PER_DIVISION pips", () => {
    expect(GRAPE_TIERS).toEqual(["rotten", "normal", "large", "golden", "mythic"]);
    expect(RANK_DIVISIONS_PER_TIER).toBe(3);
    expect(placeOf(0)).toEqual({ tier: "rotten", division: 3, pips: 0 });
    expect(placeOf(RANK_PIPS_PER_DIVISION - 1)).toEqual({ tier: "rotten", division: 3, pips: RANK_PIPS_PER_DIVISION - 1 });
    // A full division is the bottom of the next one.
    expect(placeOf(RANK_PIPS_PER_DIVISION)).toEqual({ tier: "rotten", division: 2, pips: 0 });
    expect(placeOf(PIPS_PER_TIER - 1)).toEqual({ tier: "rotten", division: 1, pips: RANK_PIPS_PER_DIVISION - 1 });
    expect(placeOf(PIPS_PER_TIER)).toEqual({ tier: "normal", division: 3, pips: 0 });
    expect(placeOf(LADDER_TOP)).toEqual({ tier: "mythic", division: 1, pips: RANK_PIPS_PER_DIVISION - 1 });
  });

  it("R605 a player is a Raisin until the season's placements are played, then stands where the rating calls for", () => {
    const target = tierBottom(2) + 4; // Large Grape II, 1 pip
    let rank = freshRank("v0.1", "p", AT);
    for (let game = 1; game < RANK_PLACEMENT_GAMES; game += 1) {
      rank = applyRankedGame(rank, { result: game % 2 === 0 ? "win" : "loss", target, at: AT });
      expect(rank.ladder).toBeNull();
      expect(visibleRank(rank, null)).toEqual({ tier: "raisin", placementsPlayed: game, placementGames: RANK_PLACEMENT_GAMES });
    }
    rank = applyRankedGame(rank, { result: "loss", target, at: AT });
    // The game that completes them places the player at the target, whatever its own result.
    expect(rank.ladder).toBe(target);
    expect(rank.floor).toBe(2);
    expect(rank.peakLadder).toBe(target);
    expect(visibleRank(rank, null)).toEqual({ tier: "large", division: 2, pips: 1, pipsPerDivision: RANK_PIPS_PER_DIVISION, floor: "large" });
    expect(visibleRank(null, null)).toEqual({ tier: "raisin", placementsPlayed: 0, placementGames: RANK_PLACEMENT_GAMES });
  });

  it("R605 counts every rated game of the season, placements included", () => {
    const rank = play(freshRank("v0.1", "p", AT), ["win", "loss", "draw", "win", "win", "win"], 10);
    expect({ games: rank.games, wins: rank.wins, losses: rank.losses, draws: rank.draws }).toEqual({ games: 6, wins: 4, losses: 1, draws: 1 });
  });
});

describe("R606 the rank the hidden rating calls for", () => {
  it("R606 is the rating's mid-rank percentile among the season's placed players", () => {
    expect(percentileOf(1000, [])).toEqual({ numerator: 1, denominator: 2 });
    expect(percentileOf(1000, [900, 1000, 1100])).toEqual({ numerator: 2 * 1 + 1 + 1, denominator: 8 });
  });

  it("R606 spreads a population over the tiers in RANK_TIER_PERCENTS: Rotten 12%, Normal 60%, Large 20%, Golden 7%, Mythic 1%", () => {
    expect(RANK_TIER_PERCENTS).toEqual({ rotten: 12, normal: 60, large: 20, golden: 7, mythic: 1 });
    const ratings = Array.from({ length: 1000 }, (_, i) => 700 + i);
    const counts = new Map<string, number>();
    for (const rating of ratings) {
      const others = ratings.filter((other) => other !== rating);
      const tier = placeOf(targetLadder(percentileOf(rating, others))).tier;
      counts.set(tier, (counts.get(tier) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({ rotten: 120, normal: 600, large: 200, golden: 70, mythic: 10 });
  });

  it("R606 compares a boundary exactly, a percentile on one belonging to the tier above", () => {
    // 50 players: the best stands at exactly the 99th percentile, Mythic's lower edge.
    expect(placeOf(targetLadder({ numerator: 99, denominator: 100 })).tier).toBe("mythic");
    expect(placeOf(targetLadder({ numerator: 12, denominator: 100 })).tier).toBe("normal");
    expect(placeOf(targetLadder({ numerator: 11, denominator: 100 }))).toEqual({ tier: "rotten", division: 1, pips: 2 });
    // The very bottom and the very top.
    expect(targetLadder({ numerator: 1, denominator: 10_000 })).toBe(0);
    expect(targetLadder({ numerator: 9_999, denominator: 10_000 })).toBe(LADDER_TOP);
    // Alone in the season: the middle of Normal Grape.
    expect(placeOf(targetLadder(percentileOf(1000, [])))).toEqual({ tier: "normal", division: 2, pips: 2 });
  });
});

describe("R606 how one game moves a placed player", () => {
  const mid = tierBottom(1) + 4; // Normal Grape II, 1 pip

  it("R606 a win gives a pip, a loss takes one and a draw moves none, near the target", () => {
    expect(pipDelta({ result: "win", ladder: mid, target: mid, streak: 1 })).toBe(1);
    expect(pipDelta({ result: "loss", ladder: mid, target: mid, streak: 0 })).toBe(-1);
    expect(pipDelta({ result: "draw", ladder: mid, target: mid, streak: 0 })).toBe(0);
    // Inside one division of the target is still near.
    expect(pipDelta({ result: "win", ladder: mid, target: mid + RANK_CONVERGENCE_GAP_PIPS - 1, streak: 1 })).toBe(1);
    expect(pipDelta({ result: "loss", ladder: mid, target: mid - RANK_CONVERGENCE_GAP_PIPS + 1, streak: 0 })).toBe(-1);
  });

  it("R606 leans one pip toward a target a division or more away, and no more however far", () => {
    const above = mid + RANK_CONVERGENCE_GAP_PIPS;
    const below = mid - RANK_CONVERGENCE_GAP_PIPS;
    // Rated above the visible rank: wins count double, losses as ever.
    expect(pipDelta({ result: "win", ladder: mid, target: above, streak: 1 })).toBe(2);
    expect(pipDelta({ result: "win", ladder: mid, target: LADDER_TOP, streak: 1 })).toBe(2);
    expect(pipDelta({ result: "loss", ladder: mid, target: above, streak: 0 })).toBe(-1);
    // Rated below it: losses count double, wins as ever.
    expect(pipDelta({ result: "loss", ladder: mid, target: below, streak: 0 })).toBe(-2);
    expect(pipDelta({ result: "loss", ladder: mid, target: 0, streak: 0 })).toBe(-2);
    expect(pipDelta({ result: "win", ladder: mid, target: below, streak: 1 })).toBe(1);
  });

  it("R606 converges: a player who wins half their games drifts to the rank the rating calls for", () => {
    // Up across tiers, and down inside one (the floor, R607, stops a fall across a tier boundary).
    for (const [start, target] of [
      [tierBottom(0), tierBottom(3) + 4],
      [tierBottom(1) + PIPS_PER_TIER - 2, tierBottom(1)],
    ] as const) {
      let rank = placed(start);
      for (let game = 0; game < 400; game += 1) rank = applyRankedGame(rank, { result: game % 2 === 0 ? "win" : "loss", target, at: AT });
      expect(Math.abs((rank.ladder ?? 0) - target)).toBeLessThan(RANK_CONVERGENCE_GAP_PIPS + 1);
    }
  });

  it("R606 a win streak earns a bonus pip from its RANK_STREAK_LENGTH-th win, below Mythic Grape only", () => {
    const wins = Array.from({ length: RANK_STREAK_LENGTH }, () => "win" as const);
    // Below Mythic: the streak's third win gives two pips.
    const rank = play(placed(mid), wins, mid);
    expect(rank.streak).toBe(RANK_STREAK_LENGTH);
    expect(rank.ladder).toBe(mid + RANK_STREAK_LENGTH + 1);
    // A loss ends the streak; a draw neither ends nor extends it.
    expect(play(rank, ["loss"], mid).streak).toBe(0);
    expect(play(placed(mid, { streak: 2 }), ["draw"], mid).streak).toBe(2);
    expect(play(placed(mid, { streak: 2 }), ["draw", "win"], mid).ladder).toBe(mid + 2);
    // In Mythic Grape a streak earns nothing extra.
    const mythic = tierBottom(4);
    expect(play(placed(mythic), wins, mythic).ladder).toBe(mythic + RANK_STREAK_LENGTH);
  });

  it("R606 holds a player at the top of Mythic Grape I", () => {
    expect(play(placed(LADDER_TOP), ["win", "win"], LADDER_TOP).ladder).toBe(LADDER_TOP);
  });
});

describe("R607 the tier floor and the season's peak", () => {
  it("R607 a player cannot drop below the Grape tier they have reached this season, but divisions inside it can drop", () => {
    const large = tierBottom(2) + 4; // Large Grape II, 1 pip
    const fallen = play(placed(large), ["loss", "loss", "loss", "loss", "loss", "loss", "loss"], 0);
    expect(fallen.ladder).toBe(tierBottom(2));
    expect(visibleRank(fallen, null)).toMatchObject({ tier: "large", division: 3, pips: 0, floor: "large" });
    // The floor is the highest tier reached, not where the player started.
    const climbed = play(placed(tierBottom(3) - 1), ["win"], tierBottom(3) - 1);
    expect(climbed.floor).toBe(3);
    expect(play(climbed, ["loss", "loss", "loss"], 0).ladder).toBe(tierBottom(3));
    expect(play(climbed, ["loss", "loss", "loss"], 0).peakLadder).toBe(tierBottom(3));
  });

  it("R607 keeps the season's best position as the profile's badge", () => {
    // +1, +1, then +2 for the streak's third win; then two losses, the first leaning toward the
    // target four pips below.
    const rank = play(placed(tierBottom(1)), ["win", "win", "win", "loss", "loss"], tierBottom(1));
    expect(rank.ladder).toBe(tierBottom(1) + 1);
    expect(rank.peakLadder).toBe(tierBottom(1) + 4);
    expect(peakBadge(rank)).toEqual({ seasonId: "v0.1", tier: "normal", division: 2 });
    expect(peakBadge(freshRank("v0.1", "p", AT))).toBeNull();
    const jlorious = withJloriousPeak(withJloriousPeak(placed(tierBottom(4)), 12), 40);
    expect(jlorious.peakJlorious).toBe(12);
    expect(peakBadge(jlorious)).toEqual({ seasonId: "v0.1", tier: "jlorious", position: 12 });
  });
});

describe("R608 Jlorious", () => {
  const mythic = tierBottom(4);
  const standing = (profileId: string, ladder: number | null, rating: number): Standing => ({ profileId, ladder, rating });

  it("R608 is the top JLORIOUS_SIZE Mythic Grape players by hidden rating, ties on profile id", () => {
    expect(JLORIOUS_SIZE).toBe(100);
    const standings = Array.from({ length: 130 }, (_, i) => standing(`m-${String(i).padStart(3, "0")}`, mythic + (i % 9), 2000 - i));
    standings.push(standing("tie-b", mythic, 1950.5), standing("tie-a", mythic, 1950.5));
    const order = jloriousOrder(standings);
    expect(order).toHaveLength(JLORIOUS_SIZE);
    expect(order[0]).toBe("m-000");
    expect(order.indexOf("tie-a")).toBe(order.indexOf("tie-b") - 1);
    // The 101st by rating is out, and back in Mythic Grape.
    expect(order).not.toContain("m-129");
  });

  it("R608 is every Mythic Grape player when fewer than JLORIOUS_SIZE qualify, and nobody below Mythic or still placing", () => {
    const order = jloriousOrder([
      standing("golden-but-rated-highest", tierBottom(3) + 8, 2600),
      standing("raisin-rated-high", null, 2500),
      standing("mythic-low", mythic, 1500),
      standing("mythic-high", mythic + 1, 1700),
    ]);
    expect(order).toEqual(["mythic-high", "mythic-low"]);
  });

  it("R608 is shown as a numbered position instead of a division, and a player who falls out is in Mythic Grape again", () => {
    const rank = placed(mythic + 2);
    expect(visibleRank(rank, 7)).toEqual({ tier: "jlorious", position: 7 });
    expect(visibleRank(rank, null)).toMatchObject({ tier: "mythic", division: 3, pips: 2 });
  });
});

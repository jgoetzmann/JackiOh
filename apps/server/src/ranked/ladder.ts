/**
 * The visible ladder (SPEC §9.12, R605–R608): the Grape tiers a player climbs, read off the hidden
 * rating (`glicko2.ts`) without ever showing it.
 *
 * A placed player's rank is one integer, `ladder`: the pips they stand above the bottom of Rotten
 * Grape III. Each tier has `RANK_DIVISIONS_PER_TIER` divisions of `RANK_PIPS_PER_DIVISION` pips, so
 * the division and the pips are that integer divided out, and a full division is the next one's
 * bottom (R605). Above the Grape tiers is Jlorious, which is not a ladder position at all but the top
 * `JLORIOUS_SIZE` Mythic Grape players by rating (R608), and below them all is Raisin, the season's
 * placements (R605).
 *
 * The hidden rating pulls the visible rank toward itself gently (R606): the rating's percentile
 * among the season's placed players, read off `RANK_TIER_PERCENTS`, is the rank it calls for (the
 * target), and a game a division or more away from its target leans one pip further toward it on a
 * move already heading that way — a win below the target or a loss above it.
 *
 * Pure: every function here takes what it reads and returns what it decides. `src/api/ranked.ts`
 * reads the season from the store, calls these, and writes the result back.
 */

import {
  JLORIOUS_SIZE,
  RANK_CONVERGENCE_GAP_PIPS,
  RANK_CONVERGENCE_PIPS,
  RANK_DIVISIONS_PER_TIER,
  RANK_LOSS_PIPS,
  RANK_PIPS_PER_DIVISION,
  RANK_PLACEMENT_GAMES,
  RANK_STREAK_BONUS_PIPS,
  RANK_STREAK_LENGTH,
  RANK_TIER_PERCENTS,
  RANK_WIN_PIPS,
} from "../config";

/** R605: the Grape tiers, lowest first. Raisin sits below them and Jlorious above. */
export const GRAPE_TIERS = ["rotten", "normal", "large", "golden", "mythic"] as const;
export type GrapeTier = (typeof GRAPE_TIERS)[number];
/** Every tier a player can be shown in, lowest first. */
export type RankTier = "raisin" | GrapeTier | "jlorious";

/** Pips in one Grape tier. */
export const PIPS_PER_TIER = RANK_DIVISIONS_PER_TIER * RANK_PIPS_PER_DIVISION;
/** The highest ladder position: Mythic Grape I with every pip but the last. Wins past it hold it. */
export const LADDER_TOP = GRAPE_TIERS.length * PIPS_PER_TIER - 1;
/** The index of Mythic Grape, the tier Jlorious is drawn from and the one no streak bonus reaches. */
const MYTHIC = GRAPE_TIERS.indexOf("mythic");

const PERCENT = 100;
const percentTotal = GRAPE_TIERS.reduce((sum, tier) => sum + RANK_TIER_PERCENTS[tier], 0);
if (percentTotal !== PERCENT || GRAPE_TIERS.some((tier) => !Number.isInteger(RANK_TIER_PERCENTS[tier]) || RANK_TIER_PERCENTS[tier] <= 0)) {
  throw new Error("RANK_TIER_PERCENTS must be positive whole percents that sum to 100 (R606)");
}

/** A game's result for one side. */
export type GameResult = "win" | "loss" | "draw";

/**
 * One player's season on the ladder: the store's `season_ranks` row (R605). `ladder` is null until
 * the placements are played. `floor` is the Grape tier the player has reached this season (its index
 * in `GRAPE_TIERS`), which the ladder never drops below (R607); `peakLadder` and `peakJlorious` are
 * the best the season has seen, for the profile's badge.
 */
export type SeasonRank = {
  seasonId: string;
  profileId: string;
  /** Rated games played this season, placements included. */
  games: number;
  wins: number;
  losses: number;
  draws: number;
  ladder: number | null;
  floor: number;
  /** Consecutive wins, ended by a loss. A draw neither extends nor ends it (R606). */
  streak: number;
  peakLadder: number | null;
  /** The best (lowest) Jlorious position held this season, or null. */
  peakJlorious: number | null;
  updatedAt: number;
};

/** A placed or placing player's standing, as the season's percentiles and Jlorious read it. */
export type Standing = { profileId: string; ladder: number | null; rating: number };

/** A season row before its first game. */
export function freshRank(seasonId: string, profileId: string, at: number): SeasonRank {
  return {
    seasonId,
    profileId,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    ladder: null,
    floor: 0,
    streak: 0,
    peakLadder: null,
    peakJlorious: null,
    updatedAt: at,
  };
}

/** The Grape tier (an index into `GRAPE_TIERS`) a ladder position is in. */
export function tierIndexOf(ladder: number): number {
  return Math.min(GRAPE_TIERS.length - 1, Math.max(0, Math.floor(ladder / PIPS_PER_TIER)));
}

/** The lowest ladder position of a Grape tier: its Division III with no pip. */
export function tierBottom(tierIndex: number): number {
  return tierIndex * PIPS_PER_TIER;
}

/** A position inside a Grape tier, as the client draws it: division III to I, and pips. */
export type LadderPlace = { tier: GrapeTier; division: number; pips: number };

/** R605: where a ladder position sits. Division 3 is the bottom of a tier (III), 1 the top (I). */
export function placeOf(ladder: number): LadderPlace {
  const tierIndex = tierIndexOf(ladder);
  const within = ladder - tierBottom(tierIndex);
  const fromBottom = Math.floor(within / RANK_PIPS_PER_DIVISION);
  return {
    tier: GRAPE_TIERS[tierIndex] ?? "rotten",
    division: RANK_DIVISIONS_PER_TIER - fromBottom,
    pips: within - fromBottom * RANK_PIPS_PER_DIVISION,
  };
}

/**
 * A rating's percentile among the others, as an exact fraction (R606). It is the mid-rank: the
 * others below, half of those level with it, and half of the player's own place, over everyone
 * counted, `(2·below + level + 1) / (2·(others + 1))`. Kept as two integers so a tier boundary is
 * compared exactly. With nobody else placed the percentile is one half.
 */
export type Percentile = { numerator: number; denominator: number };

export function percentileOf(rating: number, others: readonly number[]): Percentile {
  let below = 0;
  let level = 0;
  for (const other of others) {
    if (other < rating) below += 1;
    else if (other === rating) level += 1;
  }
  return { numerator: 2 * below + level + 1, denominator: 2 * (others.length + 1) };
}

/**
 * R606: the ladder position a percentile calls for. The tiers take `RANK_TIER_PERCENTS` of the
 * range in order, a percentile exactly on a boundary belonging to the tier above it, and inside a
 * tier the percentile is spread evenly over its pips.
 */
export function targetLadder(percentile: Percentile): number {
  const scaled = percentile.numerator * PERCENT;
  let below = 0;
  for (let tierIndex = 0; tierIndex < GRAPE_TIERS.length; tierIndex += 1) {
    const tier = GRAPE_TIERS[tierIndex] ?? "mythic";
    const share = RANK_TIER_PERCENTS[tier];
    const last = tierIndex === GRAPE_TIERS.length - 1;
    if (last || scaled < (below + share) * percentile.denominator) {
      // How far into the tier, in pips: (p − below) / share of the tier's pips, floored, in integers.
      const into = Math.floor(((scaled - below * percentile.denominator) * PIPS_PER_TIER) / (share * percentile.denominator));
      return tierBottom(tierIndex) + Math.min(PIPS_PER_TIER - 1, Math.max(0, into));
    }
    below += share;
  }
  return LADDER_TOP;
}

/**
 * R606: the pips one game moves a placed player, before the floor and the top clamp it. A win gives
 * `RANK_WIN_PIPS`, plus the streak bonus below Mythic Grape, plus the lean when the rating calls for
 * a rank a division or more above; a loss takes `RANK_LOSS_PIPS`, plus the lean when the rating calls
 * for a rank a division or more below; a draw moves nothing. `ladder` is the position before the
 * game and `streak` the win streak counting this game.
 */
export function pipDelta(input: { result: GameResult; ladder: number; target: number; streak: number }): number {
  const gap = input.target - input.ladder;
  if (input.result === "draw") return 0;
  if (input.result === "win") {
    const lean = gap >= RANK_CONVERGENCE_GAP_PIPS ? RANK_CONVERGENCE_PIPS : 0;
    const bonus = input.streak >= RANK_STREAK_LENGTH && tierIndexOf(input.ladder) < MYTHIC ? RANK_STREAK_BONUS_PIPS : 0;
    return RANK_WIN_PIPS + lean + bonus;
  }
  const lean = gap <= -RANK_CONVERGENCE_GAP_PIPS ? RANK_CONVERGENCE_PIPS : 0;
  return -(RANK_LOSS_PIPS + lean);
}

/**
 * R605–R607: one rated game on a player's season. `target` is the rank the player's rating calls for
 * once this game has moved it. A player still placing plays toward their placements, and the game
 * that completes them puts them straight at the target; a placed player moves by `pipDelta`, never
 * below the floor of the highest Grape tier they have reached this season, and never past the top.
 */
export function applyRankedGame(rank: SeasonRank, input: { result: GameResult; target: number; at: number }): SeasonRank {
  const games = rank.games + 1;
  const streak = input.result === "win" ? rank.streak + 1 : input.result === "loss" ? 0 : rank.streak;
  const tally = {
    games,
    wins: rank.wins + (input.result === "win" ? 1 : 0),
    losses: rank.losses + (input.result === "loss" ? 1 : 0),
    draws: rank.draws + (input.result === "draw" ? 1 : 0),
    streak,
    updatedAt: input.at,
  };

  if (rank.ladder === null) {
    if (games < RANK_PLACEMENT_GAMES) return { ...rank, ...tally };
    const placed = Math.min(LADDER_TOP, Math.max(0, input.target));
    return {
      ...rank,
      ...tally,
      ladder: placed,
      floor: Math.max(rank.floor, tierIndexOf(placed)),
      peakLadder: Math.max(rank.peakLadder ?? placed, placed),
    };
  }

  const moved = rank.ladder + pipDelta({ result: input.result, ladder: rank.ladder, target: input.target, streak });
  const ladder = Math.min(LADDER_TOP, Math.max(tierBottom(rank.floor), moved));
  return {
    ...rank,
    ...tally,
    ladder,
    floor: Math.max(rank.floor, tierIndexOf(ladder)),
    peakLadder: Math.max(rank.peakLadder ?? ladder, ladder),
  };
}

/**
 * R608: Jlorious, in order: the season's placed Mythic Grape players by hidden rating, highest
 * first, ties broken by profile id, the first `JLORIOUS_SIZE` of them. When fewer qualify, every one
 * of them is Jlorious. A player who falls out is in Mythic Grape again, where the floor holds them.
 */
export function jloriousOrder(standings: readonly Standing[]): string[] {
  return standings
    .filter((standing) => standing.ladder !== null && tierIndexOf(standing.ladder) === MYTHIC)
    .sort((a, b) => b.rating - a.rating || (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0))
    .slice(0, JLORIOUS_SIZE)
    .map((standing) => standing.profileId);
}

/** R608: the rank row with a Jlorious position it has just held, kept if it is its best. */
export function withJloriousPeak(rank: SeasonRank, position: number): SeasonRank {
  if (rank.peakJlorious !== null && rank.peakJlorious <= position) return rank;
  return { ...rank, peakJlorious: position };
}

/**
 * What a player is shown as (R612): Raisin with their placements, a Grape tier with its division,
 * pips and the floor that holds them, or a Jlorious position. Never the rating.
 */
export type VisibleRank =
  | { tier: "raisin"; placementsPlayed: number; placementGames: number }
  | { tier: GrapeTier; division: number; pips: number; pipsPerDivision: number; floor: GrapeTier }
  | { tier: "jlorious"; position: number };

/** A player's rank, given their season row (null before their first game) and Jlorious position. */
export function visibleRank(rank: SeasonRank | null, jloriousPosition: number | null): VisibleRank {
  if (rank === null || rank.ladder === null) {
    return {
      tier: "raisin",
      placementsPlayed: Math.min(rank?.games ?? 0, RANK_PLACEMENT_GAMES),
      placementGames: RANK_PLACEMENT_GAMES,
    };
  }
  if (jloriousPosition !== null) return { tier: "jlorious", position: jloriousPosition };
  const place = placeOf(rank.ladder);
  return {
    tier: place.tier,
    division: place.division,
    pips: place.pips,
    pipsPerDivision: RANK_PIPS_PER_DIVISION,
    floor: GRAPE_TIERS[rank.floor] ?? "rotten",
  };
}

/** A season's best, as the profile's badge shows it (R607): a Jlorious position or a Grape division. */
export type PeakBadge =
  | { seasonId: string; tier: "jlorious"; position: number }
  | { seasonId: string; tier: GrapeTier; division: number };

/** The season's badge, or null for a season whose placements were never finished. */
export function peakBadge(rank: SeasonRank): PeakBadge | null {
  if (rank.peakJlorious !== null) return { seasonId: rank.seasonId, tier: "jlorious", position: rank.peakJlorious };
  if (rank.peakLadder === null) return null;
  const place = placeOf(rank.peakLadder);
  return { seasonId: rank.seasonId, tier: place.tier, division: place.division };
}

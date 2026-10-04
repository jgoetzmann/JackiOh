/**
 * The ranked ladder on the server (SPEC §9.12, R603–R612): opening a season, rating a ranked game,
 * and the three reads the client has — your own rank, the leaderboard, and both players' ranks on
 * the match screen.
 *
 * The rules are pure and live in `src/ranked/*`: Glicko-2 (`glicko2.ts`), the ladder (`ladder.ts`)
 * and the season's soft reset (`season.ts`). This file only reads the store, hands what it read to
 * them, and writes back what they decided, always inside the caller's transaction.
 *
 * Who calls it:
 *  - `results.ts`, for a ranked match that is not a series game, in the transaction that writes the
 *    result (R604);
 *  - `series.ts`, for a ranked series when it ends, in the transaction of its last transition (R262);
 *  - `src/index.ts` at boot, and `src/db/season-start.ts` by hand, to open the build's season (R609).
 *
 * Nothing here ever sends a rating to a client (R612): the reads answer with `VisibleRank`s, tags,
 * and the season's badges.
 */

import type { GameOverReason, PlayerId } from "@jackioh/shared";

import { loadCurrentPatch } from "./catalog";
import { rateGame, START_GLICKO, type Glicko, type Score } from "../ranked/glicko2";
import {
  GRAPE_TIERS,
  applyRankedGame,
  freshRank,
  jloriousOrder,
  peakBadge,
  percentileOf,
  placeOf,
  targetLadder,
  tierIndexOf,
  visibleRank,
  withJloriousPeak,
  type GameResult,
  type GrapeTier,
  type PeakBadge,
  type SeasonRank,
  type VisibleRank,
} from "../ranked/ladder";
import { seasonIdOf, softReset, type ResetReport } from "../ranked/season";
import { callerProfile } from "./collection";
import { playerTag } from "./crypto";
import { ApiError, ok, route, type Route } from "./http";
import type {
  RatedGameRow,
  RatedSide,
  Season,
  SeasonStanding,
  SeriesEnd,
  ServerDeps,
  Store,
} from "./ports";

// ---------------------------------------------------------------------------
// The game's version (R375) and its season (R609)
// ---------------------------------------------------------------------------

/**
 * The newest patch's version: the game's version, which names the season (R609). Read once at
 * boot. Answered by `catalog.ts`'s reader, so the ranked ladder and the game records file under
 * the same version.
 */
export async function loadPatchVersion(): Promise<string> {
  return loadCurrentPatch();
}

/** R609: the id of the season this build rates games in. */
export function buildSeasonId(deps: Pick<ServerDeps, "patchVersion">): string {
  return seasonIdOf(deps.patchVersion);
}

/** What opening a season reads: the version that names it, the clock that stamps it, the log. */
export type SeasonDeps = Pick<ServerDeps, "patchVersion" | "timers" | "log">;

/** What opening a season did: the season, and the soft reset's report when this call opened it. */
export type OpenedSeason = { season: Season; opened: boolean; reset: ResetReport | null };

/**
 * R609: the build's season, opened inside `t` when it does not exist yet. The first season of all
 * resets nothing — there is no season before it to come back from — and every later one runs the
 * soft reset over every rated player in the same transaction as the season row, so a season is
 * either open and reset or neither. Opens serialize on `ranked.lockSeasons`: two processes
 * opening at once — the same season or, racing deploys, two different ones — run one after the
 * other, so the second sees the first's row (or resets over a world that already holds it) and
 * never soft-resets off a snapshot that predates it.
 */
export async function openSeasonInTx(t: Store, deps: SeasonDeps): Promise<OpenedSeason> {
  const id = buildSeasonId(deps);
  await t.ranked.lockSeasons();
  const seasons = await t.ranked.seasons();
  const existing = seasons.find((season) => season.id === id);
  if (existing !== undefined) return { season: existing, opened: false, reset: null };

  const season: Season = { id, patchVersion: deps.patchVersion, startedAt: deps.timers.now() };
  if (!(await t.ranked.createSeason(season))) {
    const raced = (await t.ranked.seasons()).find((candidate) => candidate.id === id);
    if (raced === undefined) throw new Error(`season ${id} was neither created nor found`);
    return { season: raced, opened: false, reset: null };
  }
  if (seasons.length === 0) {
    deps.log.info("season.opened", { seasonId: id, patchVersion: deps.patchVersion, reset: null });
    return { season, opened: true, reset: null };
  }
  const { changes, report } = softReset(await t.ranked.ratedPlayers());
  await t.ranked.resetRatings(changes);
  deps.log.info("season.opened", { seasonId: id, patchVersion: deps.patchVersion, reset: report });
  return { season, opened: true, reset: report };
}

/** R609: opens the build's season in a transaction of its own (boot, and `season-start.ts`). */
export async function openSeason(deps: SeasonDeps & Pick<ServerDeps, "store">): Promise<OpenedSeason> {
  return deps.store.tx((t) => openSeasonInTx(t, deps));
}

// ---------------------------------------------------------------------------
// Rating one ranked game (R603–R608, R610, R611)
// ---------------------------------------------------------------------------

/** One side of a ranked game: a player's profile, or one of the AI bots (R610). */
export type RankedSideInput = { kind: "player"; profileId: string } | { kind: "bot"; botId: string };

export type RankedGameInput = {
  /** The match's id, or the series' id: the rated game's id, and what makes rating it idempotent. */
  id: string;
  kind: RatedGameRow["kind"];
  catalogVersion: string;
  sides: readonly [RankedSideInput, RankedSideInput];
  /** The index of the side that won, or null for a draw. */
  winnerSide: 0 | 1 | null;
  reason: GameOverReason | SeriesEnd;
  at: number;
};

/**
 * Everything one ranked game will write, decided before any of it is written. Kept apart from the
 * write because a series has to put the ratings on its own row first, by compare-and-set, and must
 * write nothing if it loses (`series.ts`).
 */
export type RankedPlan = {
  row: RatedGameRow;
  /** Null when the game was rated before: nothing is written again. */
  writes: {
    glickos: { side: RankedSideInput; glicko: Glicko; games: number }[];
    ranks: SeasonRank[];
    peaks: { profileId: string; position: number }[];
  } | null;
};

function scoreOf(winnerSide: 0 | 1 | null, side: 0 | 1): Score {
  if (winnerSide === null) return 0.5;
  return winnerSide === side ? 1 : 0;
}

function resultOf(winnerSide: 0 | 1 | null, side: 0 | 1): GameResult {
  if (winnerSide === null) return "draw";
  return winnerSide === side ? "win" : "loss";
}

/** A standing without its rating: the season row itself. */
function rowOf(standing: SeasonStanding): SeasonRank {
  const { rating: _rating, ...row } = standing;
  return row;
}

/** A 1-based position in Jlorious, or null. */
function positionIn(order: readonly string[], profileId: string): number | null {
  const at = order.indexOf(profileId);
  return at < 0 ? null : at + 1;
}

/**
 * Plans one ranked game (R603–R608): both sides rated against each other's rating from before it,
 * each player's season moved toward the rank their new rating calls for, and the Jlorious peaks it
 * gave anyone. Both targets are read from the season as it stood before the game, with both new
 * ratings in it, so neither side's placement depends on which of the two is computed first.
 */
export async function planRankedGame(t: Store, deps: ServerDeps, input: RankedGameInput): Promise<RankedPlan> {
  const recorded = await t.ranked.game(input.id);
  if (recorded !== null) return { row: recorded, writes: null };

  const [first, second] = input.sides;
  if (first.kind === "player" && second.kind === "player" && first.profileId === second.profileId) {
    throw new Error(`rated game ${input.id} names one profile on both sides`);
  }

  const { season } = await openSeasonInTx(t, deps);
  const standings = await t.ranked.standings(season.id);
  const playerIds = input.sides.flatMap((side) => (side.kind === "player" ? [side.profileId] : []));
  const profiles = await t.profiles.getMany(playerIds);

  const beforeOf = async (side: RankedSideInput): Promise<{ glicko: Glicko; games: number }> => {
    if (side.kind === "bot") {
      const bot = await t.ranked.bot(side.botId);
      return { glicko: bot?.glicko ?? START_GLICKO, games: bot?.games ?? 0 };
    }
    const profile = profiles.find((candidate) => candidate.id === side.profileId);
    if (profile === undefined) {
      // A ranked game cannot outlive its players (the foreign keys say so): rate it from the start
      // and shout, as `results.ts` always has.
      deps.log.alert("ranked.profile_missing", { gameId: input.id, profileId: side.profileId });
      return { glicko: START_GLICKO, games: 0 };
    }
    return {
      glicko: { rating: profile.rating, deviation: profile.ratingDeviation, volatility: profile.ratingVolatility },
      games: 0,
    };
  };
  const before = [await beforeOf(first), await beforeOf(second)] as const;
  const rated = rateGame(before[0].glicko, before[1].glicko, scoreOf(input.winnerSide, 0));
  const after = [rated.a, rated.b] as const;

  // The season with both new ratings in it, and each player's row as it stood.
  const newRating = new Map<string, number>();
  input.sides.forEach((side, index) => {
    if (side.kind === "player") newRating.set(side.profileId, after[index === 0 ? 0 : 1].rating);
  });
  const reRated = standings.map((standing) => ({ ...standing, rating: newRating.get(standing.profileId) ?? standing.rating }));
  const jloriousBefore = jloriousOrder(standings);

  const ranks = new Map<string, { before: SeasonRank | null; after: SeasonRank }>();
  input.sides.forEach((side, index) => {
    if (side.kind !== "player") return;
    const sideIndex = index === 0 ? 0 : 1;
    const standing = standings.find((candidate) => candidate.profileId === side.profileId);
    const rowBefore = standing === undefined ? null : rowOf(standing);
    const others = reRated
      .filter((candidate) => candidate.profileId !== side.profileId && candidate.ladder !== null)
      .map((candidate) => candidate.rating);
    const target = targetLadder(percentileOf(after[sideIndex].rating, others));
    const rowAfter = applyRankedGame(rowBefore ?? freshRank(season.id, side.profileId, input.at), {
      result: resultOf(input.winnerSide, sideIndex),
      target,
      at: input.at,
    });
    ranks.set(side.profileId, { before: rowBefore, after: rowAfter });
  });

  // Jlorious after the game, and the peak it gave each member who now stands higher than ever.
  const standingsAfter: SeasonStanding[] = reRated.filter((standing) => !ranks.has(standing.profileId));
  for (const [profileId, { after: row }] of ranks) {
    standingsAfter.push({ ...row, rating: newRating.get(profileId) ?? 0 });
  }
  const jloriousAfter = jloriousOrder(standingsAfter);
  const peaks: { profileId: string; position: number }[] = [];
  jloriousAfter.forEach((profileId, index) => {
    const position = index + 1;
    const own = ranks.get(profileId);
    if (own !== undefined) {
      own.after = withJloriousPeak(own.after, position);
      return;
    }
    const standing = standingsAfter.find((candidate) => candidate.profileId === profileId);
    if (standing !== undefined && (standing.peakJlorious === null || position < standing.peakJlorious)) {
      peaks.push({ profileId, position });
    }
  });

  const sideOf = (side: RankedSideInput, index: 0 | 1): RatedSide => {
    if (side.kind === "bot") {
      return { profileId: null, botId: side.botId, pilot: "ai", before: before[index].glicko, after: after[index], rankBefore: null, rankAfter: null };
    }
    const rank = ranks.get(side.profileId);
    return {
      profileId: side.profileId,
      botId: null,
      pilot: "human",
      before: before[index].glicko,
      after: after[index],
      rankBefore: visibleRank(rank?.before ?? null, positionIn(jloriousBefore, side.profileId)),
      rankAfter: visibleRank(rank?.after ?? null, positionIn(jloriousAfter, side.profileId)),
    };
  };

  const row: RatedGameRow = {
    id: input.id,
    kind: input.kind,
    seasonId: season.id,
    patchVersion: deps.patchVersion,
    catalogVersion: input.catalogVersion,
    sides: [sideOf(first, 0), sideOf(second, 1)],
    winnerSide: input.winnerSide,
    reason: input.reason,
    endedAt: input.at,
  };
  return {
    row,
    writes: {
      glickos: input.sides.map((side, index) => ({
        side,
        glicko: after[index === 0 ? 0 : 1],
        games: before[index === 0 ? 0 : 1].games + 1,
      })),
      ranks: [...ranks.values()].map((rank) => rank.after),
      peaks,
    },
  };
}

/** Writes a plan inside `t`: both ratings, both season rows, the peaks, and the record (R611). */
export async function commitRankedGame(t: Store, plan: RankedPlan, at: number): Promise<void> {
  if (plan.writes === null) return;
  for (const { side, glicko, games } of plan.writes.glickos) {
    if (side.kind === "player") await t.profiles.setGlicko(side.profileId, glicko);
    else await t.ranked.putBot({ botId: side.botId, glicko, games, updatedAt: at });
  }
  for (const rank of plan.writes.ranks) await t.ranked.putRank(rank);
  for (const peak of plan.writes.peaks) await t.ranked.notePeakJlorious(plan.row.seasonId, peak.profileId, peak.position);
  await t.ranked.recordGame(plan.row);
}

/** Plans and writes one ranked game inside `t`. Rating the same id again changes nothing. */
export async function rateRankedGame(t: Store, deps: ServerDeps, input: RankedGameInput): Promise<RatedGameRow> {
  const plan = await planRankedGame(t, deps, input);
  await commitRankedGame(t, plan, input.at);
  return plan.row;
}

// ---------------------------------------------------------------------------
// What the client reads (R612)
// ---------------------------------------------------------------------------

/** One profile's rank in a season it has standings for. */
function rankIn(standings: readonly SeasonStanding[], jlorious: readonly string[], profileId: string): VisibleRank {
  const standing = standings.find((candidate) => candidate.profileId === profileId);
  return visibleRank(standing === undefined ? null : rowOf(standing), positionIn(jlorious, profileId));
}

/** `GET /api/ranked`: the caller's own season, tag and badges. */
export type OwnRankBody = {
  season: string;
  tag: string;
  rank: VisibleRank;
  /** The current win streak, which earns bonus pips below Mythic Grape (R606). */
  streak: number;
  record: { games: number; wins: number; losses: number; draws: number };
  /** Each season's best, newest season first; a season whose placements were never finished has none. */
  badges: PeakBadge[];
};

export async function ownRank(deps: ServerDeps, profileId: string): Promise<OwnRankBody> {
  const seasonId = buildSeasonId(deps);
  const standings = await deps.store.ranked.standings(seasonId);
  const jlorious = jloriousOrder(standings);
  const mine = standings.find((standing) => standing.profileId === profileId);
  const history = await deps.store.ranked.ranksOf(profileId);
  return {
    season: seasonId,
    tag: playerTag(profileId),
    rank: rankIn(standings, jlorious, profileId),
    streak: mine?.streak ?? 0,
    record: { games: mine?.games ?? 0, wins: mine?.wins ?? 0, losses: mine?.losses ?? 0, draws: mine?.draws ?? 0 },
    badges: history
      .map(peakBadge)
      .filter((badge): badge is PeakBadge => badge !== null)
      .reverse(),
  };
}

/** One row of a Grape tier on the leaderboard. */
export type LeaderboardRow = { tag: string; division: number; pips: number; you: boolean };

/** `GET /api/leaderboard` (R612). */
export type LeaderboardBody = {
  season: string;
  /** Jlorious, #1 first. */
  jlorious: { position: number; tag: string; you: boolean }[];
  /**
   * Every other placed player, grouped by Grape tier, highest tier first and, inside a tier, highest
   * rank first. `count` is the tier's size; `players` is all of it (R612).
   */
  tiers: { tier: GrapeTier; count: number; players: LeaderboardRow[] }[];
  /** Players still playing their placements. */
  raisins: number;
  you: VisibleRank;
};

export async function leaderboard(deps: ServerDeps, viewerId: string): Promise<LeaderboardBody> {
  const seasonId = buildSeasonId(deps);
  const standings = await deps.store.ranked.standings(seasonId);
  const jlorious = jloriousOrder(standings);
  const inJlorious = new Set(jlorious);

  const groups = new Map<GrapeTier, { tag: string; ladder: number; you: boolean }[]>(GRAPE_TIERS.map((tier) => [tier, []]));
  let raisins = 0;
  for (const standing of standings) {
    if (standing.ladder === null) {
      raisins += 1;
      continue;
    }
    if (inJlorious.has(standing.profileId)) continue;
    groups.get(GRAPE_TIERS[tierIndexOf(standing.ladder)] ?? "rotten")?.push({
      tag: playerTag(standing.profileId),
      ladder: standing.ladder,
      you: standing.profileId === viewerId,
    });
  }

  return {
    season: seasonId,
    jlorious: jlorious.map((profileId, index) => ({ position: index + 1, tag: playerTag(profileId), you: profileId === viewerId })),
    tiers: [...GRAPE_TIERS].reverse().map((tier) => {
      const rows = (groups.get(tier) ?? []).sort((a, b) => b.ladder - a.ladder || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
      return {
        tier,
        count: rows.length,
        players: rows.map((row) => {
          const place = placeOf(row.ladder);
          return { tag: row.tag, division: place.division, pips: place.pips, you: row.you };
        }),
      };
    }),
    raisins,
    you: rankIn(standings, jlorious, viewerId),
  };
}

/** `GET /api/matches/:matchId/ranks`: both seats' ranks for the match screen (R612). */
export type MatchRanksBody = {
  /**
   * R604: whether the match is ranked. A ranked match's end moves the rating and the ladder
   * itself; a ranked series' games carry the flag while the series moves the rating once,
   * when it ends.
   */
  ranked: boolean;
  seats: Record<PlayerId, { tag: string; rank: VisibleRank; you: boolean }>;
};

export async function matchRanks(deps: ServerDeps, matchId: string, viewerId: string): Promise<MatchRanksBody | null> {
  const match = await deps.store.matches.get(matchId);
  if (match === null || !match.players.includes(viewerId)) return null;
  const standings = await deps.store.ranked.standings(buildSeasonId(deps));
  const jlorious = jloriousOrder(standings);
  const seat = (profileId: string) => ({ tag: playerTag(profileId), rank: rankIn(standings, jlorious, profileId), you: profileId === viewerId });
  // A missing flag is unranked (a pre-0019 row, or a room's), so this game moved nothing.
  return { ranked: match.ranked ?? false, seats: { p1: seat(match.players[0]), p2: seat(match.players[1]) } };
}

export function createRankedRoutes(): Route[] {
  return [
    /** The caller's own rank, record, streak, tag and season badges. Never the rating (R612). */
    route("GET", "/api/ranked", "active", async (req, deps) => ok(await ownRank(deps, callerProfile(req).id))),

    /** R612: Jlorious #1–#100, then everyone else by Grape tier, then how many are still placing. */
    route("GET", "/api/leaderboard", "active", async (req, deps) => ok(await leaderboard(deps, callerProfile(req).id))),

    /**
     * Both players' ranks for the match screen. 404 when the caller is not one of the match's
     * players, exactly as for a match that does not exist (§9.1: a caller learns nothing about
     * matches it is not in).
     */
    route("GET", "/api/matches/:matchId/ranks", "active", async (req, deps) => {
      const body = await matchRanks(deps, req.params["matchId"] ?? "", callerProfile(req).id);
      if (body === null) throw new ApiError("not_found", "no such match");
      return ok(body);
    }),
  ];
}

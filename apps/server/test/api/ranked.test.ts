/**
 * The ranked ladder through the server (SPEC §9.12, R603–R612): opening seasons, rating ranked
 * games of players and bots, Jlorious, and the three reads the client has.
 *
 * The pure rules have their own suites (`test/ranked/*`); these drive `src/api/ranked.ts` against
 * the in-memory store, so what is proved here is the reading and writing around them.
 */

import { describe, expect, it } from "vitest";

import { playerTag } from "../../src/api/crypto";
import { createRouter } from "../../src/api/http";
import type { FrozenDeck, FrozenTrio, MatchRow, SeriesRow } from "../../src/api/ports";
import {
  createRankedRoutes,
  leaderboard,
  openSeason,
  ownRank,
  rateRankedGame,
  type LeaderboardBody,
  type MatchRanksBody,
  type OwnRankBody,
  type RankedGameInput,
} from "../../src/api/ranked";
import { createRecordResult } from "../../src/api/results";
import { JLORIOUS_SIZE, RANK_PLACEMENT_GAMES, RATING_DEVIATION_START, SEASON_RESET_STRENGTH } from "../../src/config";
import { initialClocks } from "../../src/match/clock";
import { START_GLICKO } from "../../src/ranked/glicko2";
import { freshRank, tierBottom, type SeasonRank } from "../../src/ranked/ladder";
import { createTestDeps, jsonRequest, readJson, type TestDeps } from "../fakes/deps";

const A = "profile-a";
const B = "profile-b";

/** A ranked match game between two sides, `winnerSide` winning (null: a draw). */
function game(id: string, sides: RankedGameInput["sides"], winnerSide: 0 | 1 | null, at = 1): RankedGameInput {
  return { id, kind: "match", catalogVersion: "test-1", sides, winnerSide, reason: winnerSide === null ? "draw-accepted" : "hero-death", at };
}

const player = (profileId: string) => ({ kind: "player", profileId }) as const;
const bot = (botId: string) => ({ kind: "bot", botId }) as const;

async function rate(deps: TestDeps, input: RankedGameInput) {
  return deps.store.tx((t) => rateRankedGame(t, deps, input));
}

/** A placed player at `ladder` with `rating`, written straight into the season. */
async function seedPlaced(deps: TestDeps, profileId: string, rating: number, ladder: number, extra: Partial<SeasonRank> = {}): Promise<void> {
  deps.store.seedProfile({ id: profileId, rating });
  await deps.store.ranked.putRank({
    ...freshRank("v0.1", profileId, 0),
    games: RANK_PLACEMENT_GAMES,
    wins: RANK_PLACEMENT_GAMES,
    ladder,
    floor: Math.floor(ladder / tierBottom(1)),
    peakLadder: ladder,
    ...extra,
  });
}

describe("R609 seasons on the server", () => {
  it("R609 the build's season opens once, and the first season of all resets nothing", async () => {
    const deps = createTestDeps();
    deps.store.seedProfile({ id: A, rating: 1300, ratingDeviation: 80 });
    const first = await openSeason(deps);
    expect(first).toMatchObject({ season: { id: "v0.1", patchVersion: "v0.1.1" }, opened: true, reset: null });
    expect(await openSeason(deps)).toMatchObject({ opened: false, reset: null });
    expect(deps.store.tables.seasons).toHaveLength(1);
    expect((await deps.store.profiles.getById(A))?.rating).toBe(1300);
  });

  it("R609 a new minor version opens the next season with a soft reset of every rated player, and nobody else", async () => {
    const deps = createTestDeps();
    deps.store.seedProfile({ id: A, rating: 1000 });
    deps.store.seedProfile({ id: B, rating: 1000 });
    deps.store.seedProfile({ id: "never-played", rating: 1000 });
    for (let n = 0; n < 4; n += 1) await rate(deps, game(`m-${String(n)}`, [player(A), player(B)], 0));
    await rate(deps, game("bot-game", [player(A), bot("ai-hard")], 1));
    const [a, b, botBefore] = [await deps.store.profiles.getById(A), await deps.store.profiles.getById(B), await deps.store.ranked.bot("ai-hard")];
    if (a === null || b === null || botBefore === null) throw new Error("premise: all three were rated");
    const mean = (a.rating + b.rating) / 2;

    const next = await openSeason({ ...deps, patchVersion: "v0.2.0" });
    expect(next).toMatchObject({ season: { id: "v0.2", patchVersion: "v0.2.0" }, opened: true, reset: { players: 2 } });
    const after = [await deps.store.profiles.getById(A), await deps.store.profiles.getById(B)];
    expect(after[0]?.rating).toBeCloseTo(mean + (a.rating - mean) * (1 - SEASON_RESET_STRENGTH), 9);
    expect(after[1]?.rating).toBeCloseTo(mean + (b.rating - mean) * (1 - SEASON_RESET_STRENGTH), 9);
    expect(after[0]?.ratingDeviation).toBeGreaterThan(a.ratingDeviation);
    // A player who never played a rated game, and the bot, are left as they were.
    expect(await deps.store.profiles.getById("never-played")).toMatchObject({ rating: 1000, ratingDeviation: RATING_DEVIATION_START });
    expect(await deps.store.ranked.bot("ai-hard")).toEqual(botBefore);
    // Everyone starts the new season back in placements; the old season's rows are kept.
    expect(await ownRank({ ...deps, patchVersion: "v0.2.0" }, A)).toMatchObject({ season: "v0.2", rank: { tier: "raisin", placementsPlayed: 0 } });
    expect((await deps.store.ranked.ranksOf(A)).map((rank) => rank.seasonId)).toEqual(["v0.1"]);
  });

  it("R609 the first rated game of a build opens its season itself", async () => {
    const deps = createTestDeps();
    deps.store.seedProfile({ id: A });
    deps.store.seedProfile({ id: B });
    const row = await rate(deps, game("m-1", [player(A), player(B)], null));
    expect(row.seasonId).toBe("v0.1");
    expect(deps.store.tables.seasons.map((season) => season.id)).toEqual(["v0.1"]);
  });
});

describe("R605 placements through rated games", () => {
  it("R605 RANK_PLACEMENT_GAMES rated games place a Raisin where the rating calls for", async () => {
    const deps = createTestDeps();
    // A placed field to be read against, rated 700 to 1300.
    for (let n = 0; n < 7; n += 1) await seedPlaced(deps, `field-${String(n)}`, 700 + 100 * n, tierBottom(1));
    deps.store.seedProfile({ id: A });
    deps.store.seedProfile({ id: B });
    for (let n = 1; n <= RANK_PLACEMENT_GAMES; n += 1) {
      await rate(deps, game(`m-${String(n)}`, [player(A), player(B)], 0, n));
      const mine = await ownRank(deps, A);
      if (n < RANK_PLACEMENT_GAMES) expect(mine.rank).toEqual({ tier: "raisin", placementsPlayed: n, placementGames: RANK_PLACEMENT_GAMES });
    }
    const [winner, loser] = [await ownRank(deps, A), await ownRank(deps, B)];
    // Both placed by the same game, each read against the field: the winner well above the loser.
    expect(winner.rank.tier).not.toBe("raisin");
    expect(loser.rank.tier).not.toBe("raisin");
    expect(winner.record).toEqual({ games: RANK_PLACEMENT_GAMES, wins: RANK_PLACEMENT_GAMES, losses: 0, draws: 0 });
    expect(winner.streak).toBe(RANK_PLACEMENT_GAMES);
    const ladder = async (id: string) => (await deps.store.ranked.rank("v0.1", id))?.ladder ?? -1;
    expect(await ladder(A)).toBeGreaterThan(await ladder(B));
  });

  it("R603 rating the same game twice changes nothing", async () => {
    const deps = createTestDeps();
    deps.store.seedProfile({ id: A });
    deps.store.seedProfile({ id: B });
    const first = await rate(deps, game("m-1", [player(A), player(B)], 0));
    const profile = await deps.store.profiles.getById(A);
    expect(await rate(deps, game("m-1", [player(A), player(B)], 1))).toEqual(first);
    expect(await deps.store.profiles.getById(A)).toEqual(profile);
    expect(deps.store.tables.ratedGames).toHaveLength(1);
  });
});

describe("R610 bots", () => {
  it("R610 a bot is rated like a player, from its own rating, and has no rank, no season row and no place on the leaderboard", async () => {
    const deps = createTestDeps();
    deps.store.seedProfile({ id: A });
    const first = await rate(deps, game("b-1", [player(A), bot("ai-easy")], 0));
    expect(first.sides[1]).toMatchObject({ profileId: null, botId: "ai-easy", pilot: "ai", before: START_GLICKO, rankBefore: null, rankAfter: null });
    const easy = await deps.store.ranked.bot("ai-easy");
    expect(easy?.games).toBe(1);
    expect(easy?.glicko.rating).toBeLessThan(START_GLICKO.rating);
    expect(easy?.glicko).toEqual(first.sides[1].after);

    // The bot's next game starts from the rating its last one left it.
    const second = await rate(deps, game("b-2", [bot("ai-easy"), player(A)], 0));
    expect(second.sides[0].before).toEqual(first.sides[1].after);
    expect((await deps.store.ranked.bot("ai-easy"))?.games).toBe(2);

    expect(deps.store.tables.seasonRanks.map((rank) => rank.profileId)).toEqual([A]);
    const board = await leaderboard(deps, A);
    expect(JSON.stringify(board)).not.toContain("ai-easy");
  });

  it("R610 a bot's rating is not among the players a rank's percentile is read from", async () => {
    const deps = createTestDeps();
    // One placed player, rated far above a fresh one: the fresh player's target reads only them.
    await seedPlaced(deps, "placed", 2000, tierBottom(2));
    deps.store.seedProfile({ id: A });
    await deps.store.ranked.putBot({ botId: "ai-hard", glicko: { ...START_GLICKO, rating: 400 }, games: 50, updatedAt: 0 });
    for (let n = 1; n <= RANK_PLACEMENT_GAMES; n += 1) await rate(deps, game(`g-${String(n)}`, [player(A), bot("ai-hard")], 0, n));
    // Rated below the one placed player, alone with them: the 25th percentile, in Normal Grape.
    expect((await ownRank(deps, A)).rank).toMatchObject({ tier: "normal" });
  });
});

describe("R608 Jlorious through the server", () => {
  it("R608 ranks Mythic Grape players by rating on the leaderboard and records the position a game gives as the season's peak", async () => {
    const deps = createTestDeps();
    const mythic = tierBottom(4);
    await seedPlaced(deps, "m-high", 1900, mythic);
    await seedPlaced(deps, "m-low", 1500, mythic + 2);
    await seedPlaced(deps, "golden", 2500, tierBottom(3) + 8);
    await seedPlaced(deps, A, 1400, mythic + 1);
    await seedPlaced(deps, B, 1300, tierBottom(1));
    // A beats B and climbs past m-low on rating: Jlorious #2.
    await rate(deps, game("j-1", [player(A), player(B)], 0));
    const board = await leaderboard(deps, A);
    expect(board.jlorious.map((row) => [row.position, row.tag, row.you])).toEqual([
      [1, playerTag("m-high"), false],
      [2, playerTag(A), true],
      [3, playerTag("m-low"), false],
    ]);
    expect((await deps.store.ranked.rank("v0.1", A))?.peakJlorious).toBe(2);
    expect((await ownRank(deps, A)).rank).toEqual({ tier: "jlorious", position: 2 });
    expect((await ownRank(deps, A)).badges).toEqual([{ seasonId: "v0.1", tier: "jlorious", position: 2 }]);
    // m-low fell to #3 and keeps the #2 it never held: no peak is invented for it.
    expect((await deps.store.ranked.rank("v0.1", "m-low"))?.peakJlorious).toBe(3);
    // Golden is rated highest of all and is not Jlorious: Jlorious is drawn from Mythic Grape.
    expect(board.tiers.find((tier) => tier.tier === "golden")?.players.map((row) => row.tag)).toEqual([playerTag("golden")]);
    expect(JLORIOUS_SIZE).toBe(100);
  });
});

describe("R612 what the client reads", () => {
  async function routed() {
    const deps = createTestDeps();
    const tokenA = deps.auth.addUser({ userId: `user-${A}`, email: "a@example.test" });
    const tokenB = deps.auth.addUser({ userId: `user-${B}`, email: "b@example.test" });
    const stranger = deps.auth.addUser({ userId: "user-stranger", email: "s@example.test" });
    deps.store.seedProfile({ id: A, userId: `user-${A}`, rating: 1234.5678 });
    deps.store.seedProfile({ id: B, userId: `user-${B}`, rating: 987.654 });
    deps.store.seedProfile({ id: "stranger", userId: "user-stranger" });
    const router = createRouter(createRankedRoutes(), deps);
    const get = async <T>(path: string, token: string): Promise<{ status: number; body: T; text: string }> => {
      const res = await router(jsonRequest("GET", path, undefined, { token }));
      const body = (await readJson(res)) as T;
      return { status: res.status, body, text: JSON.stringify(body) };
    };
    return { deps, get, tokenA, tokenB, stranger };
  }

  it("R612 GET /api/ranked answers the caller's tag, rank, streak, record and badges, and never a rating", async () => {
    const { get, tokenA } = await routed();
    const { status, body, text } = await get<OwnRankBody>("/api/ranked", tokenA);
    expect(status).toBe(200);
    expect(body).toEqual({
      season: "v0.1",
      tag: playerTag(A),
      rank: { tier: "raisin", placementsPlayed: 0, placementGames: RANK_PLACEMENT_GAMES },
      streak: 0,
      record: { games: 0, wins: 0, losses: 0, draws: 0 },
      badges: [],
    });
    expect(text).not.toMatch(/1234|rating|deviation|volatility/);
  });

  it("R612 GET /api/leaderboard lists tags and ranks, marks the caller, and counts the Raisins", async () => {
    const { deps, get, tokenA } = await routed();
    await deps.store.ranked.putRank({ ...freshRank("v0.1", B, 0), games: 2, wins: 2 });
    await deps.store.ranked.putRank({ ...freshRank("v0.1", A, 0), games: RANK_PLACEMENT_GAMES, ladder: tierBottom(1) + 4, floor: 1, peakLadder: tierBottom(1) + 4 });
    const { status, body, text } = await get<LeaderboardBody>("/api/leaderboard", tokenA);
    expect(status).toBe(200);
    expect(body.jlorious).toEqual([]);
    expect(body.raisins).toBe(1);
    expect(body.tiers.map((tier) => tier.tier)).toEqual(["mythic", "golden", "large", "normal", "rotten"]);
    expect(body.tiers.find((tier) => tier.tier === "normal")).toEqual({
      tier: "normal",
      count: 1,
      players: [{ tag: playerTag(A), division: 2, pips: 1, you: true }],
    });
    expect(body.you).toMatchObject({ tier: "normal", division: 2, pips: 1 });
    expect(text).not.toMatch(/1234|987|profile-|rating/);
  });

  it("R612 GET /api/matches/:id/ranks shows both seats to a player of the match, and 404s for anyone else", async () => {
    const { deps, get, tokenA, stranger } = await routed();
    const match: MatchRow = {
      id: "match-1",
      seed: "s",
      players: [A, B],
      decks: [[], []],
      catalogVersion: "test-1",
      ranked: true,
      status: "live",
      createdAt: 0,
      finishedAt: null,
      clocks: initialClocks(0, deps.config),
    };
    await deps.store.matches.create(match);
    const mine = await get<MatchRanksBody>("/api/matches/match-1/ranks", tokenA);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({
      ranked: true,
      seats: {
        p1: { tag: playerTag(A), rank: { tier: "raisin", placementsPlayed: 0, placementGames: RANK_PLACEMENT_GAMES }, you: true },
        p2: { tag: playerTag(B), rank: { tier: "raisin", placementsPlayed: 0, placementGames: RANK_PLACEMENT_GAMES }, you: false },
      },
    });
    expect(mine.text).not.toMatch(/rating|profile-/);
    expect((await get("/api/matches/match-1/ranks", stranger)).status).toBe(404);
    expect((await get("/api/matches/no-such-match/ranks", tokenA)).status).toBe(404);
  });
});

describe("R604 a ranked series through the results writer", () => {
  it("R604 a room's series moves no rating when it ends, and a queue's moves it once", async () => {
    for (const ranked of [false, true]) {
      const deps = createTestDeps();
      deps.store.seedProfile({ id: A, inMatchId: "game-1" });
      deps.store.seedProfile({ id: B, inMatchId: "game-1" });
      const deck = (slot: number): FrozenDeck => ({ name: `d${String(slot)}`, cards: [] });
      const trio: FrozenTrio = { name: "t", decks: [deck(0), deck(1), deck(2)] };
      const series: SeriesRow = {
        id: "series-1",
        sides: [
          { profileId: A, trio, wins: 2, pick: null },
          { profileId: B, trio, wins: 0, pick: null },
        ],
        catalogVersion: "test-1",
        ranked,
        seedBase: "s",
        status: "playing",
        games: [
          { gameNo: 1, matchId: "g-a", slots: [0, 0], first: "p1", winner: "p1", reason: "concede" },
          { gameNo: 2, matchId: "g-b", slots: [1, 0], first: "p2", winner: "p1", reason: "concede" },
          { gameNo: 3, matchId: "game-1", slots: [2, 0], first: "p1", winner: null, reason: null },
        ],
        nextMatchId: "game-1",
        pickDeadline: null,
        winner: null,
        endReason: null,
        ratingBefore: null,
        ratingAfter: null,
        createdAt: 0,
        updatedAt: 0,
        endedAt: null,
        version: 1,
      };
      await deps.store.series.create(series);
      await deps.store.matches.create({
        id: "game-1",
        seed: "s:3",
        players: [A, B],
        decks: [[], []],
        catalogVersion: "test-1",
        ranked,
        status: "live",
        createdAt: 0,
        finishedAt: null,
        clocks: initialClocks(0, deps.config),
      });
      await createRecordResult(deps)({
        matchId: "game-1",
        seats: [
          { profileId: A, player: "p1", deck: [] },
          { profileId: B, player: "p2", deck: [] },
        ],
        outcome: { winner: "p1", reason: "hero-death" },
        turns: 4,
        at: 5,
      });
      const ended = await deps.store.series.get("series-1");
      expect(ended?.status).toBe("over");
      const rating = (await deps.store.profiles.getById(A))?.rating ?? 0;
      if (ranked) {
        expect(rating).toBeGreaterThan(1000);
        expect(deps.store.tables.ratedGames.map((row) => [row.id, row.kind, row.reason, row.winnerSide])).toEqual([["series-1", "series", "decided", 0]]);
        expect(ended?.ratingAfter?.[0]).toBe(rating);
      } else {
        expect(rating).toBe(1000);
        expect(deps.store.tables.ratedGames).toEqual([]);
        expect(ended?.ratingAfter).toBeNull();
      }
    }
  });
});

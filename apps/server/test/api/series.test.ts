/**
 * The Best-of-3 series through the server (`src/api/series.ts`, `src/api/results.ts`, SPEC §9.5,
 * R259–R262). `series-rules.test.ts` holds the exhaustive rule tables; this file shows each ruling
 * holding end to end: a series made the way pairing makes it (`startSeries`), picks and forfeits
 * through the router, games started through the match directory, and games finished through the
 * same `createRecordResult` the actor calls.
 *
 * The match directory here writes the match row (`createFakeMatchDirectory(store)`), as the real
 * registry does, so "the game started" is a row in the store and a result can finish it. Time is the
 * manual clock, so the pick clock (R260) is driven by `timers.advance` and the sweeper.
 */

import { describe, expect, it } from "vitest";

import { createRouter, type Router } from "../../src/api/http";
import type { FrozenTrio, MatchSeat, SeriesRow } from "../../src/api/ports";
import { createRecordResult } from "../../src/api/results";
import {
  createSeriesRoutes,
  startSeries,
  startSeriesSweeper,
  sweepSeries,
} from "../../src/api/series";
import type { SeriesView } from "../../src/api/series-rules";
import { SERIES_PICK_SECONDS, SERIES_SWEEP_INTERVAL_SECONDS, eloUpdate } from "../../src/config";
import type { GameOverReason } from "@jackioh/shared";
import {
  createFakeMatchDirectory,
  createTestDeps,
  jsonRequest,
  readJson,
  type TestDeps,
} from "../fakes/deps";

const ALICE = "profile-alice";
const BOB = "profile-bob";
const STRANGER = "profile-stranger";
const SERIES_ID = "series-1";
const FIRST_MATCH = "match-1";
const PICK_MS = SERIES_PICK_SECONDS * 1000;
const SWEEP_MS = SERIES_SWEEP_INTERVAL_SECONDS * 1000;

type ErrorBody = { error: { code: string; message: string } };

type Harness = {
  deps: TestDeps;
  router: Router;
  tokens: { alice: string; bob: string; stranger: string };
  discarded: string[];
};

function trio(owner: string): FrozenTrio {
  const deck = (slot: number) => ({
    name: `${owner} deck ${String(slot)}`,
    cards: [`${owner}-card-${String(slot)}a`, `${owner}-card-${String(slot)}b`],
  });
  return { name: `${owner}'s trio`, decks: [deck(0), deck(1), deck(2)] };
}

function activeProfile(deps: TestDeps, id: string, rating: number): string {
  const userId = `user-${id}`;
  deps.store.seedProfile({ id, userId, status: "active", rating });
  return deps.auth.addUser({ userId, email: `${id}@example.test` });
}

async function harness(ratings: [number, number] = [1000, 1000]): Promise<Harness> {
  const deps = createTestDeps();
  deps.matches = createFakeMatchDirectory(deps.store);
  // `matches.discardOpen` is a no-op in memory (there are no `open` rows), so record what it is asked.
  const discarded: string[] = [];
  const discard = deps.store.matches.discardOpen;
  deps.store.matches.discardOpen = async (matchId) => {
    discarded.push(matchId);
    await discard(matchId);
  };
  const tokens = {
    alice: activeProfile(deps, ALICE, ratings[0]),
    bob: activeProfile(deps, BOB, ratings[1]),
    stranger: activeProfile(deps, STRANGER, 1000),
  };
  await startSeries(deps, {
    seriesId: SERIES_ID,
    firstMatchId: FIRST_MATCH,
    sides: [
      { profileId: ALICE, trio: trio("alice") },
      { profileId: BOB, trio: trio("bob") },
    ],
    seedBase: "seed-base",
    catalogVersion: deps.catalog.version,
  });
  return { deps, router: createRouter(createSeriesRoutes(), deps), tokens, discarded };
}

async function getSeries(h: Harness, token: string, id = SERIES_ID): Promise<Response> {
  return h.router(jsonRequest("GET", `/api/series/${id}`, undefined, { token }));
}

async function pick(h: Harness, token: string, slot: unknown): Promise<Response> {
  return h.router(jsonRequest("POST", `/api/series/${SERIES_ID}/pick`, { slot }, { token }));
}

async function forfeit(h: Harness, token: string): Promise<Response> {
  return h.router(jsonRequest("POST", `/api/series/${SERIES_ID}/forfeit`, undefined, { token }));
}

async function pickBoth(h: Harness, slots: [number, number]): Promise<SeriesView> {
  expect((await pick(h, h.tokens.alice, slots[0])).status).toBe(200);
  const answer = await pick(h, h.tokens.bob, slots[1]);
  expect(answer.status).toBe(200);
  return readJson<SeriesView>(answer);
}

async function row(h: Harness): Promise<SeriesRow> {
  const series = await h.deps.store.series.get(SERIES_ID);
  if (series === null) throw new Error("the series is gone");
  return series;
}

function seatsOf(h: Harness, matchId: string): readonly [MatchSeat, MatchSeat] {
  const started = h.deps.matches.started.find((input) => input.matchId === matchId);
  if (started === undefined) throw new Error(`${matchId} was never started`);
  return started.seats;
}

/** Ends the game in play the way the actor does: `createRecordResult`, with the match's own seats. */
async function finishGame(
  h: Harness,
  winner: string | "draw",
  reason: GameOverReason = winner === "draw" ? "draw-accepted" : "hero-death",
): Promise<void> {
  const series = await row(h);
  expect(series.status).toBe("playing");
  const matchId = series.nextMatchId;
  const seats = seatsOf(h, matchId);
  const seat = seats.find((candidate) => candidate.profileId === winner);
  await createRecordResult(h.deps)({
    matchId,
    seats,
    outcome: { winner: winner === "draw" ? "draw" : (seat?.player ?? "p1"), reason },
    turns: 9,
    at: h.deps.timers.now(),
  });
}

async function ratings(h: Harness): Promise<[number | undefined, number | undefined]> {
  const [alice, bob] = [await h.deps.store.profiles.getById(ALICE), await h.deps.store.profiles.getById(BOB)];
  return [alice?.rating, bob?.rating];
}

async function inMatch(h: Harness): Promise<[string | null | undefined, string | null | undefined]> {
  const [alice, bob] = [await h.deps.store.profiles.getById(ALICE), await h.deps.store.profiles.getById(BOB)];
  return [alice?.inMatchId, bob?.inMatchId];
}

/** Lets the sweeper's `void sweep()` run to completion: the memory store is all microtasks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Advances the manual clock one sweep interval at a time, letting each sweep finish. */
async function advanceSweeping(h: Harness, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += SWEEP_MS) {
    h.deps.timers.advance(Math.min(SWEEP_MS, ms - elapsed));
    await flush();
  }
}

describe("R259 — the series through the API", () => {
  it("R259 GET /api/series/:id answers each player's own view, and 404 to a stranger or an unknown id", async () => {
    const h = await harness();

    const alice = await readJson<SeriesView>(await getSeries(h, h.tokens.alice));
    expect(alice).toMatchObject({ id: SERIES_ID, status: "picking", gameNo: 1, currentMatchId: null });
    expect(alice.you).toMatchObject({ seat: "p1", trioName: "alice's trio", pick: null });
    const bob = await readJson<SeriesView>(await getSeries(h, h.tokens.bob));
    expect(bob.you.seat).toBe("p2");
    expect(JSON.stringify(bob)).not.toMatch(/alice/u);

    const stranger = await getSeries(h, h.tokens.stranger);
    expect(stranger.status).toBe(404);
    expect((await readJson<ErrorBody>(stranger)).error.code).toBe("not_found");
    const unknown = await getSeries(h, h.tokens.alice, "no-such-series");
    expect(unknown.status).toBe(404);
    // One answer for both, so an id tells a stranger nothing.
    expect(await readJson<ErrorBody>(unknown)).toEqual(await readJson<ErrorBody>(await getSeries(h, h.tokens.stranger)));

    // A stranger can neither pick nor forfeit in it.
    expect((await pick(h, h.tokens.stranger, 0)).status).toBe(404);
    expect((await forfeit(h, h.tokens.stranger)).status).toBe(404);
  });

  it("R259 a pick stays hidden until both are in; then game 1 starts with the right seats, decks and seed", async () => {
    const h = await harness();

    const afterAlice = await readJson<SeriesView>(await pick(h, h.tokens.alice, 1));
    expect(afterAlice).toMatchObject({ status: "picking", you: { pick: 1 } });
    expect(h.deps.matches.started).toHaveLength(0);

    const bobSees = await readJson<SeriesView>(await getSeries(h, h.tokens.bob));
    expect(bobSees.opponent).toEqual({
      wins: 0,
      decks: [
        { slot: 0, played: false },
        { slot: 1, played: false },
        { slot: 2, played: false },
      ],
      picked: true,
    });

    const afterBob = await readJson<SeriesView>(await pick(h, h.tokens.bob, 2));
    expect(afterBob).toMatchObject({ status: "playing", currentMatchId: FIRST_MATCH, gameNo: 1 });
    expect(h.deps.matches.started).toEqual([
      {
        matchId: FIRST_MATCH,
        seed: "seed-base:1",
        catalogVersion: h.deps.catalog.version,
        seats: [
          { profileId: ALICE, player: "p1", deck: ["alice-card-1a", "alice-card-1b"] },
          { profileId: BOB, player: "p2", deck: ["bob-card-2a", "bob-card-2b"] },
        ],
      },
    ]);
    expect(await inMatch(h)).toEqual([FIRST_MATCH, FIRST_MATCH]);
    expect((await h.deps.store.matches.get(FIRST_MATCH))?.status).toBe("live");
  });

  it("R259 a pick is refused: 400 for a slot out of range or already played, 409 while a game is played", async () => {
    const h = await harness();

    for (const slot of ["0", 3, -1, 0.5, null]) {
      const refused = await pick(h, h.tokens.alice, slot);
      expect(refused.status).toBe(400);
      expect((await readJson<ErrorBody>(refused)).error.code).toBe("bad_request");
    }

    await pickBoth(h, [0, 0]);
    const during = await pick(h, h.tokens.alice, 1);
    expect(during.status).toBe(409);
    expect((await readJson<ErrorBody>(during)).error.code).toBe("conflict");

    await finishGame(h, ALICE);
    const again = await pick(h, h.tokens.alice, 0);
    expect(again.status).toBe(400);
    expect((await readJson<ErrorBody>(again)).error.message).toMatch(/already played/u);
    expect((await pick(h, h.tokens.alice, 1)).status).toBe(200);
  });

  it("R259 game 2 puts series p2 first, and game 3 starts by itself with the one deck each has left", async () => {
    const h = await harness();
    await pickBoth(h, [0, 1]);
    await finishGame(h, ALICE);

    const game2 = await pickBoth(h, [2, 0]);
    const game2Id = game2.currentMatchId ?? "";
    expect(game2Id).not.toBe(FIRST_MATCH);
    expect(h.deps.matches.started[1]).toEqual({
      matchId: game2Id,
      seed: "seed-base:2",
      catalogVersion: h.deps.catalog.version,
      seats: [
        { profileId: BOB, player: "p1", deck: ["bob-card-0a", "bob-card-0b"] },
        { profileId: ALICE, player: "p2", deck: ["alice-card-2a", "alice-card-2b"] },
      ],
    });

    // Bob wins game 2 (he is the match's p1): 1–1, and game 3 needs no pick.
    await finishGame(h, BOB);
    const series = await row(h);
    expect(series.status).toBe("playing");
    expect(series.games[2]).toMatchObject({ gameNo: 3, slots: [1, 2], first: "p1" });
    expect(h.deps.matches.started[2]).toEqual({
      matchId: series.nextMatchId,
      seed: "seed-base:3",
      catalogVersion: h.deps.catalog.version,
      seats: [
        { profileId: ALICE, player: "p1", deck: ["alice-card-1a", "alice-card-1b"] },
        { profileId: BOB, player: "p2", deck: ["bob-card-2a", "bob-card-2b"] },
      ],
    });
    expect(await inMatch(h)).toEqual([series.nextMatchId, series.nextMatchId]);

    const view = await readJson<SeriesView>(await getSeries(h, h.tokens.bob));
    expect(view).toMatchObject({ status: "playing", gameNo: 3, currentMatchId: series.nextMatchId });
    expect(view.games.map((game) => [game.yourSlot, game.opponentSlot, game.youWentFirst, game.result])).toEqual([
      [1, 0, false, "loss"],
      [0, 2, true, "win"],
      [2, 1, false, null],
    ]);
  });

  it("R259 GET /api/matches/:matchId/series names the series a game belongs to, for its players only", async () => {
    const h = await harness();
    const read = async (token: string, matchId: string): Promise<{ series: SeriesView | null }> => {
      const answer = await h.router(jsonRequest("GET", `/api/matches/${matchId}/series`, undefined, { token }));
      expect(answer.status).toBe(200);
      return readJson<{ series: SeriesView | null }>(answer);
    };

    // Not a game yet: game 1's id is only reserved while its players pick.
    expect((await read(h.tokens.alice, FIRST_MATCH)).series).toBeNull();

    await pickBoth(h, [0, 0]);
    await finishGame(h, BOB);
    const afterGame1 = await read(h.tokens.alice, FIRST_MATCH);
    expect(afterGame1.series).toMatchObject({ id: SERIES_ID, status: "picking", gameNo: 2 });
    expect(afterGame1.series?.games[0]).toMatchObject({ matchId: FIRST_MATCH, result: "loss" });

    expect((await read(h.tokens.stranger, FIRST_MATCH)).series).toBeNull();
    expect((await read(h.tokens.alice, "some-other-match")).series).toBeNull();
  });
});

describe("R261 — endings inside a series", () => {
  it("R261 a concede or a disconnect loses the game, not the series", async () => {
    const h = await harness();
    await pickBoth(h, [0, 0]);
    await finishGame(h, ALICE, "concede");
    expect((await row(h)).status).toBe("picking");
    await pickBoth(h, [1, 1]);
    await finishGame(h, BOB, "disconnect");
    const series = await row(h);
    expect(series.status).toBe("playing");
    expect(series.sides.map((side) => side.wins)).toEqual([1, 1]);
    expect(series.games.map((game) => game.reason)).toEqual(["concede", "disconnect", null]);
  });

  it("R261 a drawn game counts for neither side; after three games equal wins is a series draw, rated once", async () => {
    const h = await harness([1200, 1000]);
    await pickBoth(h, [0, 0]);
    await finishGame(h, "draw");
    expect((await row(h)).sides.map((side) => side.wins)).toEqual([0, 0]);
    await pickBoth(h, [1, 1]);
    await finishGame(h, ALICE);
    await finishGame(h, BOB);

    const series = await row(h);
    expect(series).toMatchObject({ status: "over", winner: "draw", endReason: "exhausted" });
    const expected = eloUpdate(1200, 1000, 0.5);
    expect(await ratings(h)).toEqual([expected.a, expected.b]);
    expect(series.ratingBefore).toEqual([1200, 1000]);
    expect(series.ratingAfter).toEqual([expected.a, expected.b]);
    const view = await readJson<SeriesView>(await getSeries(h, h.tokens.bob));
    expect(view.result).toEqual({
      outcome: "draw",
      endReason: "exhausted",
      ratingBefore: 1000,
      ratingAfter: expected.b,
    });
    expect(await inMatch(h)).toEqual([null, null]);
  });

  it("R261 between games a player may forfeit: the other side wins, and the series is rated once (R262)", async () => {
    const h = await harness();
    await pickBoth(h, [0, 0]);
    await finishGame(h, BOB);
    // Bob leads 1–0 and forfeits anyway: alice takes the series.
    const answer = await forfeit(h, h.tokens.bob);
    expect(answer.status).toBe(200);
    const view = await readJson<SeriesView>(answer);
    const expected = eloUpdate(1000, 1000, 1);
    expect(view).toMatchObject({ status: "over", currentMatchId: null, pickDeadline: null });
    expect(view.result).toEqual({
      outcome: "loss",
      endReason: "forfeit",
      ratingBefore: 1000,
      ratingAfter: expected.b,
    });
    expect(await ratings(h)).toEqual([expected.a, expected.b]);
    // A game was played, so no reserved id is released.
    expect(h.discarded).toEqual([]);
    // Over is over: a second forfeit or a pick is a conflict.
    expect((await forfeit(h, h.tokens.alice)).status).toBe(409);
    expect((await pick(h, h.tokens.alice, 1)).status).toBe(409);
  });

  it("R261 a forfeit before game 1 releases the match id the pairing reserved (R263)", async () => {
    const h = await harness();
    expect((await forfeit(h, h.tokens.alice)).status).toBe(200);
    expect(h.discarded).toEqual([FIRST_MATCH]);
    expect(h.deps.matches.started).toEqual([]);
    expect((await row(h))).toMatchObject({ status: "over", winner: "p2", endReason: "forfeit", games: [] });
  });

  it("R261 a forfeit is refused with 409 while a game is being played: concede the game instead", async () => {
    const h = await harness();
    await pickBoth(h, [0, 0]);
    const refused = await forfeit(h, h.tokens.alice);
    expect(refused.status).toBe(409);
    const body = await readJson<ErrorBody>(refused);
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toMatch(/concede/u);
    expect((await row(h)).status).toBe("playing");
  });
});

describe("R262 — how a series is rated", () => {
  it("R262 a series decided at two wins moves Elo once, from the ratings before game 1; its games are unrated", async () => {
    const h = await harness([1200, 1000]);
    await pickBoth(h, [0, 0]);
    await finishGame(h, BOB);
    // Game 1's row: recorded, not rated.
    expect(h.deps.store.tables.results).toHaveLength(1);
    expect(h.deps.store.tables.results[0]).toMatchObject({
      matchId: FIRST_MATCH,
      winnerProfileId: BOB,
      ratingBefore: [1200, 1000],
      ratingAfter: [1200, 1000],
    });
    expect(await ratings(h)).toEqual([1200, 1000]);
    expect(await inMatch(h)).toEqual([null, null]);

    await pickBoth(h, [1, 1]);
    // Game 2: bob is the match's p1, so the row's seats are in his order.
    await finishGame(h, BOB);
    expect(h.deps.store.tables.results).toHaveLength(2);
    expect(h.deps.store.tables.results[1]).toMatchObject({
      winnerProfileId: BOB,
      players: [BOB, ALICE],
      ratingBefore: [1000, 1200],
      ratingAfter: [1000, 1200],
    });

    // The series: one move, scored as one match that bob won.
    const expected = eloUpdate(1200, 1000, 0);
    expect(await ratings(h)).toEqual([expected.a, expected.b]);
    const series = await row(h);
    expect(series).toMatchObject({
      status: "over",
      winner: "p2",
      endReason: "decided",
      ratingBefore: [1200, 1000],
      ratingAfter: [expected.a, expected.b],
    });
    expect(h.deps.matches.started).toHaveLength(2);

    const alice = await readJson<SeriesView>(await getSeries(h, h.tokens.alice));
    expect(alice.result).toEqual({
      outcome: "loss",
      endReason: "decided",
      ratingBefore: 1200,
      ratingAfter: expected.a,
    });
    expect(alice.gameNo).toBe(2);

    // A late second report of the deciding game changes nothing.
    await createRecordResult(h.deps)({
      matchId: series.games[1]?.matchId ?? "",
      seats: seatsOf(h, series.games[1]?.matchId ?? ""),
      outcome: { winner: "p2", reason: "concede" },
      turns: 1,
      at: h.deps.timers.now(),
    });
    expect(await ratings(h)).toEqual([expected.a, expected.b]);
    expect((await row(h)).version).toBe(series.version);
  });
});

describe("R260 — the pick clock", () => {
  it("R260 at the deadline the sweeper gives a player who has not picked their first unplayed deck, and the game starts", async () => {
    const h = await harness();
    expect((await pick(h, h.tokens.alice, 2)).status).toBe(200);

    h.deps.timers.advance(PICK_MS - 1);
    expect(await sweepSeries(h.deps)).toEqual({ timedOut: [], started: [] });
    expect(h.deps.matches.started).toHaveLength(0);

    h.deps.timers.advance(1);
    expect(await sweepSeries(h.deps)).toEqual({ timedOut: [SERIES_ID], started: [] });
    expect(h.deps.matches.started[0]?.seats).toEqual([
      { profileId: ALICE, player: "p1", deck: ["alice-card-2a", "alice-card-2b"] },
      { profileId: BOB, player: "p2", deck: ["bob-card-0a", "bob-card-0b"] },
    ]);
    expect(await inMatch(h)).toEqual([FIRST_MATCH, FIRST_MATCH]);
  });

  it("R260 a pick that arrives after the deadline is refused with 409", async () => {
    const h = await harness();
    h.deps.timers.advance(PICK_MS);
    const late = await pick(h, h.tokens.bob, 0);
    expect(late.status).toBe(409);
    expect((await readJson<ErrorBody>(late)).error.code).toBe("conflict");
  });

  it("R260 with no pick at all by the deadline the series is abandoned: no winner, unrated, game 1's id released", async () => {
    const h = await harness([1200, 1000]);
    h.deps.timers.advance(PICK_MS);
    await sweepSeries(h.deps);

    expect(await row(h)).toMatchObject({
      status: "over",
      winner: null,
      endReason: "abandoned",
      ratingBefore: null,
      ratingAfter: null,
    });
    expect(await ratings(h)).toEqual([1200, 1000]);
    expect(h.discarded).toEqual([FIRST_MATCH]);
    expect(h.deps.matches.started).toEqual([]);
    const view = await readJson<SeriesView>(await getSeries(h, h.tokens.alice));
    expect(view.result).toEqual({
      outcome: "abandoned",
      endReason: "abandoned",
      ratingBefore: null,
      ratingAfter: null,
    });
    // Not active any more: the sweeper leaves it alone from now on.
    expect(await h.deps.store.series.active()).toEqual([]);
  });

  it("R260 the sweeper runs every SERIES_SWEEP_INTERVAL_SECONDS on its own, and a failed sweep does not stop it", async () => {
    const h = await harness();
    const sweeper = startSeriesSweeper(h.deps);

    let failures = 1;
    h.deps.store.onCall = (method) => {
      if (method === "series.active" && failures > 0) {
        failures -= 1;
        throw new Error("the database went away");
      }
    };
    await advanceSweeping(h, SWEEP_MS);
    expect(h.deps.log.entries.some((entry) => entry.event === "series.sweeper_failed")).toBe(true);

    expect((await pick(h, h.tokens.bob, 1)).status).toBe(200);
    await advanceSweeping(h, PICK_MS);
    // The pick clock ran out between two sweeps; the next one settled it.
    expect((await row(h)).status).toBe("playing");
    expect(h.deps.matches.started[0]?.seats.map((seat) => seat.deck[0])).toEqual([
      "alice-card-0a",
      "bob-card-1a",
    ]);

    sweeper.stop();
    expect(h.deps.timers.pending).toBe(0);
    h.deps.timers.advance(10 * SWEEP_MS);
    await flush();
    expect(h.deps.timers.pending).toBe(0);
  });
});

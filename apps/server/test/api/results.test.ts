/**
 * BUILD M7-T2: "one integration test per reason".
 *
 * §2.5's seven endings each get a test — `hero-death`, `both-heroes-dead`, `concede`,
 * `draw-accepted`, `turn-cap`, `disconnect`, `match-ceiling` — and each one drives the scripted
 * engine to produce the outcome rather than hand-writing it, so the reason strings under test are
 * the ones `reduce` really emits. Then the two things §9.5 asks of the writer itself: it is
 * idempotent, and the reaper resolves anything past the ceiling.
 */

import { describe, expect, it } from "vitest";
import type { Action, ActionInput, PlayerId } from "@jackioh/shared";
import { createRecordResult, reapStuckMatches } from "../../src/api/results";
import { ensureSeriesGame, startSeries } from "../../src/api/series";
import { pickDeck } from "../../src/api/series-rules";
import { initialClocks, matchCeilingAt } from "../../src/match/clock";
import { eloUpdate } from "../../src/config";
import type { FrozenTrio, MatchSeat, ResultRow, SeriesRow } from "../../src/api/ports";
import type { TerminalOutcome } from "../../src/match/contracts";
import { createFakeMatchDirectory, createTestDeps, type TestDeps } from "../fakes/deps";
import { createFakeEngine, fakeDeck } from "../fakes/engine";

const MINUTE = 60 * 1000;
const MATCH_ID = "match-1";
const A = "profile-a";
const B = "profile-b";

const seats: readonly [MatchSeat, MatchSeat] = [
  // Hand slot 0 is `test-lethal` (one hero dies) and slot 1 `test-mutual-lethal` (both do), so the
  // two §2.5 endings that differ only in how many heroes the state check finds dead are reachable
  // from the same fixture and differ by nothing but which card is played.
  { profileId: A, player: "p1", deck: fakeDeck(["test-lethal", "test-mutual-lethal"]) },
  { profileId: B, player: "p2", deck: fakeDeck() },
];

/**
 * Runs the scripted engine (`test/fakes/engine.ts`) to a terminal state and hands back the
 * outcome and turn count the actor would pass to `recordResult`.
 */
function play(inputs: readonly ActionInput[]): { outcome: TerminalOutcome; turns: number } {
  const engine = createFakeEngine();
  let state = engine.beginGame(
    engine.createGame({ seed: "seed-1", decks: [[...seats[0].deck], [...seats[1].deck]] }),
  ).state;
  let n = 0;
  for (const input of inputs) {
    n += 1;
    const action = { ...input, nonce: `nonce-${String(n)}` } as Action;
    const result = engine.reduce(state, action);
    if (result.error !== undefined) throw new Error(`${input.type}: ${result.error}`);
    state = result.state;
  }
  const snapshot = engine.snapshot(state);
  if (snapshot.result === null) throw new Error("the scripted game did not end");
  return { outcome: snapshot.result, turns: snapshot.turn };
}

/** Thirty player-turns ends the match in a draw (§2.5, `FAKE_TURN_CAP`). */
function toTheTurnCap(): ActionInput[] {
  return Array.from({ length: 30 }, (_, i) => ({
    type: "endTurn" as const,
    playerId: (i % 2 === 0 ? "p1" : "p2") as PlayerId,
  }));
}

async function scenario(
  options: { ratings?: [number, number]; startedOffsetMs?: number } = {},
): Promise<TestDeps> {
  const deps = createTestDeps();
  const [ratingA, ratingB] = options.ratings ?? [1000, 1000];
  deps.store.seedProfile({ id: A, rating: ratingA, inMatchId: MATCH_ID });
  deps.store.seedProfile({ id: B, rating: ratingB, inMatchId: MATCH_ID });
  const startedAt = deps.timers.now() - (options.startedOffsetMs ?? 0);
  await deps.store.matches.create({
    id: MATCH_ID,
    seed: "seed-1",
    players: [A, B],
    decks: [[...seats[0].deck], [...seats[1].deck]],
    catalogVersion: deps.catalog.version,
    status: "live",
    createdAt: startedAt,
    finishedAt: null,
    clocks: initialClocks(startedAt, deps.config),
  });
  await deps.matches.start({
    matchId: MATCH_ID,
    seed: "seed-1",
    catalogVersion: deps.catalog.version,
    seats: [seats[0], seats[1]],
  });
  return deps;
}

async function record(deps: TestDeps, inputs: readonly ActionInput[]): Promise<ResultRow> {
  const { outcome, turns } = play(inputs);
  return createRecordResult(deps)({
    matchId: MATCH_ID,
    seats,
    outcome,
    turns,
    at: deps.timers.now(),
  });
}

/** §9.5: "Every ending records a result and clears both players' in-match state." */
async function expectOneEnding(
  deps: TestDeps,
  expected: { winner: string | null; reason: string; ratingAfter: [number, number] },
): Promise<void> {
  expect(deps.store.tables.results).toHaveLength(1);
  const row = deps.store.tables.results[0];
  expect(row?.matchId).toBe(MATCH_ID);
  expect(row?.players).toEqual([A, B]);
  expect(row?.winnerProfileId).toBe(expected.winner);
  expect(row?.reason).toBe(expected.reason);
  expect(row?.ratingAfter).toEqual(expected.ratingAfter);

  const [profileA, profileB] = [await deps.store.profiles.getById(A), await deps.store.profiles.getById(B)];
  expect([profileA?.rating, profileB?.rating]).toEqual(expected.ratingAfter);
  // Both, for every reason — M7-T1's "both can queue again".
  expect(profileA?.inMatchId).toBeNull();
  expect(profileB?.inMatchId).toBeNull();

  const match = await deps.store.matches.get(MATCH_ID);
  expect(match?.status).toBe("finished");
}

describe("results (M7-T2)", () => {
  // K = 32 from 1000 against an equally rated opponent: the expected score is 0.5, so the winner
  // takes 16 and the loser gives 16 (R79).
  const WIN = 1016;
  const LOSS = 984;

  it("hero-death: the winner is rated up and the loser down", async () => {
    const deps = await scenario();
    const row = await record(deps, [{ type: "play", instanceId: "p1-h0", playerId: "p1" }]);
    expect(row.reason).toBe("hero-death");
    expect(row.turns).toBe(1);
    expect(row.ratingBefore).toEqual([1000, 1000]);
    await expectOneEnding(deps, { winner: A, reason: "hero-death", ratingAfter: [WIN, LOSS] });
  });

  it("both-heroes-dead: both heroes dying in the same check is a draw, and rates as one (§2.5)", async () => {
    // The seventh reason `api/results.ts`'s own header names and `0004_matches.sql`'s `reason`
    // CHECK allows. It is the one ending that is a *draw produced by lethal damage*, so the thing
    // to prove is that the writer scores it 0.5/0.5 and names no winner — `scoreForSeat` decides
    // that on `outcome.winner === "draw"` alone, and a writer that read the reason instead (or
    // that treated "somebody died" as a win) would name A here.
    const deps = await scenario({ ratings: [1200, 1000] });
    const row = await record(deps, [{ type: "play", instanceId: "p1-h1", playerId: "p1" }]);

    // PREMISE: the scripted engine really produced this reason, so the assertions below are about
    // the writer and not about a string this file typed out.
    expect(row.reason).toBe("both-heroes-dead");
    expect(row.turns).toBe(1);
    expect(row.ratingBefore).toEqual([1200, 1000]);

    // The same Elo move a draw gets anywhere else (R79): the favourite gives, the underdog takes.
    const expected = eloUpdate(1200, 1000, 0.5);
    expect(expected.a).toBeLessThan(1200);
    expect(expected.b).toBeGreaterThan(1000);
    await expectOneEnding(deps, {
      winner: null,
      reason: "both-heroes-dead",
      ratingAfter: [expected.a, expected.b],
    });
  });

  it("concede: the conceding player loses (§2.5)", async () => {
    const deps = await scenario();
    await record(deps, [{ type: "concede", playerId: "p2" }]);
    await expectOneEnding(deps, { winner: A, reason: "concede", ratingAfter: [WIN, LOSS] });
  });

  it("draw-accepted: a draw moves both ratings toward each other", async () => {
    const deps = await scenario({ ratings: [1200, 1000] });
    const row = await record(deps, [
      { type: "offerDraw", playerId: "p1" },
      { type: "answerDraw", accept: true, playerId: "p2" },
    ]);
    const expected = eloUpdate(1200, 1000, 0.5);
    expect(row.ratingBefore).toEqual([1200, 1000]);
    // The favourite gives points away on a draw; the underdog takes them.
    expect(expected.a).toBeLessThan(1200);
    expect(expected.b).toBeGreaterThan(1000);
    await expectOneEnding(deps, {
      winner: null,
      reason: "draw-accepted",
      ratingAfter: [expected.a, expected.b],
    });
  });

  it("turn-cap: the 30th player-turn is a draw", async () => {
    const deps = await scenario();
    const row = await record(deps, toTheTurnCap());
    expect(row.turns).toBeGreaterThan(30);
    await expectOneEnding(deps, {
      winner: null,
      reason: "turn-cap",
      ratingAfter: [1000, 1000],
    });
  });

  it("disconnect: the disconnected player loses (§9.5)", async () => {
    const deps = await scenario();
    await record(deps, [{ type: "disconnectExpired", player: "p1", playerId: "p1" }]);
    await expectOneEnding(deps, { winner: B, reason: "disconnect", ratingAfter: [LOSS, WIN] });
  });

  it("match-ceiling: an actor-resolved ceiling is a draw with the ordinary Elo move (R112)", async () => {
    const deps = await scenario({ ratings: [1200, 1000] });
    const row = await record(deps, [{ type: "ceilingReached", playerId: "p1" }]);
    const expected = eloUpdate(1200, 1000, 0.5);
    expect(row.turns).toBe(1);
    await expectOneEnding(deps, {
      winner: null,
      reason: "match-ceiling",
      ratingAfter: [expected.a, expected.b],
    });
  });

  it("writes one row and rates once when it is called twice for the same match (§9.5)", async () => {
    const deps = await scenario();
    const first = await record(deps, [{ type: "concede", playerId: "p2" }]);
    const again = await createRecordResult(deps)({
      matchId: MATCH_ID,
      seats,
      // Even a different outcome cannot rewrite history: the row already written is returned.
      outcome: { winner: "p2", reason: "hero-death" },
      turns: 99,
      at: deps.timers.now() + 1,
    });
    expect(again).toEqual(first);
    await expectOneEnding(deps, { winner: A, reason: "concede", ratingAfter: [WIN, LOSS] });
  });

  it("clears a stray open queue ticket so both players can queue again (§9.5)", async () => {
    const deps = await scenario();
    await deps.store.tickets.insert({
      id: "ticket-a",
      profileId: A,
      rating: 1000,
      mode: "bo1",
      deck: [...seats[0].deck],
      trio: null,
      catalogVersion: deps.catalog.version,
      enqueuedAt: deps.timers.now(),
      status: "open",
      matchId: null,
    });
    await record(deps, [{ type: "concede", playerId: "p2" }]);
    expect(await deps.store.tickets.openForProfile(A)).toBeNull();
  });

  describe("the reaper (§9.5, R112)", () => {
    it("resolves a match past its ceiling as a draw and leaves both ratings unchanged (R112)", async () => {
      const deps = await scenario({ ratings: [1200, 1000], startedOffsetMs: 61 * MINUTE });
      const startedAt = deps.timers.now() - 61 * MINUTE;
      expect(matchCeilingAt(startedAt, deps.config)).toBeLessThan(deps.timers.now());

      expect(await reapStuckMatches(deps)).toEqual([MATCH_ID]);

      const row = deps.store.tables.results[0];
      // R112: "records `turns = 0` and leaves both ratings unchanged".
      expect(row?.turns).toBe(0);
      expect(row?.ratingBefore).toEqual([1200, 1000]);
      await expectOneEnding(deps, {
        winner: null,
        reason: "match-ceiling",
        ratingAfter: [1200, 1000],
      });
      // The in-memory actor is dropped; the log stays.
      expect(deps.matches.has(MATCH_ID)).toBe(false);
    });

    it("leaves a match that has not reached its ceiling alone", async () => {
      const deps = await scenario();
      expect(await reapStuckMatches(deps)).toEqual([]);
      expect(deps.store.tables.results).toHaveLength(0);
      expect(deps.matches.has(MATCH_ID)).toBe(true);
    });

    it("is a no-op once the actor has already recorded the ending", async () => {
      const deps = await scenario({ startedOffsetMs: 61 * MINUTE });
      await record(deps, [{ type: "concede", playerId: "p2" }]);
      expect(await reapStuckMatches(deps)).toEqual([]);
      await expectOneEnding(deps, { winner: A, reason: "concede", ratingAfter: [WIN, LOSS] });
    });

    it("keeps its own row when an actor reports the same match afterwards", async () => {
      const deps = await scenario({ ratings: [1200, 1000], startedOffsetMs: 61 * MINUTE });
      await reapStuckMatches(deps);
      const late = await record(deps, [{ type: "concede", playerId: "p2" }]);
      expect(late.reason).toBe("match-ceiling");
      await expectOneEnding(deps, {
        winner: null,
        reason: "match-ceiling",
        ratingAfter: [1200, 1000],
      });
    });
  });

  describe("a game of a Conquest series (R262, R263)", () => {
    const SERIES_ID = "series-1";

    function trio(owner: string): FrozenTrio {
      const deck = (slot: number) => ({ name: `${owner} ${String(slot)}`, cards: [`${owner}-${String(slot)}`] });
      return { name: owner, decks: [deck(0), deck(1), deck(2)] };
    }

    async function seriesRow(deps: TestDeps): Promise<SeriesRow> {
      const series = await deps.store.series.get(SERIES_ID);
      if (series === null) throw new Error("the series is gone");
      return series;
    }

    /**
     * The picks a side still owes, one compare-and-set each, then the game started as the pick
     * route starts it. A side whose last deck was picked for it (R332) is not asked.
     */
    async function playNext(deps: TestDeps, slots: [number, number]): Promise<SeriesRow> {
      const now = deps.timers.now();
      let row = await seriesRow(deps);
      for (const [index, seat] of (["p1", "p2"] as const).entries()) {
        if (row.status !== "picking" || row.sides[index]?.pick !== null) continue;
        const next = pickDeck(row, seat, slots[index] ?? 0, now);
        await deps.store.series.update(next);
        row = next;
      }
      await ensureSeriesGame(deps, row);
      return row;
    }

    /** The game in play ends with `winner` (a profile, or a draw), reported with the match's own seats. */
    async function finish(deps: TestDeps, winner: string | "draw"): Promise<void> {
      const series = await seriesRow(deps);
      const started = deps.matches.started.find((input) => input.matchId === series.nextMatchId);
      if (started === undefined) throw new Error(`${series.nextMatchId} was never started`);
      const seat = started.seats.find((candidate) => candidate.profileId === winner);
      await createRecordResult(deps)({
        matchId: series.nextMatchId,
        seats: started.seats,
        outcome: { winner: winner === "draw" ? "draw" : (seat?.player ?? "p1"), reason: winner === "draw" ? "draw-accepted" : "hero-death" },
        turns: 3,
        at: deps.timers.now(),
      });
    }

    /** A in series seat p1 at 1200, B in p2 at 1000, game 1 (match `MATCH_ID`) being played. */
    async function seriesScenario(): Promise<TestDeps> {
      const deps = createTestDeps();
      deps.matches = createFakeMatchDirectory(deps.store);
      deps.store.seedProfile({ id: A, rating: 1200 });
      deps.store.seedProfile({ id: B, rating: 1000 });
      await startSeries(deps, {
        seriesId: SERIES_ID,
        firstMatchId: MATCH_ID,
        sides: [
          { profileId: A, trio: trio("a") },
          { profileId: B, trio: trio("b") },
        ],
        seedBase: "seed",
        catalogVersion: deps.catalog.version,
      });
      await playNext(deps, [0, 0]);
      return deps;
    }

    it("R262 a series game's row leaves both ratings unchanged, and the series records the game in the same write", async () => {
      const deps = await seriesScenario();
      // Game 1: series p1 (A) goes first, so the match's p1 is A, as in `seats`.
      const row = await record(deps, [{ type: "concede", playerId: "p2" }]);

      expect(row).toMatchObject({
        winnerProfileId: A,
        reason: "concede",
        ratingBefore: [1200, 1000],
        ratingAfter: [1200, 1000],
      });
      expect([(await deps.store.profiles.getById(A))?.rating, (await deps.store.profiles.getById(B))?.rating]).toEqual([
        1200, 1000,
      ]);
      const series = await seriesRow(deps);
      expect(series.status).toBe("picking");
      expect(series.games[0]).toMatchObject({ matchId: MATCH_ID, winner: "p1", reason: "concede" });
      expect(series.sides.map((side) => side.wins)).toEqual([1, 0]);
      // Everything else a result does, it still does.
      expect((await deps.store.profiles.getById(A))?.inMatchId).toBeNull();
      expect((await deps.store.matches.get(MATCH_ID))?.status).toBe("finished");
      expect(deps.log.entries.find((entry) => entry.event === "match.ended")?.data).toMatchObject({
        ratingPolicy: "unchanged",
        seriesId: SERIES_ID,
      });
    });

    it("R263 the reaper's ceiling draw counts for neither side, and a next game both sides' last decks begin is started (R332)", async () => {
      const deps = await seriesScenario();
      await finish(deps, A);
      await playNext(deps, [1, 0]);
      await finish(deps, B);
      await playNext(deps, [1, 1]);
      await finish(deps, A);
      await playNext(deps, [2, 1]);
      await finish(deps, B);
      // Two wins each: game 5 began by itself, on each side's last deck.
      const game5 = await seriesRow(deps);
      expect(game5.status).toBe("playing");
      const game5Id = game5.nextMatchId;
      expect(game5.games[4]).toMatchObject({ gameNo: 5, slots: [2, 2] });

      // The fake directory's rows carry a ceiling of 0, so game 5 is long past it.
      expect(await reapStuckMatches(deps)).toEqual([game5Id]);
      const reaped = deps.store.tables.results.find((result) => result.matchId === game5Id);
      expect(reaped).toMatchObject({ reason: "match-ceiling", turns: 0, ratingBefore: [1200, 1000], ratingAfter: [1200, 1000] });

      const series = await seriesRow(deps);
      expect(series.sides.map((side) => side.wins)).toEqual([2, 2]);
      expect(series.games[4]).toMatchObject({ winner: "draw", reason: "match-ceiling" });
      expect(series.status).toBe("playing");
      expect(series.games[5]).toMatchObject({ gameNo: 6, slots: [2, 2], first: "p2" });
      const game6 = deps.matches.started.find((input) => input.matchId === series.nextMatchId);
      expect(game6).toMatchObject({ seed: "seed:6" });
      expect(game6?.seats.map((seat) => seat.profileId)).toEqual([B, A]);
      expect((await deps.store.profiles.getById(B))?.inMatchId).toBe(series.nextMatchId);
      expect([(await deps.store.profiles.getById(A))?.rating, (await deps.store.profiles.getById(B))?.rating]).toEqual([
        1200, 1000,
      ]);
    });

    it("R262 the game that ends the series moves both ratings once, from where the series began", async () => {
      const deps = await seriesScenario();
      await record(deps, [{ type: "concede", playerId: "p2" }]);
      await playNext(deps, [1, 1]);
      // Game 2: B is the match's p1. A wins it.
      await finish(deps, A);
      // Game 3: A's last deck is picked for A (R332); B picks, and A wins with every deck.
      const game3 = await playNext(deps, [2, 2]);
      expect(game3.games[2]?.slots).toEqual([2, 2]);
      await finish(deps, A);
      const expected = eloUpdate(1200, 1000, 1);
      expect([(await deps.store.profiles.getById(A))?.rating, (await deps.store.profiles.getById(B))?.rating]).toEqual([
        expected.a,
        expected.b,
      ]);
      expect(await seriesRow(deps)).toMatchObject({
        status: "over",
        winner: "p1",
        endReason: "decided",
        ratingBefore: [1200, 1000],
        ratingAfter: [expected.a, expected.b],
      });
      // Every game row is unrated.
      expect(deps.store.tables.results).toHaveLength(3);
      for (const result of deps.store.tables.results) expect(result.ratingAfter).toEqual(result.ratingBefore);
    });
  });
});

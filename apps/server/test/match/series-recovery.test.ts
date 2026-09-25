/**
 * SPEC §11 R263: a Best-of-3 series survives a restart.
 *
 * A series is a database row written by compare-and-set; a game's result, the series' record of it
 * and (when the game ends the series) the rating move commit in one transaction; and a sweeper
 * starts any game whose picks are in but whose match is not running, once the row has sat unchanged
 * for `SERIES_START_GRACE_SECONDS`. Each of those is checked here the way it can fail:
 *
 *  - a crash between "both picked" and "match started" (the playing row written, no start);
 *  - a restart: a second `ServerDeps` over the same store — a fresh match directory, fresh ids —
 *    carries on a series the first one began;
 *  - a store failure in the middle of the result's transaction, which must take the series advance
 *    and the rating move down with the result row;
 *  - a lost compare-and-set, which is re-read and re-applied rather than dropped;
 *  - two starts racing for the same game.
 */

import { describe, expect, it } from "vitest";

import { createRouter, type Router } from "../../src/api/http";
import type { FrozenTrio, Ids, MatchDirectory, SeriesRow } from "../../src/api/ports";
import { createRecordResult } from "../../src/api/results";
import { createSeriesRoutes, ensureSeriesGame, startSeries, sweepSeries } from "../../src/api/series";
import { gameEnded, pickDeck, type SeriesView } from "../../src/api/series-rules";
import { SERIES_START_GIVE_UP_SECONDS, SERIES_START_GRACE_SECONDS, eloUpdate } from "../../src/config";
import {
  createFakeMatchDirectory,
  createTestDeps,
  jsonRequest,
  readJson,
  type TestDeps,
} from "../fakes/deps";
import type { MemoryStore } from "../fakes/store";

const ALICE = "profile-alice";
const BOB = "profile-bob";
const SERIES_ID = "series-1";
const FIRST_MATCH = "match-1";
const GRACE_MS = SERIES_START_GRACE_SECONDS * 1000;
const GIVE_UP_MS = SERIES_START_GIVE_UP_SECONDS * 1000;

function trio(owner: string): FrozenTrio {
  const deck = (slot: number) => ({
    name: `${owner} deck ${String(slot)}`,
    cards: [`${owner}-card-${String(slot)}a`, `${owner}-card-${String(slot)}b`],
  });
  return { name: `${owner}'s trio`, decks: [deck(0), deck(1), deck(2)] };
}

/** Ids for one "process", prefixed so a second process over the same store mints no id twice. */
function processIds(prefix: string): Ids {
  let n = 0;
  const next = (): string => {
    n += 1;
    return `${prefix}-${String(n)}`;
  };
  return { uuid: () => `${next()}-id`, seed: () => `${next()}-seed`, code: (length) => next().slice(0, length) };
}

type Process = {
  deps: TestDeps;
  router: Router;
  tokens: { alice: string; bob: string };
};

/** One server process. Pass `store` (and the clock) to "restart" over the database another left. */
function boot(prefix: string, from?: Process): Process {
  const deps = createTestDeps({
    ids: processIds(prefix),
    ...(from === undefined ? {} : { store: from.deps.store, timers: from.deps.timers }),
  });
  deps.matches = createFakeMatchDirectory(deps.store);
  if (from === undefined) {
    deps.store.seedProfile({ id: ALICE, userId: `user-${ALICE}`, status: "active", rating: 1000 });
    deps.store.seedProfile({ id: BOB, userId: `user-${BOB}`, status: "active", rating: 1000 });
  }
  const tokens = {
    alice: deps.auth.addUser({ userId: `user-${ALICE}`, email: "alice@example.test" }),
    bob: deps.auth.addUser({ userId: `user-${BOB}`, email: "bob@example.test" }),
  };
  return { deps, router: createRouter(createSeriesRoutes(), deps), tokens };
}

async function begin(process: Process): Promise<SeriesRow> {
  return startSeries(process.deps, {
    seriesId: SERIES_ID,
    firstMatchId: FIRST_MATCH,
    sides: [
      { profileId: ALICE, trio: trio("alice") },
      { profileId: BOB, trio: trio("bob") },
    ],
    seedBase: "seed-base",
    catalogVersion: process.deps.catalog.version,
  });
}

async function row(store: MemoryStore): Promise<SeriesRow> {
  const series = await store.series.get(SERIES_ID);
  if (series === null) throw new Error("the series is gone");
  return series;
}

async function pick(process: Process, token: string, slot: number): Promise<Response> {
  return process.router(jsonRequest("POST", `/api/series/${SERIES_ID}/pick`, { slot }, { token }));
}

async function pickBoth(process: Process, slots: [number, number]): Promise<SeriesView> {
  expect((await pick(process, process.tokens.alice, slots[0])).status).toBe(200);
  const answer = await pick(process, process.tokens.bob, slots[1]);
  expect(answer.status).toBe(200);
  return readJson<SeriesView>(answer);
}

/**
 * The game in play ends as the actor would report it, from the seats in the match row — which a
 * restarted process reads from the store, not from its own memory.
 */
async function finishGame(process: Process, winner: string | "draw"): Promise<void> {
  const series = await row(process.deps.store);
  const match = await process.deps.store.matches.get(series.nextMatchId);
  if (match === null) throw new Error(`${series.nextMatchId} has no match row`);
  const seats = [
    { profileId: match.players[0], player: "p1" as const, deck: match.decks[0] },
    { profileId: match.players[1], player: "p2" as const, deck: match.decks[1] },
  ] as const;
  const winnerSeat = seats.find((seat) => seat.profileId === winner);
  await createRecordResult(process.deps)({
    matchId: match.id,
    seats,
    outcome: { winner: winner === "draw" ? "draw" : (winnerSeat?.player ?? "p1"), reason: "hero-death" },
    turns: 5,
    at: process.deps.timers.now(),
  });
}

/**
 * Both picks written the way two requests write them — one compare-and-set each — and nothing
 * after: the state a process leaves when it dies between committing the second pick and starting
 * the match.
 */
async function writePicksOnly(
  store: MemoryStore,
  series: SeriesRow,
  slots: [number, number],
  now: number,
): Promise<SeriesRow> {
  const one = pickDeck(series, "p1", slots[0], now);
  expect(await store.series.update(one)).toBe(true);
  const both = pickDeck(one, "p2", slots[1], now);
  expect(await store.series.update(both)).toBe(true);
  expect(both.status).toBe("playing");
  return both;
}

async function inMatch(store: MemoryStore): Promise<(string | null | undefined)[]> {
  return [(await store.profiles.getById(ALICE))?.inMatchId, (await store.profiles.getById(BOB))?.inMatchId];
}

describe("R263 — a series survives a restart", () => {
  it("R263 a series whose picks landed but whose match never started is started by the sweeper after the grace", async () => {
    const a = boot("a");
    const series = await begin(a);
    // The crash: both picks are in the row, and the process died before `matches.start`.
    await writePicksOnly(a.deps.store, series, [0, 1], a.deps.timers.now());

    // Inside the grace the sweeper leaves it to the request that may be starting it right now.
    a.deps.timers.advance(GRACE_MS - 1);
    expect(await sweepSeries(a.deps)).toEqual({ timedOut: [], started: [], abandoned: [] });
    expect(a.deps.matches.started).toEqual([]);

    a.deps.timers.advance(1);
    expect(await sweepSeries(a.deps)).toEqual({ timedOut: [], started: [SERIES_ID], abandoned: [] });
    expect(a.deps.matches.started).toEqual([
      {
        matchId: FIRST_MATCH,
        seed: "seed-base:1",
        catalogVersion: a.deps.catalog.version,
        seats: [
          { profileId: ALICE, player: "p1", deck: ["alice-card-0a", "alice-card-0b"] },
          { profileId: BOB, player: "p2", deck: ["bob-card-1a", "bob-card-1b"] },
        ],
      },
    ]);
    expect(await inMatch(a.deps.store)).toEqual([FIRST_MATCH, FIRST_MATCH]);

    // Running now: the next sweeps do nothing.
    a.deps.timers.advance(GRACE_MS);
    expect(await sweepSeries(a.deps)).toEqual({ timedOut: [], started: [], abandoned: [] });
    expect(a.deps.matches.started).toHaveLength(1);
  });

  it("R263 a game that can never be started ends the series abandoned and unrated, and lets both players go", async () => {
    const a = boot("a");
    await begin(a);
    // Every start fails: the frozen decks no longer build a game (a catalog change, say).
    a.deps.matches.start = async () => {
      throw new Error("createGame refused the frozen decks");
    };
    await pickBoth(a, [1, 2]);
    expect(await a.deps.store.series.activeFor(ALICE)).not.toBeNull();

    // Inside the give-up window the sweeper keeps trying to start it.
    a.deps.timers.advance(GIVE_UP_MS - 1);
    expect(await sweepSeries(a.deps)).toEqual({ timedOut: [], started: [], abandoned: [] });
    expect((await row(a.deps.store)).status).toBe("playing");

    a.deps.timers.advance(1);
    expect(await sweepSeries(a.deps)).toEqual({ timedOut: [], started: [], abandoned: [SERIES_ID] });
    const ended = await row(a.deps.store);
    expect(ended).toMatchObject({ status: "over", winner: null, endReason: "abandoned", ratingBefore: null });
    // The game that never started is not on the record.
    expect(ended.games).toEqual([]);
    expect(await a.deps.store.series.activeFor(ALICE)).toBeNull();
    expect(await a.deps.store.series.activeFor(BOB)).toBeNull();
    expect((await a.deps.store.profiles.getById(ALICE))?.rating).toBe(1000);
  });

  it("R263 never gives up a game whose match did start, however long it has run", async () => {
    const a = boot("a");
    await begin(a);
    await pickBoth(a, [0, 0]);
    // A restart: the match row is live in the store, its actor not yet rebuilt in memory.
    const b = boot("b", a);
    b.deps.timers.advance(GIVE_UP_MS * 2);
    expect(await sweepSeries(b.deps)).toEqual({ timedOut: [], started: [], abandoned: [] });
    expect((await row(b.deps.store)).status).toBe("playing");
  });

  it("R263 a restart between both picks and the match start heals itself in the new process", async () => {
    const a = boot("a");
    await begin(a);
    // The first process accepts both picks and dies as it starts the match.
    a.deps.matches.start = async () => {
      throw new Error("the process exited");
    };
    const view = await pickBoth(a, [2, 2]);
    // The picks were committed; the answer still names the game.
    expect(view).toMatchObject({ status: "playing", currentMatchId: FIRST_MATCH });
    expect(a.deps.log.entries.some((entry) => entry.event === "series.start_failed")).toBe(true);
    expect(await a.deps.store.matches.get(FIRST_MATCH)).toBeNull();

    const b = boot("b", a);
    b.deps.timers.advance(GRACE_MS);
    expect(await sweepSeries(b.deps)).toEqual({ timedOut: [], started: [SERIES_ID], abandoned: [] });
    expect(b.deps.matches.started[0]).toMatchObject({ matchId: FIRST_MATCH, seed: "seed-base:1" });
    expect(await inMatch(b.deps.store)).toEqual([FIRST_MATCH, FIRST_MATCH]);
  });

  it("R263 a new process over the same store carries on a series the old one began", async () => {
    const a = boot("a");
    await begin(a);
    await pickBoth(a, [0, 0]);
    expect(a.deps.matches.started).toHaveLength(1);

    // Restart: the match row is in the store, its actor is not in the new process's memory.
    const b = boot("b", a);
    expect(b.deps.matches.has(FIRST_MATCH)).toBe(false);
    b.deps.timers.advance(GRACE_MS);
    // The match exists, so the sweeper does not start it again: the registry folds its log back on
    // the first socket (§9.5).
    expect(await sweepSeries(b.deps)).toEqual({ timedOut: [], started: [], abandoned: [] });
    expect(b.deps.matches.started).toEqual([]);

    // Its actor, rebuilt in the new process, reports the result.
    await finishGame(b, ALICE);
    const afterGame1 = await row(b.deps.store);
    expect(afterGame1).toMatchObject({ status: "picking" });
    expect(afterGame1.nextMatchId).toMatch(/^b-/u);

    // The players pick through the new process and game 2 starts there.
    const game2 = await pickBoth(b, [1, 1]);
    expect(game2.currentMatchId).toBe(afterGame1.nextMatchId);
    expect(b.deps.matches.started[0]).toMatchObject({
      matchId: afterGame1.nextMatchId,
      seed: "seed-base:2",
    });
    expect(b.deps.matches.started[0]?.seats[0]?.profileId).toBe(BOB);

    // Alice wins again: her last deck is picked for her (R332), and that pick is in the row, so a
    // third process finds it there and only waits for Bob's.
    await finishGame(b, ALICE);
    const c = boot("c", b);
    const aliceSees = await readJson<SeriesView>(
      await c.router(jsonRequest("GET", `/api/series/${SERIES_ID}`, undefined, { token: c.tokens.alice })),
    );
    expect(aliceSees.you).toMatchObject({ pick: 2, autoPick: true });
    expect((await pick(c, c.tokens.bob, 0)).status).toBe(200);
    expect(c.deps.matches.started[0]?.seats.map((seat) => seat.deck[0])).toEqual(["alice-card-2a", "bob-card-0a"]);
    await finishGame(c, ALICE);
    expect(await row(c.deps.store)).toMatchObject({ status: "over", winner: "p1", endReason: "decided" });
  });

  it("R331 a pick made before a restart is kept by the next process, and still sealed and hidden", async () => {
    const a = boot("a");
    await begin(a);
    expect((await pick(a, a.tokens.alice, 2)).status).toBe(200);

    const b = boot("b", a);
    const bobSees = await readJson<SeriesView>(
      await b.router(jsonRequest("GET", `/api/series/${SERIES_ID}`, undefined, { token: b.tokens.bob })),
    );
    expect(bobSees.opponent.picked).toBe(true);
    expect(JSON.stringify(bobSees)).not.toMatch(/alice/u);
    // Sealed across the restart too: Alice cannot change it in the new process.
    expect((await pick(b, b.tokens.alice, 1)).status).toBe(409);
    expect((await pick(b, b.tokens.bob, 1)).status).toBe(200);
    expect(b.deps.matches.started[0]?.seats.map((seat) => seat.deck[0])).toEqual(["alice-card-2a", "bob-card-1a"]);
  });

  it("R263 a store failure inside the result's transaction rolls back the series advance with the result", async () => {
    const a = boot("a");
    await begin(a);
    await pickBoth(a, [0, 0]);
    const playing = await row(a.deps.store);

    a.deps.store.onCall = (method) => {
      if (method === "series.update") throw new Error("the connection dropped");
    };
    await expect(finishGame(a, BOB)).rejects.toThrow(/connection dropped/u);

    // Nothing of the ending landed: no result row, the series still playing that game, the match
    // still live and both players still in it.
    expect(a.deps.store.tables.results).toEqual([]);
    expect(await row(a.deps.store)).toEqual(playing);
    expect((await a.deps.store.matches.get(FIRST_MATCH))?.status).toBe("live");
    expect(await inMatch(a.deps.store)).toEqual([FIRST_MATCH, FIRST_MATCH]);

    a.deps.store.onCall = null;
    await finishGame(a, BOB);
    expect(a.deps.store.tables.results).toHaveLength(1);
    expect(await row(a.deps.store)).toMatchObject({ status: "picking", version: playing.version + 1 });
  });

  it("R263 a failure writing the series' rating move rolls back the deciding game's result too", async () => {
    const a = boot("a");
    await begin(a);
    await pickBoth(a, [0, 0]);
    await finishGame(a, ALICE);
    await pickBoth(a, [1, 1]);
    await finishGame(a, ALICE);
    // Alice's last deck is picked for her (R332); Bob's pick starts the deciding game.
    expect((await pick(a, a.tokens.bob, 0)).status).toBe(200);
    const deciding = await row(a.deps.store);

    a.deps.store.onCall = (method) => {
      if (method === "profiles.setRating") throw new Error("the connection dropped");
    };
    await expect(finishGame(a, ALICE)).rejects.toThrow(/connection dropped/u);
    expect(a.deps.store.tables.results).toHaveLength(2);
    expect(await row(a.deps.store)).toEqual(deciding);
    expect((await a.deps.store.profiles.getById(ALICE))?.rating).toBe(1000);

    a.deps.store.onCall = null;
    await finishGame(a, ALICE);
    const expected = eloUpdate(1000, 1000, 1);
    expect(a.deps.store.tables.results).toHaveLength(3);
    expect((await a.deps.store.profiles.getById(ALICE))?.rating).toBe(expected.a);
    expect(await row(a.deps.store)).toMatchObject({ status: "over", ratingAfter: [expected.a, expected.b] });
  });
});

describe("R263 — every write is a compare-and-set", () => {
  it("R263 a pick that loses the compare-and-set is re-applied to the row that won, and completes the game", async () => {
    const a = boot("a");
    await begin(a);
    const update = a.deps.store.series.update;
    let raced = false;
    a.deps.store.series.update = async (next) => {
      if (!raced) {
        // Bob's pick lands between alice's read and her write.
        raced = true;
        const current = await a.deps.store.series.get(next.id);
        if (current !== null) expect(await update(pickDeck(current, "p2", 2, a.deps.timers.now()))).toBe(true);
      }
      return update(next);
    };

    const answer = await pick(a, a.tokens.alice, 1);
    expect(answer.status).toBe(200);
    expect(await readJson<SeriesView>(answer)).toMatchObject({ status: "playing", currentMatchId: FIRST_MATCH });
    const series = await row(a.deps.store);
    expect(series.games[0]?.slots).toEqual([1, 2]);
    expect(series.version).toBe(3);
    expect(a.deps.matches.started).toHaveLength(1);
  });

  it("R263 a write that keeps losing is refused with 409 and writes nothing", async () => {
    const a = boot("a");
    const series = await begin(a);
    a.deps.store.series.update = async () => false;
    const answer = await pick(a, a.tokens.alice, 0);
    expect(answer.status).toBe(409);
    expect(await row(a.deps.store)).toEqual(series);
  });

  it("R263 a result whose series write loses the compare-and-set re-reads the series and records the game", async () => {
    const a = boot("a");
    await begin(a);
    await pickBoth(a, [0, 0]);
    const update = a.deps.store.series.update;
    let raced = false;
    a.deps.store.series.update = async (next) => {
      if (!raced) {
        // Another writer touched the row (same state, next version) just before this one.
        raced = true;
        const current = await a.deps.store.series.get(next.id);
        if (current !== null) await update({ ...current, version: current.version + 1 });
      }
      return update(next);
    };
    const before = await row(a.deps.store);
    await finishGame(a, BOB);
    const after = await row(a.deps.store);
    expect(after).toMatchObject({ status: "picking", version: before.version + 2 });
    expect(after.games[0]?.winner).toBe("p2");
    expect(a.deps.store.tables.results).toHaveLength(1);
  });

  it("R263 two starts racing for one game make one match: the loser finds the winner's row and stops", async () => {
    const a = boot("a");
    const series = await begin(a);
    const now = a.deps.timers.now();
    const playing = await writePicksOnly(a.deps.store, series, [0, 0], now);

    // A directory whose start loses to another process that wrote the row a moment earlier.
    const loser: MatchDirectory = {
      start: async (input) => {
        await createFakeMatchDirectory(a.deps.store).start(input);
        throw new Error("matches.id is unique");
      },
      has: () => false,
      stop: async () => undefined,
    };
    a.deps.matches = Object.assign(loser, { started: [] });
    await expect(ensureSeriesGame(a.deps, playing)).resolves.toBeUndefined();
    expect((await a.deps.store.matches.get(FIRST_MATCH))?.status).toBe("live");

    // A start that fails for any other reason is not swallowed.
    const broken = boot("c");
    const other = await begin(broken);
    const playingToo = await writePicksOnly(broken.deps.store, other, [0, 0], now);
    broken.deps.matches.start = async () => {
      throw new Error("the engine could not be loaded");
    };
    await expect(ensureSeriesGame(broken.deps, playingToo)).rejects.toThrow(/engine/u);
  });

  it("R263 a started match whose in-match flags were lost to a crash gets them back from the sweeper", async () => {
    const a = boot("a");
    await begin(a);
    await pickBoth(a, [0, 0]);
    for (const id of [ALICE, BOB]) await a.deps.store.profiles.setInMatch(id, null);

    const b = boot("b", a);
    b.deps.timers.advance(GRACE_MS);
    expect(await sweepSeries(b.deps)).toEqual({ timedOut: [], started: [], abandoned: [] });
    expect(await inMatch(b.deps.store)).toEqual([FIRST_MATCH, FIRST_MATCH]);
  });

  it("R263 a series game the store says has ended with no result is reported, never replayed", async () => {
    const a = boot("a");
    await begin(a);
    await pickBoth(a, [0, 0]);
    // The actor's own `finish` landed but its result write did not.
    await a.deps.store.matches.finish(FIRST_MATCH, a.deps.timers.now());

    const b = boot("b", a);
    b.deps.timers.advance(GRACE_MS);
    expect(await sweepSeries(b.deps)).toEqual({ timedOut: [], started: [], abandoned: [] });
    expect(b.deps.matches.started).toEqual([]);
    expect(b.deps.log.entries.some((entry) => entry.event === "series.game_unrecorded")).toBe(true);
    // The rules still refuse to end a game twice.
    const series = await row(b.deps.store);
    expect(() => gameEnded(gameEnded(series, "p1", "concede", 0, "x"), "p1", "concede", 0, "y")).toThrow();
  });
});

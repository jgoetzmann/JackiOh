/**
 * The Best-of-3 series' pure rules (`src/api/series-rules.ts`, SPEC §9.5, R259–R263).
 *
 * No store, no clock and no router: every transition is a function of a row and a time, so each
 * ruling is checked here exhaustively on hand-built rows, and `series.test.ts` /
 * `test/match/series-recovery.test.ts` check the same rulings once more through the server.
 *
 * The two trios are built from the owners' names ("alice", "bob"), so "the projection never
 * carries the opponent's deck names or cards" is a substring search: nothing in bob's view may
 * contain "alice", whatever state the series is in.
 */

import { describe, expect, it } from "vitest";
import { TRIO_DECKS } from "@jackioh/validator";

import {
  SERIES_MAX_GAMES,
  SERIES_PICK_SECONDS,
  SERIES_WINS_NEEDED,
  eloUpdate,
} from "../../src/config";
import type { FrozenTrio, SeriesRow, SeriesSeat } from "../../src/api/ports";
import {
  SeriesRefusal,
  beginGame,
  bothPicked,
  firstUnplayed,
  forfeitSeries,
  gameEnded,
  gameSeats,
  newSeries,
  pickDeck,
  projectSeries,
  rateSeries,
  seriesScore,
  timeoutPicks,
  type SeriesRefusalReason,
  type SeriesView,
} from "../../src/api/series-rules";

const NOW = 1_700_000_000_000;
const PICK_MS = SERIES_PICK_SECONDS * 1000;
const ALICE = "profile-alice";
const BOB = "profile-bob";

function trio(owner: string): FrozenTrio {
  const deck = (slot: number) => ({
    name: `${owner} deck ${String(slot)}`,
    cards: [`${owner}-card-${String(slot)}a`, `${owner}-card-${String(slot)}b`],
  });
  return { name: `${owner}'s trio`, decks: [deck(0), deck(1), deck(2)] };
}

function fresh(now = NOW): SeriesRow {
  return newSeries(
    {
      seriesId: "series-1",
      firstMatchId: "match-1",
      sides: [
        { profileId: ALICE, trio: trio("alice") },
        { profileId: BOB, trio: trio("bob") },
      ],
      seedBase: "seed-base",
      catalogVersion: "v1",
    },
    now,
  );
}

/** Both sides pick (when the game is not already under way), then the game ends. */
function play(
  series: SeriesRow,
  slots: [number, number],
  winner: SeriesSeat | "draw",
  nextMatchId: string,
  now = NOW,
): SeriesRow {
  let row = series;
  if (row.status === "picking") {
    row = pickDeck(row, "p1", slots[0], now);
    row = pickDeck(row, "p2", slots[1], now);
  }
  return gameEnded(row, winner, winner === "draw" ? "turn-cap" : "hero-death", now, nextMatchId);
}

function refusalOf(run: () => unknown): SeriesRefusalReason | null {
  try {
    run();
  } catch (error) {
    if (error instanceof SeriesRefusal) return error.reason;
    throw error;
  }
  return null;
}

function viewOf(series: SeriesRow, profileId: string, now = NOW): SeriesView {
  const view = projectSeries(series, profileId, now);
  if (view === null) throw new Error(`${profileId} is not in the series`);
  return view;
}

describe("R259 — the Best-of-3 series", () => {
  it("R259 SERIES_MAX_GAMES is the validator's TRIO_DECKS: one game per deck of a trio", () => {
    expect(SERIES_MAX_GAMES).toBe(TRIO_DECKS);
    // Two wins of three: a side at `SERIES_WINS_NEEDED` has won a majority of the most games.
    expect(SERIES_WINS_NEEDED * 2).toBeGreaterThan(SERIES_MAX_GAMES);
  });

  it("R259 a new series opens game 1's pick phase on the reserved match id, at version 1", () => {
    const series = fresh();
    expect(series).toMatchObject({
      status: "picking",
      games: [],
      nextMatchId: "match-1",
      pickDeadline: NOW + PICK_MS,
      winner: null,
      endReason: null,
      ratingBefore: null,
      ratingAfter: null,
      createdAt: NOW,
      updatedAt: NOW,
      endedAt: null,
      version: 1,
    });
    expect(series.sides.map((side) => [side.profileId, side.wins, side.pick])).toEqual([
      [ALICE, 0, null],
      [BOB, 0, null],
    ]);
    const view = viewOf(series, ALICE);
    expect(view.gameNo).toBe(1);
    expect(view.currentMatchId).toBeNull();
    expect(view.you.seat).toBe("p1");
    expect(viewOf(series, BOB).you.seat).toBe("p2");
  });

  it("R259 a pick is hidden from the opponent until both have picked: they see only that one is in", () => {
    const before = fresh();
    const picked = pickDeck(before, "p1", 2, NOW);

    // The row holds it, and its owner sees it.
    expect(picked.sides[0].pick).toBe(2);
    expect(bothPicked(picked)).toBe(false);
    expect(viewOf(picked, ALICE).you.pick).toBe(2);

    // Bob's view changes in exactly one bit: `opponent.picked`.
    const bobBefore = viewOf(before, BOB);
    const bobAfter = viewOf(picked, BOB);
    expect(bobBefore.opponent.picked).toBe(false);
    expect(bobAfter.opponent.picked).toBe(true);
    expect({ ...bobAfter, opponent: { ...bobAfter.opponent, picked: false } }).toEqual(bobBefore);
    expect(Object.keys(bobAfter.opponent).sort()).toEqual(["decks", "picked", "wins"]);
  });

  it("R259 a player may change their pick while the other has not picked", () => {
    const first = pickDeck(fresh(), "p1", 0, NOW);
    const changed = pickDeck(first, "p1", 1, NOW + 1);
    expect(changed.status).toBe("picking");
    expect(changed.sides[0].pick).toBe(1);
    expect(changed.version).toBe(first.version + 1);
  });

  it("R259 the pick that completes both begins the game at once, series p1 first in game 1", () => {
    const series = pickDeck(pickDeck(fresh(), "p2", 2, NOW), "p1", 1, NOW + 5);

    expect(series.status).toBe("playing");
    expect(series.pickDeadline).toBeNull();
    expect(series.sides.map((side) => side.pick)).toEqual([null, null]);
    expect(series.games).toEqual([
      { gameNo: 1, matchId: "match-1", slots: [1, 2], first: "p1", winner: null, reason: null },
    ]);

    const { seats, seed } = gameSeats(series);
    expect(seed).toBe("seed-base:1");
    expect(seats).toEqual([
      { profileId: ALICE, player: "p1", deck: ["alice-card-1a", "alice-card-1b"] },
      { profileId: BOB, player: "p2", deck: ["bob-card-2a", "bob-card-2b"] },
    ]);

    const bob = viewOf(series, BOB);
    expect(bob.currentMatchId).toBe("match-1");
    expect(bob.gameNo).toBe(1);
    expect(bob.games).toEqual([
      {
        gameNo: 1,
        matchId: "match-1",
        yourSlot: 2,
        opponentSlot: 1,
        youWentFirst: false,
        result: null,
        reason: null,
      },
    ]);
  });

  it("R259 seats alternate: series p2 goes first in game 2, and each game has its own seed", () => {
    const afterGame1 = play(fresh(), [0, 0], "p1", "match-2");
    const game2 = pickDeck(pickDeck(afterGame1, "p1", 1, NOW), "p2", 2, NOW);

    expect(game2.games[1]).toMatchObject({ gameNo: 2, matchId: "match-2", first: "p2" });
    const { seats, seed } = gameSeats(game2);
    expect(seed).toBe("seed-base:2");
    // The match's p1 is whoever goes first: bob, with the deck he picked.
    expect(seats).toEqual([
      { profileId: BOB, player: "p1", deck: ["bob-card-2a", "bob-card-2b"] },
      { profileId: ALICE, player: "p2", deck: ["alice-card-1a", "alice-card-1b"] },
    ]);
    expect(viewOf(game2, BOB).games[1]?.youWentFirst).toBe(true);
    expect(viewOf(game2, ALICE).games[1]?.youWentFirst).toBe(false);
  });

  it("R259 game 3's picks are made for both players, and it begins at once with p1 first", () => {
    const one = play(fresh(), [0, 1], "p1", "match-2");
    const two = play(one, [2, 0], "p2", "match-3");

    expect(two.status).toBe("playing");
    expect(two.nextMatchId).toBe("match-3");
    expect(two.pickDeadline).toBeNull();
    expect(two.games[2]).toEqual({
      gameNo: 3,
      matchId: "match-3",
      slots: [1, 2],
      first: "p1",
      winner: null,
      reason: null,
    });
    expect(gameSeats(two).seed).toBe("seed-base:3");
    expect(gameSeats(two).seats[0]).toEqual({
      profileId: ALICE,
      player: "p1",
      deck: ["alice-card-1a", "alice-card-1b"],
    });
    // One write, however much it did.
    expect(two.version).toBe(one.version + 3);
  });

  it("R259 a pick must be a whole slot of the trio the player has not played, made while picking and in time", () => {
    const series = fresh();
    expect(refusalOf(() => pickDeck(series, "p1", -1, NOW))).toBe("slot_out_of_range");
    expect(refusalOf(() => pickDeck(series, "p1", 3, NOW))).toBe("slot_out_of_range");
    expect(refusalOf(() => pickDeck(series, "p1", 1.5, NOW))).toBe("slot_out_of_range");
    expect(refusalOf(() => pickDeck(series, "p1", Number.NaN, NOW))).toBe("slot_out_of_range");

    // R260: the clock closes picking at its deadline.
    expect(refusalOf(() => pickDeck(series, "p1", 0, NOW + PICK_MS))).toBe("pick_closed");
    expect(refusalOf(() => pickDeck(series, "p1", 0, NOW + PICK_MS - 1))).toBeNull();

    const afterGame1 = play(series, [0, 1], "p2", "match-2");
    expect(refusalOf(() => pickDeck(afterGame1, "p1", 0, NOW))).toBe("slot_played");
    expect(refusalOf(() => pickDeck(afterGame1, "p2", 1, NOW))).toBe("slot_played");
    // The other side's played slot is no business of this side's pick.
    expect(refusalOf(() => pickDeck(afterGame1, "p1", 1, NOW))).toBeNull();

    const playing = pickDeck(pickDeck(series, "p1", 0, NOW), "p2", 0, NOW);
    expect(refusalOf(() => pickDeck(playing, "p1", 1, NOW))).toBe("not_picking");
    expect(refusalOf(() => beginGame(playing, NOW))).toBe("not_picking");
    expect(refusalOf(() => beginGame(series, NOW))).toBe("picks_missing");

    const over = forfeitSeries(series, "p1", NOW);
    expect(refusalOf(() => pickDeck(over, "p1", 0, NOW))).toBe("over");
  });

  it("R259 the projection never carries the opponent's deck names, cards or pending pick, at any point", () => {
    const states: SeriesRow[] = [];
    let row = fresh();
    states.push(row);
    row = pickDeck(row, "p1", 2, NOW);
    states.push(row);
    row = pickDeck(row, "p2", 0, NOW);
    states.push(row);
    row = gameEnded(row, "draw", "draw-accepted", NOW, "match-2");
    states.push(row);
    row = pickDeck(row, "p2", 1, NOW);
    states.push(row);
    row = pickDeck(row, "p1", 1, NOW);
    states.push(row);
    row = gameEnded(row, "p1", "concede", NOW, "match-3");
    states.push(row);
    row = gameEnded(row, "p2", "hero-death", NOW, "unused");
    states.push(row);
    expect(row.status).toBe("over");

    for (const state of states) {
      const bob = JSON.stringify(viewOf(state, BOB));
      const alice = JSON.stringify(viewOf(state, ALICE));
      expect(bob).not.toMatch(/alice/u);
      expect(alice).not.toMatch(/bob/u);
      // A pending pick is never in the other side's view, as a number or otherwise.
      if (state.status === "picking") {
        expect(viewOf(state, BOB).opponent).toEqual({
          wins: state.sides[0].wins,
          decks: expect.any(Array),
          picked: state.sides[0].pick !== null,
        });
      }
    }
    expect(projectSeries(row, "a-stranger", NOW)).toBeNull();
  });

  it("R259 the projection has exactly the fields of the client's SeriesView", () => {
    const over = play(play(fresh(), [0, 0], "p1", "match-2"), [1, 1], "p1", "unused");
    const view = viewOf(over, ALICE);
    expect(Object.keys(view).sort()).toEqual(
      [
        "currentMatchId",
        "gameNo",
        "games",
        "id",
        "maxGames",
        "now",
        "opponent",
        "pickDeadline",
        "result",
        "status",
        "winsNeeded",
        "you",
      ].sort(),
    );
    expect(Object.keys(view.you).sort()).toEqual(["decks", "pick", "seat", "trioName", "wins"]);
    expect(Object.keys(view.you.decks[0] ?? {}).sort()).toEqual(["cards", "name", "played", "slot"]);
    expect(Object.keys(view.opponent.decks[0] ?? {}).sort()).toEqual(["played", "slot"]);
    expect(Object.keys(view.games[0] ?? {}).sort()).toEqual(
      ["gameNo", "matchId", "opponentSlot", "reason", "result", "youWentFirst", "yourSlot"].sort(),
    );
    expect(Object.keys(view.result ?? {}).sort()).toEqual(
      ["endReason", "outcome", "ratingAfter", "ratingBefore"].sort(),
    );
    expect(view).toMatchObject({
      winsNeeded: SERIES_WINS_NEEDED,
      maxGames: SERIES_MAX_GAMES,
      gameNo: 2,
      now: NOW,
      currentMatchId: null,
      pickDeadline: null,
    });
  });
});

describe("R260 — the pick clock", () => {
  it("R260 each pick phase runs SERIES_PICK_SECONDS from when it opens", () => {
    expect(fresh().pickDeadline).toBe(NOW + PICK_MS);
    // Game 1 was picked quickly and played for a long time: game 2's clock starts when it ended.
    const playing = pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW);
    const later = NOW + 10 * PICK_MS;
    const next = gameEnded(playing, "p1", "hero-death", later, "match-2");
    expect(next.pickDeadline).toBe(later + PICK_MS);
    expect(viewOf(next, ALICE).pickDeadline).toBe(later + PICK_MS);
  });

  it("R260 at the deadline a player who has not picked gets their first unplayed deck, and the game starts", () => {
    const bobPicked = pickDeck(fresh(), "p2", 2, NOW);
    const started = timeoutPicks(bobPicked, NOW + PICK_MS);
    expect(started.status).toBe("playing");
    expect(started.games[0]?.slots).toEqual([0, 2]);

    // Game 2: alice played slot 0, so her first unplayed is 1; bob's (he played 1) is 0.
    const afterGame1 = play(fresh(), [0, 1], "p1", "match-2");
    expect(firstUnplayed("p1", afterGame1.games)).toBe(1);
    expect(firstUnplayed("p2", afterGame1.games)).toBe(0);
    const alicePicked = pickDeck(afterGame1, "p1", 2, NOW);
    const game2 = timeoutPicks(alicePicked, NOW + PICK_MS);
    expect(game2.games[1]?.slots).toEqual([2, 0]);
    expect(gameSeats(game2).seats[0]?.profileId).toBe(BOB);
  });

  it("R260 if neither has picked by the deadline the series is abandoned: no winner, unrated", () => {
    const abandoned = timeoutPicks(fresh(), NOW + PICK_MS);
    expect(abandoned).toMatchObject({
      status: "over",
      winner: null,
      endReason: "abandoned",
      pickDeadline: null,
      endedAt: NOW + PICK_MS,
    });
    expect(seriesScore(abandoned)).toBeNull();
    expect(rateSeries(abandoned, [1200, 1000])).toMatchObject({ ratingBefore: null, ratingAfter: null });
    expect(viewOf(abandoned, BOB).result).toEqual({
      outcome: "abandoned",
      endReason: "abandoned",
      ratingBefore: null,
      ratingAfter: null,
    });

    // After a played game it is still abandoned, not a result for the side that won game 1.
    const afterGame1 = play(fresh(), [0, 0], "p1", "match-2");
    const later = timeoutPicks(afterGame1, NOW + PICK_MS);
    expect(later).toMatchObject({ status: "over", winner: null, endReason: "abandoned" });
  });

  it("R260 the clock is not settled before its deadline, nor outside a pick phase", () => {
    expect(refusalOf(() => timeoutPicks(fresh(), NOW + PICK_MS - 1))).toBe("pick_open");
    const playing = pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW);
    expect(refusalOf(() => timeoutPicks(playing, NOW + 10 * PICK_MS))).toBe("not_picking");
  });
});

describe("R261 — endings inside a series", () => {
  it("R261 a drawn game counts for neither side and still spends both decks", () => {
    const series = play(fresh(), [0, 1], "draw", "match-2");
    expect(series.status).toBe("picking");
    expect(series.sides.map((side) => side.wins)).toEqual([0, 0]);
    expect(series.games[0]).toMatchObject({ winner: "draw", reason: "turn-cap" });
    expect(refusalOf(() => pickDeck(series, "p1", 0, NOW))).toBe("slot_played");
    expect(refusalOf(() => pickDeck(series, "p2", 1, NOW))).toBe("slot_played");

    const alice = viewOf(series, ALICE);
    expect(alice.you.decks.map((deck) => deck.played)).toEqual([true, false, false]);
    expect(alice.opponent.decks).toEqual([
      { slot: 0, played: false },
      { slot: 1, played: true },
      { slot: 2, played: false },
    ]);
    expect(alice.games[0]?.result).toBe("draw");
  });

  it("R261 the first side to SERIES_WINS_NEEDED wins takes the series (decided)", () => {
    const twoNil = play(play(fresh(), [0, 0], "p1", "match-2"), [1, 1], "p1", "unused");
    expect(twoNil).toMatchObject({ status: "over", winner: "p1", endReason: "decided", endedAt: NOW });
    expect(twoNil.games).toHaveLength(2);
    expect(seriesScore(twoNil)).toBe(1);

    const twoOne = play(
      play(play(fresh(), [0, 0], "p2", "match-2"), [1, 1], "p1", "match-3"),
      [2, 2],
      "p1",
      "unused",
    );
    expect(twoOne).toMatchObject({ status: "over", winner: "p1", endReason: "decided" });
    expect(twoOne.games).toHaveLength(3);
    expect(viewOf(twoOne, BOB).result?.outcome).toBe("loss");
    expect(viewOf(twoOne, ALICE).result?.outcome).toBe("win");
  });

  it("R261 after three games equal wins is a series draw (exhausted)", () => {
    const series = play(
      play(play(fresh(), [0, 0], "p1", "match-2"), [1, 1], "p2", "match-3"),
      [2, 2],
      "draw",
      "unused",
    );
    expect(series).toMatchObject({ status: "over", winner: "draw", endReason: "exhausted" });
    expect(seriesScore(series)).toBe(0.5);
    expect(viewOf(series, ALICE).result?.outcome).toBe("draw");
    expect(viewOf(series, BOB).result?.outcome).toBe("draw");
  });

  it("R261 after three games more wins takes the series, even one win to none", () => {
    const series = play(
      play(play(fresh(), [0, 0], "draw", "match-2"), [1, 1], "draw", "match-3"),
      [2, 2],
      "p2",
      "unused",
    );
    expect(series).toMatchObject({ status: "over", winner: "p2", endReason: "exhausted" });
    expect(series.sides.map((side) => side.wins)).toEqual([0, 1]);
    expect(seriesScore(series)).toBe(0);
    expect(viewOf(series, BOB).result?.outcome).toBe("win");
  });

  it("R261 between games a player may forfeit the series, and the other side wins it", () => {
    const beforeAnyGame = forfeitSeries(pickDeck(fresh(), "p1", 1, NOW), "p2", NOW + 1);
    expect(beforeAnyGame).toMatchObject({
      status: "over",
      winner: "p1",
      endReason: "forfeit",
      endedAt: NOW + 1,
      pickDeadline: null,
    });
    expect(beforeAnyGame.sides.map((side) => side.pick)).toEqual([null, null]);

    const afterGame1 = forfeitSeries(play(fresh(), [0, 0], "p2", "match-2"), "p2", NOW);
    expect(afterGame1).toMatchObject({ status: "over", winner: "p1", endReason: "forfeit" });
    expect(viewOf(afterGame1, BOB).result).toMatchObject({ outcome: "loss", endReason: "forfeit" });
  });

  it("R261 a forfeit is refused while a game is being played, and after the series", () => {
    const playing = pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW);
    expect(refusalOf(() => forfeitSeries(playing, "p1", NOW))).toBe("not_picking");
    const over = forfeitSeries(fresh(), "p1", NOW);
    expect(refusalOf(() => forfeitSeries(over, "p2", NOW))).toBe("over");
    expect(refusalOf(() => gameEnded(over, "p1", "concede", NOW, "x"))).toBe("over");
    expect(refusalOf(() => gameEnded(fresh(), "p1", "concede", NOW, "x"))).toBe("not_playing");
  });
});

describe("R262 — how a series is rated", () => {
  it("R262 a series scores once, for series p1: 1, 0.5 or 0, and not at all while it runs", () => {
    expect(seriesScore(fresh())).toBeNull();
    expect(seriesScore(pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW))).toBeNull();
    expect(seriesScore(forfeitSeries(fresh(), "p1", NOW))).toBe(0);
    expect(seriesScore(forfeitSeries(fresh(), "p2", NOW))).toBe(1);
  });

  it("R262 the one move is R79's Elo from the ratings given, recorded without a second write", () => {
    const decided = play(play(fresh(), [0, 0], "p2", "match-2"), [1, 1], "p2", "unused");
    const rated = rateSeries(decided, [1200, 1000]);
    const expected = eloUpdate(1200, 1000, 0);
    expect(rated.ratingBefore).toEqual([1200, 1000]);
    expect(rated.ratingAfter).toEqual([expected.a, expected.b]);
    expect(rated.version).toBe(decided.version);
    expect(decided.ratingBefore).toBeNull();

    expect(viewOf(rated, BOB).result).toEqual({
      outcome: "win",
      endReason: "decided",
      ratingBefore: 1000,
      ratingAfter: expected.b,
    });
    expect(viewOf(rated, ALICE).result).toMatchObject({ ratingBefore: 1200, ratingAfter: expected.a });
  });
});

describe("R263 — a series is written by compare-and-set", () => {
  it("R263 every transition moves the version by exactly one and stamps updatedAt", () => {
    let row = fresh();
    const step = (next: SeriesRow, at: number): void => {
      expect(next.version).toBe(row.version + 1);
      expect(next.updatedAt).toBe(at);
      row = next;
    };
    step(pickDeck(row, "p1", 0, NOW + 1), NOW + 1);
    step(pickDeck(row, "p2", 0, NOW + 2), NOW + 2);
    step(gameEnded(row, "p1", "hero-death", NOW + 3, "match-2"), NOW + 3);
    step(pickDeck(row, "p2", 1, NOW + 4), NOW + 4);
    step(timeoutPicks(row, row.pickDeadline ?? 0), row.pickDeadline ?? 0);
    const at = row.updatedAt + 1;
    step(gameEnded(row, "p2", "concede", at, "match-3"), at);
    step(gameEnded(row, "p1", "disconnect", at + 1, "unused"), at + 1);
    expect(row.status).toBe("over");
    expect(forfeitSeries(fresh(), "p1", NOW + 9)).toMatchObject({ version: 2, updatedAt: NOW + 9 });
    const picked = pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW);
    expect(picked.version).toBe(3);
  });

  it("R263 each new pick phase is for the match id it was handed, and the game is played under it", () => {
    const next = play(fresh(), [0, 0], "p1", "match-2");
    expect(next.nextMatchId).toBe("match-2");
    expect(viewOf(next, ALICE).currentMatchId).toBeNull();
    const playing = pickDeck(pickDeck(next, "p1", 1, NOW), "p2", 1, NOW);
    expect(playing.games[1]?.matchId).toBe("match-2");
    expect(viewOf(playing, ALICE).currentMatchId).toBe("match-2");
  });

  it("R263 a transition never changes the row it was given, so a lost write can re-apply to a fresh read", () => {
    const series = pickDeck(fresh(), "p1", 0, NOW);
    const snapshot = structuredClone(series);
    pickDeck(series, "p2", 1, NOW);
    forfeitSeries(series, "p1", NOW);
    timeoutPicks(series, NOW + PICK_MS);
    rateSeries(forfeitSeries(series, "p1", NOW), [1000, 1000]);
    expect(series).toEqual(snapshot);
  });
});

/**
 * The Conquest series' pure rules (`src/api/series-rules.ts`, SPEC §9.5, R330–R337, R259–R263).
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
  alreadyPicked,
  beginGame,
  bothPicked,
  firstUnwon,
  forfeitSeries,
  gameEnded,
  gameSeats,
  newSeries,
  pickDeck,
  projectSeries,
  rateSeries,
  seriesScore,
  timeoutPicks,
  unwonSlots,
  wonSlots,
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

/**
 * Both sides pick (when the game is not already under way), then the game ends. A side whose pick
 * the rules already made (R332) is not asked again, and the test says so when the pick it asked for
 * is not the one made.
 */
function play(
  series: SeriesRow,
  slots: [number, number],
  winner: SeriesSeat | "draw",
  nextMatchId: string,
  now = NOW,
): SeriesRow {
  let row = series;
  const seats: readonly SeriesSeat[] = ["p1", "p2"];
  for (const [index, seat] of seats.entries()) {
    const slot = slots[index] ?? -1;
    if (row.status === "picking") {
      const made = row.sides[index]?.pick ?? null;
      if (made === null) row = pickDeck(row, seat, slot, now);
      else if (made !== slot) throw new Error(`${seat}'s pick was made for it: slot ${String(made)}, not ${String(slot)}`);
    } else {
      const game = row.games.at(-1);
      if (game?.slots[index] !== slot) throw new Error(`${seat} is already playing slot ${String(game?.slots[index])}`);
    }
  }
  return gameEnded(row, winner, winner === "draw" ? "turn-cap" : "hero-death", now, nextMatchId);
}

/** A seeded walk for the invariant sweeps: a small LCG, so the test states its own randomness. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
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

describe("R330 — Conquest: a win with every deck", () => {
  it("R330 SERIES_WINS_NEEDED is the validator's TRIO_DECKS: one win with each deck of a trio", () => {
    expect(SERIES_WINS_NEEDED).toBe(TRIO_DECKS);
  });

  it("R330 a deck that wins is locked; a deck that lost or drew may be picked again", () => {
    const afterGame1 = play(fresh(), [0, 1], "p1", "match-2");
    expect(afterGame1.status).toBe("picking");
    expect([...wonSlots("p1", afterGame1.games)]).toEqual([0]);
    expect(unwonSlots(afterGame1, "p1")).toEqual([1, 2]);
    expect(refusalOf(() => pickDeck(afterGame1, "p1", 0, NOW))).toBe("slot_won");
    // Bob lost with slot 1: it is his to pick again.
    expect(unwonSlots(afterGame1, "p2")).toEqual([0, 1, 2]);
    expect(refusalOf(() => pickDeck(afterGame1, "p2", 1, NOW))).toBeNull();

    const alice = viewOf(afterGame1, ALICE);
    expect(alice.you.decks.map((deck) => [deck.won, deck.games])).toEqual([
      [true, 1],
      [false, 0],
      [false, 0],
    ]);
    expect(alice.opponent.decks).toEqual([
      { slot: 0, won: false },
      { slot: 1, won: false },
      { slot: 2, won: false },
    ]);
  });

  it("R330 the side that has won with all three decks takes the series (decided)", () => {
    const sweep = play(play(play(fresh(), [0, 0], "p1", "m2"), [1, 0], "p1", "m3"), [2, 0], "p1", "unused");
    expect(sweep).toMatchObject({ status: "over", winner: "p1", endReason: "decided", endedAt: NOW });
    expect(sweep.games).toHaveLength(SERIES_WINS_NEEDED);
    expect(seriesScore(sweep)).toBe(1);

    // Three–two in five games: each side's losing decks came back until one side had all three.
    let row = fresh();
    row = play(row, [0, 0], "p1", "m2");
    row = play(row, [1, 0], "p2", "m3");
    row = play(row, [1, 1], "p1", "m4");
    row = play(row, [2, 2], "p2", "m5");
    expect(row.sides.map((side) => side.wins)).toEqual([2, 2]);
    // Both sides are down to their last deck, so game 5 began by itself (R332).
    expect(row.status).toBe("playing");
    expect(row.games.at(-1)?.slots).toEqual([2, 1]);
    row = play(row, [2, 1], "p1", "unused");
    expect(row).toMatchObject({ status: "over", winner: "p1", endReason: "decided" });
    expect(row.games).toHaveLength(2 * SERIES_WINS_NEEDED - 1);
    expect(viewOf(row, BOB).result?.outcome).toBe("loss");
    expect(viewOf(row, ALICE).result?.outcome).toBe("win");
  });

  it("R330 a side's wins always equal the decks that won, and a locked deck is never played again", () => {
    for (let run = 0; run < 400; run += 1) {
      const random = lcg(run + 1);
      let row = fresh();
      let guard = 0;
      while (row.status !== "over" && guard < SERIES_MAX_GAMES + 1) {
        guard += 1;
        if (row.status === "picking") {
          for (const [index, seat] of (["p1", "p2"] as const).entries()) {
            if (row.status !== "picking" || row.sides[index]?.pick !== null) continue;
            const open = unwonSlots(row, seat);
            row = pickDeck(row, seat, open[Math.floor(random() * open.length)] ?? 0, NOW);
          }
        }
        const game = row.games.at(-1);
        expect(game?.winner, "a game is under way").toBeNull();
        for (const [index, seat] of (["p1", "p2"] as const).entries()) {
          const before = row.games.slice(0, -1);
          expect(wonSlots(seat, before).has(game?.slots[index] ?? -1), "a locked deck is never played").toBe(false);
        }
        const roll = random();
        const winner = roll < 0.45 ? "p1" : roll < 0.9 ? "p2" : "draw";
        row = gameEnded(row, winner, winner === "draw" ? "turn-cap" : "hero-death", NOW, `m-${String(row.games.length + 1)}`);
        for (const [index, seat] of (["p1", "p2"] as const).entries()) {
          expect(row.sides[index]?.wins).toBe(wonSlots(seat, row.games).size);
        }
      }
      expect(row.status).toBe("over");
      expect(row.games.length).toBeLessThanOrEqual(SERIES_MAX_GAMES);
      const decisive = row.games.filter((game) => game.winner !== "draw").length;
      expect(decisive).toBeLessThanOrEqual(2 * SERIES_WINS_NEEDED - 1);
      if (row.endReason === "decided") {
        expect(Math.max(...row.sides.map((side) => side.wins))).toBe(SERIES_WINS_NEEDED);
      }
    }
  });
});

describe("R331 — the sealed pick", () => {
  it("R331 a pick is hidden from the opponent until both have picked: they see only that one is in (R259)", () => {
    const before = fresh();
    const picked = pickDeck(before, "p1", 2, NOW);

    // The row holds it, and its owner sees it.
    expect(picked.sides[0].pick).toBe(2);
    expect(bothPicked(picked)).toBe(false);
    expect(viewOf(picked, ALICE).you.pick).toBe(2);
    expect(viewOf(picked, ALICE).you.autoPick).toBe(false);

    // Bob's view changes in exactly one bit: `opponent.picked`.
    const bobBefore = viewOf(before, BOB);
    const bobAfter = viewOf(picked, BOB);
    expect(bobBefore.opponent.picked).toBe(false);
    expect(bobAfter.opponent.picked).toBe(true);
    expect({ ...bobAfter, opponent: { ...bobAfter.opponent, picked: false } }).toEqual(bobBefore);
    expect(Object.keys(bobAfter.opponent).sort()).toEqual(["decks", "picked", "wins"]);
  });

  it("R331 a pick is final: a second pick, the same or another, is refused as sealed", () => {
    const first = pickDeck(fresh(), "p1", 0, NOW);
    expect(refusalOf(() => pickDeck(first, "p1", 1, NOW + 1))).toBe("pick_sealed");
    expect(refusalOf(() => pickDeck(first, "p1", 0, NOW + 1))).toBe("pick_sealed");
    // What a retried request finds, before and after the game began.
    expect(alreadyPicked(first, "p1", 0)).toBe(true);
    expect(alreadyPicked(first, "p1", 1)).toBe(false);
    expect(alreadyPicked(first, "p2", 0)).toBe(false);
    const playing = pickDeck(first, "p2", 2, NOW);
    expect(alreadyPicked(playing, "p1", 0)).toBe(true);
    expect(alreadyPicked(playing, "p2", 2)).toBe(true);
    expect(alreadyPicked(playing, "p2", 1)).toBe(false);
    const ended = gameEnded(playing, "p1", "hero-death", NOW, "match-2");
    expect(alreadyPicked(ended, "p1", 0)).toBe(false);
  });

  it("R331 a sealed pick is found sealed first, even after the deadline or for a locked slot", () => {
    const first = pickDeck(fresh(), "p1", 0, NOW);
    expect(refusalOf(() => pickDeck(first, "p1", 0, NOW + PICK_MS))).toBe("pick_sealed");
    expect(refusalOf(() => pickDeck(first, "p1", 7, NOW))).toBe("pick_sealed");
  });

  it("R331 a pick naming another game is refused as stale, and a retry is recognised by its game", () => {
    const afterGame1 = play(fresh(), [0, 1], "p2", "match-2");
    // A late duplicate of game 1's pick of slot 0 must not become game 2's.
    expect(refusalOf(() => pickDeck(afterGame1, "p1", 0, NOW, 1))).toBe("stale_pick");
    expect(alreadyPicked(afterGame1, "p1", 0, 1)).toBe(true);
    expect(alreadyPicked(afterGame1, "p1", 1, 1)).toBe(false);
    expect(alreadyPicked(afterGame1, "p1", 0, 2)).toBe(false);
    const picked = pickDeck(afterGame1, "p1", 2, NOW, 2);
    expect(picked.sides[0].pick).toBe(2);
    expect(alreadyPicked(picked, "p1", 2, 2)).toBe(true);
    expect(refusalOf(() => pickDeck(afterGame1, "p1", 2, NOW, 3))).toBe("stale_pick");
  });

  it("R331 the pick that completes both begins the game at once, series p1 first in game 1", () => {
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

  it("R331 a pick must be a whole slot of the trio whose deck has not won, made while picking and in time", () => {
    const series = fresh();
    expect(refusalOf(() => pickDeck(series, "p1", -1, NOW))).toBe("slot_out_of_range");
    expect(refusalOf(() => pickDeck(series, "p1", 3, NOW))).toBe("slot_out_of_range");
    expect(refusalOf(() => pickDeck(series, "p1", 1.5, NOW))).toBe("slot_out_of_range");
    expect(refusalOf(() => pickDeck(series, "p1", Number.NaN, NOW))).toBe("slot_out_of_range");

    // R333: the clock closes picking at its deadline.
    expect(refusalOf(() => pickDeck(series, "p1", 0, NOW + PICK_MS))).toBe("pick_closed");
    expect(refusalOf(() => pickDeck(series, "p1", 0, NOW + PICK_MS - 1))).toBeNull();

    const afterGame1 = play(series, [0, 1], "p2", "match-2");
    expect(refusalOf(() => pickDeck(afterGame1, "p2", 1, NOW))).toBe("slot_won");
    // Alice lost with slot 0, and the other side's won slot is no business of this side's pick.
    expect(refusalOf(() => pickDeck(afterGame1, "p1", 0, NOW))).toBeNull();
    expect(refusalOf(() => pickDeck(afterGame1, "p1", 1, NOW))).toBeNull();

    const playing = pickDeck(pickDeck(series, "p1", 0, NOW), "p2", 0, NOW);
    expect(refusalOf(() => pickDeck(playing, "p1", 1, NOW))).toBe("not_picking");
    expect(refusalOf(() => beginGame(playing, NOW))).toBe("not_picking");
    expect(refusalOf(() => beginGame(series, NOW))).toBe("picks_missing");

    const over = forfeitSeries(series, "p1", NOW);
    expect(refusalOf(() => pickDeck(over, "p1", 0, NOW))).toBe("over");
  });
});

describe("R332 — the last deck is picked for you", () => {
  it("R332 a side with one deck left that has not won has it picked when the pick phase opens", () => {
    const twoWins = play(play(fresh(), [0, 0], "p1", "m2"), [1, 0], "p1", "m3");
    expect(twoWins.status).toBe("picking");
    expect(twoWins.sides.map((side) => side.pick)).toEqual([2, null]);
    const alice = viewOf(twoWins, ALICE);
    expect(alice.you.pick).toBe(2);
    expect(alice.you.autoPick).toBe(true);
    // Bob sees only that a pick is in, as for any pick (R331).
    expect(viewOf(twoWins, BOB).opponent.picked).toBe(true);
    expect(viewOf(twoWins, BOB).you.autoPick).toBe(false);
    // Alice cannot change it; the game begins when Bob picks.
    expect(refusalOf(() => pickDeck(twoWins, "p1", 2, NOW))).toBe("pick_sealed");
    const game3 = pickDeck(twoWins, "p2", 1, NOW);
    expect(game3.status).toBe("playing");
    expect(game3.games[2]?.slots).toEqual([2, 1]);
  });

  it("R332 when both sides have one deck left, the game begins at once with no pick phase", () => {
    let row = fresh();
    row = play(row, [0, 0], "p1", "m2");
    row = play(row, [1, 0], "p1", "m3");
    row = play(row, [2, 0], "p2", "m4");
    const before = row;
    row = play(row, [2, 1], "p2", "m5");
    expect(row.status).toBe("playing");
    expect(row.pickDeadline).toBeNull();
    expect(row.games.at(-1)).toEqual({ gameNo: 5, matchId: "m5", slots: [2, 2], first: "p1", winner: null, reason: null });
    // One write, however much it did.
    expect(row.version).toBe(before.version + 2);
    expect(gameSeats(row).seed).toBe("seed-base:5");
  });

  it("R332 a side with two or three decks left still picks for itself", () => {
    const afterGame1 = play(fresh(), [0, 0], "p1", "m2");
    expect(afterGame1.sides.map((side) => side.pick)).toEqual([null, null]);
    expect(viewOf(afterGame1, ALICE).you.autoPick).toBe(false);
  });
});

describe("R333 — the pick clock", () => {
  it("R333 each pick phase runs SERIES_PICK_SECONDS from when it opens", () => {
    expect(fresh().pickDeadline).toBe(NOW + PICK_MS);
    // Game 1 was picked quickly and played for a long time: game 2's clock starts when it ended.
    const playing = pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW);
    const later = NOW + 10 * PICK_MS;
    const next = gameEnded(playing, "p1", "hero-death", later, "match-2");
    expect(next.pickDeadline).toBe(later + PICK_MS);
    expect(viewOf(next, ALICE).pickDeadline).toBe(later + PICK_MS);
  });

  it("R333 at the deadline a player who has not picked gets their first deck that has not won, and the game starts", () => {
    const bobPicked = pickDeck(fresh(), "p2", 2, NOW);
    const started = timeoutPicks(bobPicked, NOW + PICK_MS);
    expect(started.status).toBe("playing");
    expect(started.games[0]?.slots).toEqual([0, 2]);

    // Game 2: alice won with slot 0, so her first unwon deck is 1; bob lost with 1, so his is 0.
    const afterGame1 = play(fresh(), [0, 1], "p1", "match-2");
    expect(firstUnwon(afterGame1, "p1")).toBe(1);
    expect(firstUnwon(afterGame1, "p2")).toBe(0);
    const alicePicked = pickDeck(afterGame1, "p1", 2, NOW);
    const game2 = timeoutPicks(alicePicked, NOW + PICK_MS);
    expect(game2.games[1]?.slots).toEqual([2, 0]);
    expect(gameSeats(game2).seats[0]?.profileId).toBe(BOB);
  });

  it("R333 a pick made for a player counts: the other is given a deck and the game starts", () => {
    const twoWins = play(play(fresh(), [0, 0], "p1", "m2"), [1, 0], "p1", "m3");
    const game3 = timeoutPicks(twoWins, (twoWins.pickDeadline ?? 0) + 1);
    expect(game3.status).toBe("playing");
    expect(game3.games[2]?.slots).toEqual([2, 0]);
  });

  it("R333 if neither has picked by the deadline the series is abandoned: no winner, unrated (R260)", () => {
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

  it("R333 the clock is not settled before its deadline, nor outside a pick phase", () => {
    expect(refusalOf(() => timeoutPicks(fresh(), NOW + PICK_MS - 1))).toBe("pick_open");
    const playing = pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW);
    expect(refusalOf(() => timeoutPicks(playing, NOW + 10 * PICK_MS))).toBe("not_picking");
  });
});

describe("R334 — draws, the game cap and forfeits", () => {
  it("R334 a drawn game counts for neither side and locks neither deck", () => {
    const series = play(fresh(), [0, 1], "draw", "match-2");
    expect(series.status).toBe("picking");
    expect(series.sides.map((side) => side.wins)).toEqual([0, 0]);
    expect(series.games[0]).toMatchObject({ winner: "draw", reason: "turn-cap" });
    expect(refusalOf(() => pickDeck(series, "p1", 0, NOW))).toBeNull();
    expect(refusalOf(() => pickDeck(series, "p2", 1, NOW))).toBeNull();

    const alice = viewOf(series, ALICE);
    expect(alice.you.decks.map((deck) => deck.won)).toEqual([false, false, false]);
    expect(alice.you.decks.map((deck) => deck.games)).toEqual([1, 0, 0]);
    expect(alice.games[0]?.result).toBe("draw");
  });

  it("R334 SERIES_MAX_GAMES leaves room for two drawn games in the longest series", () => {
    // Without a draw a series is decided by game 2 × SERIES_WINS_NEEDED − 1 at the latest.
    expect(2 * SERIES_WINS_NEEDED - 1).toBe(5);
    expect(SERIES_MAX_GAMES).toBe(7);
    expect(SERIES_MAX_GAMES).toBeGreaterThan(2 * SERIES_WINS_NEEDED - 1);
  });

  it("R334 at the cap equal wins is a series draw (exhausted)", () => {
    let row = fresh();
    row = play(row, [0, 0], "draw", "m2");
    row = play(row, [0, 0], "draw", "m3");
    row = play(row, [0, 0], "draw", "m4");
    row = play(row, [0, 0], "p1", "m5");
    row = play(row, [1, 0], "p2", "m6");
    row = play(row, [1, 1], "draw", "m7");
    expect(row.status).toBe("picking");
    row = play(row, [2, 2], "draw", "unused");
    expect(row.games).toHaveLength(SERIES_MAX_GAMES);
    expect(row).toMatchObject({ status: "over", winner: "draw", endReason: "exhausted" });
    expect(seriesScore(row)).toBe(0.5);
    expect(viewOf(row, ALICE).result?.outcome).toBe("draw");
    expect(viewOf(row, BOB).result?.outcome).toBe("draw");
  });

  it("R334 at the cap more wins takes the series, even one win to none", () => {
    let row = fresh();
    for (let game = 1; game < SERIES_MAX_GAMES; game += 1) row = play(row, [0, 0], "draw", `m${String(game + 1)}`);
    row = play(row, [2, 1], "p2", "unused");
    expect(row).toMatchObject({ status: "over", winner: "p2", endReason: "exhausted" });
    expect(row.sides.map((side) => side.wins)).toEqual([0, 1]);
    expect(seriesScore(row)).toBe(0);
    expect(viewOf(row, BOB).result?.outcome).toBe("win");
  });

  it("R334 a concede or a disconnect loses the game, not the series (R261)", () => {
    const conceded = gameEnded(pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW), "p2", "concede", NOW, "m2");
    expect(conceded.status).toBe("picking");
    expect(conceded.winner).toBeNull();
    const disconnected = gameEnded(pickDeck(pickDeck(conceded, "p1", 1, NOW), "p2", 1, NOW), "p1", "disconnect", NOW, "m3");
    expect(disconnected.status).toBe("picking");
    expect(disconnected.sides.map((side) => side.wins)).toEqual([1, 1]);
  });

  it("R334 between games a player may forfeit the series, and the other side wins it (R261)", () => {
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

  it("R334 a forfeit is refused while a game is being played, and after the series", () => {
    const playing = pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW);
    expect(refusalOf(() => forfeitSeries(playing, "p1", NOW))).toBe("not_picking");
    const over = forfeitSeries(fresh(), "p1", NOW);
    expect(refusalOf(() => forfeitSeries(over, "p2", NOW))).toBe("over");
    expect(refusalOf(() => gameEnded(over, "p1", "concede", NOW, "x"))).toBe("over");
    expect(refusalOf(() => gameEnded(fresh(), "p1", "concede", NOW, "x"))).toBe("not_playing");
  });
});

describe("R335 — seats and seeds", () => {
  it("R335 seats alternate by game number, drawn games counted: p1 first in odd games, p2 in even ones", () => {
    let row = fresh();
    const firsts: SeriesSeat[] = [];
    const outcomes: (SeriesSeat | "draw")[] = ["draw", "p1", "draw", "p2", "p1"];
    for (const [index, outcome] of outcomes.entries()) {
      if (row.status === "picking") {
        for (const [side, seat] of (["p1", "p2"] as const).entries()) {
          if (row.status === "picking" && row.sides[side]?.pick === null) {
            row = pickDeck(row, seat, firstUnwon(row, seat) ?? 0, NOW);
          }
        }
      }
      firsts.push(row.games.at(-1)?.first ?? "p1");
      expect(gameSeats(row).seed).toBe(`seed-base:${String(index + 1)}`);
      row = gameEnded(row, outcome, outcome === "draw" ? "turn-cap" : "hero-death", NOW, `m${String(index + 2)}`);
    }
    expect(firsts).toEqual(["p1", "p2", "p1", "p2", "p1"]);
  });

  it("R335 the match's p1 is whoever goes first, with the deck they picked (R259)", () => {
    const afterGame1 = play(fresh(), [0, 0], "p1", "match-2");
    const game2 = pickDeck(pickDeck(afterGame1, "p1", 1, NOW), "p2", 2, NOW);

    expect(game2.games[1]).toMatchObject({ gameNo: 2, matchId: "match-2", first: "p2" });
    const { seats, seed } = gameSeats(game2);
    expect(seed).toBe("seed-base:2");
    expect(seats).toEqual([
      { profileId: BOB, player: "p1", deck: ["bob-card-2a", "bob-card-2b"] },
      { profileId: ALICE, player: "p2", deck: ["alice-card-1a", "alice-card-1b"] },
    ]);
    expect(viewOf(game2, BOB).games[1]?.youWentFirst).toBe(true);
    expect(viewOf(game2, ALICE).games[1]?.youWentFirst).toBe(false);
  });
});

describe("R336 — what each side sees", () => {
  it("R336 the projection never carries the opponent's deck names, cards or pending pick, at any point (R259)", () => {
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
    // Alice wins with her third deck and has one left: it is picked for her (R332), and Bob must
    // not learn which.
    row = play(row, [2, 2], "p1", "match-4");
    expect(row.sides[0].pick).toBe(0);
    states.push(row);
    row = pickDeck(row, "p2", 0, NOW);
    states.push(row);
    row = gameEnded(row, "p1", "hero-death", NOW, "unused");
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

  it("R336 each side sees both sides' won decks: its own by name, the other's by slot", () => {
    let row = fresh();
    row = play(row, [0, 2], "p1", "m2");
    row = play(row, [1, 2], "p2", "m3");
    const alice = viewOf(row, ALICE);
    expect(alice.you.decks.map((deck) => ({ slot: deck.slot, name: deck.name, won: deck.won }))).toEqual([
      { slot: 0, name: "alice deck 0", won: true },
      { slot: 1, name: "alice deck 1", won: false },
      { slot: 2, name: "alice deck 2", won: false },
    ]);
    expect(alice.opponent.decks).toEqual([
      { slot: 0, won: false },
      { slot: 1, won: false },
      { slot: 2, won: true },
    ]);
    expect(viewOf(row, BOB).opponent.decks).toEqual([
      { slot: 0, won: true },
      { slot: 1, won: false },
      { slot: 2, won: false },
    ]);
  });

  it("R336 the projection has exactly the fields of the client's SeriesView", () => {
    const over = play(play(play(fresh(), [0, 0], "p1", "m2"), [1, 1], "p1", "m3"), [2, 2], "p1", "unused");
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
    expect(Object.keys(view.you).sort()).toEqual(["autoPick", "decks", "pick", "seat", "trioName", "wins"]);
    expect(Object.keys(view.you.decks[0] ?? {}).sort()).toEqual(["cards", "games", "name", "slot", "won"]);
    expect(Object.keys(view.opponent.decks[0] ?? {}).sort()).toEqual(["slot", "won"]);
    expect(Object.keys(view.games[0] ?? {}).sort()).toEqual(
      ["gameNo", "matchId", "opponentSlot", "reason", "result", "youWentFirst", "yourSlot"].sort(),
    );
    expect(Object.keys(view.result ?? {}).sort()).toEqual(
      ["endReason", "outcome", "ratingAfter", "ratingBefore"].sort(),
    );
    expect(view).toMatchObject({
      winsNeeded: SERIES_WINS_NEEDED,
      maxGames: SERIES_MAX_GAMES,
      gameNo: 3,
      now: NOW,
      currentMatchId: null,
      pickDeadline: null,
    });
  });
});

describe("R337 — a series begun before Conquest", () => {
  it("R337 a Best-of-3 row at one win each, playing its third game, goes on as a Conquest series", () => {
    // The shape R259 wrote: game 3's decks were the last unplayed ones, picked for both sides.
    const legacy: SeriesRow = {
      ...fresh(),
      status: "playing",
      nextMatchId: "m3",
      pickDeadline: null,
      version: 6,
      sides: [
        { ...fresh().sides[0], wins: 1, pick: null },
        { ...fresh().sides[1], wins: 1, pick: null },
      ],
      games: [
        { gameNo: 1, matchId: "match-1", slots: [0, 1], first: "p1", winner: "p1", reason: "hero-death" },
        { gameNo: 2, matchId: "m2", slots: [1, 0], first: "p2", winner: "p2", reason: "concede" },
        { gameNo: 3, matchId: "m3", slots: [2, 2], first: "p1", winner: null, reason: null },
      ],
    };
    const after = gameEnded(legacy, "p1", "hero-death", NOW, "m4");
    // Two wins no longer end it: Alice has won with decks 0 and 2 and must still win with deck 1.
    expect(after.status).toBe("picking");
    expect(after.sides.map((side) => side.wins)).toEqual([2, 1]);
    expect(after.sides.map((side) => side.pick)).toEqual([1, null]);
    expect(unwonSlots(after, "p2")).toEqual([1, 2]);
    expect(viewOf(after, ALICE).you.decks.map((deck) => deck.won)).toEqual([true, false, true]);
  });
});

describe("R259, R260, R261 — what stands of the Best-of-3 rulings", () => {
  it("R259 a new series opens game 1's pick phase on the reserved match id, with each side's frozen trio", () => {
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
    expect(series.sides[0].trio).toEqual(trio("alice"));
    const view = viewOf(series, ALICE);
    expect(view.gameNo).toBe(1);
    expect(view.currentMatchId).toBeNull();
    expect(view.you.seat).toBe("p1");
    expect(viewOf(series, BOB).you.seat).toBe("p2");
  });

  it("R260 the pick clock still abandons a series nobody picks in, unrated (now R333)", () => {
    expect(timeoutPicks(fresh(), NOW + PICK_MS)).toMatchObject({ status: "over", winner: null, endReason: "abandoned" });
  });

  it("R261 a concede loses the game and never the series by itself (now R334)", () => {
    const row = gameEnded(pickDeck(pickDeck(fresh(), "p1", 0, NOW), "p2", 0, NOW), "p1", "concede", NOW, "m2");
    expect(row.status).toBe("picking");
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
    const decided = play(play(play(fresh(), [0, 0], "p2", "m2"), [1, 1], "p2", "m3"), [2, 2], "p2", "unused");
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
    step(gameEnded(row, "p1", "concede", at, "match-3"), at);
    step(forfeitSeries(row, "p2", at + 1), at + 1);
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

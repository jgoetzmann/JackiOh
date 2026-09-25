/**
 * The Conquest series as pure transitions over `SeriesRow` (SPEC §9.5, R330–R337, with R262–R264).
 *
 * Conquest is the trio mode (the queue's `bo3`, called Best of 3 before R330): a player takes the
 * series by winning one game with EACH of their three decks. A deck that has won is locked for the
 * rest of the series; a deck that lost or drew may be picked again (R330). Before each game both
 * players pick at once, from their decks that have not won yet, and a pick is sealed: final once
 * made, and hidden from the other side until both are in (R331). A player with one deck left has it
 * picked for them (R332).
 *
 * Every rule of a series lives here and nowhere else: who may pick what and when, when a game
 * begins and which seat goes first, what a finished game does to the score, when the series is
 * over and how it scores for Elo, and what each player is allowed to see of it. `series.ts` reads
 * a row, applies one of these, and writes the result back by compare-and-set; `results.ts` does the
 * same inside the game result's transaction. Nothing here reads a clock, a store or an id minter:
 * time and the next match id arrive as parameters, so the same inputs always give the same row and
 * a CAS retry can re-apply a transition to the row it re-read.
 *
 * Every exported transition returns a NEW row whose `version` is exactly one more than its input's
 * and whose `updatedAt` is `now`, because `SeriesStore.update` writes only over the version before
 * (R263). A transition that composes others (a pick that completes both picks begins the game) is
 * still one write, so it still moves the version by one.
 *
 * A transition that does not apply throws `SeriesRefusal`, with a sentence a player can read;
 * `series.ts` turns it into an HTTP answer.
 *
 * THE ROW IS THE ONE R259 WROTE. Which decks have won is not stored: it is read off `games` (the
 * slot each side played and who won), and `SeriesSide.wins` stays the count of games won, which a
 * locked deck makes the same number (a deck wins at most once). So a series begun before Conquest
 * shipped reads as a Conquest series with the games it has played (R337), and no migration was
 * needed.
 */

import type { GameOverReason } from "@jackioh/shared";

import {
  SERIES_MAX_GAMES,
  SERIES_PICK_SECONDS,
  SERIES_WINS_NEEDED,
  eloUpdate,
} from "../config";
import type {
  FrozenTrio,
  MatchSeat,
  SeriesEnd,
  SeriesGame,
  SeriesRow,
  SeriesSeat,
  SeriesSide,
  SeriesStatus,
} from "./ports";

/** Unit conversion, not configuration: the pick clock is stated in seconds, rows in epoch ms. */
const MS_PER_SECOND = 1000;

/** Games are numbered from one (`SeriesGame.gameNo`). */
const FIRST_GAME = 1;

const SEATS: readonly [SeriesSeat, SeriesSeat] = ["p1", "p2"];

// ---------------------------------------------------------------------------
// The projection's shape
// ---------------------------------------------------------------------------

/**
 * What `GET /api/series/:id` answers: `SeriesView` in `apps/web/src/net/api.ts`, field for field.
 * It is restated rather than imported because the web module reads `import.meta.env`, which the
 * server's program does not compile; `test/api/series-rules.test.ts` pins the key set.
 */
export type SeriesView = {
  id: string;
  status: SeriesStatus;
  /** The game being picked for or played, or the last one played once the series is over. */
  gameNo: number;
  /** R330: game wins that take the series — one with each deck of the trio. */
  winsNeeded: number;
  /** R334: the most games a series plays. */
  maxGames: number;
  /** Epoch ms the pick clock runs out (R333), or null outside the pick phase. */
  pickDeadline: number | null;
  /** The server's clock when it answered, so a countdown does not depend on the device's. */
  now: number;
  /** The match to open while `status` is `playing`. */
  currentMatchId: string | null;
  you: {
    seat: SeriesSeat;
    wins: number;
    trioName: string;
    /** `won`: the deck has won a game in this series and is locked (R330). `games`: games it played. */
    decks: { slot: number; name: string; cards: string[]; won: boolean; games: number }[];
    /** Your sealed pick for the next game, or null (R331). */
    pick: number | null;
    /** R332: your pick was made for you, because one deck is left that has not won. */
    autoPick: boolean;
  };
  opponent: {
    wins: number;
    /** Only which slots have won: names, cards and picks stay hidden (R336). */
    decks: { slot: number; won: boolean }[];
    /** Whether their pick is in; never what (R331). */
    picked: boolean;
  };
  games: {
    gameNo: number;
    matchId: string;
    yourSlot: number;
    opponentSlot: number;
    youWentFirst: boolean;
    result: "win" | "loss" | "draw" | null;
    reason: GameOverReason | null;
  }[];
  /** Null until the series is over. */
  result: {
    outcome: "win" | "loss" | "draw" | "abandoned";
    endReason: SeriesEnd;
    ratingBefore: number | null;
    ratingAfter: number | null;
  } | null;
};

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Why a transition did not apply. The first five reach a player (`series.ts` maps them to 409 or
 * 400); the rest are the server calling a transition out of turn — a CAS retry that re-read a row
 * another writer had already moved, which the caller treats as "nothing to do".
 */
export type SeriesRefusalReason =
  /** A game is being played, so there is nothing to pick and no series to forfeit. */
  | "not_picking"
  /** The series has ended. */
  | "over"
  /** The pick clock has run out; the sweeper is about to settle the picks (R333). */
  | "pick_closed"
  /** The slot is not one of the trio's, or not a whole number. */
  | "slot_out_of_range"
  /** That deck has already won a game in this series, so it is locked (R330). */
  | "slot_won"
  /** This player's pick for the game is already in, and a pick is final (R331). */
  | "pick_sealed"
  /** The pick names a game other than the one being picked for: a late duplicate (R331). */
  | "stale_pick"
  /** The pick clock has not run out yet. */
  | "pick_open"
  /** There is no game in play to end or to seat. */
  | "not_playing"
  /** A game cannot begin before both players have picked. */
  | "picks_missing";

export class SeriesRefusal extends Error {
  readonly reason: SeriesRefusalReason;

  constructor(reason: SeriesRefusalReason, message: string) {
    super(message);
    this.name = "SeriesRefusal";
    this.reason = reason;
  }
}

function refuse(reason: SeriesRefusalReason, message: string): never {
  throw new SeriesRefusal(reason, message);
}

const OVER_MESSAGE = "This series is over.";

// ---------------------------------------------------------------------------
// Small reads
// ---------------------------------------------------------------------------

export function seatIndex(seat: SeriesSeat): 0 | 1 {
  return seat === "p1" ? 0 : 1;
}

export function otherSeat(seat: SeriesSeat): SeriesSeat {
  return seat === "p1" ? "p2" : "p1";
}

/** The caller's seat in this series, or null when they are not one of its two players. */
export function seatOf(series: SeriesRow, profileId: string): SeriesSeat | null {
  const index = series.sides.findIndex((side) => side.profileId === profileId);
  return index < 0 ? null : (SEATS[index] ?? null);
}

function sideOf(series: SeriesRow, seat: SeriesSeat): SeriesSide {
  return series.sides[seatIndex(seat)];
}

/** How many decks this seat's trio holds: three, by L1, frozen at queue. */
function slotCount(series: SeriesRow, seat: SeriesSeat): number {
  return sideOf(series, seat).trio.decks.length;
}

/** R330: the trio slots whose deck has won a game for this seat — each one locked. */
export function wonSlots(seat: SeriesSeat, games: readonly SeriesGame[]): Set<number> {
  const index = seatIndex(seat);
  return new Set(games.filter((game) => game.winner === seat).map((game) => game.slots[index]));
}

/** The slots this seat may still pick: every slot of its trio whose deck has not won (R330). */
export function unwonSlots(series: SeriesRow, seat: SeriesSeat, games: readonly SeriesGame[] = series.games): number[] {
  const won = wonSlots(seat, games);
  const open: number[] = [];
  for (let slot = 0; slot < slotCount(series, seat); slot += 1) {
    if (!won.has(slot)) open.push(slot);
  }
  return open;
}

/**
 * R333: the deck a player who did not pick is given — their first deck in trio order that has not
 * won — or null when every deck has won (the series is then already over).
 */
export function firstUnwon(series: SeriesRow, seat: SeriesSeat, games: readonly SeriesGame[] = series.games): number | null {
  return unwonSlots(series, seat, games)[0] ?? null;
}

export function bothPicked(series: SeriesRow): boolean {
  return series.sides.every((side) => side.pick !== null);
}

/** R335: series `p1` goes first in odd games, `p2` in even ones, drawn games counted. */
function firstSeatOf(gameNo: number): SeriesSeat {
  return gameNo % 2 === 1 ? "p1" : "p2";
}

/** The game in play: the last recorded one, while it has no result. */
function gameInPlay(series: SeriesRow): SeriesGame | null {
  const last = series.games.at(-1);
  return series.status === "playing" && last !== undefined && last.winner === null ? last : null;
}

/** R332: a seat with exactly one deck left that has not won has its pick made for it. */
function automaticPick(series: SeriesRow, seat: SeriesSeat): number | null {
  const open = unwonSlots(series, seat);
  return open.length === 1 ? (open[0] ?? null) : null;
}

/**
 * R262: series `p1`'s Elo score once the series is over — 1 for a series win, 0 for a loss, 0.5
 * for a series draw — or null while it is not over and when it was abandoned (unrated, R333).
 */
export function seriesScore(series: SeriesRow): 0 | 0.5 | 1 | null {
  if (series.status !== "over" || series.winner === null) return null;
  if (series.winner === "draw") return 0.5;
  return series.winner === "p1" ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

const copy = (series: SeriesRow): SeriesRow => structuredClone(series);

/** One write: the version moves by exactly one from the row the transition was applied to. */
function stamp(next: SeriesRow, from: SeriesRow, now: number): SeriesRow {
  next.version = from.version + 1;
  next.updatedAt = now;
  return next;
}

function pickDeadlineFrom(now: number): number {
  return now + SERIES_PICK_SECONDS * MS_PER_SECOND;
}

/**
 * Records the next game from both picks and starts playing it (R331, R335). Mutates `series`.
 * Refused when a pick is missing or names a deck that has won: both are guarded before a pick is
 * stored, so this is the last word, not the first.
 */
function begin(series: SeriesRow): void {
  const [a, b] = series.sides;
  if (a.pick === null || b.pick === null) {
    refuse("picks_missing", "A game cannot start before both players have picked.");
  }
  for (const seat of SEATS) {
    const pick = sideOf(series, seat).pick;
    if (pick !== null && wonSlots(seat, series.games).has(pick)) {
      refuse("slot_won", "That deck has already won a game in this series, so it is locked.");
    }
  }
  const gameNo = series.games.length + FIRST_GAME;
  series.games.push({
    gameNo,
    matchId: series.nextMatchId,
    slots: [a.pick, b.pick],
    first: firstSeatOf(gameNo),
    winner: null,
    reason: null,
  });
  a.pick = null;
  b.pick = null;
  series.status = "playing";
  series.pickDeadline = null;
}

/**
 * Opens the pick phase for the next game under a freshly reserved match id (R263), with its clock
 * running from `now` (R333). A seat with one deck left gets it picked for it (R332); when both have,
 * there is nothing to choose and the game begins at once. Mutates `series`.
 */
function openPicks(series: SeriesRow, matchId: string, now: number): void {
  series.status = "picking";
  series.nextMatchId = matchId;
  series.pickDeadline = pickDeadlineFrom(now);
  for (const seat of SEATS) sideOf(series, seat).pick = automaticPick(series, seat);
  if (bothPicked(series)) begin(series);
}

/** Ends the series. `winner` null is an abandoned series (R333, R263). Mutates `series`. */
function end(series: SeriesRow, winner: SeriesSeat | "draw" | null, reason: SeriesEnd, now: number): void {
  series.status = "over";
  series.winner = winner;
  series.endReason = reason;
  series.pickDeadline = null;
  series.endedAt = now;
  for (const side of series.sides) side.pick = null;
}

function assertPicking(series: SeriesRow, notPickingMessage: string): void {
  if (series.status === "over") refuse("over", OVER_MESSAGE);
  if (series.status !== "picking") refuse("not_picking", notPickingMessage);
}

export type NewSeriesInput = {
  seriesId: string;
  /** The match id `tickets.claimPair` or `rooms.claim` reserved: game 1's (R263). */
  firstMatchId: string;
  /** Index 0 is series p1: the older ticket, or the room's host (R335). */
  sides: [{ profileId: string; trio: FrozenTrio }, { profileId: string; trio: FrozenTrio }];
  /** Each game's seed is `${seedBase}:${gameNo}` (R335). */
  seedBase: string;
  catalogVersion: string;
};

/** R331, R333, R263: a series in game 1's pick phase, its clock running from `now`. */
export function newSeries(input: NewSeriesInput, now: number): SeriesRow {
  const side = (entry: { profileId: string; trio: FrozenTrio }): SeriesSide => ({
    profileId: entry.profileId,
    trio: structuredClone(entry.trio),
    wins: 0,
    pick: null,
  });
  return {
    id: input.seriesId,
    sides: [side(input.sides[0]), side(input.sides[1])],
    catalogVersion: input.catalogVersion,
    seedBase: input.seedBase,
    status: "picking",
    games: [],
    nextMatchId: input.firstMatchId,
    pickDeadline: pickDeadlineFrom(now),
    winner: null,
    endReason: null,
    ratingBefore: null,
    ratingAfter: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    version: 1,
  };
}

/**
 * R331: `seat` picks trio slot `slot` for the next game. The pick is sealed: once it is in it is
 * final (`pick_sealed`, checked first, which `series.ts` answers as a success when the same slot is
 * sent again, so a retried request is harmless), and the other side learns only that it is in. A
 * pick that names its game (`gameNo`) is refused as `stale_pick` when that is not the game being
 * picked for, so a late duplicate of game n's pick can never become game n + 1's. The pick that
 * completes both begins the game at once. Refused once the pick clock has run out (R333), for a slot
 * the trio does not have, and for a deck that has already won in this series (R330).
 */
export function pickDeck(series: SeriesRow, seat: SeriesSeat, slot: number, now: number, gameNo?: number): SeriesRow {
  assertPicking(series, "A game of this series is being played; pick your next deck when it ends.");
  const pickingFor = series.games.length + FIRST_GAME;
  if (gameNo !== undefined && gameNo !== pickingFor) {
    refuse("stale_pick", `That pick was for game ${String(gameNo)}; this is game ${String(pickingFor)}'s pick.`);
  }
  const side = sideOf(series, seat);
  if (side.pick !== null) {
    refuse("pick_sealed", "Your pick for this game is already in, and it is final.");
  }
  if (series.pickDeadline !== null && now >= series.pickDeadline) {
    refuse("pick_closed", "The pick clock has run out for this game.");
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= side.trio.decks.length) {
    refuse("slot_out_of_range", "Pick one of the three decks in your trio.");
  }
  if (wonSlots(seat, series.games).has(slot)) {
    refuse("slot_won", "That deck has already won a game in this series, so it is locked; pick another.");
  }

  const next = copy(series);
  sideOf(next, seat).pick = slot;
  if (bothPicked(next)) begin(next);
  return stamp(next, series, now);
}

/** R331: both have picked, so the game begins: recorded, seated and `playing`. */
export function beginGame(series: SeriesRow, now: number): SeriesRow {
  assertPicking(series, "This game has already begun.");
  const next = copy(series);
  begin(next);
  return stamp(next, series, now);
}

/**
 * R330, R334: the game in play ended. `winner` is the series seat that won it — the deck it played
 * is locked from now on — or `"draw"`, which counts for neither side and locks nothing. A side at
 * `SERIES_WINS_NEEDED` wins has won with every deck and takes the series (`decided`). After
 * `SERIES_MAX_GAMES` games without that, more wins takes it and equal wins is a series draw
 * (`exhausted`). Otherwise the next pick phase opens under `newMatchId` (R263), with the picks made
 * for a side that has one deck left (R332) — and when both have, the game begins at once.
 */
export function gameEnded(
  series: SeriesRow,
  winner: SeriesSeat | "draw",
  reason: GameOverReason,
  now: number,
  newMatchId: string,
): SeriesRow {
  if (series.status === "over") refuse("over", OVER_MESSAGE);
  if (gameInPlay(series) === null) refuse("not_playing", "No game of this series is being played.");

  const next = copy(series);
  const game = next.games.at(-1);
  if (game === undefined) refuse("not_playing", "No game of this series is being played.");
  game.winner = winner;
  game.reason = reason;
  if (winner !== "draw") sideOf(next, winner).wins += 1;

  const [p1, p2] = next.sides;
  if (p1.wins >= SERIES_WINS_NEEDED || p2.wins >= SERIES_WINS_NEEDED) {
    end(next, p1.wins >= SERIES_WINS_NEEDED ? "p1" : "p2", "decided", now);
  } else if (next.games.length >= SERIES_MAX_GAMES) {
    end(next, p1.wins > p2.wins ? "p1" : p2.wins > p1.wins ? "p2" : "draw", "exhausted", now);
  } else {
    openPicks(next, newMatchId, now);
  }
  return stamp(next, series, now);
}

/**
 * R333: the pick clock ran out. A player who has not picked gets their first deck in trio order that
 * has not won, and the game begins; if neither has a pick in, the series is abandoned — no winner,
 * unrated. A pick made for a player (R332) is a pick. Refused before the deadline, so a stale sweep
 * cannot close a pick phase that opened after it read.
 */
export function timeoutPicks(series: SeriesRow, now: number): SeriesRow {
  assertPicking(series, "A game of this series is being played.");
  if (series.pickDeadline === null || now < series.pickDeadline) {
    refuse("pick_open", "The pick clock is still running.");
  }

  const next = copy(series);
  if (next.sides.every((side) => side.pick === null)) {
    end(next, null, "abandoned", now);
    return stamp(next, series, now);
  }
  for (const seat of SEATS) {
    const side = sideOf(next, seat);
    if (side.pick !== null) continue;
    const slot = firstUnwon(next, seat);
    if (slot === null) refuse("picks_missing", "Every deck of this trio has already won.");
    side.pick = slot;
  }
  begin(next);
  return stamp(next, series, now);
}

/**
 * R263: a game whose picks are in but whose match could not be started for
 * `SERIES_START_GIVE_UP_SECONDS` ends the series abandoned — no winner, unrated (R262) — so no player
 * is held in a series that cannot go on. The unplayed game is taken off the record: it never
 * happened. The sweeper decides the time has come; this only makes the change.
 */
export function abandonUnstarted(series: SeriesRow, now: number): SeriesRow {
  if (series.status === "over") refuse("over", OVER_MESSAGE);
  if (series.status !== "playing") refuse("not_playing", "No game of this series is waiting to start.");
  const current = series.games.at(-1);
  if (current === undefined || current.matchId !== series.nextMatchId || current.winner !== null) {
    refuse("not_playing", "No game of this series is waiting to start.");
  }
  const next = copy(series);
  next.games.pop();
  end(next, null, "abandoned", now);
  return stamp(next, series, now);
}

/**
 * R334: `seat` leaves the series between games and the other side wins it (`forfeit`). During a
 * game the way out is to concede that game, so a forfeit is refused while one is being played.
 */
export function forfeitSeries(series: SeriesRow, seat: SeriesSeat, now: number): SeriesRow {
  assertPicking(
    series,
    "A game is being played: concede the game instead. You can forfeit the series between games.",
  );
  const next = copy(series);
  end(next, otherSeat(seat), "forfeit", now);
  return stamp(next, series, now);
}

/**
 * R262: records the series' one Elo move on a row that has just ended, from `before` (series p1's
 * rating, then p2's). Not a transition — it rides on the ending's own write, so the version is left
 * alone. An abandoned series is unrated and keeps both fields null.
 */
export function rateSeries(series: SeriesRow, before: readonly [number, number]): SeriesRow {
  const score = seriesScore(series);
  const next = copy(series);
  if (score === null) {
    next.ratingBefore = null;
    next.ratingAfter = null;
    return next;
  }
  const after = eloUpdate(before[0], before[1], score);
  next.ratingBefore = [before[0], before[1]];
  next.ratingAfter = [after.a, after.b];
  return next;
}

// ---------------------------------------------------------------------------
// The game in play
// ---------------------------------------------------------------------------

/**
 * R335: the two seats and the seed of the game in play. The match's `p1` is the side that goes
 * first in this game (series `p1` in odd games, `p2` in even ones), each playing the deck in the
 * trio slot they picked, and the seed is `${seedBase}:${gameNo}`.
 */
export function gameSeats(series: SeriesRow): { seats: [MatchSeat, MatchSeat]; seed: string } {
  const game = gameInPlay(series);
  if (game === null) refuse("not_playing", "No game of this series is being played.");
  const firstIndex = seatIndex(game.first);
  const secondIndex = seatIndex(otherSeat(game.first));
  const seatFor = (index: 0 | 1, player: "p1" | "p2"): MatchSeat => {
    const side = series.sides[index];
    const deck = side.trio.decks[game.slots[index]];
    if (deck === undefined) throw new Error(`series ${series.id}: slot ${String(game.slots[index])} is not a deck`);
    return { profileId: side.profileId, player, deck: [...deck.cards] };
  };
  return {
    seats: [seatFor(firstIndex, "p1"), seatFor(secondIndex, "p2")],
    seed: `${series.seedBase}:${String(game.gameNo)}`,
  };
}

/**
 * R331: whether `slot` is the pick `seat` already made — for game `gameNo` when the request named
 * one, else for the game now picked for or in play — which is what a retried pick request finds
 * after its first attempt landed. `series.ts` answers such a retry as the success it was, rather
 * than as a refusal the player did nothing to earn.
 */
export function alreadyPicked(series: SeriesRow, seat: SeriesSeat, slot: number, gameNo?: number): boolean {
  if (gameNo !== undefined) {
    const begun = series.games.find((game) => game.gameNo === gameNo);
    if (begun !== undefined) return begun.slots[seatIndex(seat)] === slot;
    return (
      series.status === "picking" &&
      gameNo === series.games.length + FIRST_GAME &&
      sideOf(series, seat).pick === slot
    );
  }
  if (series.status === "picking") return sideOf(series, seat).pick === slot;
  const game = gameInPlay(series);
  return game !== null && game.slots[seatIndex(seat)] === slot;
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * What one player may see of a series (R336): all of their own trio, and of the opponent's only
 * which slots have won and whether a pick is in — never its slot before both have picked (by then
 * the game has begun and it is history), never a deck name, never a card. Null for a profile that is
 * not one of the two players.
 */
export function projectSeries(series: SeriesRow, viewerProfileId: string, now: number): SeriesView | null {
  const seat = seatOf(series, viewerProfileId);
  if (seat === null) return null;
  const mine = seatIndex(seat);
  const theirs = seatIndex(otherSeat(seat));
  const you = series.sides[mine];
  const opponent = series.sides[theirs];
  const myWon = wonSlots(seat, series.games);
  const theirWon = wonSlots(otherSeat(seat), series.games);
  const picking = series.status === "picking";

  const outcomeOf = (winner: SeriesSeat | "draw"): "win" | "loss" | "draw" =>
    winner === "draw" ? "draw" : winner === seat ? "win" : "loss";

  const gameNo = picking ? series.games.length + FIRST_GAME : Math.max(series.games.length, FIRST_GAME);

  return {
    id: series.id,
    status: series.status,
    gameNo,
    winsNeeded: SERIES_WINS_NEEDED,
    maxGames: SERIES_MAX_GAMES,
    pickDeadline: picking ? series.pickDeadline : null,
    now,
    currentMatchId: series.status === "playing" ? series.nextMatchId : null,
    you: {
      seat,
      wins: you.wins,
      trioName: you.trio.name,
      decks: you.trio.decks.map((deck, slot) => ({
        slot,
        name: deck.name,
        cards: [...deck.cards],
        won: myWon.has(slot),
        games: series.games.filter((game) => game.slots[mine] === slot).length,
      })),
      pick: picking ? you.pick : null,
      autoPick: picking && you.pick !== null && automaticPick(series, seat) === you.pick,
    },
    opponent: {
      wins: opponent.wins,
      decks: opponent.trio.decks.map((_deck, slot) => ({ slot, won: theirWon.has(slot) })),
      picked: picking && opponent.pick !== null,
    },
    games: series.games.map((game) => ({
      gameNo: game.gameNo,
      matchId: game.matchId,
      yourSlot: game.slots[mine],
      opponentSlot: game.slots[theirs],
      youWentFirst: game.first === seat,
      result: game.winner === null ? null : outcomeOf(game.winner),
      reason: game.reason,
    })),
    result:
      series.status !== "over" || series.endReason === null
        ? null
        : {
            outcome:
              series.endReason === "abandoned" || series.winner === null
                ? "abandoned"
                : outcomeOf(series.winner),
            endReason: series.endReason,
            ratingBefore: series.ratingBefore?.[mine] ?? null,
            ratingAfter: series.ratingAfter?.[mine] ?? null,
          },
  };
}

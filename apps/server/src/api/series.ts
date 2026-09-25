/**
 * The Conquest series (SPEC §9.5, R330–R338, with R262–R264): the store half of `series-rules.ts`.
 *
 * The rules are pure functions over `SeriesRow` in `series-rules.ts`; this file reads a row,
 * applies one of them and writes the result back, and does the three things a pure function
 * cannot:
 *
 *  - **Compare-and-set** (R263). A series has several writers — both players' requests, the
 *    sweeper, and `results.ts` when a game ends — and `SeriesStore.update` writes only over the
 *    version it was computed from. A write that loses re-reads the row and re-applies the same
 *    transition to it, so the loser's intent lands on the winner's state or is refused by the rules
 *    (a pick that arrives after the game began finds `playing`). A pick is persisted in the row
 *    before it is acknowledged, so a restart keeps it, and it leaves the server only in its owner's
 *    projection (R331).
 *  - **The rating move** (R262). When a transition ends the series, its one Elo move is computed
 *    from both players' current ratings and written in the same transaction as the row, which
 *    records it (`ratingBefore`, `ratingAfter`). A game inside a series is never rated
 *    (`results.ts`). An abandoned series is unrated.
 *  - **Starting the game** (R331, R263). When both picks are in, the game in `nextMatchId` is
 *    started through `deps.matches` with the seats and seed `gameSeats` names, and both players'
 *    in-match flags are set. It happens after the commit, because the actor must never run a game
 *    the series row does not name; a crash between the two leaves a `playing` series with no match,
 *    which the sweeper starts once the row has sat unchanged for `SERIES_START_GRACE_SECONDS`.
 */

import {
  SERIES_START_GIVE_UP_SECONDS,
  SERIES_START_GRACE_SECONDS,
  SERIES_SWEEP_INTERVAL_SECONDS,
  SERIES_WRITE_ATTEMPTS,
} from "../config";
import type { TerminalOutcome } from "../match/contracts";
import { callerProfile } from "./collection";
import { ApiError, badRequest, ok, route, type ApiRequest, type Route } from "./http";
import type { MatchSeat, ServerDeps, SeriesRow, SeriesSeat, Store, Timer } from "./ports";
import {
  SeriesRefusal,
  abandonUnstarted,
  alreadyPicked,
  forfeitSeries,
  gameEnded,
  gameSeats,
  newSeries,
  pickDeck,
  projectSeries,
  rateSeries,
  seatOf,
  seriesScore,
  timeoutPicks,
  type NewSeriesInput,
} from "./series-rules";

export type { NewSeriesInput } from "./series-rules";

/** Unit conversion, not configuration: the series constants are stated in seconds. */
const MS_PER_SECOND = 1000;


// ---------------------------------------------------------------------------
// Making a series
// ---------------------------------------------------------------------------

/**
 * Makes the series in game 1's pick phase and persists it (R331, R333, R263). Called by pairing
 * (`queue.ts`) and by a Conquest room's join (`match/rooms.ts`) with the match id they reserved,
 * which becomes game 1's. No match starts and no in-match flag is set: a series in its pick phase
 * is not a match, and `assertNotInSeries` is what keeps its players out of the queue meanwhile.
 *
 * `store` lets a caller make the series inside its own transaction (the claim and the series then
 * land together); it defaults to `deps.store`.
 */
export async function startSeries(
  deps: ServerDeps,
  input: NewSeriesInput,
  store: Store = deps.store,
): Promise<SeriesRow> {
  const now = deps.timers.now();
  const series = newSeries(input, now);
  await store.series.create(series);
  // §9.5: a player in a series is in no queue. The queue's own pairing has claimed both tickets
  // already, but a player may have joined (or hosted) a Conquest room while a ticket of theirs
  // waited. A match's result cancels such a ticket; a series can end with no game played (a
  // forfeit or an abandoned pick, R333, R334), and then nothing would, and the stale ticket would
  // pair them into a match they stopped waiting for. So it goes now, as the series begins.
  for (const side of series.sides) {
    const stale = await store.tickets.openForProfile(side.profileId);
    if (stale !== null) await store.tickets.cancel(stale.id, now);
  }
  deps.log.info("series.started", {
    seriesId: series.id,
    players: series.sides.map((side) => side.profileId),
    matchId: series.nextMatchId,
    pickDeadline: series.pickDeadline,
  });
  return series;
}

// ---------------------------------------------------------------------------
// Starting a game
// ---------------------------------------------------------------------------

/**
 * Starts the game `series.nextMatchId` names when the series is `playing` and that match is
 * neither running in this process nor written to the store (R263). Safe to call from several
 * places at once — the request whose pick completed both, the result whose next game both sides'
 * automatic picks began (R332), the sweeper — because a start that loses to another start finds the row the winner wrote and stops.
 */
export async function ensureSeriesGame(deps: ServerDeps, series: SeriesRow): Promise<void> {
  await startSeriesGame(deps, series);
}

/** `ensureSeriesGame`, answering whether this call is the one that started the match. */
async function startSeriesGame(deps: ServerDeps, series: SeriesRow): Promise<boolean> {
  if (series.status !== "playing") return false;
  const matchId = series.nextMatchId;
  if (deps.matches.has(matchId)) return false;

  const { seats, seed } = gameSeats(series);
  const existing = await deps.store.matches.get(matchId);
  if (existing !== null) {
    if (existing.status === "live") {
      // Started, and then the process stopped before the in-match flags were written: the match
      // itself rebuilds from its log when a socket arrives, so only the flags need healing.
      await markInMatch(deps, seats, matchId);
      return false;
    }
    // The match ended but the series still names it as the game in play. `results.ts` advances the
    // series in the same transaction as the result, so this is a result that was never written.
    // Re-read first: the row we were handed may simply be older than the result.
    const fresh = await deps.store.series.get(series.id);
    if (fresh !== null && fresh.status === "playing" && fresh.nextMatchId === matchId) {
      deps.log.alert("series.game_unrecorded", { seriesId: series.id, matchId });
    }
    return false;
  }

  try {
    await deps.matches.start({ matchId, seed, catalogVersion: series.catalogVersion, seats });
  } catch (error) {
    // Another start got there first — a request and the sweeper, or a second process — and wrote
    // the row this one was about to write. That start sets the flags.
    if ((await deps.store.matches.get(matchId)) !== null) return false;
    throw error;
  }

  // After the start, not before: for every game after the first the match row is what `profiles`' in-match
  // reference points at, and only the start writes it.
  await markInMatch(deps, seats, matchId);
  deps.log.info("series.game_started", {
    seriesId: series.id,
    matchId,
    gameNo: series.games.length,
    seed,
  });
  return true;
}

/** §9.5's in-match state for both players of a series game, in one transaction. */
async function markInMatch(
  deps: ServerDeps,
  seats: readonly [MatchSeat, MatchSeat],
  matchId: string,
): Promise<void> {
  await deps.store.tx(async (t) => {
    const profiles = await t.profiles.getMany(seats.map((seat) => seat.profileId));
    for (const profile of profiles) {
      if (profile.inMatchId !== matchId) await t.profiles.setInMatch(profile.id, matchId);
    }
  });
}

/**
 * After a commit that may have left the series `playing`, start its game. A failure is logged and
 * left to the sweeper (R263): the write that led here has committed and must not be reported as
 * failed because the match behind it could not start yet.
 */
export async function resumeSeries(deps: ServerDeps, series: SeriesRow | null): Promise<void> {
  if (series === null || series.status !== "playing") return;
  try {
    await startSeriesGame(deps, series);
  } catch (error) {
    deps.log.warn("series.start_failed", {
      seriesId: series.id,
      matchId: series.nextMatchId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Writing a transition
// ---------------------------------------------------------------------------

/** Both players' current ratings, series p1 first. Games inside a series never move them (R262). */
async function ratingsOf(t: Store, deps: ServerDeps, series: SeriesRow): Promise<[number, number]> {
  const [p1, p2] = series.sides;
  const profiles = await t.profiles.getMany([p1.profileId, p2.profileId]);
  const rating = (profileId: string): number => {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (profile !== undefined) return profile.rating;
    deps.log.alert("series.profile_missing", { seriesId: series.id, profileId });
    return deps.config.eloStart;
  };
  return [rating(p1.profileId), rating(p2.profileId)];
}

/**
 * Writes `next` over `before` inside the caller's transaction, and with it everything an ending
 * owes: R262's rating move, recorded on the row, and — for a series that ends before game 1 was
 * played — the reserved match id released (R263). Null when the compare-and-set lost; nothing has
 * been written then, so the caller may re-read and try again in the same transaction.
 */
async function commitSeries(
  t: Store,
  deps: ServerDeps,
  before: SeriesRow,
  next: SeriesRow,
): Promise<SeriesRow | null> {
  const ends = next.status === "over" && before.status !== "over";
  const row = ends && seriesScore(next) !== null ? rateSeries(next, await ratingsOf(t, deps, next)) : next;

  if (!(await t.series.update(row))) return null;
  if (!ends) return row;

  if (row.ratingBefore !== null && row.ratingAfter !== null) {
    for (const index of [0, 1] as const) {
      if (row.ratingAfter[index] !== row.ratingBefore[index]) {
        await t.profiles.setRating(row.sides[index].profileId, row.ratingAfter[index]);
      }
    }
  }
  if (row.games.length === 0) await t.matches.discardOpen(row.nextMatchId);

  deps.log.info("series.ended", {
    seriesId: row.id,
    winner: row.winner,
    endReason: row.endReason,
    games: row.games.length,
    ratingBefore: row.ratingBefore,
    ratingAfter: row.ratingAfter,
  });
  return row;
}

type Written = { before: SeriesRow; after: SeriesRow };

/**
 * One transition, written by compare-and-set (R263). Each attempt reads the row, applies
 * `transition` and writes it in one transaction; a lost write is retried on a fresh read. A
 * `SeriesRefusal` from the rules is thrown as it is. After the commit, a series that has just
 * begun a game gets that game started.
 */
async function writeTransition(
  deps: ServerDeps,
  seriesId: string,
  transition: (series: SeriesRow) => SeriesRow,
): Promise<Written> {
  for (let attempt = 1; attempt <= SERIES_WRITE_ATTEMPTS; attempt += 1) {
    const written = await deps.store.tx(async (t): Promise<Written | null> => {
      const before = await t.series.get(seriesId);
      if (before === null) throw seriesNotFound();
      const after = await commitSeries(t, deps, before, transition(before));
      return after === null ? null : { before, after };
    });
    if (written === null) continue;
    if (written.before.status !== "playing") await resumeSeries(deps, written.after);
    return written;
  }
  deps.log.warn("series.write_contended", { seriesId, attempts: SERIES_WRITE_ATTEMPTS });
  throw new ApiError("conflict", "This series changed while your request was on its way. Try again.");
}

// ---------------------------------------------------------------------------
// A game's result (called by `results.ts` inside its transaction)
// ---------------------------------------------------------------------------

export type SeriesGameResult = {
  matchId: string;
  /** The match's seats, index 0 being the match's p1 — not necessarily series p1 (R335). */
  seats: readonly [MatchSeat, MatchSeat];
  outcome: TerminalOutcome;
  at: number;
};

/** The series seat that won the match, found by profile id, or `"draw"`. */
function seriesWinnerOf(series: SeriesRow, result: SeriesGameResult): SeriesSeat | "draw" {
  if (result.outcome.winner === "draw") return "draw";
  const seat = result.seats.find((candidate) => candidate.player === result.outcome.winner);
  const winner = seat === undefined ? null : seatOf(series, seat.profileId);
  if (winner === null) {
    throw new Error(`series ${series.id}: the winner of ${result.matchId} is not one of its players`);
  }
  return winner;
}

/**
 * R334, R263: records the game `result.matchId` in `series` and, when that ends the series, R262's
 * rating move, all inside `t` — the transaction `results.ts` writes the game's result in, so the
 * result, the series' record of it and the rating move commit together or not at all. The next
 * game's match id is minted here, when its pick phase opens. Throws when the write cannot land, which
 * rolls the result back with it.
 */
export async function advanceSeriesInTx(
  t: Store,
  deps: ServerDeps,
  series: SeriesRow,
  result: SeriesGameResult,
): Promise<SeriesRow> {
  let current = series;
  for (let attempt = 1; ; attempt += 1) {
    const next = gameEnded(current, seriesWinnerOf(current, result), result.outcome.reason, result.at, deps.ids.uuid());
    const written = await commitSeries(t, deps, current, next);
    if (written !== null) return written;

    const reread = await t.series.get(current.id);
    const stillThisGame =
      reread !== null && reread.status === "playing" && reread.nextMatchId === result.matchId;
    if (attempt >= SERIES_WRITE_ATTEMPTS || !stillThisGame) {
      throw new Error(`series ${current.id}: the result of ${result.matchId} could not be recorded`);
    }
    current = reread;
  }
}

// ---------------------------------------------------------------------------
// The sweeper (R333, R263)
// ---------------------------------------------------------------------------

export type SeriesSweep = { timedOut: string[]; started: string[]; abandoned: string[] };

/**
 * One sweep over every series that is not over:
 *  - a pick phase past its deadline is settled (R333): missing picks are made and the game starts,
 *    or, with no pick at all, the series is abandoned;
 *  - a `playing` series whose match is not running and whose row has not changed for
 *    `SERIES_START_GRACE_SECONDS` gets its match started (R263). The grace is what keeps the
 *    sweeper from racing the request that is starting that match right now;
 *  - one that still has no match row `SERIES_START_GIVE_UP_SECONDS` after its picks is abandoned,
 *    unrated (R263): its game cannot be started, and its players are let go.
 *
 * One series that fails does not stop the sweep.
 */
export async function sweepSeries(deps: ServerDeps): Promise<SeriesSweep> {
  const now = deps.timers.now();
  const graceMs = SERIES_START_GRACE_SECONDS * MS_PER_SECOND;
  const giveUpMs = SERIES_START_GIVE_UP_SECONDS * MS_PER_SECOND;
  const swept: SeriesSweep = { timedOut: [], started: [], abandoned: [] };

  for (const series of await deps.store.series.active()) {
    try {
      if (series.status === "picking") {
        if (series.pickDeadline === null || now < series.pickDeadline) continue;
        const { after } = await writeTransition(deps, series.id, (row) => timeoutPicks(row, now));
        swept.timedOut.push(series.id);
        deps.log.info("series.pick_timeout", {
          seriesId: series.id,
          outcome: after.status === "over" ? "abandoned" : "auto-picked",
        });
        continue;
      }
      if (series.status !== "playing") continue;
      if (now - series.updatedAt < graceMs) continue;
      if (deps.matches.has(series.nextMatchId)) continue;
      // R263: a game that has had every chance to start and still has no match row cannot be
      // started, so the series is given up rather than holding both players in it for ever. A
      // live or finished match row means the game did start, and is never given up here.
      if (
        now - series.updatedAt >= giveUpMs &&
        (await deps.store.matches.get(series.nextMatchId)) === null
      ) {
        await writeTransition(deps, series.id, (row) => abandonUnstarted(row, now));
        swept.abandoned.push(series.id);
        deps.log.alert("series.game_unstartable", { seriesId: series.id, matchId: series.nextMatchId });
        continue;
      }
      if (await startSeriesGame(deps, series)) {
        swept.started.push(series.id);
        deps.log.warn("series.game_recovered", { seriesId: series.id, matchId: series.nextMatchId });
      }
    } catch (error) {
      // Another writer moved the series first: the rules refused a transition that no longer
      // applies, which is the sweep having nothing to do.
      if (error instanceof SeriesRefusal) continue;
      deps.log.warn("series.sweep_failed", {
        seriesId: series.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return swept;
}

/**
 * R263: the sweeper, every `SERIES_SWEEP_INTERVAL_SECONDS`. Rescheduled through `deps.timers.after`
 * like `startMatchmaker` (queue.ts), so a test drives it with the manual clock, and a failed sweep
 * never stops the next one.
 */
export function startSeriesSweeper(deps: ServerDeps): { stop: () => void } {
  let timer: Timer | null = null;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    timer = deps.timers.after(SERIES_SWEEP_INTERVAL_SECONDS * MS_PER_SECOND, () => {
      timer = null;
      void sweep();
    });
  };

  const sweep = async (): Promise<void> => {
    try {
      await sweepSeries(deps);
    } catch (error) {
      deps.log.warn("series.sweeper_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    arm();
  };

  arm();
  return {
    stop: () => {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** One answer for a missing series and one the caller is not in, so an id reveals nothing. */
function seriesNotFound(): ApiError {
  return new ApiError("not_found", "This series could not be found.");
}

/** A rules refusal as the player hears it: a bad slot is their request, the rest is timing. */
function refusalToApi(refusal: SeriesRefusal): ApiError {
  if (refusal.reason === "slot_out_of_range" || refusal.reason === "slot_won") {
    return badRequest(refusal.message);
  }
  return new ApiError("conflict", refusal.message);
}

/** The caller's series and seat, or the 404 a stranger gets. */
async function callersSeries(
  req: ApiRequest,
  deps: ServerDeps,
): Promise<{ series: SeriesRow; seat: SeriesSeat; profileId: string }> {
  const profile = callerProfile(req);
  const series = await deps.store.series.get(req.params["id"] ?? "");
  const seat = series === null ? null : seatOf(series, profile.id);
  if (series === null || seat === null) throw seriesNotFound();
  return { series, seat, profileId: profile.id };
}

function slotOf(body: Readonly<Record<string, unknown>>): number {
  const value = body["slot"];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badRequest("Pick one of the three decks in your trio.");
  }
  return value;
}

/** A transition requested by a player: refusals become their HTTP answers. */
async function playerTransition(
  deps: ServerDeps,
  seriesId: string,
  transition: (series: SeriesRow) => SeriesRow,
): Promise<SeriesRow> {
  try {
    return (await writeTransition(deps, seriesId, transition)).after;
  } catch (error) {
    if (error instanceof SeriesRefusal) throw refusalToApi(error);
    throw error;
  }
}

function view(deps: ServerDeps, series: SeriesRow, profileId: string): unknown {
  return projectSeries(series, profileId, deps.timers.now());
}

export function createSeriesRoutes(): Route[] {
  return [
    /** The caller's view of the series (R336). 404 when it does not exist or they are not in it. */
    route("GET", "/api/series/:id", "active", async (req, deps) => {
      const { series, profileId } = await callersSeries(req, deps);
      return ok(view(deps, series, profileId));
    }),

    /**
     * R331: pick a trio slot for the next game. The pick is sealed: final once in, and shown to the
     * other side only as "picked". The pick that completes both starts the game, and the answer
     * then names it in `currentMatchId`. The same slot sent again (a retry whose first answer was
     * lost) is answered with the current view, as the success it was. 409 for a different slot once
     * a pick is in, while a game is being played, or after the pick clock ran out (R333); 400 for a
     * slot out of range or one whose deck has won (R330).
     */
    route("POST", "/api/series/:id/pick", "active", async (req, deps) => {
      const slot = slotOf(req.body);
      const { series, seat, profileId } = await callersSeries(req, deps);
      const now = deps.timers.now();
      try {
        const { after } = await writeTransition(deps, series.id, (row) => pickDeck(row, seat, slot, now));
        deps.log.info("series.picked", { seriesId: series.id, seat, status: after.status });
        return ok(view(deps, after, profileId));
      } catch (error) {
        if (!(error instanceof SeriesRefusal)) throw error;
        if (error.reason === "pick_sealed" || error.reason === "not_picking") {
          const current = await deps.store.series.get(series.id);
          if (current !== null && alreadyPicked(current, seat, slot)) return ok(view(deps, current, profileId));
        }
        throw refusalToApi(error);
      }
    }),

    /** R334: leave the series between games; the other side wins it. 409 during a game. */
    route("POST", "/api/series/:id/forfeit", "active", async (req, deps) => {
      const { series, seat, profileId } = await callersSeries(req, deps);
      const now = deps.timers.now();
      const after = await playerTransition(deps, series.id, (row) => forfeitSeries(row, seat, now));
      return ok(view(deps, after, profileId));
    }),

    /**
     * The series a match was a game of, for the board's series banner once the game ends: `null`
     * when the match is not a series game or the caller is not one of its players.
     */
    route("GET", "/api/matches/:matchId/series", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const series = await deps.store.series.withGame(req.params["matchId"] ?? "");
      const projected = series === null ? null : projectSeries(series, profile.id, deps.timers.now());
      return ok({ series: projected });
    }),
  ];
}

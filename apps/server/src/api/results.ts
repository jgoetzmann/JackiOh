/**
 * Results and rating (BUILD M7-T2, SPEC §2.5, §9.5, §9.12, R79, R112, R603, R604).
 *
 * §9.5: "Every ending records a result and clears both players' in-match state, and a reaper
 * resolves anything past the ceiling." §9.12: a ranked game moves both players' hidden Glicko-2
 * ratings and their ranks on the ladder.
 *
 * One function is that sentence: `createRecordResult(deps)` returns the `RecordResult` port the
 * actor calls for every one of §2.5's seven endings — `hero-death`, `both-heroes-dead`,
 * `concede`, `draw-accepted`, `turn-cap`, `disconnect` and `match-ceiling` — and it writes exactly
 * one `results` row, rates both players when the match is ranked (R604) and clears both in-match
 * flags in one transaction.
 *
 * It is idempotent by design, not by luck: the actor and the reaper can both reach the same
 * terminal match (a crashed actor is exactly the case §9.5's reaper exists for), so the first
 * thing the transaction does is look for the row it is about to write.
 *
 * The rating maths is `src/ranked/glicko2.ts` and the ladder `src/ranked/ladder.ts`, reached through
 * `rateRankedGame` (`ranked.ts`), which also writes the record of the rated game (R611). This file
 * only decides which side won: §2.5's draws are a draw (0.5 each), and a concede and a disconnect
 * are a loss like any other.
 *
 * A room challenge is unranked (R604): its row records both ratings unchanged.
 *
 * A game of a Conquest series is written the same way with one difference and one addition
 * (R262, R263): its row leaves both ratings unchanged, because a series moves the rating once, when it
 * ends; and the series' record of the game — and, when the game ends the series, that one rating
 * move — commit in the same transaction as the row (`advanceSeriesInTx` in `series.ts`). When the
 * game leaves the series in its next game already (both sides had one deck left, so both picks were
 * made for them, R332), that game is started after the commit.
 */

import type {
  MatchRow,
  MatchSeat,
  Profile,
  ResultRow,
  SeriesRow,
  ServerDeps,
  Store,
} from "./ports";
import type { RecordResult, RecordResultInput, TerminalOutcome } from "../match/contracts";
import { recordLiveGame } from "./game-records";
import { rateRankedGame } from "./ranked";
import { advanceSeriesInTx, resumeSeries } from "./series";

/**
 * The side of the match's two seats that won, or null for a draw. §2.5: both heroes dead in the
 * same check, an accepted draw offer, the end of the 30th turn and the hard ceiling are draws;
 * everything else names a winner, a concede and a disconnect included.
 */
function winnerSideOf(outcome: TerminalOutcome, seats: readonly [MatchSeat, MatchSeat]): 0 | 1 | null {
  if (outcome.winner === "draw") return null;
  return outcome.winner === seats[0].player ? 0 : 1;
}

/**
 * R112: a reaper-resolved ceiling draw "records `turns = 0` and leaves both ratings unchanged,
 * where the same draw resolved by a live match actor records the real turn count and applies the
 * ordinary rating move". So the rating move is a parameter of the write, not a property of the
 * reason: the same `match-ceiling` draw rates differently depending on who resolved it.
 */
type RatingPolicy = "rated" | "unchanged";

type WriteInput = RecordResultInput & { ratingPolicy: RatingPolicy };

/**
 * What one write did: the row (new, or the one already there), and the series this write advanced
 * — null for a match that is not a series game and for a repeated write, which advances nothing.
 */
type Written = { row: ResultRow; series: SeriesRow | null };

/**
 * The one write. Everything it touches is inside `deps.store.tx`, so a mid-write failure leaves
 * no half-ended match: either the row, both ratings, both in-match flags and the match's own
 * `finished` state all land, or none of them do.
 */
async function writeResult(deps: ServerDeps, input: WriteInput): Promise<Written> {
  return deps.store.tx(async (t: Store): Promise<Written> => {
    // §9.5 idempotency: one row per match. The in-memory store and the `results` primary key both
    // refuse a second row, so this read is what turns that refusal into a clean no-op — and it is
    // inside the transaction, so a concurrent actor and reaper cannot both pass it.
    const already = await t.results.getByMatch(input.matchId);
    if (already !== null) return { row: already, series: null };

    // R262: a game of a Conquest series is recorded but not rated — the series moves the rating
    // once, when it ends — whoever resolved it. R604: and a match the queue did not pair (a room
    // challenge) is never rated at all. The match row is what says so; a match whose row is gone
    // cannot say it was ranked, so it is not rated.
    const series = await t.series.byMatch(input.matchId);
    const match = await t.matches.get(input.matchId);
    const ratingPolicy: RatingPolicy =
      series === null && match !== null && match.ranked ? input.ratingPolicy : "unchanged";

    // A ranked series reaches its rating move — and so openSeasonInTx's `lockSeasons` — inside
    // `advanceSeriesInTx` below, AFTER `results.insert`, `setInMatch` and the rest have already
    // taken row locks. Take the season lock first: a tx that waits on it while holding profile
    // locks deadlocks with the season opener holding it, whose `resetRatings` update wants those
    // very rows. Every other path to `lockSeasons` already takes it before writing, and the
    // advisory lock is re-entrant, so `openSeasonInTx`'s own take costs nothing here.
    if (series?.ranked === true) await t.ranked.lockSeasons();

    const [seatA, seatB] = input.seats;
    const profiles = await t.profiles.getMany([seatA.profileId, seatB.profileId]);
    const byId = new Map<string, Profile>(profiles.map((profile) => [profile.id, profile]));
    const ratingOf = (seat: MatchSeat): number => {
      const profile = byId.get(seat.profileId);
      if (profile !== undefined) return profile.rating;
      // A match cannot outlive its players (the `results` foreign keys say so), so this is a
      // broken match rather than a rule: rate it from the starting rating and shout.
      deps.log.alert("results.profile_missing", {
        matchId: input.matchId,
        profileId: seat.profileId,
      });
      return deps.config.ratingStart;
    };

    let before: [number, number] = [ratingOf(seatA), ratingOf(seatB)];
    let after: [number, number] = [before[0], before[1]];
    if (ratingPolicy === "rated" && match !== null) {
      // R603–R611: both hidden ratings, both ranks and the record of the rated game, in this
      // transaction, so the result and its rating move commit together or not at all.
      const rated = await rateRankedGame(t, deps, {
        id: input.matchId,
        kind: "match",
        catalogVersion: match.catalogVersion,
        sides: [
          { kind: "player", profileId: seatA.profileId },
          { kind: "player", profileId: seatB.profileId },
        ],
        winnerSide: winnerSideOf(input.outcome, input.seats),
        reason: input.outcome.reason,
        at: input.at,
      });
      before = [rated.sides[0].before.rating, rated.sides[1].before.rating];
      after = [rated.sides[0].after.rating, rated.sides[1].after.rating];
    }

    const row: ResultRow = {
      matchId: input.matchId,
      players: [seatA.profileId, seatB.profileId],
      winnerProfileId:
        input.outcome.winner === "draw"
          ? null
          : (input.outcome.winner === seatA.player ? seatA : seatB).profileId,
      reason: input.outcome.reason,
      turns: input.turns,
      endedAt: input.at,
      ratingBefore: before,
      ratingAfter: after,
    };
    await t.results.insert(row);

    // R417, R565: each seat's board as this game ended, read from its own side, becomes its last
    // server board, with the result or not at all. The reaper reads no state, so it writes none.
    if (input.lastBoards !== undefined) {
      for (const [at, seat] of input.seats.entries()) {
        await t.lastBoards.put(seat.profileId, "server", input.lastBoards[at] ?? [], input.at);
      }
    }

    for (const seat of [seatA, seatB]) {
      // R112's "leaves both ratings unchanged" is literal: no rating write happens at all, and the
      // rated path above made the only one there is.
      // §9.5: "Every ending records a result and clears both players' in-match state." Both, for
      // every reason — M7-T1's "past grace they have lost and both can queue again".
      await t.profiles.setInMatch(seat.profileId, null);
      // A profile can be queued *and* in a match (it accepted a room challenge while waiting), and
      // an open ticket would block the re-queue that M7-T1 promises, so the ending clears that
      // too. This mirrors `app.end_match` in migration 0004, which cancels the same stray ticket.
      const ticket = await t.tickets.openForProfile(seat.profileId);
      if (ticket !== null) await t.tickets.cancel(ticket.id, input.at);
    }

    // The match row may be gone; a missing match must not lose the result, so it is checked rather
    // than assumed.
    if (match !== null) await t.matches.finish(input.matchId, input.at);

    // R263: the series' record of this game, and R262's rating move if it ends the series, in this
    // same transaction — a failure here rolls the result back with it, so the two cannot disagree.
    const advanced =
      series === null
        ? null
        : await advanceSeriesInTx(t, deps, series, {
            matchId: input.matchId,
            seats: input.seats,
            outcome: input.outcome,
            at: input.at,
          });

    deps.log.info("match.ended", {
      matchId: input.matchId,
      reason: row.reason,
      winner: row.winnerProfileId,
      turns: row.turns,
      ratingPolicy,
      ...(advanced === null ? {} : { seriesId: advanced.id, seriesStatus: advanced.status }),
    });
    return { row, series: advanced };
  });
}

/**
 * The `RecordResult` port the actor holds (`ActorDeps.recordResult`). Every terminal reason comes
 * through here, and a ranked match gets the ordinary Glicko-2 rating move (R603, R112's
 * "live match actor" half). Once the result is in, the game is filed for the card statistics
 * (R376, `game-records.ts`).
 */
export function createRecordResult(deps: ServerDeps): RecordResult {
  return async (input: RecordResultInput) => {
    const written = await writeResult(deps, { ...input, ratingPolicy: "rated" });
    // After the commit: a series whose next game began already (R332) gets its match. A
    // failure to start it is the sweeper's to heal (R263), never this result's.
    await resumeSeries(deps, written.series);
    // R376: after the commit too, and never at the result's expense — it logs and swallows its
    // own failures, and a second write of the same match files nothing.
    await recordLiveGame(deps, input.matchId);
    return written.row;
  };
}

/** R112: the reaper's ceiling draw records no turn count. */
const REAPER_TURNS = 0;

/**
 * §9.5's reaper: "a reaper resolves anything past the ceiling". Every `live` match whose
 * `clocks.ceilingAt` has passed ends as a draw by `match-ceiling` (§2.5, R79) with both players'
 * in-match state cleared, and its in-memory actor — if the process still has one — is dropped.
 *
 * R112 fixes what a reaper-resolved draw records: `turns = 0` and both ratings unchanged. A match
 * the reaper reaches is one whose actor is not answering, so the turn count it would need is
 * exactly the thing it cannot read, and it does not guess.
 *
 * Safe to run beside a live actor: both paths go through the same idempotent write, so whichever
 * gets there first is the one that counts and the other returns that row untouched.
 *
 * @returns the ids it resolved.
 */
export async function reapStuckMatches(deps: ServerDeps): Promise<string[]> {
  const now = deps.timers.now();
  const live = await deps.store.matches.live();
  const resolved: string[] = [];

  for (const match of live) {
    if (match.clocks.ceilingAt > now) continue;
    let advanced: SeriesRow | null;
    try {
      ({ series: advanced } = await writeResult(deps, {
        matchId: match.id,
        seats: seatsOf(match),
        outcome: { winner: "draw", reason: "match-ceiling" },
        turns: REAPER_TURNS,
        at: now,
        ratingPolicy: "unchanged",
      }));
    } catch (error) {
      // One wedged match must not stop the sweep.
      deps.log.alert("reaper.failed", {
        matchId: match.id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    resolved.push(match.id);
    if (deps.matches.has(match.id)) await deps.matches.stop(match.id);
    // A reaped series game is a drawn game like any other (R334), and may leave the next game to
    // start (R332).
    await resumeSeries(deps, advanced);
  }

  if (resolved.length > 0) deps.log.warn("reaper.resolved", { matches: resolved });
  return resolved;
}

/** Seat order is the match row's player order: index 0 is p1 (ports.ts `MatchRow.players`). */
function seatsOf(match: MatchRow): readonly [MatchSeat, MatchSeat] {
  return [
    { profileId: match.players[0], player: "p1", deck: match.decks[0] },
    { profileId: match.players[1], player: "p2", deck: match.decks[1] },
  ];
}

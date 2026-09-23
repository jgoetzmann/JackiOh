/**
 * Matchmaking (BUILD M7-T3, SPEC §9.5).
 *
 * §9.5, in full, is what this file implements: "Enqueue asserts the account is active and not in
 * a match, validates the loadout, freezes the chosen deck into the ticket and returns the ticket
 * id. Pairing runs on enqueue plus a sweeper every few seconds; the window widens ±50 rating
 * every 10 s from ±100 and is uncapped after 60 s; both tickets are claimed in one atomic
 * statement. The client shows the queue population instead of an endless spinner."
 *
 * Three pieces, in that order: the three endpoints, one pairing sweep (`tryPair`), and the
 * sweeper that reschedules it (`startMatchmaker`).
 *
 * Two invariants carry the weight:
 *
 *  - **The deck is frozen at enqueue.** §9.4: "Decks are frozen into the queue ticket." Nothing
 *    below re-reads `loadouts` (or, R172, `decks`) after the ticket exists, so a deck edited while
 *    queued cannot change the match that ticket becomes (M7-T3's second acceptance item).
 *  - **Both tickets are claimed in one atomic statement**, `tickets.claimPair`. A match is
 *    created *only* after that statement returns true, so two matchers racing over the same
 *    ticket cannot pair it twice (M7-T3's race test). Losing the race is not an error: it means
 *    someone else already found that player a game.
 *
 * The rating window is `ratingWindow` from `src/config.ts`, imported rather than re-derived, so
 * "±100 widening ±50 every 10 s, uncapped after 60 s" is written down exactly once.
 */

import { ratingWindow } from "../config";
import { callerProfile } from "./collection";
import { deckChoiceOf, frozenDeckFor } from "./decks";
import { ApiError, badRequest, ok, route, type Route } from "./http";
import type { DeckChoice, MatchSeat, Profile, ServerDeps, Ticket, Timer } from "./ports";

/** Unit conversion, not configuration: `ratingWindow` speaks seconds, tickets are stamped in ms. */
const MS_PER_SECOND = 1000;

// ---------------------------------------------------------------------------
// R143 — the end-to-end mode's optional seed
// ---------------------------------------------------------------------------

/**
 * SPEC §11 R143: "Who chooses a match's seed. The server mints it; a client never supplies one. In
 * end-to-end mode the room and queue endpoints accept an optional seed and use it verbatim so a
 * networked spec can be seeded, and outside that mode the field is rejected. §9.3 makes
 * `(seed, log)` the truth without saying who picks the seed, and BUILD requires every spec to set
 * one, so the exception is confined to the test mode."
 *
 * Rejected, not ignored: a client that sends a seed against a production server is told its
 * request was not understood, rather than silently getting a match it did not ask for.
 *
 * Exported because R143 names *two* endpoints, and `match/rooms.ts` is the other one: the room
 * endpoints read the field through this same function rather than through a second copy of the
 * rule, so "accepted in end-to-end mode, rejected everywhere else" is decided in one place.
 */
export function seedOverrideOf(
  deps: ServerDeps,
  body: Readonly<Record<string, unknown>>,
): string | null {
  const value = body["seed"];
  if (value === undefined) return null;
  if (deps.e2e !== true) {
    throw badRequest('"seed" is only accepted by an end-to-end test server; the server mints it');
  }
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest('"seed" must be a non-empty string');
  }
  return value;
}

/**
 * ticketId -> the seed its enqueue asked for, until the ticket is paired or cancelled.
 *
 * Module state rather than a closure because `tryPair` is also run by the sweeper
 * (`startMatchmaker`), which never sees the route table's closure. Nothing is ever written here
 * outside end-to-end mode — `seedOverrideOf` has already refused the field by then — and the map
 * empties itself as tickets resolve, so a production process keeps it permanently empty.
 *
 * Not in SPEC, and no R-row: where the seed is held is an implementation detail; R143 already
 * rules on the seed itself ("the server mints it; a client never supplies one", with the test-mode
 * exception). `Ticket` (ports.ts) carries no seed, and adding one would put a test-mode field into
 * the shape `src/db/**` persists, so R143's exception is confined to this map the way the row
 * confines it to the mode. `match/rooms.ts` holds `room code -> seed` for the same reason.
 */
const e2eSeedByTicket = new Map<string, string>();

/** Exported for the R143 tests; nothing in `src/` calls it. */
export function e2eSeedCount(): number {
  return e2eSeedByTicket.size;
}

function forgetSeed(ticketId: string): void {
  e2eSeedByTicket.delete(ticketId);
}

/**
 * The seed for a pair, consumed. Two seeded tickets can disagree — each spec seeds its own
 * enqueue — so the older ticket's seed wins, which is the same "oldest first" tie-break `tryPair`
 * already uses, and both entries are dropped either way.
 */
function takeSeedForPair(a: Ticket, b: Ticket): string | null {
  const older = a.enqueuedAt <= b.enqueuedAt ? a : b;
  const younger = older === a ? b : a;
  const seed = e2eSeedByTicket.get(older.id) ?? e2eSeedByTicket.get(younger.id) ?? null;
  forgetSeed(a.id);
  forgetSeed(b.id);
  return seed;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

function deckIndexOf(body: Readonly<Record<string, unknown>>): number {
  const value = body["deckIndex"];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badRequest('"deckIndex" must be a whole number');
  }
  // The range belongs to the loadout, not to this endpoint: `deckFor` rejects an index the
  // player's own loadout does not have (§9.4 L1 fixes how many decks that is).
  return value;
}

/**
 * §9.5's enqueue. The order of the checks is the order §9.5 writes them, and it matters: a player
 * already in a match or already queued is told so before their loadout is validated, so a stale
 * client gets the useful error rather than a loadout complaint.
 */
async function enqueue(
  deps: ServerDeps,
  profile: Profile,
  /** A loadout deck or, R172, one of the caller's library decks. */
  choice: DeckChoice,
  /** R143: the seed this enqueue asked for, or null. Only ever non-null in end-to-end mode. */
  seed: string | null = null,
): Promise<Ticket> {
  // §9.5: "asserts the account is active and not in a match". `auth: "active"` did the first half
  // (§9.4's gate, in `createRouter`); this is the second.
  if (profile.inMatchId !== null) {
    throw new ApiError("already_in_match", "finish your current match first");
  }
  const open = await deps.store.tickets.openForProfile(profile.id);
  if (open !== null) {
    throw new ApiError("already_queued", "you are already in the queue", { ticketId: open.id });
  }

  // §9.4: "checked by one validator module shared by client and server, at save and again at
  // queue". For a loadout deck the queue-time re-check is `validateStoredLoadout`, which also
  // rejects a stale catalog version, and `deckFor` picks the deck being frozen; for a library deck
  // (R172) it is the strict single-deck check. `frozenDeckFor` is both.
  const { deck, catalogVersion } = await frozenDeckFor(deps, profile.id, choice);

  const ticket: Ticket = {
    id: deps.ids.uuid(),
    profileId: profile.id,
    rating: profile.rating,
    // §9.4, §9.5: frozen. `frozenDeckFor` already copied it; this is the copy that lands in the
    // ticket and, later, in the match — neither the loadout nor the library is read again.
    deck,
    catalogVersion,
    enqueuedAt: deps.timers.now(),
    status: "open",
    matchId: null,
  };

  try {
    await deps.store.tickets.insert(ticket);
  } catch (error) {
    // `tickets_profile_queued_key` (migration 0004) is the race-proof half of "not already
    // queued": two simultaneous enqueues both pass the read above and one loses here.
    const existing = await deps.store.tickets.openForProfile(profile.id);
    if (existing !== null) {
      throw new ApiError("already_queued", "you are already in the queue", {
        ticketId: existing.id,
      });
    }
    throw error;
  }

  // R143, after the insert won: a seed remembered for a ticket that does not exist would never be
  // consumed and never dropped.
  if (seed !== null) e2eSeedByTicket.set(ticket.id, seed);

  deps.log.info("queue.enqueued", { profileId: profile.id, ticketId: ticket.id, ...choice });
  return ticket;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/** §9.5's widening window, read for one ticket at one instant. */
function windowFor(ticket: Ticket, now: number): number {
  const waitedSeconds = Math.max(0, now - ticket.enqueuedAt) / MS_PER_SECOND;
  return ratingWindow(waitedSeconds);
}

/**
 * §9.5: the gap has to sit inside *both* windows, so the player who has waited longer cannot drag
 * a freshly queued opponent into a match their own window would refuse.
 */
function qualifies(a: Ticket, b: Ticket, now: number): boolean {
  if (a.profileId === b.profileId) return false;
  const gap = Math.abs(a.rating - b.rating);
  return gap <= windowFor(a, now) && gap <= windowFor(b, now);
}

/**
 * Creates the paired match. Called only with two tickets this process has already claimed, which
 * is what makes it safe to write: the claim is the mutual exclusion.
 *
 * The match row is written here rather than inside `matches.start` because a `MatchRow` needs the
 * two frozen decks, the catalog version and the initial clocks, and `StartMatchInput` carries
 * none of the last two. The actor takes it from there.
 */
async function startPairedMatch(
  deps: ServerDeps,
  a: Ticket,
  b: Ticket,
  matchId: string,
): Promise<void> {
  const seats: [MatchSeat, MatchSeat] = [
    { profileId: a.profileId, player: "p1", deck: a.deck },
    { profileId: b.profileId, player: "p2", deck: b.deck },
  ];
  // R143: the server mints the seed, unless an end-to-end enqueue supplied one.
  const seed = takeSeedForPair(a, b) ?? deps.ids.seed();

  // NO `matches.create` HERE. `MatchRegistry.start` builds the row -- seed, both frozen decks,
  // R79's clocks, status live -- and calls `store.matches.create` itself (registry.ts), so a
  // create here made it TWICE for one id. The second call found the row already `live` and
  // `matches.create` refuses that by contract ("anything else -> the id is taken"), so the
  // SECOND player's enqueue returned 500 after the match had already been made, leaving both
  // players in a match no client had been given the id of.
  //
  // The room path never had this bug and shows the shape that works: `rooms.claim` writes the
  // `open` row and the registry's create promotes it to `live` -- one create, one promotion.
  // `tickets.claimPair` writes the same `open` skeleton for a pair, so the queue now behaves
  // identically.
  //
  // What stays in a transaction is the pair of `setInMatch` writes, which is what §9.5 means by
  // in-match state; `profiles.current_match_id` is a foreign key into `matches` and the `open`
  // row `claimPair` wrote is what satisfies it.
  await deps.store.tx(async (t) => {
    // §9.5: in-match state is set here and cleared by `results.ts` at every ending.
    await t.profiles.setInMatch(a.profileId, matchId);
    await t.profiles.setInMatch(b.profileId, matchId);
  });

  await deps.matches.start({ matchId, seed, catalogVersion: deps.catalog.version, seats });
  deps.log.info("queue.paired", {
    matchId,
    tickets: [a.id, b.id],
    ratings: [a.rating, b.rating],
  });
}

/**
 * One pairing sweep. Oldest ticket first, and for each of them the oldest qualifying opponent, so
 * the pair that has waited longest is made first.
 *
 * NOT IN SPEC, and no R-row yet — PROPOSED RULING for §11:
 *   Topic: Which qualifying opponent a sweep pairs
 *   Ruling: The oldest ticket is paired first, and against the oldest opponent its window admits —
 *     not the closest in rating. §9.5 fixes the window (±100 rating, widening ±50 every 10 s,
 *     uncapped after 60 s) and says nothing about the choice inside it, and the window is already
 *     the rating rule: picking the closest rating inside a window that was widened precisely
 *     because nobody closer was there re-applies the same criterion twice and leaves the player
 *     who has waited longest waiting again. Wait time is also the one thing a queued player can
 *     watch going up, which §9.5's "queue population instead of an endless spinner" is about. Ties
 *     break on ticket id, so a sweep is deterministic and a replay of the same open set pairs the
 *     same way.
 *   Affects: §9.5, R108; `api/queue.ts`.
 *
 * @returns how many matches this sweep made.
 */
export async function tryPair(deps: ServerDeps): Promise<number> {
  const now = deps.timers.now();
  const open = [...(await deps.store.tickets.listOpen())].sort(
    (x, y) => x.enqueuedAt - y.enqueuedAt || (x.id < y.id ? -1 : 1),
  );
  if (open.length < 2) return 0;

  // §9.5's "not in a match" holds at pairing too, not only at enqueue: a ticket left open while
  // its owner joined a room match must not become a second match for them. One read for the whole
  // sweep, and `taken` covers the pairs this sweep makes as it goes.
  const busy = new Set(
    (await deps.store.profiles.getMany(open.map((ticket) => ticket.profileId)))
      .filter((profile) => profile.inMatchId !== null)
      .map((profile) => profile.id),
  );
  const taken = new Set<string>(
    open.filter((ticket) => busy.has(ticket.profileId)).map((ticket) => ticket.id),
  );
  let made = 0;

  for (const a of open) {
    if (taken.has(a.id)) continue;
    for (const b of open) {
      if (b.id === a.id || taken.has(b.id)) continue;
      if (!qualifies(a, b, now)) continue;

      const matchId = deps.ids.uuid();
      // §9.5: "both tickets are claimed in one atomic statement". Everything before this line is
      // a guess; only a `true` here gives this process the right to create a match.
      const won = await deps.store.tickets.claimPair(a.id, b.id, matchId, now);
      if (!won) {
        // Another matcher got one of them. Never create a match for a ticket we did not claim:
        // find out which one is gone and either try another opponent or drop this ticket.
        const still = await deps.store.tickets.get(a.id);
        if (still === null || still.status !== "open") {
          taken.add(a.id);
          break;
        }
        taken.add(b.id);
        continue;
      }

      taken.add(a.id);
      taken.add(b.id);
      await startPairedMatch(deps, a, b, matchId);
      made += 1;
      break;
    }
  }

  return made;
}

/**
 * §9.5: "Pairing runs on enqueue plus a sweeper every few seconds" (R108: every 3 s, as
 * `limits.queueSweepMs`). Rescheduled through `deps.timers.after` rather than `setInterval` so it
 * is the same port the clocks use and a test drives it with a manual timer.
 */
export function startMatchmaker(deps: ServerDeps): { stop: () => void } {
  let timer: Timer | null = null;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    timer = deps.timers.after(deps.limits.queueSweepMs, () => {
      timer = null;
      void sweep();
    });
  };

  const sweep = async (): Promise<void> => {
    try {
      await tryPair(deps);
    } catch (error) {
      // A failed sweep must not kill the sweeper: the next one may well succeed.
      deps.log.warn("matchmaker.sweep_failed", {
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

export function createQueueRoutes(): Route[] {
  return [
    /**
     * §9.5's enqueue. `auth: "active"` is §9.4's gate ("A pending account ... nothing else: no
     * collection, loadout, queue or match"), so a pending account gets 403 here without this
     * handler saying anything about it.
     *
     * Pairing is attempted inline ("Pairing runs on enqueue plus a sweeper"), which is why the
     * response reports the ticket's status: a player who paired immediately learns it from the
     * same round trip instead of waiting for a sweep.
     */
    route("POST", "/api/queue", "active", async (req, deps) => {
      const profile = callerProfile(req);
      // R143: an optional `seed`, accepted only by an end-to-end test server and rejected — never
      // ignored — anywhere else.
      const seed = seedOverrideOf(deps, req.body);
      const ticket = await enqueue(deps, profile, deckChoiceOf(req.body, deckIndexOf), seed);
      await tryPair(deps);
      const current = await deps.store.tickets.get(ticket.id);
      return ok({
        ticketId: ticket.id,
        status: current?.status ?? ticket.status,
        matchId: current?.matchId ?? null,
        population: await deps.store.tickets.countOpen(),
      });
    }),

    /**
     * Leaving the queue. Idempotent; `cancelled: false` when there was nothing open to cancel.
     *
     * NOT IN SPEC, and no R-row yet — PROPOSED RULING for §11:
     *   Topic: How a player leaves the queue
     *   Ruling: A queued player may cancel, and cancelling is idempotent: a client that cancels
     *     twice, or whose ticket was paired a moment earlier, is told nothing was cancelled rather
     *     than given an error it cannot act on. §9.5 describes enqueue and pairing and never says
     *     how a player leaves, but its own enqueue assertion — the account is active "and not in a
     *     match" — has no other way to become satisfiable again: without cancel a player who
     *     queued by mistake is held until somebody pairs with them. It must be idempotent because
     *     the race is unavoidable and one-sided: the sweeper (R108) can pair a ticket between the
     *     client deciding to cancel and the request arriving, and at that point the match exists
     *     and the player belongs in it. So cancel never unmakes a pairing; it only closes a ticket
     *     that is still open.
     *   Affects: §9.5, R108, R143; `api/queue.ts`, migration `0004_matches.sql`.
     *
     * `tickets.status = 'cancelled'` in migration 0004 is what this writes.
     */
    route("DELETE", "/api/queue", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const ticket = await deps.store.tickets.openForProfile(profile.id);
      if (ticket === null) return ok({ cancelled: false });
      await deps.store.tickets.cancel(ticket.id, deps.timers.now());
      // R143: a cancelled ticket will never be paired, so its seed is dropped with it.
      forgetSeed(ticket.id);
      deps.log.info("queue.cancelled", { profileId: profile.id, ticketId: ticket.id });
      return ok({ cancelled: true, ticketId: ticket.id });
    }),

    /**
     * §9.5: "The client shows the queue population instead of an endless spinner."
     *
     * `auth: "user"` rather than `"active"` or `"none"`. The count is one aggregate about the
     * server, not about any profile: it names nobody, and §9.4's "no queue" for a pending account
     * is about joining the queue and being matched, which `POST /api/queue` still refuses. Making
     * it `"none"` would hand an anonymous caller a free live-traffic feed, and requiring a token
     * costs the lobby nothing — it has one either way, since a player reaches this screen signed
     * in. If a later review reads §9.4's gate as covering even the count, this becomes `"active"`
     * and nothing else changes.
     */
    route("GET", "/api/queue/population", "user", async (_req, deps) =>
      ok({ population: await deps.store.tickets.countOpen() }),
    ),
  ];
}

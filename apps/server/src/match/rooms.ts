/**
 * The room-code challenge (SPEC §9.5, R79, BUILD M6-T4: "room-code challenge (`createRoom` →
 * 6-char code → `joinRoom`)"), in the queue's three modes (R264).
 *
 * §9.5: "Direct challenge by room code (6 characters from the invite-code alphabet) ships before
 * the ranked queue and is the primary mode while the player base is small." The queue's rules
 * apply here too, because they are the same assertions §9.5 makes about entering a match:
 *
 *  - the account is active (the route's `auth: "active"`, §9.4), not already in a match and not in
 *    a series that is not over (R264);
 *  - the deck or trio is validated at match time by the shared validator, not trusted from save
 *    time (§9.4, R253), through the same `freezeChoice` the queue uses;
 *  - the chosen deck or trio is frozen into the room the moment it is created, so editing it
 *    afterwards cannot change the game (§9.4, §9.5, §9.8);
 *  - `rooms.claim` is the atomic single-claim, so the loser of a join race gets a 409 and never a
 *    second match.
 *
 * R264: a room is created in a mode, and a joiner plays that mode or is refused with it named. A
 * Best-of-1 join starts the match on the two frozen decks; an All Random join deals both decks
 * (R258) and starts the match; a Best-of-3 join makes the series (R259), whose first game starts
 * once both players have picked a deck.
 */

import {
  assertNotInSeries,
  freezeChoice,
  readModeChoice,
  type FrozenChoice,
} from "../api/decks";
import { normalizeCode, isWellFormedCode } from "../api/crypto";
import { ApiError, ok, route, type ApiRequest, type Route } from "../api/http";
import { seedOverrideOf } from "../api/queue";
import { startSeries } from "../api/series";
import { ROOM_CODE_LENGTH } from "../config";
import type { MatchSeat, QueueMode, Room, ServerDeps } from "../api/ports";

/**
 * SPEC §11 R149: a room code "is minted by retrying a bounded number of times against the codes
 * still in use and then reporting that no code is available, rather than retrying without limit".
 * R149 requires the bound and leaves the number to config, the way R79 leaves its clocks; eight is
 * far more than a 30-bit space (R104) ever needs against the codes R110 has not yet released.
 */
const CODE_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// R143 — the end-to-end mode's optional seed, for the room half
// ---------------------------------------------------------------------------

/**
 * SPEC §11 R143: "In end-to-end mode the room and queue endpoints accept an optional seed and use
 * it verbatim so a networked spec can be seeded, and outside that mode the field is rejected."
 *
 * A room's match is not created until someone joins, so the seed the *host* supplied to
 * `POST /api/rooms` has to be held between the two calls. `room code -> seed`, exactly as
 * `api/queue.ts` holds `ticket id -> seed`, and for the same reasons written out there: `Room`
 * (ports.ts) carries no seed, and adding one would put a test-mode field into the shape `src/db/**`
 * persists. `seedOverrideOf` — the same function the queue uses — has already refused the field
 * outside end-to-end mode by the time anything is written here, so a production process keeps this
 * map permanently empty.
 */
const e2eSeedByRoom = new Map<string, { seed: string; expiresAt: number }>();

/** Exported for the R143 tests; nothing in `src/` calls it. */
export function e2eRoomSeedCount(): number {
  return e2eSeedByRoom.size;
}

/**
 * A room that is never joined has no claim to clear it, unlike a ticket, which is always paired or
 * cancelled. So every remembered seed carries its room's expiry and the stale ones are dropped as
 * new rooms are made: a long-running end-to-end server cannot accumulate them.
 */
function rememberSeed(code: string, seed: string, expiresAt: number, now: number): void {
  for (const [candidate, held] of e2eSeedByRoom) {
    if (held.expiresAt <= now) e2eSeedByRoom.delete(candidate);
  }
  e2eSeedByRoom.set(code, { seed, expiresAt });
}

/**
 * The seed for this room, consumed. The host's seed wins over a seed the joiner sent: the room was
 * created first, which is the same "whoever asked first" tie-break `queue.ts` uses between two
 * seeded tickets.
 */
function takeSeedForRoom(code: string, joinerSeed: string | null): string | null {
  const held = e2eSeedByRoom.get(code) ?? null;
  e2eSeedByRoom.delete(code);
  return held?.seed ?? joinerSeed;
}

/**
 * R264: a join in another mode than the room's is refused with the room's mode named, so the lobby
 * can ask for the right deck or trio (`details.mode` carries it for the client).
 */
const MODE_REFUSAL: Readonly<Record<QueueMode, string>> = {
  bo1: "This room plays Best of 1: pick one of your decks.",
  bo3: "This room plays Best of 3: pick one of your trios.",
  random: "This room plays All Random: join it without a deck.",
};

/** §9.5: "Enqueue asserts the account is active and not in a match." */
function assertNotInMatch(req: ApiRequest): void {
  if (req.profile?.inMatchId != null) {
    throw new ApiError("already_in_match", "finish your current match first");
  }
}

function profileOf(req: ApiRequest): string {
  const profileId = req.profile?.id;
  // Unreachable on an `auth: "active"` route; the router resolves the caller first.
  if (profileId === undefined) throw new ApiError("unauthorized", "sign in first");
  return profileId;
}

/**
 * A room the caller may still join. Missing, malformed and expired codes are one answer, so a
 * scan of the 30-bit code space cannot tell "wrong" from "too late" (the same reasoning as §9.4's
 * identical invite-code error).
 */
async function joinableRoom(deps: ServerDeps, typed: string): Promise<Room> {
  const code = normalizeCode(typed);
  const miss = new ApiError("not_found", "that room code is not open");
  if (!isWellFormedCode(code, ROOM_CODE_LENGTH)) throw miss;

  const room = await deps.store.rooms.get(code);
  if (room === null) throw miss;
  if (room.expiresAt <= deps.timers.now()) throw miss;
  if (room.guestProfileId !== null) {
    throw new ApiError("conflict", "someone already joined that room");
  }
  // §9.4: a stale catalog is rejected at every door into a match.
  if (room.catalogVersion !== deps.catalog.version) {
    throw new ApiError("update_required", "update required");
  }
  return room;
}

/**
 * §9.5's "not in a match" holds for the host at the moment the match is made, not only when the
 * room was opened — the same reason `tryPair` re-reads it at pairing. A room can wait for its
 * guest up to `roomCodeTtlMs`, and the host can be matched from the queue (or paired into a
 * series, R264) meanwhile. The room is left unclaimed, so the join can be tried again once the
 * host is free.
 */
async function assertHostFree(deps: ServerDeps, hostProfileId: string): Promise<void> {
  const host = await deps.store.profiles.getById(hostProfileId);
  const series = await deps.store.series.activeFor(hostProfileId);
  if ((host?.inMatchId ?? null) !== null || series !== null) {
    throw new ApiError("conflict", "The host of that room is playing another game right now.");
  }
}

/** The two seats of a room's match: the host is p1 (§9.5), the joiner p2. */
function roomSeats(
  deps: ServerDeps,
  room: Room,
  joinerId: string,
  joiner: FrozenChoice,
  seed: string,
): [MatchSeat, MatchSeat] {
  if (room.mode === "random") {
    // R258: dealt from the match seed and the seat, and frozen into the match row like any deck.
    return [
      { profileId: room.hostProfileId, player: "p1", deck: deps.dealRandomDeck(`${seed}:p1-deck`) },
      { profileId: joinerId, player: "p2", deck: deps.dealRandomDeck(`${seed}:p2-deck`) },
    ];
  }
  if (joiner.mode !== "bo1") throw new Error(`a ${joiner.mode} choice reached a Best-of-1 room`);
  return [
    { profileId: room.hostProfileId, player: "p1", deck: [...room.hostDeck] },
    { profileId: joinerId, player: "p2", deck: [...joiner.deck.cards] },
  ];
}

export function createRoomRoutes(): Route[] {
  /** POST /api/rooms — create a room in a mode and return its code (§9.5, R264). */
  const create = route("POST", "/api/rooms", "active", async (req, deps) => {
    const profileId = profileOf(req);
    assertNotInMatch(req);
    // R257, R264: the same choice the queue takes, legacy `{ deckIndex }` included.
    const choice = readModeChoice(req.body);
    // R143: an optional `seed`, accepted only by an end-to-end test server and rejected — never
    // ignored — anywhere else. Read before any work is done, so a production caller that sends one
    // gets the 400 without a room being made.
    const seed = seedOverrideOf(deps, req.body);
    await assertNotInSeries(deps, profileId);

    // R253: checked now and frozen into the room — a deck, a trio, or nothing for All Random.
    const frozen = await freezeChoice(deps, profileId, choice);

    const now = deps.timers.now();
    const expiresAt = now + deps.limits.roomCodeTtlMs;

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      // R79, §9.5: 6 characters from the invite-code alphabet. `deps.config.roomCodeLength`
      // carries the same value if a test ever needs to vary it.
      const code = deps.ids.code(ROOM_CODE_LENGTH);
      const created = await deps.store.rooms.create({
        code,
        hostProfileId: profileId,
        mode: frozen.mode,
        // §9.4, §9.5: the deck or the trio is frozen here, exactly as it is into a queue ticket.
        hostDeck: frozen.mode === "bo1" ? [...frozen.deck.cards] : [],
        hostTrio: frozen.mode === "bo3" ? frozen.trio : null,
        catalogVersion: deps.catalog.version,
        createdAt: now,
        expiresAt,
        guestProfileId: null,
        matchId: null,
      });
      if (!created) continue;
      // R143, after the create won: a seed remembered for a room that does not exist would never be
      // consumed and never dropped (`queue.ts` waits for its insert for the same reason).
      if (seed !== null) rememberSeed(code, seed, expiresAt, now);
      deps.log.info("room.created", { code, hostProfileId: profileId, mode: frozen.mode });
      return ok({ code, expiresAt, mode: frozen.mode });
    }

    deps.log.alert("room.code.exhausted", { attempts: CODE_ATTEMPTS });
    throw new ApiError("unavailable", "could not allocate a room code; try again");
  });

  /**
   * POST /api/rooms/:code/join — claim the room and start its game (§9.5, R264): the match for
   * Best of 1 and All Random, the series for Best of 3.
   */
  const join = route("POST", "/api/rooms/:code/join", "active", async (req, deps) => {
    const profileId = profileOf(req);
    assertNotInMatch(req);
    const choice = readModeChoice(req.body);
    // R143 again: both room endpoints accept the field in end-to-end mode and both refuse it
    // outside one. A spec that seeds the join rather than the create still gets its seed.
    const joinerSeed = seedOverrideOf(deps, req.body);
    await assertNotInSeries(deps, profileId);

    const typed = req.params.code ?? "";
    const room = await joinableRoom(deps, typed);
    if (room.hostProfileId === profileId) {
      throw new ApiError("conflict", "you created that room; wait for someone to join");
    }
    // R264: the room's mode, or a refusal naming it — before the joiner's deck is looked at, so the
    // answer is the useful one.
    if (choice.mode !== room.mode) {
      throw new ApiError("conflict", MODE_REFUSAL[room.mode], { mode: room.mode });
    }

    const frozen = await freezeChoice(deps, profileId, choice);
    await assertHostFree(deps, room.hostProfileId);

    const matchId = deps.ids.uuid();
    const now = deps.timers.now();

    // The atomic single-claim: whoever wins this statement is the guest, and there is no second
    // winner (§9.5, mirroring `tickets.claimPair`).
    const claimed = await deps.store.rooms.claim(room.code, profileId, matchId, now);
    if (claimed === null) throw new ApiError("conflict", "someone already joined that room");
    // R143: the server mints the seed, unless an end-to-end room asked for one.
    const seed = takeSeedForRoom(claimed.code, joinerSeed) ?? deps.ids.seed();

    if (frozen.mode === "bo3") {
      // R259, R263: the series, with the host as series p1 and the id the claim reserved as game
      // 1's. Nobody is in a match yet: the series opens on its pick phase.
      if (claimed.hostTrio === null) throw new Error(`Best-of-3 room ${claimed.code} holds no trio`);
      const series = await startSeries(deps, {
        seriesId: deps.ids.uuid(),
        firstMatchId: matchId,
        sides: [
          { profileId: claimed.hostProfileId, trio: claimed.hostTrio },
          { profileId, trio: frozen.trio },
        ],
        seedBase: seed,
        catalogVersion: deps.catalog.version,
      });
      deps.log.info("room.joined", {
        code: claimed.code,
        mode: claimed.mode,
        seriesId: series.id,
        firstMatchId: matchId,
        guestProfileId: profileId,
      });
      return ok({ matchId: null, seriesId: series.id, code: claimed.code, seat: "p2", mode: claimed.mode });
    }

    await deps.matches.start({
      matchId,
      seed,
      catalogVersion: deps.catalog.version,
      seats: roomSeats(deps, claimed, profileId, frozen, seed),
    });

    // §9.5: the in-match flag both ends of the lifecycle read ("not in a match" above, and
    // "clears both players' in-match state" when the result lands).
    await deps.store.profiles.setInMatch(claimed.hostProfileId, matchId);
    await deps.store.profiles.setInMatch(profileId, matchId);

    deps.log.info("room.joined", { code: claimed.code, mode: claimed.mode, matchId, guestProfileId: profileId });
    return ok({ matchId, seriesId: null, code: claimed.code, seat: "p2", mode: claimed.mode });
  });

  return [create, join];
}

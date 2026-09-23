/**
 * The room-code challenge (SPEC §9.5, R79, BUILD M6-T4: "room-code challenge (`createRoom` →
 * 6-char code → `joinRoom`)").
 *
 * §9.5: "Direct challenge by room code (6 characters from the invite-code alphabet) ships before
 * the ranked queue and is the primary mode while the player base is small." The queue's rules
 * apply here too, because they are the same assertions §9.5 makes about entering a match:
 *
 *  - the account is active (the route's `auth: "active"`, §9.4) and not already in a match;
 *  - the deck is re-validated at match time, not trusted from save time (§9.4: "checked by one
 *    validator module shared by client and server, at save and again at queue"), whether it is a
 *    loadout deck or, R172, a library deck;
 *  - the chosen deck is frozen into the room the moment it is created, so editing the loadout or
 *    the library afterwards cannot change the match (§9.4, §9.5);
 *  - `rooms.claim` is the atomic single-claim, so the loser of a join race gets a 409 and never a
 *    second match.
 */

import { normalizeCode, isWellFormedCode } from "../api/crypto";
import { deckChoiceOf, frozenDeckFor, type FrozenDeck } from "../api/decks";
import { ApiError, ok, route, type ApiRequest, type Route } from "../api/http";
import { seedOverrideOf } from "../api/queue";
import { ROOM_CODE_LENGTH } from "../config";
import type { DeckChoice, Room, ServerDeps } from "../api/ports";

/**
 * The deck a room freezes is taken through this seam so a test can drive the room endpoints without
 * a real collection ledger. It began as a dynamic import of `src/api/loadouts.ts`, another agent's
 * file that had not landed yet; since R172 the one function behind it is `frozenDeckFor`
 * (`src/api/decks.ts`), which runs the loadout path through `loadouts.ts` exactly as before and
 * adds the library path beside it.
 */
export type LoadoutsModule = {
  /** §9.4: re-validate at match time and copy; throws an `ApiError` when the deck no longer passes. */
  frozenDeckFor: (deps: ServerDeps, profileId: string, choice: DeckChoice) => Promise<FrozenDeck>;
};

export type LoadLoadouts = () => Promise<LoadoutsModule>;

const loadLoadoutsModule: LoadLoadouts = async () => ({ frozenDeckFor });

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

function deckIndexOf(body: ApiRequest["body"]): number {
  const value = body.deckIndex;
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new ApiError("bad_request", `"deckIndex" must be 0, 1 or 2`);
  }
  return value;
}

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

export function createRoomRoutes(loadLoadouts: LoadLoadouts = loadLoadoutsModule): Route[] {
  /** POST /api/rooms — create a room and return its code (§9.5). */
  const create = route("POST", "/api/rooms", "active", async (req, deps) => {
    const profileId = profileOf(req);
    assertNotInMatch(req);
    const choice = deckChoiceOf(req.body, deckIndexOf);
    // R143: an optional `seed`, accepted only by an end-to-end test server and rejected — never
    // ignored — anywhere else. Read before any work is done, so a production caller that sends one
    // gets the 400 without a room being made.
    const seed = seedOverrideOf(deps, req.body);

    const { frozenDeckFor } = await loadLoadouts();
    const { deck } = await frozenDeckFor(deps, profileId, choice);

    const now = deps.timers.now();
    const expiresAt = now + deps.limits.roomCodeTtlMs;

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      // R79, §9.5: 6 characters from the invite-code alphabet. `deps.config.roomCodeLength`
      // carries the same value if a test ever needs to vary it.
      const code = deps.ids.code(ROOM_CODE_LENGTH);
      const created = await deps.store.rooms.create({
        code,
        hostProfileId: profileId,
        // §9.4, §9.5: the deck is frozen here, exactly as it is frozen into a queue ticket.
        hostDeck: [...deck],
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
      deps.log.info("room.created", { code, hostProfileId: profileId });
      return ok({ code, expiresAt, ...choice });
    }

    deps.log.alert("room.code.exhausted", { attempts: CODE_ATTEMPTS });
    throw new ApiError("unavailable", "could not allocate a room code; try again");
  });

  /** POST /api/rooms/:code/join — claim the room and start the match (§9.5). */
  const join = route("POST", "/api/rooms/:code/join", "active", async (req, deps) => {
    const profileId = profileOf(req);
    assertNotInMatch(req);
    const choice = deckChoiceOf(req.body, deckIndexOf);
    // R143 again: both room endpoints accept the field in end-to-end mode and both refuse it
    // outside one. A spec that seeds the join rather than the create still gets its seed.
    const joinerSeed = seedOverrideOf(deps, req.body);

    const typed = req.params.code ?? "";
    const room = await joinableRoom(deps, typed);
    if (room.hostProfileId === profileId) {
      throw new ApiError("conflict", "you created that room; wait for someone to join");
    }

    const { frozenDeckFor } = await loadLoadouts();
    const { deck } = await frozenDeckFor(deps, profileId, choice);

    const matchId = deps.ids.uuid();
    const now = deps.timers.now();

    // The atomic single-claim: whoever wins this statement is the guest, and there is no second
    // winner (§9.5, mirroring `tickets.claimPair`).
    const claimed = await deps.store.rooms.claim(room.code, profileId, matchId, now);
    if (claimed === null) throw new ApiError("conflict", "someone already joined that room");

    await deps.matches.start({
      matchId,
      // R143: the server mints the seed, unless an end-to-end room asked for one.
      seed: takeSeedForRoom(claimed.code, joinerSeed) ?? deps.ids.seed(),
      catalogVersion: deps.catalog.version,
      seats: [
        { profileId: claimed.hostProfileId, player: "p1", deck: [...claimed.hostDeck] },
        { profileId, player: "p2", deck: [...deck] },
      ],
    });

    // §9.5: the in-match flag both ends of the lifecycle read ("not in a match" above, and
    // "clears both players' in-match state" when the result lands).
    await deps.store.profiles.setInMatch(claimed.hostProfileId, matchId);
    await deps.store.profiles.setInMatch(profileId, matchId);

    deps.log.info("room.joined", { code: claimed.code, matchId, guestProfileId: profileId });
    return ok({ matchId, code: claimed.code, seat: "p2" });
  });

  return [create, join];
}

/**
 * The room-code challenge (SPEC §9.5, R79, BUILD M6-T4: "room-code challenge (`createRoom` →
 * 6-char code → `joinRoom`)").
 *
 * §9.5: "Direct challenge by room code (6 characters from the invite-code alphabet) ships before
 * the ranked queue and is the primary mode while the player base is small." The queue's rules
 * apply here too, because they are the same assertions §9.5 makes about entering a match:
 *
 *  - the account is active (the route's `auth: "active"`, §9.4) and not already in a match;
 *  - the loadout is re-validated at match time, not trusted from save time (§9.4: "checked by one
 *    validator module shared by client and server, at save and again at queue");
 *  - the chosen deck is frozen into the room the moment it is created, so editing the loadout
 *    afterwards cannot change the match (§9.4, §9.5);
 *  - `rooms.claim` is the atomic single-claim, so the loser of a join race gets a 409 and never a
 *    second match.
 */

import { normalizeCode, isWellFormedCode } from "../api/crypto";
import { ApiError, ok, route, type ApiRequest, type Route } from "../api/http";
import { ROOM_CODE_LENGTH } from "../config";
import type { Room, ServerDeps, StoredLoadout } from "../api/ports";

/**
 * `src/api/loadouts.ts` (M6-T3) is another agent's file. Its two exports are taken through this
 * seam so this module typechecks and tests before that file lands, and so a test can drive the
 * room endpoints without a real collection ledger. The signatures are the fixed ones.
 */
export type LoadoutsModule = {
  /** §9.4: re-validate at match time; throws an `ApiError` when the loadout no longer passes. */
  validateStoredLoadout: (
    deps: ServerDeps,
    profileId: string,
    catalogVersion: string,
  ) => Promise<StoredLoadout>;
  deckFor: (loadout: StoredLoadout, deckIndex: number) => string[];
};

export type LoadLoadouts = () => Promise<LoadoutsModule>;

let cachedLoadouts: Promise<LoadoutsModule> | null = null;

/**
 * The specifier is held in a variable for the same reason `match/engine.ts` does it: the module it
 * names is not in the tree yet, and nothing here should fail to compile because of that. Make this
 * a static `import { deckFor, validateStoredLoadout } from "../api/loadouts"` the day M6-T3 lands.
 */
function loadLoadoutsModule(): Promise<LoadoutsModule> {
  if (cachedLoadouts !== null) return cachedLoadouts;
  const specifier = "../api/loadouts";
  cachedLoadouts = import(specifier).then((mod: LoadoutsModule) => mod);
  return cachedLoadouts;
}

/** NOT IN SPEC: how many collisions a 30-bit code space is allowed before we give up. */
const CODE_ATTEMPTS = 8;

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
    const deckIndex = deckIndexOf(req.body);

    const { validateStoredLoadout, deckFor } = await loadLoadouts();
    const loadout = await validateStoredLoadout(deps, profileId, deps.catalog.version);
    const deck = deckFor(loadout, deckIndex);

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
      deps.log.info("room.created", { code, hostProfileId: profileId });
      return ok({ code, expiresAt, deckIndex });
    }

    deps.log.alert("room.code.exhausted", { attempts: CODE_ATTEMPTS });
    throw new ApiError("unavailable", "could not allocate a room code; try again");
  });

  /** POST /api/rooms/:code/join — claim the room and start the match (§9.5). */
  const join = route("POST", "/api/rooms/:code/join", "active", async (req, deps) => {
    const profileId = profileOf(req);
    assertNotInMatch(req);
    const deckIndex = deckIndexOf(req.body);

    const typed = req.params.code ?? "";
    const room = await joinableRoom(deps, typed);
    if (room.hostProfileId === profileId) {
      throw new ApiError("conflict", "you created that room; wait for someone to join");
    }

    const { validateStoredLoadout, deckFor } = await loadLoadouts();
    const loadout = await validateStoredLoadout(deps, profileId, deps.catalog.version);
    const deck = deckFor(loadout, deckIndex);

    const matchId = deps.ids.uuid();
    const now = deps.timers.now();

    // The atomic single-claim: whoever wins this statement is the guest, and there is no second
    // winner (§9.5, mirroring `tickets.claimPair`).
    const claimed = await deps.store.rooms.claim(room.code, profileId, matchId, now);
    if (claimed === null) throw new ApiError("conflict", "someone already joined that room");

    await deps.matches.start({
      matchId,
      seed: deps.ids.seed(),
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

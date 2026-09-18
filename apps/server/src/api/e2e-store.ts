/**
 * The `Store` BUILD M8's end-to-end mode runs on, held entirely in memory.
 *
 * WHY THIS EXISTS AND WHY IT IS HERE. R144 makes the server reseed its fixture accounts and invite
 * codes at boot, which needs somewhere to seed *into*, and the e2e suite has no Postgres. The real
 * implementation of this port is `src/db/**`, which the database agent owns; this one is a test
 * fixture that happens to live in `src/` because `src/index.ts` has to be able to choose it at
 * boot. It is reachable only when `env.E2E` is true, and `src/env.ts` refuses `E2E` together with
 * `NODE_ENV=production`.
 *
 * It is deliberately strict everywhere Postgres is strict, because those are the invariants
 * SPEC §9.4 and §9.5 lean on and a laxer fixture would let a real bug pass the suite:
 *
 *  - `tx` snapshots every table and restores it if the callback throws, so §9.4's "writes
 *    `collection` and `collection_grants` in one transaction" is really all-or-nothing;
 *  - `codes.claim`, `rooms.claim` and `tickets.claimPair` are single-shot, so the second of two
 *    racing callers loses (§9.4 step 6, §9.5);
 *  - `matches.appendActions` refuses a `seq` that already exists (append-only, §9.3);
 *  - `results.insert` refuses a second row for the same match (§9.5);
 *  - `tickets.insert` refuses a second open ticket for one profile (`tickets_profile_queued_key`,
 *    which `queue.ts` relies on as the race-proof half of "not already queued");
 *  - `loadouts.replace` refuses a card id that appears in two decks (`loadout_card_unique`, §9.4
 *    L4, "also enforced by a unique index on `(profile_id, card_id)`").
 *
 * R111 IS A DATABASE TRIGGER, so it is implemented here rather than in a handler. SPEC §11 R111:
 * "Becoming `active` grants one copy of every non-token card, written by a trigger on the
 * `pending → active` transition and idempotent, so a repeated redemption cannot double a
 * collection." Nothing in application code grants it — `codes.ts` only calls
 * `profiles.setStatus(profileId, "active")` — so `setStatus` carries the trigger, writing both
 * tables exactly as `grantCards` in `collection.ts` does and reading the same `LAUNCH_COPIES` and
 * `LAUNCH_GRANT_REASON` so the two can never drift.
 *
 * `apps/server/test/fakes/store.ts` is the same port in memory for unit tests. This module does
 * not import it (`src` must not depend on `test`) and that one carries no launch grant, so the
 * existing tests keep seeing the store their assertions were written against.
 */

import { LAUNCH_COPIES, LAUNCH_GRANT_REASON } from "./collection";
import type {
  CatalogInfo,
  CodeAttempt,
  CollectionEntry,
  CollectionGrant,
  InviteCode,
  MatchActionRow,
  MatchRow,
  Profile,
  ProfileStatus,
  ResultRow,
  Room,
  Store,
  StoredLoadout,
  Ticket,
} from "./ports";

type CollectionRow = { profileId: string; cardId: string; quantity: number };

type Tables = {
  profiles: Profile[];
  codes: InviteCode[];
  attempts: CodeAttempt[];
  collection: CollectionRow[];
  grants: CollectionGrant[];
  loadouts: { profileId: string; loadout: StoredLoadout }[];
  matches: MatchRow[];
  matchActions: MatchActionRow[];
  rooms: Room[];
  tickets: Ticket[];
  results: ResultRow[];
};

function emptyTables(): Tables {
  return {
    profiles: [],
    codes: [],
    attempts: [],
    collection: [],
    grants: [],
    loadouts: [],
    matches: [],
    matchActions: [],
    rooms: [],
    tickets: [],
    results: [],
  };
}

const clone = <T>(value: T): T => structuredClone(value);

export type E2EStoreOptions = {
  /** R111 needs to know which ids are non-token and unbanned; §9.4 L3 and L6 define both. */
  catalog: CatalogInfo;
  /** The `Timers.now` of the runtime this store belongs to; never `Date.now()` directly. */
  now: () => number;
};

export type E2EStore = Store & {
  /**
   * R144: "the server reseeds its fixture accounts and invite codes at boot". The reseed is a
   * wipe and rewrite rather than a merge, so a second run starts from the same rows as the first.
   */
  reset: () => void;
  /**
   * The append-only grant ledger (§9.4), which `CollectionStore` has no read for because no client
   * path shows it. Exposed so the boot log and the R111 tests can see what the trigger wrote.
   */
  grantsFor: (profileId: string) => CollectionGrant[];
};

export function createE2EStore(options: E2EStoreOptions): E2EStore {
  let tables = emptyTables();
  let depth = 0;
  let nextProfile = 1;

  const store = {} as E2EStore;

  const profileOf = (profileId: string): Profile | undefined =>
    tables.profiles.find((row) => row.id === profileId);

  const collectionRow = (profileId: string, cardId: string): CollectionRow | undefined =>
    tables.collection.find((row) => row.profileId === profileId && row.cardId === cardId);

  // -------------------------------------------------------------------------
  // R111's trigger
  // -------------------------------------------------------------------------

  /**
   * One copy of every non-token, unbanned card, idempotent. Written as a delta against what the
   * profile already owns — exactly what `grantCards` does — so a second `pending → active`
   * transition computes zero for everything and writes no row at all: `collection_grants.delta`
   * carries `check (delta <> 0)` in the db agent's migration `0002_collection.sql`, and an empty
   * audit row would be a lie in the ledger.
   */
  const applyLaunchGrant = (profileId: string): void => {
    const at = options.now();
    const quantities: CollectionEntry[] = [];
    const grants: CollectionGrant[] = [];

    for (const cardId of options.catalog.cardIds) {
      if (options.catalog.isToken(cardId) || options.catalog.isBanned(cardId)) continue;
      const owned = collectionRow(profileId, cardId)?.quantity ?? 0;
      const delta = LAUNCH_COPIES - owned;
      if (delta <= 0) continue;
      quantities.push({ cardId, quantity: owned + delta });
      grants.push({ profileId, cardId, delta, reason: LAUNCH_GRANT_REASON, at });
    }

    if (quantities.length === 0) return;
    for (const entry of quantities) {
      const row = collectionRow(profileId, entry.cardId);
      if (row === undefined) {
        tables.collection.push({ profileId, cardId: entry.cardId, quantity: entry.quantity });
      } else {
        row.quantity = entry.quantity;
      }
    }
    tables.grants.push(...grants.map(clone));
  };

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  store.tx = async <T>(fn: (t: Store) => Promise<T>): Promise<T> => {
    // Nested `tx` joins the enclosing transaction (ports.ts), so only the outermost one snapshots.
    if (depth > 0) return fn(store);
    const snapshot = clone(tables);
    depth += 1;
    try {
      return await fn(store);
    } catch (error) {
      tables = snapshot;
      throw error;
    } finally {
      depth -= 1;
    }
  };

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  store.profiles = {
    getById: async (profileId) => {
      const row = profileOf(profileId);
      return row === undefined ? null : clone(row);
    },
    getByUserId: async (userId) => {
      const row = tables.profiles.find((profile) => profile.userId === userId);
      return row === undefined ? null : clone(row);
    },
    getMany: async (profileIds) =>
      tables.profiles.filter((profile) => profileIds.includes(profile.id)).map(clone),
    create: async ({ userId, email, rating, at }) => {
      if (tables.profiles.some((profile) => profile.userId === userId)) {
        throw new Error(`profiles.user_id is unique: ${userId} already has a profile`);
      }
      // §9.4: an account exists the moment auth says so and stays pending until a code is
      // redeemed, which is what `resolveCaller` in http.ts relies on.
      const profile: Profile = {
        id: `profile-${String(nextProfile)}`,
        userId,
        email,
        status: "pending",
        rating,
        inMatchId: null,
        createdAt: at,
      };
      nextProfile += 1;
      tables.profiles.push(profile);
      return clone(profile);
    },
    setStatus: async (profileId, status: ProfileStatus) => {
      const row = profileOf(profileId);
      if (row === undefined) throw new Error(`no profile ${profileId}`);
      const wasPending = row.status === "pending";
      row.status = status;
      // R111: the trigger fires on the `pending → active` transition only.
      if (wasPending && status === "active") applyLaunchGrant(profileId);
    },
    setRating: async (profileId, rating) => {
      const row = profileOf(profileId);
      if (row === undefined) throw new Error(`no profile ${profileId}`);
      row.rating = rating;
    },
    setInMatch: async (profileId, matchId) => {
      const row = profileOf(profileId);
      if (row === undefined) throw new Error(`no profile ${profileId}`);
      row.inMatchId = matchId;
    },
  };

  // -------------------------------------------------------------------------
  // Invite codes (§9.4)
  // -------------------------------------------------------------------------

  store.codes = {
    insert: async (code) => {
      if (tables.codes.some((row) => row.codeHash === code.codeHash)) {
        throw new Error("invite_codes.code_hash is unique");
      }
      tables.codes.push(clone(code));
    },
    findByHash: async (codeHash) => {
      const row = tables.codes.find((code) => code.codeHash === codeHash);
      return row === undefined ? null : clone(row);
    },
    // §9.4 step 6: one atomic statement. Two callers cannot both win the last use.
    claim: async (codeId, now) => {
      const row = tables.codes.find((code) => code.id === codeId);
      if (row === undefined) return false;
      if (row.revoked) return false;
      if (row.expiresAt !== null && row.expiresAt <= now) return false;
      if (row.uses >= row.maxUses) return false;
      row.uses += 1;
      return true;
    },
    logAttempt: async (attempt) => {
      tables.attempts.push(clone(attempt));
    },
    countAttemptsByProfile: async (profileId, since) =>
      tables.attempts.filter((a) => a.profileId === profileId && a.at >= since).length,
    countAttemptsByIp: async (ipHash, since) =>
      tables.attempts.filter((a) => a.ipHash === ipHash && a.at >= since).length,
    countFailures: async (since) =>
      tables.attempts.filter((a) => a.result === "rejected" && a.at >= since).length,
  };

  // -------------------------------------------------------------------------
  // Collection (§9.4's entitlement ledger)
  // -------------------------------------------------------------------------

  store.collection = {
    get: async (profileId) =>
      tables.collection
        .filter((row) => row.profileId === profileId)
        .map(({ cardId, quantity }) => ({ cardId, quantity })),
    // Sets the absolute quantity, never adds to it (ports.ts).
    upsertQuantities: async (profileId, entries: readonly CollectionEntry[]) => {
      for (const entry of entries) {
        const row = collectionRow(profileId, entry.cardId);
        if (row === undefined) {
          tables.collection.push({ profileId, cardId: entry.cardId, quantity: entry.quantity });
        } else {
          row.quantity = entry.quantity;
        }
      }
    },
    appendGrants: async (grants: readonly CollectionGrant[]) => {
      for (const grant of grants) {
        // `collection_grants.delta <> 0` in migration 0002.
        if (grant.delta === 0) throw new Error("collection_grants.delta must not be 0");
      }
      tables.grants.push(...grants.map(clone));
    },
  };

  // -------------------------------------------------------------------------
  // Loadouts (§9.4)
  // -------------------------------------------------------------------------

  store.loadouts = {
    get: async (profileId) => {
      const row = tables.loadouts.find((entry) => entry.profileId === profileId);
      return row === undefined ? null : clone(row.loadout);
    },
    replace: async (profileId, catalogVersion, decks, at) => {
      // §9.4 L4 is "also enforced by a unique index on `(profile_id, card_id)`", so a bypassed
      // application check still fails here.
      const seen = new Set<string>();
      for (const deck of decks) {
        for (const cardId of deck) {
          if (seen.has(cardId)) {
            throw new Error(`loadout_card_unique: (${profileId}, ${cardId}) appears twice`);
          }
          seen.add(cardId);
        }
      }
      const loadout: StoredLoadout = {
        catalogVersion,
        decks: decks.map((deck) => [...deck]),
        updatedAt: at,
      };
      const row = tables.loadouts.find((entry) => entry.profileId === profileId);
      if (row === undefined) tables.loadouts.push({ profileId, loadout });
      else row.loadout = loadout;
    },
  };

  // -------------------------------------------------------------------------
  // Matches (§9.3, §9.5)
  // -------------------------------------------------------------------------

  store.matches = {
    create: async (match) => {
      if (tables.matches.some((row) => row.id === match.id)) {
        throw new Error(`matches.id is unique: ${match.id}`);
      }
      tables.matches.push(clone(match));
    },
    get: async (matchId) => {
      const row = tables.matches.find((match) => match.id === matchId);
      return row === undefined ? null : clone(row);
    },
    appendActions: async (rows: readonly MatchActionRow[]) => {
      for (const row of rows) {
        const clash = tables.matchActions.some(
          (existing) => existing.matchId === row.matchId && existing.seq === row.seq,
        );
        if (clash) throw new Error(`match_actions is append-only: seq ${String(row.seq)} exists`);
        tables.matchActions.push(clone(row));
      }
    },
    actions: async (matchId) =>
      tables.matchActions
        .filter((row) => row.matchId === matchId)
        .sort((a, b) => a.seq - b.seq)
        .map(clone),
    setClocks: async (matchId, clocks) => {
      const row = tables.matches.find((match) => match.id === matchId);
      if (row === undefined) throw new Error(`no match ${matchId}`);
      row.clocks = clone(clocks);
    },
    finish: async (matchId, at) => {
      const row = tables.matches.find((match) => match.id === matchId);
      if (row === undefined) throw new Error(`no match ${matchId}`);
      row.status = "finished";
      row.finishedAt = at;
    },
    live: async () => tables.matches.filter((match) => match.status === "live").map(clone),
  };

  // -------------------------------------------------------------------------
  // Rooms (§9.5)
  // -------------------------------------------------------------------------

  store.rooms = {
    create: async (room) => {
      if (tables.rooms.some((existing) => existing.code === room.code)) return false;
      tables.rooms.push(clone(room));
      return true;
    },
    get: async (code) => {
      const row = tables.rooms.find((room) => room.code === code);
      return row === undefined ? null : clone(row);
    },
    // The atomic single-claim: the loser of a join race gets null, never a second match.
    claim: async (code, guestProfileId, matchId, at) => {
      const row = tables.rooms.find((room) => room.code === code);
      if (row === undefined) return null;
      if (row.guestProfileId !== null) return null;
      if (row.expiresAt <= at) return null;
      row.guestProfileId = guestProfileId;
      row.matchId = matchId;
      return clone(row);
    },
  };

  // -------------------------------------------------------------------------
  // Tickets (§9.5)
  // -------------------------------------------------------------------------

  store.tickets = {
    insert: async (ticket) => {
      const queued = tables.tickets.some(
        (row) => row.profileId === ticket.profileId && row.status === "open",
      );
      if (queued) throw new Error("tickets_profile_queued_key: this profile is already queued");
      tables.tickets.push(clone(ticket));
    },
    get: async (ticketId) => {
      const row = tables.tickets.find((ticket) => ticket.id === ticketId);
      return row === undefined ? null : clone(row);
    },
    openForProfile: async (profileId) => {
      const row = tables.tickets.find(
        (ticket) => ticket.profileId === profileId && ticket.status === "open",
      );
      return row === undefined ? null : clone(row);
    },
    listOpen: async () =>
      tables.tickets
        .filter((ticket) => ticket.status === "open")
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
        .map(clone),
    countOpen: async () => tables.tickets.filter((ticket) => ticket.status === "open").length,
    // §9.5: "both tickets are claimed in one atomic statement".
    claimPair: async (aId, bId, matchId, _at) => {
      if (aId === bId) return false;
      const a = tables.tickets.find((ticket) => ticket.id === aId);
      const b = tables.tickets.find((ticket) => ticket.id === bId);
      if (a === undefined || b === undefined) return false;
      if (a.status !== "open" || b.status !== "open") return false;
      for (const ticket of [a, b]) {
        ticket.status = "matched";
        ticket.matchId = matchId;
      }
      return true;
    },
    cancel: async (ticketId, _at) => {
      const row = tables.tickets.find((ticket) => ticket.id === ticketId);
      if (row === undefined || row.status !== "open") return;
      row.status = "cancelled";
    },
  };

  // -------------------------------------------------------------------------
  // Results (§9.5)
  // -------------------------------------------------------------------------

  store.results = {
    insert: async (row: ResultRow) => {
      if (tables.results.some((existing) => existing.matchId === row.matchId)) {
        throw new Error(`results holds one row per match: ${row.matchId}`);
      }
      tables.results.push(clone(row));
    },
    getByMatch: async (matchId) => {
      const row = tables.results.find((result) => result.matchId === matchId);
      return row === undefined ? null : clone(row);
    },
  };

  store.reset = () => {
    tables = emptyTables();
    nextProfile = 1;
  };

  store.grantsFor = (profileId) =>
    tables.grants.filter((grant) => grant.profileId === profileId).map(clone);

  return store;
}

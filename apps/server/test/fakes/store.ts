/**
 * An in-memory `Store` (apps/server/src/api/ports.ts) for the server tests.
 *
 * It is deliberately strict where Postgres is strict, because those are the invariants SPEC §9.4
 * and §9.5 lean on:
 *  - `tx` snapshots every table and restores it if the callback throws, so "both tables or
 *    neither" is a real assertion rather than a hope (M6-T2);
 *  - `codes.claim`, `rooms.claim` and `tickets.claimPair` are single-shot, so a second caller
 *    loses (§9.4 step 6, §9.5);
 *  - `matches.appendActions` refuses a seq that already exists (append-only, §9.3);
 *  - `results.insert` refuses a second row for the same match (§9.5).
 *
 * `redeem` (§9.4's six-step transaction) is not reimplemented here: it is `createInMemoryRedeem`
 * from `src/api/e2e-store.ts`, the same function the end-to-end fixture store uses, so the two
 * in-memory stores cannot answer a redemption differently while only one of them is under
 * `test/db/contract.ts`. It runs through this store's own methods, so `onCall` charges each step
 * and a test can wrap one of them.
 *
 * `onCall` is the fault-injection seam: a test throws from it to fail one method mid-transaction.
 */

import { createInMemoryRedeem, type RedemptionSettings } from "../../src/api/e2e-store";
import type {
  CodeAttempt,
  CollectionEntry,
  CollectionGrant,
  InviteCode,
  MatchActionRow,
  MatchClocks,
  MatchRow,
  Profile,
  ProfileStatus,
  ResultRow,
  Room,
  Store,
  StoredLoadout,
  Ticket,
} from "../../src/api/ports";

type Tables = {
  profiles: Profile[];
  codes: InviteCode[];
  attempts: CodeAttempt[];
  collection: { profileId: string; cardId: string; quantity: number }[];
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

export type MemoryStore = Store & {
  /** The raw tables, for assertions. */
  tables: Tables;
  /** Called with the port method name before every operation; throw here to inject a fault. */
  onCall: ((method: string) => void) | null;
  /** Seeds a profile without going through the API. */
  seedProfile: (input: Partial<Profile> & { id: string }) => Profile;
};

export type MemoryStoreOptions = {
  /**
   * The clock `Store.redeem` reads — `Timers.now` of the deps this store belongs to, so a test on
   * a virtual clock sees its own time in `code_attempts.at` and in the attempt windows. Postgres
   * reads the database clock in the same place.
   */
  now?: () => number;
  /** §9.4's attempt limits, the redemption kill switch and email verification (see e2e-store.ts). */
  redemption?: Partial<RedemptionSettings>;
};

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const tables = emptyTables();
  let depth = 0;
  let nextProfile = 1;

  const store = {
    tables,
    onCall: null as ((method: string) => void) | null,
  } as MemoryStore;

  const call = (method: string): void => {
    store.onCall?.(method);
  };

  const profileOf = (profileId: string): Profile | undefined =>
    tables.profiles.find((row) => row.id === profileId);

  store.seedProfile = (input) => {
    const profile: Profile = {
      id: input.id,
      userId: input.userId ?? `user-${input.id}`,
      email: input.email ?? `${input.id}@example.test`,
      status: input.status ?? "active",
      rating: input.rating ?? 1000,
      inMatchId: input.inMatchId ?? null,
      createdAt: input.createdAt ?? 0,
    };
    tables.profiles.push(profile);
    nextProfile += 1;
    return clone(profile);
  };

  store.tx = async <T>(fn: (t: Store) => Promise<T>): Promise<T> => {
    if (depth > 0) return fn(store);
    const snapshot = clone(tables);
    depth += 1;
    try {
      return await fn(store);
    } catch (error) {
      for (const key of Object.keys(snapshot) as (keyof Tables)[]) {
        // Restore in place: callers hold a reference to `tables`.
        (tables[key] as unknown[]).length = 0;
        (tables[key] as unknown[]).push(...(clone(snapshot[key]) as unknown[]));
      }
      throw error;
    } finally {
      depth -= 1;
    }
  };

  // §9.4's six steps, shared with `src/api/e2e-store.ts`. `call` is charged for the transaction
  // itself as well as for each step it takes through the port.
  const redeem = createInMemoryRedeem({
    store,
    now: options.now ?? (() => Date.now()),
    ...(options.redemption === undefined ? {} : { settings: options.redemption }),
  });
  store.redeem = async (input) => {
    call("redeem");
    return redeem(input);
  };

  store.profiles = {
    getById: async (profileId) => {
      call("profiles.getById");
      const row = profileOf(profileId);
      return row === undefined ? null : clone(row);
    },
    getByUserId: async (userId) => {
      call("profiles.getByUserId");
      const row = tables.profiles.find((p) => p.userId === userId);
      return row === undefined ? null : clone(row);
    },
    getMany: async (profileIds) => {
      call("profiles.getMany");
      return tables.profiles.filter((p) => profileIds.includes(p.id)).map(clone);
    },
    create: async ({ userId, email, rating, at }) => {
      call("profiles.create");
      const existing = tables.profiles.find((p) => p.userId === userId);
      if (existing !== undefined) throw new Error(`profile for ${userId} already exists`);
      const profile: Profile = {
        id: `profile-${nextProfile}`,
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
      call("profiles.setStatus");
      const row = profileOf(profileId);
      if (row === undefined) throw new Error(`no profile ${profileId}`);
      row.status = status;
    },
    setRating: async (profileId, rating) => {
      call("profiles.setRating");
      const row = profileOf(profileId);
      if (row === undefined) throw new Error(`no profile ${profileId}`);
      row.rating = rating;
    },
    setInMatch: async (profileId, matchId) => {
      call("profiles.setInMatch");
      const row = profileOf(profileId);
      if (row === undefined) throw new Error(`no profile ${profileId}`);
      row.inMatchId = matchId;
    },
  };

  store.codes = {
    insert: async (code) => {
      call("codes.insert");
      if (tables.codes.some((row) => row.codeHash === code.codeHash)) {
        throw new Error("duplicate code hash");
      }
      tables.codes.push(clone(code));
    },
    findByHash: async (codeHash) => {
      call("codes.findByHash");
      const row = tables.codes.find((code) => code.codeHash === codeHash);
      return row === undefined ? null : clone(row);
    },
    claim: async (codeId, now) => {
      call("codes.claim");
      const row = tables.codes.find((code) => code.id === codeId);
      if (row === undefined) return false;
      if (row.revoked) return false;
      if (row.expiresAt !== null && row.expiresAt <= now) return false;
      if (row.uses >= row.maxUses) return false;
      row.uses += 1;
      return true;
    },
    logAttempt: async (attempt) => {
      call("codes.logAttempt");
      tables.attempts.push(clone(attempt));
    },
    countAttemptsByProfile: async (profileId, since) => {
      call("codes.countAttemptsByProfile");
      return tables.attempts.filter((a) => a.profileId === profileId && a.at >= since).length;
    },
    countAttemptsByIp: async (ipHash, since) => {
      call("codes.countAttemptsByIp");
      return tables.attempts.filter((a) => a.ipHash === ipHash && a.at >= since).length;
    },
    countFailures: async (since) => {
      call("codes.countFailures");
      return tables.attempts.filter((a) => a.result === "rejected" && a.at >= since).length;
    },
  };

  store.collection = {
    get: async (profileId) => {
      call("collection.get");
      return tables.collection
        .filter((row) => row.profileId === profileId)
        .map(({ cardId, quantity }) => ({ cardId, quantity }));
    },
    upsertQuantities: async (profileId, entries: readonly CollectionEntry[]) => {
      call("collection.upsertQuantities");
      for (const entry of entries) {
        const row = tables.collection.find(
          (candidate) => candidate.profileId === profileId && candidate.cardId === entry.cardId,
        );
        if (row === undefined) {
          tables.collection.push({ profileId, cardId: entry.cardId, quantity: entry.quantity });
        } else {
          row.quantity = entry.quantity;
        }
      }
    },
    appendGrants: async (grants: readonly CollectionGrant[]) => {
      call("collection.appendGrants");
      tables.grants.push(...grants.map(clone));
    },
  };

  store.loadouts = {
    get: async (profileId) => {
      call("loadouts.get");
      const row = tables.loadouts.find((entry) => entry.profileId === profileId);
      return row === undefined ? null : clone(row.loadout);
    },
    replace: async (profileId, catalogVersion, decks, at) => {
      call("loadouts.replace");
      // The db implementation leans on the unique index on (profile_id, card_id) for L4; the
      // fake enforces the same thing so a bypassed application check still fails here.
      const seen = new Set<string>();
      for (const deck of decks) {
        for (const cardId of deck) {
          if (seen.has(cardId)) {
            throw new Error(`unique violation: (${profileId}, ${cardId}) appears twice`);
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

  store.matches = {
    create: async (match) => {
      call("matches.create");
      if (tables.matches.some((row) => row.id === match.id)) throw new Error("duplicate match");
      tables.matches.push(clone(match));
    },
    get: async (matchId) => {
      call("matches.get");
      const row = tables.matches.find((match) => match.id === matchId);
      return row === undefined ? null : clone(row);
    },
    appendActions: async (rows: readonly MatchActionRow[]) => {
      call("matches.appendActions");
      for (const row of rows) {
        const clash = tables.matchActions.some(
          (existing) => existing.matchId === row.matchId && existing.seq === row.seq,
        );
        if (clash) throw new Error(`match_actions is append-only: seq ${row.seq} exists`);
        tables.matchActions.push(clone(row));
      }
    },
    actions: async (matchId) => {
      call("matches.actions");
      return tables.matchActions
        .filter((row) => row.matchId === matchId)
        .sort((a, b) => a.seq - b.seq)
        .map(clone);
    },
    setClocks: async (matchId, clocks: MatchClocks) => {
      call("matches.setClocks");
      const row = tables.matches.find((match) => match.id === matchId);
      if (row === undefined) throw new Error(`no match ${matchId}`);
      row.clocks = clone(clocks);
    },
    finish: async (matchId, at) => {
      call("matches.finish");
      const row = tables.matches.find((match) => match.id === matchId);
      if (row === undefined) throw new Error(`no match ${matchId}`);
      row.status = "finished";
      row.finishedAt = at;
    },
    live: async () => {
      call("matches.live");
      return tables.matches.filter((match) => match.status === "live").map(clone);
    },
  };

  store.rooms = {
    create: async (room) => {
      call("rooms.create");
      if (tables.rooms.some((existing) => existing.code === room.code)) return false;
      tables.rooms.push(clone(room));
      return true;
    },
    get: async (code) => {
      call("rooms.get");
      const row = tables.rooms.find((room) => room.code === code);
      return row === undefined ? null : clone(row);
    },
    claim: async (code, guestProfileId, matchId, at) => {
      call("rooms.claim");
      const row = tables.rooms.find((room) => room.code === code);
      if (row === undefined) return null;
      if (row.guestProfileId !== null) return null;
      if (row.expiresAt <= at) return null;
      row.guestProfileId = guestProfileId;
      row.matchId = matchId;
      return clone(row);
    },
  };

  store.tickets = {
    insert: async (ticket) => {
      call("tickets.insert");
      const queued = tables.tickets.some(
        (row) => row.profileId === ticket.profileId && row.status === "open",
      );
      if (queued) throw new Error("this profile already holds an open ticket");
      tables.tickets.push(clone(ticket));
    },
    get: async (ticketId) => {
      call("tickets.get");
      const row = tables.tickets.find((ticket) => ticket.id === ticketId);
      return row === undefined ? null : clone(row);
    },
    openForProfile: async (profileId) => {
      call("tickets.openForProfile");
      const row = tables.tickets.find(
        (ticket) => ticket.profileId === profileId && ticket.status === "open",
      );
      return row === undefined ? null : clone(row);
    },
    listOpen: async () => {
      call("tickets.listOpen");
      return tables.tickets
        .filter((ticket) => ticket.status === "open")
        .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
        .map(clone);
    },
    countOpen: async () => {
      call("tickets.countOpen");
      return tables.tickets.filter((ticket) => ticket.status === "open").length;
    },
    claimPair: async (aId, bId, matchId, at) => {
      call("tickets.claimPair");
      if (aId === bId) return false;
      const a = tables.tickets.find((ticket) => ticket.id === aId);
      const b = tables.tickets.find((ticket) => ticket.id === bId);
      if (a === undefined || b === undefined) return false;
      // §9.5: one atomic statement. Either both were open or nothing changes.
      if (a.status !== "open" || b.status !== "open") return false;
      for (const ticket of [a, b]) {
        ticket.status = "matched";
        ticket.matchId = matchId;
      }
      void at;
      return true;
    },
    cancel: async (ticketId, at) => {
      call("tickets.cancel");
      const row = tables.tickets.find((ticket) => ticket.id === ticketId);
      if (row === undefined || row.status !== "open") return;
      row.status = "cancelled";
      void at;
    },
  };

  store.results = {
    insert: async (row: ResultRow) => {
      call("results.insert");
      if (tables.results.some((existing) => existing.matchId === row.matchId)) {
        throw new Error(`results already holds a row for ${row.matchId}`);
      }
      tables.results.push(clone(row));
    },
    getByMatch: async (matchId) => {
      call("results.getByMatch");
      const row = tables.results.find((result) => result.matchId === matchId);
      return row === undefined ? null : clone(row);
    },
  };

  return store;
}

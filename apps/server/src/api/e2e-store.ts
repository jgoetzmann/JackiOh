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
 *    `collection` and `collection_grants` in one transaction" is really all-or-nothing, and runs
 *    one transaction at a time (`createTransactionQueue`), so a transaction that rolls back never
 *    takes another request's committed writes with it;
 *  - `redeem` runs §9.4's six steps in SPEC's order inside one `tx` and answers the same seven
 *    result codes `app.redeem_invite_code` does, so the redemption the server calls here is the
 *    redemption it calls in Postgres;
 *  - `codes.claim`, `rooms.claim` and `tickets.claimPair` are single-shot, so the second of two
 *    racing callers loses (§9.4 step 6, §9.5);
 *  - `matches.appendActions` refuses a `seq` that already exists (append-only, §9.3);
 *  - `results.insert` refuses a second row for the same match (§9.5);
 *  - `tickets.insert` refuses a second open ticket for one profile (`tickets_profile_queued_key`,
 *    which `queue.ts` relies on as the race-proof half of "not already queued");
 *  - `decks`, `trios` and `series` are `src/api/memory-stores.ts`, shared with the unit-test fake:
 *    the deck and trio caps, the owner check and `series.update`'s compare-and-set are one
 *    implementation for both in-memory stores (R250, R252, R263).
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

import { AsyncLocalStorage } from "node:async_hooks";

import {
  CODE_ATTEMPTS_PER_IP_PER_HOUR,
  CODE_ATTEMPTS_PER_PROFILE_PER_HOUR,
  CODE_ATTEMPT_WINDOW_SECONDS,
} from "../config";
import { LAUNCH_COPIES, LAUNCH_GRANT_REASON } from "./collection";
import { createMemoryDeckStores, type DeckTables } from "./memory-stores";
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
  RedeemInviteCodeInput,
  RedeemResult,
  QueueMode,
  ResultRow,
  Room,
  Store,
  Ticket,
} from "./ports";

type CollectionRow = { profileId: string; cardId: string; quantity: number };

type Tables = {
  profiles: Profile[];
  codes: InviteCode[];
  attempts: CodeAttempt[];
  collection: CollectionRow[];
  grants: CollectionGrant[];
  matches: MatchRow[];
  matchActions: MatchActionRow[];
  rooms: Room[];
  tickets: Ticket[];
  results: ResultRow[];
} & DeckTables;

function emptyTables(): Tables {
  return {
    profiles: [],
    codes: [],
    attempts: [],
    collection: [],
    grants: [],
    decks: [],
    trios: [],
    series: [],
    matches: [],
    matchActions: [],
    rooms: [],
    tickets: [],
    results: [],
  };
}

const clone = <T>(value: T): T => structuredClone(value);

// ---------------------------------------------------------------------------
// SPEC §9.4's redemption, in memory (`Store.redeem`)
// ---------------------------------------------------------------------------

/**
 * The database state `app.redeem_invite_code` reads that no other port method can reach, and the
 * three numbers §9.4 writes into the function's body. Defaults come from `src/config.ts` — the
 * same constants `defaultLimits()` copies into `ApiLimits` — so the fixture and the deployment
 * agree without either restating a value.
 */
export type RedemptionSettings = {
  /** §9.4 step 2: "more than 5 attempts in the last hour". */
  attemptsPerProfilePerHour: number;
  /** §9.4 step 3: "more than 20". */
  attemptsPerIpPerHour: number;
  /** The window both counters are taken over. */
  attemptWindowMs: number;
  /**
   * `app.settings.redemption_enabled` — the database-side kill switch the SQL function checks
   * before the lookup and answers `circuit_open` from. A hook rather than a value so a caller can
   * flip it between calls, which is how the store contract drives it against both stores.
   */
  enabled: () => boolean;
  /**
   * `auth.users.email_confirmed_at is not null` for this profile (§9.4 step 1). `public.profiles`
   * has no such column and neither does `Profile`, so the SQL function joins `auth.users` for it
   * and the fixture asks here. True by default: BUILD M8's three fixture accounts are all verified
   * (`src/api/e2e.ts`), and the server refuses an unverified caller from the access token (R159)
   * before this port is reached.
   */
  emailVerified: (profileId: string) => boolean;
};

export function defaultRedemptionSettings(
  overrides: Partial<RedemptionSettings> = {},
): RedemptionSettings {
  return {
    attemptsPerProfilePerHour: CODE_ATTEMPTS_PER_PROFILE_PER_HOUR,
    attemptsPerIpPerHour: CODE_ATTEMPTS_PER_IP_PER_HOUR,
    attemptWindowMs: CODE_ATTEMPT_WINDOW_SECONDS * 1000,
    enabled: () => true,
    emailVerified: () => true,
    ...overrides,
  };
}

/**
 * §9.4's six steps over a `Store`'s own methods, which is what makes this the fake half of
 * `app.redeem_invite_code` rather than a second reading of §9.4: the steps run in SPEC's order,
 * rejections are returned and never thrown, and every read and write goes back through the port so
 * a fake's own invariants (`codes.claim` is single-shot, `profiles.setStatus` carries R111's launch
 * grant) hold here exactly as they do for any other caller.
 *
 * Both in-memory stores share this one function — `src/api/e2e-store.ts` and
 * `test/fakes/store.ts` — so the two fakes cannot drift from each other while the contract suite
 * only runs against the first.
 *
 * CALLS RUN ONE AT A TIME. The in-memory steps await between reads and writes, so without
 * serialisation two redemptions by one pending profile both passed step 1 across an `await` and one
 * account used up two codes. Each call therefore waits for the one before it to settle, through a
 * promise chain; a call that throws does not block the next.
 *
 * That is STRICTER than Postgres, not the same. `app.redeem_invite_code` serialises two redemptions
 * only where they share something it locks: the profile row (step 1), the caller's IP hash (an
 * advisory lock before step 3's count, migration 0006) and the code row (step 5). Two redemptions by
 * different profiles from different addresses for different codes run side by side there. So a
 * race this fixture cannot lose still needs `redeem-race.postgres.spec.ts` (`pnpm test:db`).
 */
export function createInMemoryRedeem(deps: {
  store: Store;
  /** The runtime's `Timers.now`; `app.redeem_invite_code` reads the database clock here. */
  now: () => number;
  settings?: Partial<RedemptionSettings>;
}): (input: RedeemInviteCodeInput) => Promise<RedeemResult> {
  const settings = defaultRedemptionSettings(deps.settings);

  // The tail of the queue: the promise the next call waits for. Never rejects.
  let queue: Promise<unknown> = Promise.resolve();

  const redeemOne = async ({
    profileId,
    codeHash,
    ipHash,
  }: RedeemInviteCodeInput): Promise<RedeemResult> => {
    const store = deps.store;
    // Read once the call holds the queue, as the database reads its clock inside the transaction.
    const now = deps.now();

    // §9.4: "Redemption is one server-side transaction." In Postgres the whole of this is one
    // `select app.redeem_invite_code(...)`; here it is one `tx`, so a fault leaves nothing behind.
    return store.tx(async (): Promise<RedeemResult> => {
      const log = async (result: CodeAttempt["result"], reason: string): Promise<void> => {
        await store.codes.logAttempt({ profileId, ipHash, result, reason, at: now });
      };

      // ---- Step 1: "reject unless the account is pending with a verified email" --------------
      // One result for "no such profile", "banned" and "already active", exactly as the SQL's
      // `if not found or v_status is distinct from 'pending'` decides them together.
      const profile = await store.profiles.getById(profileId);
      if (profile === null || profile.status !== "pending") return "not_pending";
      if (!settings.emailVerified(profileId)) return "email_unverified";

      const since = now - settings.attemptWindowMs;

      // ---- Step 2: "reject if this profile made more than 5 attempts in the last hour" --------
      // Strictly `>`, and the count excludes the attempt being made because step 4 logs it below,
      // so the SEVENTH attempt is the first refused (`src/config.ts` carries the reasoning).
      if ((await store.codes.countAttemptsByProfile(profileId, since)) > settings.attemptsPerProfilePerHour) {
        return "rate_limited_profile";
      }

      // ---- Step 3: "reject if this IP hash made more than 20" ---------------------------------
      if ((await store.codes.countAttemptsByIp(ipHash, since)) > settings.attemptsPerIpPerHour) {
        return "rate_limited_ip";
      }

      // The database-side kill switch, checked where the SQL checks it: after the cheap refusals
      // and before the lookup. Unlike steps 2 and 3 this one DOES log the attempt, because the
      // caller got far enough to spend one.
      if (!settings.enabled()) {
        await log("rejected", "circuit_open");
        return "circuit_open";
      }

      // ---- Steps 4 and 5: log the attempt either way, then "look up by hash and reject if
      // revoked, expired or exhausted" ---------------------------------------------------------
      // The log is written with the outcome rather than ahead of it: `CodeStore` has only
      // `logAttempt`, and no way to flip a row's result afterwards the way the SQL updates its
      // own. Inside one transaction the two orders commit identically; what matters is that every
      // attempt past steps 2 and 3 leaves a row, whichever way the code turned out.
      const reject = async (reason: string): Promise<RedeemResult> => {
        await log("rejected", reason);
        return "invalid_code";
      };

      // A code that could never exist (§9.4's alphabet and length) takes the identical path: no
      // oracle separates "well formed but unknown" from "not a code at all".
      if (codeHash === null) return reject("malformed");

      const code = await store.codes.findByHash(codeHash);
      if (code === null) return reject("missing");
      if (code.revoked) return reject("revoked");
      if (code.expiresAt !== null && code.expiresAt <= now) return reject("expired");
      if (code.uses >= code.maxUses) return reject("exhausted");

      // ---- Step 6: "increment uses and set the account active, atomically" --------------------
      // `claim` is the atomic increment, so a false return is a code that ran out between the
      // check above and here.
      if (!(await store.codes.claim(code.id, now))) return reject("exhausted");
      await store.profiles.setStatus(profileId, "active");
      await log("ok", "redeemed");
      return "ok";
    });
  };

  return (input) => {
    const run = queue.then(() => redeemOne(input));
    queue = run.catch(() => undefined);
    return run;
  };
}

/**
 * Transactions for an in-memory store, one at a time. A whole-table snapshot is the only rollback
 * these stores have, so two transactions in flight at once would share it: the second joined the
 * first through a depth counter, and when the first rolled back it took the second's writes with
 * it, after the second's caller had been told they committed. Now a transaction waits for the one
 * before it, and a `tx` called from inside a running transaction's body (anything it awaits
 * included, which `AsyncLocalStorage` follows) joins it, as `Store.tx` promises (ports.ts).
 */
export type TransactionQueue = {
  /** True inside a running transaction's body. */
  active: () => boolean;
  /** Runs `body` as a transaction once every one queued before it has settled. */
  run: <T>(body: () => Promise<T>) => Promise<T>;
};

export function createTransactionQueue(): TransactionQueue {
  const inside = new AsyncLocalStorage<true>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    active: () => inside.getStore() === true,
    run: <T>(body: () => Promise<T>): Promise<T> => {
      const run = tail.then(() => inside.run(true, body));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

export type E2EStoreOptions = {
  /** R111 needs to know which ids are non-token and unbanned; §9.4 L3 and L6 define both. */
  catalog: CatalogInfo;
  /** The `Timers.now` of the runtime this store belongs to; never `Date.now()` directly. */
  now: () => number;
  /** What the database would answer for §9.4's limits, kill switch and email verification. */
  redemption?: Partial<RedemptionSettings>;
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
  const transactions = createTransactionQueue();
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
    if (transactions.active()) return fn(store);
    return transactions.run(async () => {
      const snapshot = clone(tables);
      try {
        return await fn(store);
      } catch (error) {
        tables = snapshot;
        throw error;
      }
    });
  };

  // §9.4's redemption as one transaction. Built from this store's own methods, so R111's trigger
  // on `setStatus` and `codes.claim`'s single-shot guarantee take part exactly as they would for
  // any other caller.
  store.redeem = createInMemoryRedeem({
    store,
    now: options.now,
    ...(options.redemption === undefined ? {} : { settings: options.redemption }),
  });

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
    oldestAttemptAtByProfile: async (profileId, since) => {
      const times = tables.attempts.filter((a) => a.profileId === profileId && a.at >= since).map((a) => a.at);
      return times.length === 0 ? null : Math.min(...times);
    },
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
  // Saved decks, trios and the Best-of-3 series (R250–R263): shared with the unit-test fake.
  // -------------------------------------------------------------------------

  const deckStores = createMemoryDeckStores(() => tables);
  store.decks = deckStores.decks;
  store.trios = deckStores.trios;
  store.series = deckStores.series;

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
    // No `open` rows here: a reserved match id is only an id until the registry creates it (R263).
    discardOpen: async (_matchId) => {
    },
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
    countOpenByMode: async () => {
      const counts: Record<QueueMode, number> = { bo1: 0, bo3: 0, random: 0 };
      for (const ticket of tables.tickets) {
        if (ticket.status === "open") counts[ticket.mode] += 1;
      }
      return counts;
    },
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
    /** Counted as the Postgres store counts it: a winnerless row is a draw (§9.5). */
    recordFor: async (profileId) => {
      const mine = tables.results.filter((row) => row.players.includes(profileId));
      return {
        wins: mine.filter((row) => row.winnerProfileId === profileId).length,
        losses: mine.filter(
          (row) => row.winnerProfileId !== null && row.winnerProfileId !== profileId,
        ).length,
        draws: mine.filter((row) => row.winnerProfileId === null).length,
      };
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

/**
 * The production `Store` (SPEC §9.2's `API functions -> Postgres` edge), implemented over the four
 * migrations in `./migrations` with the `pg` driver already in `apps/server/package.json`.
 *
 * `src/index.ts` finds this module by dynamic import and calls `createPostgresStore({
 * connectionString })`; until it existed the server threw `StoreUnavailableError` and could only
 * boot in `E2E=1` mode against the in-memory fixture in `src/api/e2e-store.ts`.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES THIS FILE LIVES BY
 * ---------------------------------------------------------------------------
 *
 * 1. CALL THE `app.*` FUNCTIONS, DO NOT RE-DERIVE THEM. Migrations 0001-0004 put the rules SPEC
 *    §9.4/§9.5 call "one transaction", "one atomic statement" and "append-only" inside SECURITY
 *    DEFINER functions. Wherever the port's shape admits it, a method here is one call to one of
 *    them — `app.save_loadout`, `app.append_match_action`, `app.claim_ticket_pair`,
 *    `app.live_matches` — and the SQL stays the authority. Each method that does NOT reach an
 *    `app.*` function says why in its own comment; the report that came with this file lists them
 *    together.
 *
 * 2. THE SERVER IS `service_role`, AND NEVER THE OWNER. Every migration ends with the same
 *    sentence: "service_role: BYPASSRLS covers reads/writes to these tables; the EXECUTE grants
 *    below are what the API server and the match actor actually call." So the connection may be
 *    made as the migration owner (Supabase hands out `postgres` in `DATABASE_URL`), but no
 *    statement in this file ever RUNS as it: every transaction begins by switching to
 *    `service_role` and stamping `request.jwt.claim.sub` — the GUC `auth.uid()` reads — with the
 *    profile the call is about.
 *
 *    `SET LOCAL` is scoped to a transaction and is a silent no-op with a warning outside one
 *    (`SET LOCAL can only be used in transaction blocks`), which is exactly how a driver ends up
 *    quietly running as a superuser with RLS bypassed. This one therefore has no path that
 *    executes SQL outside a transaction: `Session.run` below is the only way in, it issues `begin`
 *    before it issues the role switch, and `SESSION_SQL` is the only statement that sets either
 *    GUC. `test/db/postgres.spec.ts` asserts both from inside the store's own transaction, with a
 *    trigger that records `current_user` and `auth.uid()` as the store's statements see them.
 *
 * 3. `src/api/e2e-store.ts` IS THE BEHAVIOURAL SPECIFICATION. It implements the same port, the
 *    server suite runs against it, and its header lists the invariants §9.4 and §9.5 lean on.
 *    `test/db/contract.ts` is those invariants as one suite, run against BOTH stores — the fake in
 *    `pnpm test` and this one in `pnpm test:db`. Where the two genuinely cannot agree (Postgres is
 *    stricter, or the schema cannot hold something the port carries) the divergence is written
 *    down in `KNOWN DIVERGENCES` at the bottom of this file and asserted, not hidden.
 */

import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import type {
  CodeAttempt,
  CollectionEntry,
  CollectionGrant,
  InviteCode,
  MatchActionRow,
  MatchClocks,
  MatchRow,
  MatchStatus,
  Profile,
  ProfileStatus,
  RedeemResult,
  ResultRow,
  Room,
  Store,
  StoredLoadout,
  Ticket,
  TicketStatus,
} from "../api/ports";
import type { Action } from "@jackioh/shared";

// ---------------------------------------------------------------------------
// The role the server acts as
// ---------------------------------------------------------------------------

/**
 * Migration 0001 §8, and the same closing note in 0002-0004: `service_role` is the role the API
 * server and the match actor hold. It is the only role granted EXECUTE on `app.redeem_invite_code`,
 * `app.save_loadout`, `app.append_match_action`, `app.claim_ticket_pair` and the rest, so running
 * as it is not a formality — a call this file gets wrong fails with `insufficient_privilege`
 * instead of succeeding because the connection happened to own the table.
 */
const ACTING_ROLE = "service_role";

/**
 * One statement, two `SET LOCAL`s. `set_config(name, value, true)` is `SET LOCAL name = value`,
 * and unlike `SET LOCAL` it takes parameters, so the profile id is bound rather than interpolated.
 *
 * `request.jwt.claim.sub` is the GUC Supabase's `auth.uid()` reads (see
 * `test/sql/00_supabase_stub.sql`, which stands the same function up for a plain Postgres). Every
 * RLS policy in 0002-0004 is `profile_id = app.current_profile_id()`, and `app.profile_is_active()`
 * reads `auth.uid()` directly, so a transaction that leaves it unset is a transaction where those
 * expressions silently see NULL. `service_role` carries BYPASSRLS, which means this cannot change
 * the result of anything here today; it is set anyway so that the day a policy, a trigger or a
 * SECURITY INVOKER helper does consult the caller, it sees the profile the call is about rather
 * than nobody.
 */
const SESSION_SQL = "select set_config('role', $1, true), set_config('request.jwt.claim.sub', $2, true)";

// ---------------------------------------------------------------------------
// Value conversions. The port speaks epoch milliseconds and plain JSON; Postgres speaks
// timestamptz, jsonb, uuid and int8.
// ---------------------------------------------------------------------------

/** `timestamptz` -> epoch ms. node-pg parses it into a `Date`; a string is a defensive fallback. */
function msOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  throw new Error(`expected a timestamptz, got ${typeof value}`);
}

function msOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : msOf(value);
}

/** Written as `to_timestamp($n / 1000.0)`; see `ts()` for the SQL half. */
function ts(param: string): string {
  return `to_timestamp(${param}::double precision / 1000.0)`;
}

function intOf(value: unknown): number {
  if (typeof value === "number") return value;
  // int8 arrives as a string, because it does not fit a JS number in general.
  if (typeof value === "string") return Number.parseInt(value, 10);
  throw new Error(`expected an integer, got ${typeof value}`);
}

function textOf(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected text, got ${typeof value}`);
  return value;
}

function cardListOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`expected a jsonb array of card ids`);
  return value.map((entry) => textOf(entry));
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Sessions: one transaction per call, the role switched inside it
// ---------------------------------------------------------------------------

/** One statement against the open transaction. */
type Query = <T extends QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
) => Promise<QueryResult<T>>;

type Session = {
  /**
   * The primitive, and the only way into the database. `subject` is the profile the call is about
   * — or null for the calls that are about nobody (`tickets.listOpen`, `matches.live`, the
   * breaker's `countFailures`). `body` runs inside ONE transaction, as `service_role`, with
   * `auth.uid()` set to `subject`. Every statement `body` issues is on the same connection and
   * commits or rolls back together — which is what a method like `matches.create` (read-lock,
   * then write) or
   * `tickets.claimPair` (claim, then link) needs to be safe at all, and what makes a mid-method
   * `throw` leave nothing behind.
   */
  run: <T>(subject: string | null, body: (q: Query) => Promise<T>) => Promise<T>;
  /** The one-statement convenience, which is what most methods want. */
  query: <T extends QueryResultRow>(
    subject: string | null,
    sql: string,
    params?: readonly unknown[],
  ) => Promise<QueryResult<T>>;
  /** True inside `Store.tx`, where the transaction is already open and must not be nested. */
  readonly joined: boolean;
  /** The pool a new transaction takes a client from, or null once inside one. */
  readonly pool: Pool | null;
};

async function beginSession(client: PoolClient, subject: string | null): Promise<void> {
  await client.query("begin");
  await client.query(SESSION_SQL, [ACTING_ROLE, subject ?? ""]);
}

function boundQuery(client: PoolClient): Query {
  return <T extends QueryResultRow>(sql: string, params: readonly unknown[] = []) =>
    client.query<T>(sql, [...params]);
}

function withQuery(session: Omit<Session, "query">): Session {
  return {
    ...session,
    query: (subject, sql, params) => session.run(subject, (q) => q(sql, params)),
  };
}

/** The top-level session: every call is its own transaction, opened and closed here. */
function poolSession(pool: Pool): Session {
  return withQuery({
    joined: false,
    pool,
    run: async <T>(subject: string | null, body: (q: Query) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      // A CHECKED-OUT client emits `error` on itself, not on the Pool, so `pool.on("error")` in
      // `createPostgresStore` does not cover this case and an unhandled 'error' event is re-thrown
      // by Node. Measured against the Supabase pooler: `Error: read ETIMEDOUT ... Emitted 'error'
      // event on Client instance`, process dead, mid-session, with a request in flight.
      //
      // The listener does not swallow the failure -- the in-flight query rejects on its own and
      // that rejection is what the caller sees and reports. It exists so the process survives long
      // enough to report it, and so the dead connection can be destroyed rather than returned to
      // the pool: `release(err)` is how `pg` is told to discard a client instead of reusing it.
      let fatal: Error | undefined;
      const onClientError = (error: Error): void => {
        fatal = error;
      };
      client.on("error", onClientError);
      try {
        await beginSession(client, subject);
        const result = await body(boundQuery(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.removeListener("error", onClientError);
        client.release(fatal);
      }
    },
  });
}

/**
 * The session inside `Store.tx`: the transaction is already open on `client`, so a call only
 * re-stamps the subject (the role is already `service_role` and stays that way until commit) and
 * a `throw` is left to the enclosing transaction to roll back, which ports.ts says it must.
 */
function joinedSession(client: PoolClient): Session {
  return withQuery({
    joined: true,
    pool: null,
    run: async <T>(subject: string | null, body: (q: Query) => Promise<T>): Promise<T> => {
      await client.query(SESSION_SQL, [ACTING_ROLE, subject ?? ""]);
      return body(boundQuery(client));
    },
  });
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type ProfileRow = {
  id: string;
  status: string;
  rating: number;
  current_match_id: string | null;
  created_at: Date;
  email: string | null;
};

const PROFILE_COLUMNS = `p.id, p.status, p.rating, p.current_match_id, p.created_at, u.email`;
const PROFILE_FROM = `from public.profiles p left join auth.users u on u.id = p.id`;

function toProfile(row: ProfileRow): Profile {
  const status = row.status;
  if (status !== "pending" && status !== "active" && status !== "banned") {
    throw new Error(`profiles.status holds an unknown value: ${status}`);
  }
  return {
    id: row.id,
    // SPEC §9.4's managed auth provider owns identity, and migration 0001 keys `profiles.id`
    // 1:1 to `auth.users(id)`. There is no second column: in this schema the profile id IS the
    // managed-auth user id, so `getById` and `getByUserId` are the same lookup.
    userId: row.id,
    email: row.email ?? "",
    status: status satisfies ProfileStatus,
    rating: row.rating,
    inMatchId: row.current_match_id,
    createdAt: msOf(row.created_at),
  };
}

type MatchDbRow = {
  id: string;
  status: string;
  seed: string;
  p1_profile_id: string;
  p2_profile_id: string | null;
  p1_deck: unknown;
  p2_deck: unknown;
  catalog_version: string;
  turn_deadline_at: Date | null;
  prompt_deadline_at: Date | null;
  p1_disconnected_at: Date | null;
  p2_disconnected_at: Date | null;
  ceiling_at: Date;
  created_at: Date;
  ended_at: Date | null;
};

const MATCH_COLUMNS = `id, status, seed, p1_profile_id, p2_profile_id, p1_deck, p2_deck,
  catalog_version, turn_deadline_at, prompt_deadline_at, p1_disconnected_at, p2_disconnected_at,
  ceiling_at, created_at, ended_at`;

function toMatch(row: MatchDbRow): MatchRow {
  const p2 = row.p2_profile_id;
  if (p2 === null) {
    // Only an `open` room reaches this, and `matches.get`/`live` filter those out before here.
    throw new Error(`match ${row.id} has no second player; it is still an open room`);
  }
  const status: MatchStatus = row.status === "over" ? "finished" : "live";
  return {
    id: row.id,
    seed: row.seed,
    players: [row.p1_profile_id, p2],
    decks: [cardListOf(row.p1_deck), cardListOf(row.p2_deck)],
    catalogVersion: row.catalog_version,
    status,
    createdAt: msOf(row.created_at),
    finishedAt: msOrNull(row.ended_at),
    clocks: {
      turnDeadline: msOrNull(row.turn_deadline_at),
      promptDeadline: msOrNull(row.prompt_deadline_at),
      // See KNOWN DIVERGENCES (clocks): these two columns carry the per-player grace DEADLINE.
      graceDeadline: {
        p1: msOrNull(row.p1_disconnected_at),
        p2: msOrNull(row.p2_disconnected_at),
      },
      ceilingAt: msOf(row.ceiling_at),
    },
  };
}

/**
 * `public.matches` holds one `grace_deadline_at` plus `p1_disconnected_at` / `p2_disconnected_at`,
 * while `MatchClocks` (ports.ts) holds a deadline per player and no disconnect instant. The two
 * per-player columns therefore carry the deadline, and `grace_deadline_at` — the column migration
 * 0004 documents as "the grace countdown ... so both clients show it" — carries the nearer of the
 * two, so a SQL reader still finds the grace deadline where the migration says it is.
 */
function nearestGrace(clocks: MatchClocks): number | null {
  const both = [clocks.graceDeadline.p1, clocks.graceDeadline.p2].filter(
    (value): value is number => value !== null,
  );
  return both.length === 0 ? null : Math.min(...both);
}

type TicketRow = {
  id: string;
  profile_id: string;
  rating: number;
  frozen_deck: unknown;
  catalog_version: string;
  status: string;
  enqueued_at: Date;
  match_id: string | null;
};

const TICKET_COLUMNS = `id, profile_id, rating, frozen_deck, catalog_version, status, enqueued_at, match_id`;

/** `tickets.status` is queued/claimed/cancelled; the port calls the same three open/matched/cancelled. */
function toTicketStatus(value: string): TicketStatus {
  if (value === "queued") return "open";
  if (value === "claimed") return "matched";
  if (value === "cancelled") return "cancelled";
  throw new Error(`tickets.status holds an unknown value: ${value}`);
}

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    profileId: row.profile_id,
    rating: row.rating,
    deck: cardListOf(row.frozen_deck),
    catalogVersion: row.catalog_version,
    enqueuedAt: msOf(row.enqueued_at),
    status: toTicketStatus(row.status),
    matchId: row.match_id,
  };
}

type ResultDbRow = {
  match_id: string;
  p1_profile_id: string;
  p2_profile_id: string;
  winner_profile_id: string | null;
  reason: string;
  turns: number;
  p1_rating_before: number;
  p1_rating_after: number;
  p2_rating_before: number;
  p2_rating_after: number;
  ended_at: Date;
};

function toResult(row: ResultDbRow): ResultRow {
  return {
    matchId: row.match_id,
    players: [row.p1_profile_id, row.p2_profile_id],
    winnerProfileId: row.winner_profile_id,
    // `results_reason_check` in migration 0004 pins this column to exactly the seven
    // `GameOverReason` strings of packages/shared, so the cast restates a database constraint.
    reason: row.reason as ResultRow["reason"],
    turns: row.turns,
    endedAt: msOf(row.ended_at),
    ratingBefore: [row.p1_rating_before, row.p2_rating_before],
    ratingAfter: [row.p1_rating_after, row.p2_rating_after],
  };
}

type RoomRow = {
  id: string;
  room_code: string;
  p1_profile_id: string;
  p2_profile_id: string | null;
  p1_deck: unknown;
  catalog_version: string;
  created_at: Date;
  ceiling_at: Date;
};

const ROOM_COLUMNS = `id, room_code, p1_profile_id, p2_profile_id, p1_deck, catalog_version, created_at, ceiling_at`;

function toRoom(row: RoomRow): Room {
  return {
    code: row.room_code,
    hostProfileId: row.p1_profile_id,
    hostDeck: cardListOf(row.p1_deck),
    catalogVersion: row.catalog_version,
    createdAt: msOf(row.created_at),
    // See KNOWN DIVERGENCES (rooms): an unclaimed room keeps its joinable-until instant in
    // `ceiling_at`, the one column migration 0004 documents as meaningless while `status = 'open'`.
    expiresAt: msOf(row.ceiling_at),
    guestProfileId: row.p2_profile_id,
    // A room's match id IS the row id, and it is only meaningful once a guest has claimed it.
    matchId: row.p2_profile_id === null ? null : row.id,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type PostgresStoreOptions = {
  /** A direct Postgres connection string (`DATABASE_URL`; SPEC §9.2's Postgres edge). */
  connectionString: string;
  /** Maximum pooled connections. Small by default: every call is one short transaction. */
  max?: number;
  /**
   * Called when the pool reports an error on an **idle** client, which is normal operation against
   * a pooler that closes idle connections. Optional: the handler below is attached either way,
   * because its job is to keep Node from re-throwing an unhandled 'error' event and killing the
   * process. This is only how a caller gets to log it -- `src/index.ts` passes its `Logger`.
   */
  onError?: (error: Error) => void;
};

export type PostgresStore = Store & {
  /** Closes the pool. Nothing in `src/index.ts` calls it; tests and a graceful shutdown do. */
  close: () => Promise<void>;
  /**
   * `Store.redeem` under the name `test/db/postgres.spec.ts` drives it by, kept because that suite
   * is about `app.redeem_invite_code` specifically rather than about the port. It is the same
   * function; `codeHash` is narrowed to `string` because a spec that means "no such code" says so
   * with a hash that matches nothing.
   */
  redeemInviteCode: (input: {
    profileId: string;
    codeHash: string;
    ipHash: string;
  }) => Promise<RedeemResult>;
};

/**
 * Exactly the strings `app.redeem_invite_code` returns (migration 0001 §6) — defined by the port,
 * because both stores answer with them, and re-exported here since this module's own name for the
 * SQL function's return type is what `test/db/postgres.spec.ts` reads.
 */
export type { RedeemResult };

/** Anything else out of the function is a schema this store was not built against. */
const REDEEM_RESULTS: readonly RedeemResult[] = [
  "ok",
  "not_pending",
  "email_unverified",
  "rate_limited_profile",
  "rate_limited_ip",
  "circuit_open",
  "invalid_code",
];

function toRedeemResult(value: unknown): RedeemResult {
  if (typeof value === "string" && (REDEEM_RESULTS as readonly string[]).includes(value)) {
    return value as RedeemResult;
  }
  throw new Error(
    `app.redeem_invite_code returned ${JSON.stringify(value)}, which is not one of ` +
      `${REDEEM_RESULTS.join(", ")} (migration 0001 §6)`,
  );
}

/**
 * A `Store` over `pg`. `src/index.ts` calls this with `{ connectionString: env.DATABASE_URL }`.
 *
 * The connection string is checked here rather than on first use so that a misconfigured
 * deployment fails at boot with a sentence naming the variable, and so that end-to-end mode's
 * `DATABASE_URL=memory://e2e-fixture-store` placeholder can never be mistaken for a database.
 */
export function createPostgresStore(options: PostgresStoreOptions): PostgresStore {
  assertPostgresUrl(options.connectionString);
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    // Supabase's Supavisor closes a client that has been idle on its side, and `pg` does not know
    // until it tries to use it — which surfaces as `read ETIMEDOUT` on a request that did nothing
    // wrong. Recycling an idle client after 10 s means the pool retires connections before the
    // pooler does, so a checkout is far more likely to hand back a live socket.
    idleTimeoutMillis: 10_000,
    // TCP keepalive, so a connection that is merely quiet is not dropped by something in between.
    keepAlive: true,
    // Fail a checkout that cannot get a connection rather than hanging the request forever.
    connectionTimeoutMillis: 10_000,
  });

  // An idle client in the pool can be closed by the *server* at any time -- Supabase's Supavisor
  // does it on its own idle timeout, and any network blip does it too. `pg` reports that as an
  // `error` event on the Pool. Node's rule for EventEmitter is that an 'error' event with no
  // listener is re-thrown, so without this handler a routine idle disconnect takes the whole
  // process down: measured against the Supabase session pooler as "Error: Connection terminated
  // unexpectedly ... Emitted 'error' event on Client instance", exit 1, mid-session.
  //
  // Swallowing it is correct rather than merely convenient: `pg` has already removed the broken
  // client from the pool by the time this fires, the next checkout opens a fresh connection, and
  // no query is lost -- a query that was in flight rejects at its own call site, which is where
  // the caller can do something about it. What must not happen is the server dying.
  pool.on("error", (error: Error) => {
    options.onError?.(error);
  });

  const store = buildStore(poolSession(pool)) as PostgresStore;

  store.close = async () => {
    await pool.end();
  };

  store.redeemInviteCode = store.redeem;

  return store;
}

/** `createStore` and `postgresStore` are the other two names `src/index.ts` looks for. */
export const createStore = createPostgresStore;
export const postgresStore = createPostgresStore;

function assertPostgresUrl(connectionString: string): void {
  const ok = /^postgres(ql)?:\/\//i.test(connectionString.trim());
  if (!ok) {
    throw new Error(
      `DATABASE_URL must be a Postgres connection string (postgres://... or postgresql://...), ` +
        `got ${JSON.stringify(connectionString.slice(0, 16))}…. ` +
        `The in-memory store of src/api/e2e-store.ts is reachable only with E2E=1.`,
    );
  }
}

function buildStore(session: Session): Store {
  const store = {} as Store;

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  /**
   * ports.ts: "`tx` runs `fn` against a handle scoped to one database transaction and rolls back
   * if `fn` throws. Nested `tx` joins the enclosing transaction."
   *
   * This is what makes SPEC §9.4's "Redemption is one server-side transaction", its "writes
   * `collection` and `collection_grants` in one transaction" and "writes all three decks in one
   * transaction or nothing" true of the port calls `src/api/**` makes: every statement those
   * callbacks issue lands on the one client below, between one `begin` and one `commit`.
   */
  store.tx = async <T>(fn: (t: Store) => Promise<T>): Promise<T> => {
    const pool = session.pool;
    if (session.joined || pool === null) return fn(store);
    const client = await pool.connect();
    try {
      await beginSession(client, null);
      const result = await fn(buildStore(joinedSession(client)));
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  // -------------------------------------------------------------------------
  // Redemption (SPEC §9.4) — rule 1 of this file's header, at its clearest: the whole six-step
  // transaction is one `app.*` call and the SQL stays the authority.
  // -------------------------------------------------------------------------

  /**
   * ports.ts, `Store.redeem`: SPEC §9.4's redemption, whole. `app.redeem_invite_code` (migration
   * 0001 §6) holds all six steps under one profile row lock and one code row lock, never raises
   * for an expected rejection, and returns one of seven strings — which is why the port's result
   * type is those strings and nothing friendlier.
   *
   * `session.query` wraps this in a transaction and stamps the subject like every other method
   * here; inside `Store.tx` it joins the enclosing one instead, so a caller that has already
   * opened a transaction gets the function's work committed with theirs rather than beside it.
   *
   * A `null` `codeHash` is passed through as SQL NULL on purpose: `where code_hash = null` matches
   * no row, so a code that could never exist is refused by the same lookup that refuses one that
   * was simply never minted — after the attempt has been logged, which is what ports.ts asks for.
   */
  store.redeem = async ({ profileId, codeHash, ipHash }) => {
    const { rows } = await session.query<{ redeem_invite_code: string }>(
      profileId,
      "select app.redeem_invite_code($1::uuid, $2::text, $3::text)",
      [profileId, codeHash, ipHash],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("app.redeem_invite_code returned no row");
    return toRedeemResult(row.redeem_invite_code);
  };

  // -------------------------------------------------------------------------
  // Profiles (SPEC §9.4)
  // -------------------------------------------------------------------------

  store.profiles = {
    getById: async (profileId) => {
      const { rows } = await session.query<ProfileRow>(
        profileId,
        `select ${PROFILE_COLUMNS} ${PROFILE_FROM} where p.id = $1::uuid`,
        [profileId],
      );
      const row = rows[0];
      return row === undefined ? null : toProfile(row);
    },

    // The same lookup as `getById`: migration 0001 keys `profiles.id` to `auth.users(id)`, so the
    // managed-auth user id and the profile id are one value (see `toProfile`).
    getByUserId: async (userId) => {
      const { rows } = await session.query<ProfileRow>(
        userId,
        `select ${PROFILE_COLUMNS} ${PROFILE_FROM} where p.id = $1::uuid`,
        [userId],
      );
      const row = rows[0];
      return row === undefined ? null : toProfile(row);
    },

    getMany: async (profileIds) => {
      if (profileIds.length === 0) return [];
      const { rows } = await session.query<ProfileRow>(
        null,
        `select ${PROFILE_COLUMNS} ${PROFILE_FROM} where p.id = any($1::uuid[])`,
        [[...profileIds]],
      );
      return rows.map(toProfile);
    },

    /**
     * §9.4: "the account exists the moment auth says so and stays pending until a code is
     * redeemed" (`resolveCaller` in http.ts). In a real Supabase project migration 0001's
     * `on_auth_user_created` trigger has usually made this row already, in which case
     * `getByUserId` finds it and this is never called; the insert is the path for a project whose
     * trigger has not run (a user created before the migration, say).
     *
     * `email` is accepted and ignored: `public.profiles` has no email column — §9.4's managed auth
     * provider owns it on `auth.users`, which is where every read here takes it from. The insert
     * fails with a foreign-key violation if that user does not exist, which is the honest answer:
     * a profile without a managed-auth identity is not a thing this schema can hold.
     */
    create: async ({ userId, rating, at }) =>
      session.run(userId, async (q) => {
        await q(
          `insert into public.profiles (id, status, rating, created_at)
           values ($1::uuid, 'pending', $2::int, ${ts("$3")})`,
          [userId, rating, at],
        );
        const { rows } = await q<ProfileRow>(
          `select ${PROFILE_COLUMNS} ${PROFILE_FROM} where p.id = $1::uuid`,
          [userId],
        );
        const row = rows[0];
        if (row === undefined) throw new Error(`profiles.create wrote no row for ${userId}`);
        return toProfile(row);
      }),

    /**
     * R111 rides on this write. Migration 0002 attaches `profiles_grant_launch_collection` to the
     * `pending -> active` transition, so becoming active grants one copy of every non-token card
     * in the current catalog version through `app.grant_cards` — both ledger tables, one
     * transaction, idempotent. Nothing here grants anything: the trigger is the implementation,
     * exactly as `e2e-store.ts` says it is ("R111 IS A DATABASE TRIGGER").
     */
    setStatus: async (profileId, status) => {
      const { rowCount } = await session.query(
        profileId,
        `update public.profiles set status = $2::text where id = $1::uuid`,
        [profileId, status],
      );
      if (affected(rowCount) === 0) throw new Error(`no profile ${profileId}`);
    },

    setRating: async (profileId, rating) => {
      const { rowCount } = await session.query(
        profileId,
        `update public.profiles set rating = $2::int where id = $1::uuid`,
        [profileId, rating],
      );
      if (affected(rowCount) === 0) throw new Error(`no profile ${profileId}`);
    },

    // §9.5: set when a match starts and cleared by every ending.
    setInMatch: async (profileId, matchId) => {
      const { rowCount } = await session.query(
        profileId,
        `update public.profiles set current_match_id = $2::uuid where id = $1::uuid`,
        [profileId, matchId],
      );
      if (affected(rowCount) === 0) throw new Error(`no profile ${profileId}`);
    },
  };

  // -------------------------------------------------------------------------
  // Invite codes (SPEC §9.4)
  // -------------------------------------------------------------------------

  store.codes = {
    insert: async (code: InviteCode) => {
      await session.query(
        null,
        `insert into public.invite_codes (id, code_hash, max_uses, uses, expires_at, revoked_at, created_at)
         values ($1::uuid, $2::text, $3::int, $4::int,
                 case when $5::double precision is null then null else ${ts("$5")} end,
                 case when $6::boolean then now() else null end,
                 ${ts("$7")})`,
        [code.id, code.codeHash, code.maxUses, code.uses, code.expiresAt, code.revoked, code.createdAt],
      );
    },

    findByHash: async (codeHash) => {
      const { rows } = await session.query<{
        id: string;
        code_hash: string;
        max_uses: number;
        uses: number;
        revoked_at: Date | null;
        expires_at: Date | null;
        created_at: Date;
      }>(
        null,
        `select id, code_hash, max_uses, uses, revoked_at, expires_at, created_at
           from public.invite_codes where code_hash = $1::text`,
        [codeHash],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        codeHash: row.code_hash,
        maxUses: row.max_uses,
        uses: row.uses,
        revoked: row.revoked_at !== null,
        expiresAt: msOrNull(row.expires_at),
        createdAt: msOf(row.created_at),
      };
    },

    /**
     * §9.4 step 6, "one atomic statement": the guard is in the `where`, so the increment and the
     * checks cannot be separated by a concurrent caller. `invite_codes.uses` also carries
     * `check (uses >= 0 and uses <= max_uses)`, so even a bug here cannot over-consume a code.
     */
    claim: async (codeId, now) => {
      const { rowCount } = await session.query(
        null,
        `update public.invite_codes
            set uses = uses + 1
          where id = $1::uuid
            and revoked_at is null
            and (expires_at is null or expires_at > ${ts("$2")})
            and uses < max_uses`,
        [codeId, now],
      );
      return affected(rowCount) === 1;
    },

    // §9.4 step 4: "log the attempt either way". `CodeAttempt.reason` has no column in
    // `public.code_attempts` — see KNOWN DIVERGENCES (attempt reason).
    logAttempt: async (attempt: CodeAttempt) => {
      await session.query(
        attempt.profileId,
        `insert into public.code_attempts (profile_id, ip_hash, succeeded, at)
         values ($1::uuid, $2::text, $3::boolean, ${ts("$4")})`,
        [attempt.profileId, attempt.ipHash, attempt.result === "ok", attempt.at],
      );
    },

    countAttemptsByProfile: async (profileId, since) => {
      const { rows } = await session.query<{ n: number }>(
        profileId,
        `select count(*)::int as n from public.code_attempts
          where profile_id = $1::uuid and at >= ${ts("$2")}`,
        [profileId, since],
      );
      return intOf(rows[0]?.n ?? 0);
    },

    countAttemptsByIp: async (ipHash, since) => {
      const { rows } = await session.query<{ n: number }>(
        null,
        `select count(*)::int as n from public.code_attempts
          where ip_hash = $1::text and at >= ${ts("$2")}`,
        [ipHash, since],
      );
      return intOf(rows[0]?.n ?? 0);
    },

    countFailures: async (since) => {
      const { rows } = await session.query<{ n: number }>(
        null,
        `select count(*)::int as n from public.code_attempts
          where succeeded = false and at >= ${ts("$1")}`,
        [since],
      );
      return intOf(rows[0]?.n ?? 0);
    },
  };

  // -------------------------------------------------------------------------
  // Collection (SPEC §9.4's entitlement ledger)
  // -------------------------------------------------------------------------

  store.collection = {
    get: async (profileId) => {
      const { rows } = await session.query<{ card_id: string; quantity: number }>(
        profileId,
        `select card_id, quantity from public.collection where profile_id = $1::uuid order by card_id`,
        [profileId],
      );
      return rows.map((row) => ({ cardId: row.card_id, quantity: row.quantity }));
    },

    /**
     * ports.ts is explicit, and it is the opposite of `app.grant_cards`: "SETS each card's quantity
     * to the absolute value given; it does not add to it ... a Postgres adapter must
     * `set quantity = excluded.quantity`, never `quantity + excluded`." `grantCards` in
     * `src/api/collection.ts` has already read the current total inside this transaction and added
     * its delta, so adding again here would double every grant.
     *
     * That is why this pair does not call `app.grant_cards`, which takes deltas and writes both
     * tables itself: the port splits the ledger's two writes and puts them in one `Store.tx`
     * instead, which is the same §9.4 guarantee reached the other way round.
     */
    upsertQuantities: async (profileId, entries: readonly CollectionEntry[]) => {
      if (entries.length === 0) return;
      await session.query(
        profileId,
        `insert into public.collection (profile_id, card_id, quantity, updated_at)
         select $1::uuid, entry.card_id, entry.quantity, now()
           from jsonb_to_recordset($2::jsonb) as entry(card_id text, quantity int)
         on conflict (profile_id, card_id)
         do update set quantity = excluded.quantity, updated_at = now()`,
        [profileId, json(entries.map((e) => ({ card_id: e.cardId, quantity: e.quantity })))],
      );
    },

    /** Append-only (§9.4); `collection_grants` carries `check (delta <> 0)` and a deny trigger. */
    appendGrants: async (grants: readonly CollectionGrant[]) => {
      if (grants.length === 0) return;
      await session.query(
        grants[0]?.profileId ?? null,
        `insert into public.collection_grants (profile_id, card_id, delta, reason, at)
         select g.profile_id::uuid, g.card_id, g.delta, g.reason, ${ts("g.at")}
           from jsonb_to_recordset($1::jsonb)
             as g(profile_id text, card_id text, delta int, reason text, at double precision)`,
        [
          json(
            grants.map((g) => ({
              profile_id: g.profileId,
              card_id: g.cardId,
              delta: g.delta,
              reason: g.reason,
              at: g.at,
            })),
          ),
        ],
      );
    },
  };

  // -------------------------------------------------------------------------
  // Loadouts (SPEC §9.4 L1-L6)
  // -------------------------------------------------------------------------

  store.loadouts = {
    /**
     * `app.resolve_deck` (migration 0003) is the same function the queue ticket freezes, so a deck
     * read here and a deck frozen into a ticket can never be two different lists. It raises when a
     * slot is empty, which for a profile with no loadout at all is the `null` this returns.
     */
    get: async (profileId) =>
      session.run(profileId, async (q) => {
        const { rows } = await q<{ catalog_version: string; updated_at: Date }>(
          `select catalog_version, updated_at from public.loadouts where profile_id = $1::uuid`,
          [profileId],
        );
        const head = rows[0];
        if (head === undefined) return null;

        const decks = await q<{ slot: number; cards: unknown }>(
          `select ld.slot, app.resolve_deck($1::uuid, ld.slot) as cards
             from public.loadout_decks ld where ld.profile_id = $1::uuid order by ld.slot`,
          [profileId],
        );
        const loadout: StoredLoadout = {
          catalogVersion: head.catalog_version,
          decks: decks.rows.map((row) => cardListOf(row.cards)),
          updatedAt: msOf(head.updated_at),
        };
        return loadout;
      }),

    /**
     * §9.4: "writes all three decks in one transaction or nothing; there is no per-deck save."
     * That transaction is `app.save_loadout`, which re-checks L1, L2, L3, L5 and L6 against the
     * database, delete-then-inserts all three decks, and leaves L4 to the `loadout_card_unique`
     * index. Nothing is re-derived here.
     *
     * Deck names: `loadout_decks.name` is `not null` and the port carries no name, so the slots are
     * named positionally. See KNOWN DIVERGENCES (deck names, deck order).
     */
    replace: async (profileId, catalogVersion, decks, _at) => {
      const payload = decks.map((deck, index) => ({
        name: `Deck ${String(index + 1)}`,
        cards: countCards(deck),
      }));
      await session.query(
        profileId,
        `select app.save_loadout($1::uuid, $2::text, $3::jsonb)`,
        [profileId, catalogVersion, json(payload)],
      );
    },
  };

  // -------------------------------------------------------------------------
  // Matches (SPEC §9.3's log, §9.5's lifecycle)
  // -------------------------------------------------------------------------

  store.matches = {
    /**
     * Writes the match row for both entry points §9.5 has — a paired queue match and a claimed
     * room — which is why it is an insert OR a completion rather than only an insert.
     *
     * `public.matches` is one table for both: a room is a row with `status = 'open'` and no second
     * player, and `rooms.claim` / `tickets.claimPair` below have already written that row under the
     * id the caller minted (they must: `tickets.match_id` and `profiles.current_match_id` are
     * foreign keys into this table, and both are written before the actor starts). So this method
     * finds one of two states under `id`:
     *
     *  - nothing      -> insert the live match;
     *  - an `open` row -> fill in the seed, the decks, the clocks and flip it `live`;
     *  - anything else -> the id is taken, which ports.ts and `e2e-store.ts` both make an error.
     *
     * The `for update` is what makes the read-then-write safe against a second caller.
     */
    create: async (match: MatchRow) =>
      session.run(match.players[0], async (q) => {
        const existing = await q<{ status: string }>(
          `select status from public.matches where id = $1::uuid for update`,
          [match.id],
        );
        const status = existing.rows[0]?.status;
        if (status !== undefined && status !== "open") {
          throw new Error(`matches.id is unique: ${match.id}`);
        }

        const params = [
          match.id,
          match.status === "finished" ? "over" : "live",
          match.seed,
          match.players[0],
          match.players[1],
          json(match.decks[0]),
          json(match.decks[1]),
          match.catalogVersion,
          match.clocks.turnDeadline,
          match.clocks.promptDeadline,
          match.clocks.graceDeadline.p1,
          match.clocks.graceDeadline.p2,
          nearestGrace(match.clocks),
          match.clocks.ceilingAt,
          match.createdAt,
          match.finishedAt,
        ];
        const values = `
          $2::text, $3::text, $4::uuid, $5::uuid, $6::jsonb, $7::jsonb, $8::text,
          ${nullableTs("$9")}, ${nullableTs("$10")}, ${nullableTs("$11")}, ${nullableTs("$12")},
          ${nullableTs("$13")}, ${ts("$14")}, ${ts("$15")}, ${nullableTs("$16")}`;

        if (status === undefined) {
          await q(
            `insert into public.matches (
               id, status, seed, p1_profile_id, p2_profile_id, p1_deck, p2_deck, catalog_version,
               turn_deadline_at, prompt_deadline_at, p1_disconnected_at, p2_disconnected_at,
               grace_deadline_at, ceiling_at, created_at, ended_at, started_at, last_seq)
             values ($1::uuid, ${values}, ${ts("$15")}, 0)`,
            params,
          );
          return;
        }

        await q(
          `update public.matches set
             status = $2::text, seed = $3::text, p1_profile_id = $4::uuid, p2_profile_id = $5::uuid,
             p1_deck = $6::jsonb, p2_deck = $7::jsonb, catalog_version = $8::text,
             turn_deadline_at = ${nullableTs("$9")}, prompt_deadline_at = ${nullableTs("$10")},
             p1_disconnected_at = ${nullableTs("$11")}, p2_disconnected_at = ${nullableTs("$12")},
             grace_deadline_at = ${nullableTs("$13")}, ceiling_at = ${ts("$14")},
             created_at = ${ts("$15")}, ended_at = ${nullableTs("$16")}, started_at = ${ts("$15")}
           where id = $1::uuid`,
          params,
        );
      }),

    get: async (matchId) => {
      const { rows } = await session.query<MatchDbRow>(
        null,
        `select ${MATCH_COLUMNS} from public.matches
          where id = $1::uuid and status in ('live', 'over')`,
        [matchId],
      );
      const row = rows[0];
      return row === undefined ? null : toMatch(row);
    },

    /**
     * §9.3's append-only log, written by `app.append_match_action` (migration 0004) and by nothing
     * else: it assigns `seq` from `matches.last_seq` under a row lock and returns the original
     * `seq` for a repeated nonce, which is BUILD M6-T4's "a reused nonce returns the original ack".
     *
     * The port hands in the `seq` the actor already used, so the two must agree: a mismatch means
     * the log and the actor have diverged (a replayed nonce, a gap, a second writer), and it is
     * raised rather than swallowed — ports.ts: "Rejects a seq that already exists."
     */
    appendActions: async (rows: readonly MatchActionRow[]) =>
      session.run(null, async (q) => {
        for (const row of rows) {
          const action = row.action as Action;
          const seat = action.playerId;
          const { rows: out } = await q<{ seq: string }>(
            `select app.append_match_action(
               $1::uuid,
               $2::text,
               (select case $2::text when 'p1' then m.p1_profile_id when 'p2' then m.p2_profile_id end
                  from public.matches m where m.id = $1::uuid),
               $3::text,
               $4::jsonb)::text as seq`,
            [row.matchId, seat, action.nonce, json(row.action)],
          );
          const assigned = intOf(out[0]?.seq ?? "0");
          // The throw happens INSIDE the transaction the function's own insert ran in, so the
          // rollback takes that insert with it. A store that wrote the row and then complained
          // would be worse than one that refused.
          if (assigned !== row.seq) {
            throw new Error(
              `match_actions is append-only: seq ${String(row.seq)} exists ` +
                `(app.append_match_action assigned ${String(assigned)} for nonce ${action.nonce})`,
            );
          }
        }
      }),

    actions: async (matchId) => {
      const { rows } = await session.query<{ seq: string; action: unknown; at: Date }>(
        null,
        `select seq::text, action, at from public.match_actions
          where match_id = $1::uuid order by seq`,
        [matchId],
      );
      return rows.map((row) => ({
        matchId,
        seq: intOf(row.seq),
        action: row.action as Action,
        at: msOf(row.at),
      }));
    },

    setClocks: async (matchId, clocks) => {
      const { rowCount } = await session.query(
        null,
        `update public.matches set
           turn_deadline_at = ${nullableTs("$2")}, prompt_deadline_at = ${nullableTs("$3")},
           p1_disconnected_at = ${nullableTs("$4")}, p2_disconnected_at = ${nullableTs("$5")},
           grace_deadline_at = ${nullableTs("$6")}, ceiling_at = ${ts("$7")}
         where id = $1::uuid`,
        [
          matchId,
          clocks.turnDeadline,
          clocks.promptDeadline,
          clocks.graceDeadline.p1,
          clocks.graceDeadline.p2,
          nearestGrace(clocks),
          clocks.ceilingAt,
        ],
      );
      if (affected(rowCount) === 0) throw new Error(`no match ${matchId}`);
    },

    /**
     * Not `app.end_match`. That function ends a match AND writes the results row AND moves both
     * ratings AND clears both `current_match_id`s AND cancels stray tickets — every one of which
     * `src/api/results.ts` already does through `results.insert`, `profiles.setRating`,
     * `profiles.setInMatch` and `tickets.cancel`, inside one `Store.tx` that this call joins. So
     * the ending is still one transaction with the same five writes; calling `app.end_match` here
     * would do the other four a second time. See the report.
     */
    finish: async (matchId, at) =>
      session.run(null, async (q) => {
        const { rowCount } = await q(
          `update public.matches set status = 'over', ended_at = ${ts("$2")}
            where id = $1::uuid and status <> 'over'`,
          [matchId, at],
        );
        if (affected(rowCount) === 0) {
          // Already over is a no-op (§9.5: the actor and the reaper can both reach an ending);
          // a match that was never there is an error, as it is in `e2e-store.ts`.
          const { rows } = await q<{ id: string }>(
            `select id from public.matches where id = $1::uuid`,
            [matchId],
          );
          if (rows.length === 0) throw new Error(`no match ${matchId}`);
        }
      }),

    /** §9.5's crash recovery and the reaper's input, straight from `app.live_matches()`. */
    live: async () => {
      const { rows } = await session.query<MatchDbRow>(null, `select ${MATCH_COLUMNS} from app.live_matches()`);
      return rows.filter((row) => row.p2_profile_id !== null).map(toMatch);
    },
  };

  // -------------------------------------------------------------------------
  // Rooms (SPEC §9.5's direct challenge)
  // -------------------------------------------------------------------------

  store.rooms = {
    /**
     * A room is a `public.matches` row with `status = 'open'`, which is what migrations 0004's
     * `app.create_room` / `app.join_room` make it; there is no `rooms` table and this file may not
     * add one (the migrations are append-only and checksum-locked).
     *
     * `app.create_room` is not called for two reasons: it mints the match id itself while the port
     * has `rooms.claim` receive an id the server minted, and it sets the host's
     * `current_match_id` while `src/match/rooms.ts` sets both players' only after the claim (§9.5
     * "not in a match" would otherwise refuse the host their own room). Everything else it does is
     * done here, including `matches_room_code_open_key` — the partial unique index is inferred in
     * the `on conflict` clause, so a taken code returns `false` instead of raising, which is the
     * port's contract.
     */
    create: async (room: Room) => {
      const { rowCount } = await session.query(
        room.hostProfileId,
        `insert into public.matches (
           room_code, status, seed, p1_profile_id, p1_deck, catalog_version, ceiling_at, created_at)
         values ($1::text, 'open', '', $2::uuid, $3::jsonb, $4::text, ${ts("$5")}, ${ts("$6")})
         on conflict (room_code) where room_code is not null and status <> 'over' do nothing`,
        [room.code, room.hostProfileId, json(room.hostDeck), room.catalogVersion, room.expiresAt, room.createdAt],
      );
      return affected(rowCount) === 1;
    },

    get: async (code) => {
      const { rows } = await session.query<RoomRow>(
        null,
        `select ${ROOM_COLUMNS} from public.matches
          where room_code = $1::text and status <> 'over'`,
        [code],
      );
      const row = rows[0];
      return row === undefined ? null : toRoom(row);
    },

    /**
     * §9.5's atomic single-claim, as one statement: the loser of a join race updates no row and
     * gets `null`. The row keeps `status = 'open'` until `matches.create` completes it, so a
     * half-claimed room is never visible to `matches.get`, `matches.live` or the reaper.
     *
     * `id = $3` is the one place this file rewrites a primary key. It is deliberate: the port mints
     * the match id at join time, `matches.create` will be called with it moments later, and a room
     * that is not yet a match has nothing pointing at it — no actions, no result, no ticket, and
     * `src/match/rooms.ts` sets `current_match_id` only after this call returns. Renaming the row
     * is what keeps "a room is the match it becomes" true of the schema.
     */
    claim: async (code, guestProfileId, matchId, at) => {
      const { rows } = await session.query<RoomRow>(
        guestProfileId,
        `update public.matches
            set id = $3::uuid, p2_profile_id = $2::uuid
          where room_code = $1::text
            and status = 'open'
            and p2_profile_id is null
            and ceiling_at > ${ts("$4")}
        returning ${ROOM_COLUMNS}`,
        [code, guestProfileId, matchId, at],
      );
      const row = rows[0];
      return row === undefined ? null : toRoom(row);
    },
  };

  // -------------------------------------------------------------------------
  // Tickets (SPEC §9.5's ranked queue)
  // -------------------------------------------------------------------------

  store.tickets = {
    /**
     * `tickets_profile_queued_key` (migration 0004) is the race-proof half of §9.5's "not already
     * queued", and `src/api/queue.ts` relies on the insert RAISING for the second one — it catches
     * the error and re-reads the open ticket. So this is a plain insert with no `on conflict`.
     *
     * `tickets.slot` is `not null`: see KNOWN DIVERGENCES (ticket slot).
     */
    insert: async (ticket: Ticket) => {
      await session.query(
        ticket.profileId,
        `insert into public.tickets
           (id, profile_id, slot, rating, frozen_deck, catalog_version, status, enqueued_at, match_id)
         values ($1::uuid, $2::uuid, 1, $3::int, $4::jsonb, $5::text, $6::text, ${ts("$7")}, $8::uuid)`,
        [
          ticket.id,
          ticket.profileId,
          ticket.rating,
          json(ticket.deck),
          ticket.catalogVersion,
          fromTicketStatus(ticket.status),
          ticket.enqueuedAt,
          ticket.matchId,
        ],
      );
    },

    get: async (ticketId) => {
      const { rows } = await session.query<TicketRow>(
        null,
        `select ${TICKET_COLUMNS} from public.tickets where id = $1::uuid`,
        [ticketId],
      );
      const row = rows[0];
      return row === undefined ? null : toTicket(row);
    },

    openForProfile: async (profileId) => {
      const { rows } = await session.query<TicketRow>(
        profileId,
        `select ${TICKET_COLUMNS} from public.tickets
          where profile_id = $1::uuid and status = 'queued'`,
        [profileId],
      );
      const row = rows[0];
      return row === undefined ? null : toTicket(row);
    },

    listOpen: async () => {
      const { rows } = await session.query<TicketRow>(
        null,
        `select ${TICKET_COLUMNS} from public.tickets where status = 'queued' order by enqueued_at, id`,
      );
      return rows.map(toTicket);
    },

    countOpen: async () => {
      const { rows } = await session.query<{ n: number }>(
        null,
        `select count(*)::int as n from public.tickets where status = 'queued'`,
      );
      return intOf(rows[0]?.n ?? 0);
    },

    /**
     * §9.5: "both tickets are claimed in one atomic statement." That statement is
     * `app.claim_ticket_pair` (migration 0004), which returns true only when it moved exactly two
     * still-queued rows, so two matchers racing over one ticket cannot both win.
     *
     * It is called with a NULL match id and the link is written immediately after, inside the same
     * transaction, because `tickets.match_id` is a foreign key into `public.matches` and the match
     * does not exist yet — `src/api/queue.ts` claims first and creates the match second. The skeleton
     * row written here is the `open` row `matches.create` then completes (see its comment); it
     * carries the two frozen decks the tickets already hold, so nothing is invented.
     */
    claimPair: async (aId, bId, matchId, at) => {
      if (aId === bId) return false;
      return session.run(null, async (q) => {
        const claimed = await q<{ claimed: boolean }>(
          `select app.claim_ticket_pair($1::uuid, $2::uuid, null) as claimed`,
          [aId, bId],
        );
        if (claimed.rows[0]?.claimed !== true) return false;

        await q(
          `insert into public.matches (
             id, status, seed, p1_profile_id, p2_profile_id, p1_deck, p2_deck, catalog_version,
             ceiling_at, created_at)
           select $3::uuid, 'open', '', a.profile_id, b.profile_id, a.frozen_deck, b.frozen_deck,
                  a.catalog_version, ${ts("$4")}, ${ts("$4")}
             from public.tickets a, public.tickets b
            where a.id = $1::uuid and b.id = $2::uuid`,
          [aId, bId, matchId, at],
        );
        await q(`update public.tickets set match_id = $3::uuid where id in ($1::uuid, $2::uuid)`, [
          aId,
          bId,
          matchId,
        ]);
        return true;
      });
    },

    cancel: async (ticketId, _at) => {
      await session.query(
        null,
        `update public.tickets set status = 'cancelled' where id = $1::uuid and status = 'queued'`,
        [ticketId],
      );
    },
  };

  // -------------------------------------------------------------------------
  // Results (SPEC §2.5, §9.5)
  // -------------------------------------------------------------------------

  store.results = {
    /** One row per match: `results.match_id` is the primary key, so a second insert raises. */
    insert: async (row: ResultRow) => {
      await session.query(
        null,
        `insert into public.results (
           match_id, p1_profile_id, p2_profile_id, winner_profile_id, reason, turns,
           p1_rating_before, p1_rating_after, p2_rating_before, p2_rating_after, ended_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::int,
                 $7::int, $8::int, $9::int, $10::int, ${ts("$11")})`,
        [
          row.matchId,
          row.players[0],
          row.players[1],
          row.winnerProfileId,
          row.reason,
          row.turns,
          row.ratingBefore[0],
          row.ratingAfter[0],
          row.ratingBefore[1],
          row.ratingAfter[1],
          row.endedAt,
        ],
      );
    },

    getByMatch: async (matchId) => {
      const { rows } = await session.query<ResultDbRow>(
        null,
        `select match_id, p1_profile_id, p2_profile_id, winner_profile_id, reason, turns,
                p1_rating_before, p1_rating_after, p2_rating_before, p2_rating_after, ended_at
           from public.results where match_id = $1::uuid`,
        [matchId],
      );
      const row = rows[0];
      return row === undefined ? null : toResult(row);
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** `pg` types `rowCount` as `number | null`; every DML statement here sets it. */
function affected(rowCount: number | null): number {
  return rowCount ?? 0;
}

/** `to_timestamp` of a nullable epoch-ms parameter, which SQL cannot express inline. */
function nullableTs(param: string): string {
  return `case when ${param}::double precision is null then null else ${ts(param)} end`;
}

function fromTicketStatus(status: TicketStatus): string {
  if (status === "open") return "queued";
  if (status === "matched") return "claimed";
  return "cancelled";
}

/**
 * `["a", "a", "b"] -> [{card_id: "a", count: 2}, {card_id: "b", count: 1}]`, the shape
 * `app.save_loadout` takes. With `MAX_COPIES = 1` every count is 1 today; the grouping is here so
 * a future `MAX_COPIES > 1` needs no change, exactly as `app.resolve_deck` expands counts on the
 * way back out.
 */
function countCards(deck: readonly string[]): { card_id: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const cardId of deck) counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  return [...counts].map(([cardId, count]) => ({ card_id: cardId, count }));
}

// =============================================================================
// KNOWN DIVERGENCES from `src/api/e2e-store.ts`
//
// Every one of these is a place where the port and the schema (which this file may not change:
// the migrations are append-only and checksum-locked) do not hold the same information. They are
// listed here, asserted in `test/db/contract.ts` where they are observable, and repeated in the
// report that came with this file.
//
//  * redemption limits. §9.4's "more than 5 attempts", "more than 20" and "the last hour" are
//    written into `app.redeem_invite_code`'s body, and the breaker's knobs into `app.settings`;
//    the migrations are checksum-locked, so neither can be made to read `ApiLimits`. The in-memory
//    stores take all three as options defaulting to the same `src/config.ts` constants
//    `defaultLimits()` copies into `ApiLimits`, so the two agree at today's values and a test can
//    shrink them on the fake path only. Changing a number for a real deployment means
//    `app.settings` and a new migration, not `src/config.ts`.
//  * attempt reason. `CodeAttempt.reason` ("a coarse reason for operators") has no column in
//    `public.code_attempts`, which stores only `succeeded`. It is dropped on write, so a store
//    round-trip cannot return it. Nothing reads it back today (`CodeStore` has no attempt read),
//    and `Store.redeem` returns a result code rather than a reason for the same reason: the
//    granularity the fake can record is granularity Postgres cannot.
//  * redemption's email check. `app.redeem_invite_code` reads `auth.users.email_confirmed_at`
//    itself; the in-memory stores have no such table and answer through
//    `RedemptionSettings.emailVerified`, true unless a caller says otherwise. The server refuses an
//    unverified caller from the access token (R159) before either store is reached, so this only
//    shows up in a test that calls the port directly — which `test/db/contract.ts` does.
//  * redemption's circuit breaker. The SQL function refuses when `app.settings.redemption_enabled`
//    is false OR when its own count of recent failures crosses R106's threshold. The in-memory
//    stores implement the switch and not the counter, because the server's own R106 breaker
//    (`src/api/codes.ts`) is checked before the store is touched, holds the same numbers and is
//    what alerts — a fake that counted as well would open during BUILD M6-T1's 150-sample timing
//    test, whose whole point is 150 uninterrupted failures.
//  * profile email. `public.profiles` has no email column — §9.4's managed auth provider owns it
//    on `auth.users` — so `Profile.email` is read from there (`service_role` needs SELECT on
//    `auth.users`, which Supabase grants) and the `email` argument to `profiles.create` is ignored.
//    `create` also requires the `auth.users` row to exist, because `profiles.id` references it;
//    `e2e-store.ts` has no such requirement.
//  * foreign keys. `results.match_id`, `tickets.match_id` and `profiles.current_match_id` all
//    reference `public.matches`, so a result or an in-match pointer for a match that was never
//    created raises here and is accepted by `e2e-store.ts`. Every caller in `src/api/**` writes the
//    match first, so this only shows up in a test that skipped it.
//  * deck order. `loadout_deck_cards` stores (card_id, count) with no ordering, and
//    `app.resolve_deck` returns the deck ordered by card id. A deck saved in one order comes back
//    sorted. §9.3's seeded shuffle is what randomises draw order, so only the SET matters — but a
//    contract assertion has to compare decks as multisets, not as lists.
//  * deck names. `loadout_decks.name` is `not null` and the port has no name, so slots are saved as
//    "Deck 1".."Deck 3".
//  * loadout strictness. `app.save_loadout` enforces L1, L2, L3, L5 and L6 and requires an active
//    profile and the current catalog version; `e2e-store.ts` enforces only L4. The real store is
//    strictly stricter, which is §9.4's "defense in depth" by design.
//  * launch grant. Migration 0002's trigger grants every NON-TOKEN card of the current catalog
//    version; `e2e-store.ts` also skips BANNED ids (§9.4 L6). With no banned card in the catalog
//    the two agree exactly; with one, the database grants a card the fake does not.
//  * action timestamps. `app.append_match_action` stamps `at` with the database clock and
//    `match_actions` is append-only, so `MatchActionRow.at` cannot be written by the caller. The
//    log's order (`seq`) is unaffected, and nothing reads `at` back except a replay tool.
//  * ticket slot. `tickets.slot` is `not null check (slot between 1 and 3)` and `Ticket` carries no
//    deck index — the frozen deck travels instead — so every ticket is written with slot 1.
//  * rooms. There is no `rooms` table: a room is a `public.matches` row with `status = 'open'`, and
//    `Room.expiresAt` is kept in `ceiling_at`, the column migration 0004 documents as meaningless
//    while a room is open. `rooms.claim` rewrites the row's id to the match id the server minted.
//  * clocks. `MatchClocks` has a grace deadline per player; `public.matches` has one
//    `grace_deadline_at` plus two `*_disconnected_at`. The per-player deadlines are stored in the
//    two `*_disconnected_at` columns and `grace_deadline_at` keeps the nearer of them. A migration
//    adding `p1_grace_deadline_at` / `p2_grace_deadline_at` would retire this.
// =============================================================================

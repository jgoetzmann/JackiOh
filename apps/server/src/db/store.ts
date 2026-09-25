/**
 * The production `Store` (SPEC §9.2's `API functions -> Postgres` edge), implemented over the
 * migrations in `./migrations` (0001-0009) with the `pg` driver already in `apps/server/package.json`.
 *
 * `src/index.ts` finds this module by dynamic import and calls `createPostgresStore({
 * connectionString })`; until it existed the server threw `StoreUnavailableError` and could only
 * boot in `E2E=1` mode against the in-memory fixture in `src/api/e2e-store.ts`.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES THIS FILE LIVES BY
 * ---------------------------------------------------------------------------
 *
 * 1. CALL THE `app.*` FUNCTIONS, DO NOT RE-DERIVE THEM. The migrations put the rules SPEC §9.4/§9.5
 *    call "one transaction", "one atomic statement" and "append-only" inside SECURITY DEFINER
 *    functions. Wherever the port's shape admits it, a method here is one call to one of them —
 *    `app.upsert_deck`, `app.upsert_trio`, `app.append_match_action`, `app.claim_ticket_pair`,
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
  FrozenTrio,
  InviteCode,
  MatchActionRow,
  MatchClocks,
  MatchRow,
  MatchStatus,
  Profile,
  ProfileStatus,
  QueueMode,
  RedeemResult,
  ResultRow,
  Room,
  SavedDeck,
  SavedTrio,
  SeriesEnd,
  SeriesGame,
  SeriesRow,
  SeriesSeat,
  SeriesStatus,
  Store,
  Ticket,
  TicketStatus,
  TrioUpsertOutcome,
  UpsertOutcome,
} from "../api/ports";
import type { Action } from "@jackioh/shared";

// ---------------------------------------------------------------------------
// The role the server acts as
// ---------------------------------------------------------------------------

/**
 * Migration 0001 §8, and the same closing note in 0002-0009: `service_role` is the role the API
 * server and the match actor hold. It is the only role granted EXECUTE on `app.redeem_invite_code`,
 * `app.upsert_deck`, `app.append_match_action`, `app.claim_ticket_pair` and the rest, so running
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
 * RLS policy in 0002-0007 is `profile_id = app.current_profile_id()`, and `app.profile_is_active()`
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

/**
 * A frozen trio (R259) as `tickets.frozen_trio`, `matches.room_trio` and the series state hold it.
 * Migration 0008's shape checks guarantee three decks on the two columns; the rest is read back as
 * this file wrote it, and checked just far enough that a row from some other writer fails here, by
 * name, rather than as an `undefined` deep inside a series transition.
 */
function frozenTrioOf(value: unknown): FrozenTrio {
  if (typeof value !== "object" || value === null) throw new Error("expected a frozen trio object");
  const trio = value as { name?: unknown; decks?: unknown };
  if (!Array.isArray(trio.decks)) throw new Error("expected a frozen trio's decks array");
  const [first, second, third, ...rest] = trio.decks.map((deck: unknown) => {
    const entry = (deck ?? {}) as { name?: unknown; cards?: unknown };
    return { name: textOf(entry.name), cards: cardListOf(entry.cards) };
  });
  if (first === undefined || second === undefined || third === undefined || rest.length > 0) {
    throw new Error("expected a frozen trio of exactly three decks");
  }
  return { name: textOf(trio.name), decks: [first, second, third] };
}

function trioOrNull(value: unknown): FrozenTrio | null {
  return value === null || value === undefined ? null : frozenTrioOf(value);
}

/** `tickets.mode` and `matches.room_mode` both carry `check (... in ('bo1', 'bo3', 'random'))`. */
function queueModeOf(value: unknown): QueueMode {
  if (value === "bo1" || value === "bo3" || value === "random") return value;
  throw new Error(`expected a queue mode, got ${JSON.stringify(value)}`);
}

/**
 * The id columns are `uuid`, and Postgres answers a malformed one with an error (22P02), not with
 * "no such row". A lookup whose id came from outside — `GET /api/matches/:matchId/series` reads
 * `series.withGame` with whatever the path held — answers here, as the in-memory stores do, with
 * the nothing that such an id names.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
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

/**
 * Checks a client out of the pool with an `error` listener attached, and returns a `release` that
 * destroys the connection when it broke.
 *
 * `pool.on("error")` in `createPostgresStore` only covers an IDLE client. A CHECKED-OUT one emits
 * `error` on ITSELF, and Node re-throws an 'error' event that has no listener, so a connection
 * dying mid-transaction took the whole process down: measured against the Supabase pooler as
 * `Error: read ETIMEDOUT ... Emitted 'error' event on Client instance`, dead with a request in
 * flight. Both checkout sites need it — `poolSession` for a single statement and `store.tx` for a
 * multi-statement transaction — and `store.tx` is the one that matters most, since matchmaking's
 * `startPairedMatch` runs there and is the most concurrent code in the server.
 *
 * The listener does not swallow the failure: the in-flight query rejects on its own and that
 * rejection is what the caller reports. `release(err)` is how `pg` is told to discard a client
 * rather than hand a poisoned connection to the next caller.
 */
async function checkout(pool: Pool): Promise<{ client: PoolClient; release: () => void }> {
  const client = await pool.connect();
  let fatal: Error | undefined;
  const onError = (error: Error): void => {
    fatal = error;
  };
  client.on("error", onError);
  return {
    client,
    release: () => {
      client.removeListener("error", onError);
      client.release(fatal);
    },
  };
}

/** The top-level session: every call is its own transaction, opened and closed here. */
function poolSession(pool: Pool): Session {
  return withQuery({
    joined: false,
    pool,
    run: async <T>(subject: string | null, body: (q: Query) => Promise<T>): Promise<T> => {
      const { client, release } = await checkout(pool);
      try {
        await beginSession(client, subject);
        const result = await body(boundQuery(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        release();
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
  mode: string;
  frozen_deck: unknown;
  frozen_trio: unknown;
  catalog_version: string;
  status: string;
  enqueued_at: Date;
  match_id: string | null;
};

const TICKET_COLUMNS = `id, profile_id, rating, mode, frozen_deck, frozen_trio, catalog_version, status,
  enqueued_at, match_id`;

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
    mode: queueModeOf(row.mode),
    deck: cardListOf(row.frozen_deck),
    trio: trioOrNull(row.frozen_trio),
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
  room_mode: string | null;
  room_trio: unknown;
  p1_profile_id: string;
  p2_profile_id: string | null;
  p1_deck: unknown;
  catalog_version: string;
  created_at: Date;
  ceiling_at: Date;
};

const ROOM_COLUMNS = `id, room_code, room_mode, room_trio, p1_profile_id, p2_profile_id, p1_deck,
  catalog_version, created_at, ceiling_at`;

function toRoom(row: RoomRow): Room {
  return {
    code: row.room_code,
    hostProfileId: row.p1_profile_id,
    // R264. A room written before migration 0008, or by 0004's `app.create_room`, has no mode; it
    // could only ever have been a Best-of-1 room. See KNOWN DIVERGENCES (rooms).
    mode: row.room_mode === null ? "bo1" : queueModeOf(row.room_mode),
    hostDeck: cardListOf(row.p1_deck),
    hostTrio: trioOrNull(row.room_trio),
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

type DeckRow = {
  id: string;
  profile_id: string;
  name: string;
  cards: unknown;
  catalog_version: string;
  created_at: Date;
  updated_at: Date;
};

const DECK_COLUMNS = `id, profile_id, name, cards, catalog_version, created_at, updated_at`;

function toDeck(row: DeckRow): SavedDeck {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    // A jsonb array keeps the order it was written in, so this is the player's order (R250).
    cards: cardListOf(row.cards),
    catalogVersion: row.catalog_version,
    createdAt: msOf(row.created_at),
    updatedAt: msOf(row.updated_at),
  };
}

type TrioRow = {
  id: string;
  profile_id: string;
  name: string;
  deck1_id: string | null;
  deck2_id: string | null;
  deck3_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const TRIO_COLUMNS = `id, profile_id, name, deck1_id, deck2_id, deck3_id, created_at, updated_at`;

function toTrio(row: TrioRow): SavedTrio {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    deckIds: [row.deck1_id, row.deck2_id, row.deck3_id],
    createdAt: msOf(row.created_at),
    updatedAt: msOf(row.updated_at),
  };
}

/** Exactly what `app.upsert_deck` returns (migration 0007); anything else is a schema this was not built against. */
const UPSERT_OUTCOMES: readonly UpsertOutcome[] = ["created", "updated", "limit", "not_owner"];
const TRIO_UPSERT_OUTCOMES: readonly TrioUpsertOutcome[] = [...UPSERT_OUTCOMES, "unknown_deck"];

function upsertOutcomeOf<T extends string>(fn: string, allowed: readonly T[], value: unknown): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `${fn} returned ${JSON.stringify(value)}, which is not one of ${allowed.join(", ")} (migration 0007)`,
  );
}

/**
 * `public.series` (migration 0009) keeps as columns what is queried or constrained — the two
 * players, the status, the next match id, the pick deadline, the version, the winner and the
 * timestamps — and everything a series only ever reads back whole in `state`. The players live in
 * the columns alone, so `state.sides` carries each side minus its `profileId` and the two cannot
 * drift apart.
 */
type SeriesState = {
  sides: [SeriesSideState, SeriesSideState];
  games: SeriesGame[];
  seedBase: string;
  endReason: SeriesEnd | null;
  ratingBefore: [number, number] | null;
  ratingAfter: [number, number] | null;
};

type SeriesSideState = { trio: FrozenTrio; wins: number; pick: number | null };

type SeriesDbRow = {
  id: string;
  p1_profile_id: string;
  p2_profile_id: string;
  status: string;
  next_match_id: string;
  pick_deadline_at: Date | null;
  version: number;
  catalog_version: string;
  winner: string | null;
  state: unknown;
  created_at: Date;
  updated_at: Date;
  ended_at: Date | null;
};

const SERIES_COLUMNS = `id, p1_profile_id, p2_profile_id, status, next_match_id, pick_deadline_at, version,
  catalog_version, winner, state, created_at, updated_at, ended_at`;

function seriesStateOf(row: SeriesRow): SeriesState {
  const side = (index: 0 | 1): SeriesSideState => {
    const { trio, wins, pick } = row.sides[index];
    return { trio, wins, pick };
  };
  return {
    sides: [side(0), side(1)],
    games: row.games,
    seedBase: row.seedBase,
    endReason: row.endReason,
    ratingBefore: row.ratingBefore,
    ratingAfter: row.ratingAfter,
  };
}

/** `series_status_check` (0009). */
function seriesStatusOf(value: string): SeriesStatus {
  if (value === "picking" || value === "playing" || value === "over") return value;
  throw new Error(`series.status holds an unknown value: ${value}`);
}

/** `series_winner_check` (0009). */
function seriesWinnerOf(value: string | null): SeriesSeat | "draw" | null {
  if (value === null || value === "p1" || value === "p2" || value === "draw") return value;
  throw new Error(`series.winner holds an unknown value: ${value}`);
}

function toSeries(row: SeriesDbRow): SeriesRow {
  const state = row.state as Partial<SeriesState> | null;
  const [first, second, ...rest] = Array.isArray(state?.sides) ? state.sides : [];
  if (
    state === null ||
    first === undefined ||
    second === undefined ||
    rest.length > 0 ||
    !Array.isArray(state.games)
  ) {
    throw new Error(`series ${row.id} has a state this store did not write`);
  }
  return {
    id: row.id,
    sides: [
      { profileId: row.p1_profile_id, trio: frozenTrioOf(first.trio), wins: first.wins, pick: first.pick },
      { profileId: row.p2_profile_id, trio: frozenTrioOf(second.trio), wins: second.wins, pick: second.pick },
    ],
    catalogVersion: row.catalog_version,
    seedBase: textOf(state.seedBase),
    status: seriesStatusOf(row.status),
    games: state.games,
    nextMatchId: row.next_match_id,
    pickDeadline: msOrNull(row.pick_deadline_at),
    winner: seriesWinnerOf(row.winner),
    endReason: state.endReason ?? null,
    ratingBefore: state.ratingBefore ?? null,
    ratingAfter: state.ratingAfter ?? null,
    createdAt: msOf(row.created_at),
    updatedAt: msOf(row.updated_at),
    endedAt: msOrNull(row.ended_at),
    version: row.version,
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
   * This is what makes SPEC §9.4's "Redemption is one server-side transaction" and its "writes
   * `collection` and `collection_grants` in one transaction", and R263's "a game's result, the
   * series' record of it and, when the game ends the series, the rating move commit in one
   * transaction", true of the port calls `src/api/**` makes: every statement those callbacks issue
   * lands on the one client below, between one `begin` and one `commit`.
   */
  store.tx = async <T>(fn: (t: Store) => Promise<T>): Promise<T> => {
    const pool = session.pool;
    if (session.joined || pool === null) return fn(store);
    const { client, release } = await checkout(pool);
    try {
      await beginSession(client, null);
      const result = await fn(buildStore(joinedSession(client)));
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      release();
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

    oldestAttemptAtByProfile: async (profileId, since) => {
      const { rows } = await session.query<{ at: unknown }>(
        profileId,
        `select min(at) as at from public.code_attempts
          where profile_id = $1::uuid and at >= ${ts("$2")}`,
        [profileId, since],
      );
      return msOrNull(rows[0]?.at);
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
  // Saved decks (SPEC §9.4, R250, R256)
  //
  // Migration 0007. The loadout tables of 0003 are no longer read or written (R254): the migration
  // turned each loadout into three of these decks and one trio.
  // -------------------------------------------------------------------------

  store.decks = {
    /** Oldest first, ties on id: the order R257's legacy `deckIndex` counts in. */
    list: async (profileId) => {
      const { rows } = await session.query<DeckRow>(
        profileId,
        `select ${DECK_COLUMNS} from public.decks where profile_id = $1::uuid order by created_at, id`,
        [profileId],
      );
      return rows.map(toDeck);
    },

    get: async (deckId) => {
      if (!isUuid(deckId)) return null;
      const { rows } = await session.query<DeckRow>(
        null,
        `select ${DECK_COLUMNS} from public.decks where id = $1::uuid`,
        [deckId],
      );
      const row = rows[0];
      return row === undefined ? null : toDeck(row);
    },

    /**
     * R250, R256: one call to `app.upsert_deck`, which takes the profile row lock, re-checks the
     * draft's shape (D1, D2, D4), refuses another profile's id and counts the cap under the lock,
     * then inserts or updates. Its answer is the port's `UpsertOutcome` verbatim.
     *
     * The function takes one instant, `p_at`: `updated_at` always, and `created_at` when the row is
     * new. It is handed `updatedAt`, which is the save being made; see KNOWN DIVERGENCES (deck and
     * trio timestamps). The cap passed is the caller's, and the function applies the smaller of it
     * and `app.settings.max_saved_decks` (KNOWN DIVERGENCES, caps).
     */
    upsert: async (deck, maxDecks) => {
      const { rows } = await session.query<{ outcome: unknown }>(
        deck.profileId,
        `select app.upsert_deck($1::uuid, $2::uuid, $3::text, $4::jsonb, $5::text, ${ts("$6")}, $7::int)
           as outcome`,
        [deck.profileId, deck.id, deck.name, json(deck.cards), deck.catalogVersion, deck.updatedAt, maxDecks],
      );
      return upsertOutcomeOf("app.upsert_deck", UPSERT_OUTCOMES, rows[0]?.outcome);
    },

    /**
     * Not an `app.*` function: a delete of the profile's own row is one statement with nothing to
     * decide, and R252's "deleting a deck empties every slot that named it" is the database's own
     * behaviour — the three `on delete set null (deckN_id)` foreign keys on `public.trios` empty the
     * slots in this same statement.
     */
    remove: async (profileId, deckId) => {
      if (!isUuid(deckId)) return false;
      const { rowCount } = await session.query(
        profileId,
        `delete from public.decks where id = $1::uuid and profile_id = $2::uuid`,
        [deckId, profileId],
      );
      return affected(rowCount) === 1;
    },
  };

  // -------------------------------------------------------------------------
  // Saved trios (SPEC §9.4, R252, R256)
  // -------------------------------------------------------------------------

  store.trios = {
    list: async (profileId) => {
      const { rows } = await session.query<TrioRow>(
        profileId,
        `select ${TRIO_COLUMNS} from public.trios where profile_id = $1::uuid order by created_at, id`,
        [profileId],
      );
      return rows.map(toTrio);
    },

    get: async (trioId) => {
      if (!isUuid(trioId)) return null;
      const { rows } = await session.query<TrioRow>(
        null,
        `select ${TRIO_COLUMNS} from public.trios where id = $1::uuid`,
        [trioId],
      );
      const row = rows[0];
      return row === undefined ? null : toTrio(row);
    },

    /**
     * R252, R256: one call to `app.upsert_trio`, as `decks.upsert`, plus `unknown_deck` for a slot
     * that is not one of this profile's decks. A deck in two slots raises `trios_decks_distinct`
     * (R252 T3), which the caller has already refused with `checkTrioDraft`, so it throws here as it
     * does in the in-memory stores.
     *
     * A slot holding something that is not a uuid cannot name any deck; it is answered here, as
     * `unknown_deck`, because Postgres would refuse the cast before the function could say so.
     */
    upsert: async (trio, maxTrios) => {
      if (trio.deckIds.some((deckId) => deckId !== null && !isUuid(deckId))) return "unknown_deck";
      const [deck1, deck2, deck3] = trio.deckIds;
      const { rows } = await session.query<{ outcome: unknown }>(
        trio.profileId,
        `select app.upsert_trio($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::uuid, ${ts("$7")},
                                $8::int) as outcome`,
        [trio.profileId, trio.id, trio.name, deck1, deck2, deck3, trio.updatedAt, maxTrios],
      );
      return upsertOutcomeOf("app.upsert_trio", TRIO_UPSERT_OUTCOMES, rows[0]?.outcome);
    },

    /** As `decks.remove`: the profile's own row, one statement. */
    remove: async (profileId, trioId) => {
      if (!isUuid(trioId)) return false;
      const { rowCount } = await session.query(
        profileId,
        `delete from public.trios where id = $1::uuid and profile_id = $2::uuid`,
        [trioId, profileId],
      );
      return affected(rowCount) === 1;
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

    /**
     * R263: "A series that ends before its first game releases the id it reserved." In this schema
     * a reserved id is a row — the `open` skeleton `tickets.claimPair` writes, or a room
     * `rooms.claim` renamed to it — so releasing it is deleting that row, and only while it is still
     * `open`: the `status` guard is what makes this a no-op on a live or finished match however it
     * is called.
     *
     * Nothing is left pointing at the deleted id: an `open` row has no actions and no result (both
     * would cascade anyway), `tickets.match_id` and `profiles.current_match_id` are `on delete set
     * null` (0004), and `series.next_match_id` deliberately has no foreign key (0009). Deleting a
     * claimed room's row also frees its code at once (R110's partial unique index covers only the
     * rows that exist). See KNOWN DIVERGENCES (reserved match ids).
     */
    discardOpen: async (matchId) => {
      if (!isUuid(matchId)) return;
      await session.query(null, `delete from public.matches where id = $1::uuid and status = 'open'`, [
        matchId,
      ]);
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
     *
     * R264: the room's mode goes in `room_mode` and a Best-of-3 host's frozen trio in `room_trio`
     * (migration 0008); `p1_deck` holds the Best-of-1 deck, `[]` in the other two modes.
     */
    create: async (room: Room) => {
      const { rowCount } = await session.query(
        room.hostProfileId,
        `insert into public.matches (
           room_code, room_mode, room_trio, status, seed, p1_profile_id, p1_deck, catalog_version,
           ceiling_at, created_at)
         values ($1::text, $2::text, $3::jsonb, 'open', '', $4::uuid, $5::jsonb, $6::text,
                 ${ts("$7")}, ${ts("$8")})
         on conflict (room_code) where room_code is not null and status <> 'over' do nothing`,
        [
          room.code,
          room.mode,
          room.hostTrio === null ? null : json(room.hostTrio),
          room.hostProfileId,
          json(room.hostDeck),
          room.catalogVersion,
          room.expiresAt,
          room.createdAt,
        ],
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
     * R257, R259: the mode, and a Best-of-3 ticket's frozen trio (migration 0008, whose
     * `tickets_frozen_trio_check` holds "a trio exactly when the mode is bo3"). `slot` — 0004's
     * loadout slot — is left NULL: a ticket now freezes a saved deck or a trio, not a slot, and 0008
     * dropped the column's `not null` for exactly that.
     */
    insert: async (ticket: Ticket) => {
      await session.query(
        ticket.profileId,
        `insert into public.tickets
           (id, profile_id, rating, mode, frozen_deck, frozen_trio, catalog_version, status,
            enqueued_at, match_id)
         values ($1::uuid, $2::uuid, $3::int, $4::text, $5::jsonb, $6::jsonb, $7::text, $8::text,
                 ${ts("$9")}, $10::uuid)`,
        [
          ticket.id,
          ticket.profileId,
          ticket.rating,
          ticket.mode,
          json(ticket.deck),
          ticket.trio === null ? null : json(ticket.trio),
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

    /** R257: "the queue population is reported per mode". Every mode is present, at 0 if empty. */
    countOpenByMode: async () => {
      const { rows } = await session.query<{ mode: string; n: number }>(
        null,
        `select mode, count(*)::int as n from public.tickets where status = 'queued' group by mode`,
      );
      const counts: Record<QueueMode, number> = { bo1: 0, bo3: 0, random: 0 };
      for (const row of rows) counts[queueModeOf(row.mode)] = intOf(row.n);
      return counts;
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
    /**
     * A profile's finished-match record, counted in one pass over `results`.
     *
     * A draw is a row with no winner — §9.5 makes the ceiling, a mutual hero death and an
     * accepted draw all winnerless — so the three counts partition every finished match and no
     * separate "played" column can drift from them. The profile may sit on either side, hence
     * the `in (p1, p2)` rather than a join.
     */
    recordFor: async (profileId: string) => {
      const { rows } = await session.query<{ wins: string; losses: string; draws: string }>(
        profileId,
        `select
           count(*) filter (where winner_profile_id = $1::uuid)                         as wins,
           count(*) filter (where winner_profile_id is not null
                              and winner_profile_id <> $1::uuid)                        as losses,
           count(*) filter (where winner_profile_id is null)                            as draws
         from public.results
        where p1_profile_id = $1::uuid or p2_profile_id = $1::uuid`,
        [profileId],
      );
      const row = rows[0];
      return {
        wins: Number(row?.wins ?? 0),
        losses: Number(row?.losses ?? 0),
        draws: Number(row?.draws ?? 0),
      };
    },

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

  // -------------------------------------------------------------------------
  // The Best-of-3 series (SPEC §9.5, R259-R263)
  //
  // Migration 0009. None of these reaches an `app.*` function, because none has a rule to hold
  // that one statement does not already hold: `update` is compare-and-set in its `where`, the
  // lookups are single selects, and the transitions themselves are the server's pure functions
  // (`src/api/series-rules.ts`), written back whole.
  // -------------------------------------------------------------------------

  const seriesParams = (row: SeriesRow): unknown[] => [
    row.id,
    row.sides[0].profileId,
    row.sides[1].profileId,
    row.status,
    row.nextMatchId,
    row.pickDeadline,
    row.version,
    row.catalogVersion,
    row.winner,
    json(seriesStateOf(row)),
    row.createdAt,
    row.updatedAt,
    row.endedAt,
  ];

  store.series = {
    /** A second series with the same id raises (`series_pkey`), as the port requires. */
    create: async (row) => {
      await session.query(
        row.sides[0].profileId,
        `insert into public.series (
           id, p1_profile_id, p2_profile_id, status, next_match_id, pick_deadline_at, version,
           catalog_version, winner, state, created_at, updated_at, ended_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, ${nullableTs("$6")}, $7::int,
                 $8::text, $9::text, $10::jsonb, ${ts("$11")}, ${ts("$12")}, ${nullableTs("$13")})`,
        seriesParams(row),
      );
    },

    get: async (seriesId) => {
      if (!isUuid(seriesId)) return null;
      const { rows } = await session.query<SeriesDbRow>(
        null,
        `select ${SERIES_COLUMNS} from public.series where id = $1::uuid`,
        [seriesId],
      );
      const row = rows[0];
      return row === undefined ? null : toSeries(row);
    },

    /**
     * R263: "written only by compare-and-set on its version". The guard is the `where`: the row is
     * replaced only while it still holds the version this transition was computed from, so of two
     * writers that read the same version exactly one updates a row and the other gets `false`, re-
     * reads and re-applies. One statement, so there is no window between the check and the write.
     */
    update: async (next) => {
      const { rowCount } = await session.query(
        next.sides[0].profileId,
        `update public.series set
           p1_profile_id = $2::uuid, p2_profile_id = $3::uuid, status = $4::text,
           next_match_id = $5::uuid, pick_deadline_at = ${nullableTs("$6")}, version = $7::int,
           catalog_version = $8::text, winner = $9::text, state = $10::jsonb,
           created_at = ${ts("$11")}, updated_at = ${ts("$12")}, ended_at = ${nullableTs("$13")}
         where id = $1::uuid and version = $7::int - 1`,
        seriesParams(next),
      );
      return affected(rowCount) === 1;
    },

    /** The series whose game in play is this match: `series_next_match_id_key` (0009) makes it one. */
    byMatch: async (matchId) => {
      if (!isUuid(matchId)) return null;
      const { rows } = await session.query<SeriesDbRow>(
        null,
        `select ${SERIES_COLUMNS} from public.series
          where next_match_id = $1::uuid and status = 'playing'`,
        [matchId],
      );
      const row = rows[0];
      return row === undefined ? null : toSeries(row);
    },

    /**
     * Any game of any series, whatever its status: a jsonb containment test over `state -> 'games'`,
     * which `series_games_idx` (GIN, jsonb_path_ops, 0009) answers without a scan.
     */
    withGame: async (matchId) => {
      if (!isUuid(matchId)) return null;
      const { rows } = await session.query<SeriesDbRow>(
        null,
        `select ${SERIES_COLUMNS} from public.series
          where state -> 'games' @> $1::jsonb
          order by created_at, id
          limit 1`,
        [json([{ matchId }])],
      );
      const row = rows[0];
      return row === undefined ? null : toSeries(row);
    },

    activeFor: async (profileId) => {
      const { rows } = await session.query<SeriesDbRow>(
        profileId,
        `select ${SERIES_COLUMNS} from public.series
          where status <> 'over' and (p1_profile_id = $1::uuid or p2_profile_id = $1::uuid)
          order by created_at, id
          limit 1`,
        [profileId],
      );
      const row = rows[0];
      return row === undefined ? null : toSeries(row);
    },

    /** The sweeper's input (R263), oldest first, over `series_active_idx`. */
    active: async () => {
      const { rows } = await session.query<SeriesDbRow>(
        null,
        `select ${SERIES_COLUMNS} from public.series where status <> 'over' order by created_at, id`,
      );
      return rows.map(toSeries);
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
//    reference `public.matches`, and `decks`, `trios` and both sides of `series` reference
//    `public.profiles`, so a result or an in-match pointer for a match that was never created, or
//    a deck, a trio or a series for a profile that does not exist, raises here and is accepted by
//    `e2e-store.ts`. Every caller in `src/api/**` writes the match or has the profile first, so this
//    only shows up in a test that skipped it. `series.next_match_id` is the one match id with NO
//    foreign key, on purpose (R263: it is reserved before its match exists).
//  * deck and trio strictness. `app.upsert_deck` and `app.upsert_trio` (0007) refuse — by raising —
//    a profile that is not active, a blank name, a name past `deck_name_max_length` or holding a
//    control character (D1, T1), more than `deck_size` cards (D2), more than `max_copies` of one id
//    (D4) and a cards value that is not an array of strings; the in-memory stores check none of
//    these, because the server's `checkDeckDraft` / `checkTrioDraft` refuse them first with a
//    sentence a player reads. The real store is strictly stricter, which is §9.4's "defense in
//    depth" by design. D3 (a deckable card) is checked by neither store: see 0007.
//  * caps. The port passes the cap (`maxDecks`, `maxTrios`); the SQL applies the smaller of it and
//    `app.settings.max_saved_decks` / `max_saved_trios` (0007, mirroring `MAX_SAVED_DECKS` and
//    `MAX_SAVED_TRIOS`). Equal today. Raising a cap in `src/config.ts` alone raises it only in
//    memory; the database needs a migration updating its row, as for the redemption limits.
//  * deck and trio timestamps. `app.upsert_deck` / `app.upsert_trio` take one instant: `updated_at`
//    always, `created_at` too when the row is new, and this store hands them `updatedAt`. The fake
//    stores a new deck's `createdAt` as given. The two agree for any caller that stamps a new
//    deck's `createdAt` and `updatedAt` from one clock read, which is what a save is.
//  * R254's decks. A deck migration 0007 made from a loadout holds its cards in
//    `app.resolve_deck` order, which is card-id order: a loadout never had any other. Every deck
//    saved since keeps the order it was saved in.
//  * launch grant. Migration 0002's trigger grants every NON-TOKEN card of the current catalog
//    version; `e2e-store.ts` also skips BANNED ids (§9.4 L6). With no banned card in the catalog
//    the two agree exactly; with one, the database grants a card the fake does not.
//  * action timestamps. `app.append_match_action` stamps `at` with the database clock and
//    `match_actions` is append-only, so `MatchActionRow.at` cannot be written by the caller. The
//    log's order (`seq`) is unaffected, and nothing reads `at` back except a replay tool.
//  * rooms. There is no `rooms` table: a room is a `public.matches` row with `status = 'open'`, and
//    `Room.expiresAt` is kept in `ceiling_at`, the column migration 0004 documents as meaningless
//    while a room is open. `rooms.claim` rewrites the row's id to the match id the server minted.
//    `Room.mode` and `Room.hostTrio` are `room_mode` / `room_trio` (0008); a room row with no mode
//    — written before 0008, or by 0004's `app.create_room` — reads as `bo1`, which is all a room
//    could be then.
//  * reserved match ids. In Postgres the id `tickets.claimPair` or `rooms.claim` reserves is an
//    `open` row, so `matches.discardOpen` (R263) deletes a row: the claimed tickets' `matchId` goes
//    back to null (`tickets.match_id` is `on delete set null`) and a claimed room's code is free
//    again. `e2e-store.ts` keeps no such row, and its `discardOpen` changes nothing; there a
//    matched ticket keeps the discarded id.
//  * clocks. `MatchClocks` has a grace deadline per player; `public.matches` has one
//    `grace_deadline_at` plus two `*_disconnected_at`. The per-player deadlines are stored in the
//    two `*_disconnected_at` columns and `grace_deadline_at` keeps the nearer of them. A migration
//    adding `p1_grace_deadline_at` / `p2_grace_deadline_at` would retire this.
// =============================================================================

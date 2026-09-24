/**
 * The server's ports (SPEC §9.1, §9.2). Everything under `src/api` and `src/match` depends on
 * these interfaces and never on a database driver, an HTTP framework or a WebSocket library, so
 * the runtime can be hosted on Node, an edge worker or a Durable Object and tested in memory.
 *
 * Ownership: this file and the rest of `src/api` / `src/match` belong to the runtime agent.
 * `src/db/**`, `src/config.ts` and `src/env.ts` belong to the database agent: they implement
 * `Store` and supply `ServerConfig`, and nothing here imports them.
 */

import type { Action, CardDef, GameOverReason, PlayerId } from "@jackioh/shared";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export type Timer = { readonly cancel: () => void };

/**
 * The only clock in the server. The engine never reads time (SPEC §9.3): it arrives as action
 * data, and every deadline in `src/match/clock.ts` is scheduled through here so tests can drive
 * it with fake timers.
 */
export type Timers = {
  /** Epoch milliseconds. */
  now: () => number;
  after: (ms: number, fn: () => void) => Timer;
};

/** Timers backed by the host runtime. */
export const systemTimers: Timers = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

// ---------------------------------------------------------------------------
// Config (SPEC §9.5, R79) — values live in `src/config.ts`, which the db agent owns.
// This is the shape the runtime consumes; it never restates the numbers.
// ---------------------------------------------------------------------------

export type ServerConfig = {
  /**
   * R79: the active player's turn clock. Filled in from `TURN_CLOCK_SECONDS` and friends by
   * `defaultConfig()` in `src/api/deps.ts`, the one place that imports `src/config.ts`.
   */
  turnClockSeconds: number;
  /** R79: a prompt held by the non-active player runs its own clock. */
  promptClockSeconds: number;
  /** R79: grace before a disconnect becomes a loss. */
  disconnectGraceSeconds: number;
  /** R79: the hard wall-clock ceiling, which ends the match in a draw. */
  matchCeilingMinutes: number;
  /** R79: room-code length, from the invite-code alphabet. */
  roomCodeLength: number;
  /** R79: Elo K factor. */
  eloK: number;
  /** R79: starting rating. */
  eloStart: number;
};

/**
 * The §9.4 and §9.5 limits, as injected values rather than direct imports, so a test can shrink
 * the redemption floor and the queue windows without waiting on wall-clock seconds. Exactly one
 * place fills this in from `src/config.ts`: `defaultLimits()` in `src/api/deps.ts`.
 */
export type ApiLimits = {
  /**
   * §9.4 step 2: redemption attempts per profile per hour.
   *
   * ENFORCED BY THE STORE, NOT BY A HANDLER. §9.4's redemption is one transaction and
   * `Store.redeem` is it, so steps 2 and 3 run where steps 4-6 run — inside the database, under
   * the same lock. This is the deployment's copy of the number, from `src/config.ts`, which is
   * also where the in-memory stores take their default; `app.redeem_invite_code` writes §9.4's
   * `5` into its own body (see `src/db/store.ts`'s KNOWN DIVERGENCES, "redemption limits").
   */
  redeemPerProfilePerHour: number;
  /** §9.4 step 3: redemption attempts per IP hash per hour. Enforced by the store, as above. */
  redeemPerIpPerHour: number;
  /** The window both counters use. Enforced by the store, as above. */
  redeemWindowMs: number;
  /**
   * §9.4: "identical error in identical time" for missing, expired and exhausted codes. Every
   * redemption response is padded to this budget, so the three are indistinguishable.
   */
  redeemConstantMs: number;
  /** §9.4: the global circuit breaker trips when this many redemptions fail in its window. */
  breakerFailureThreshold: number;
  breakerWindowMs: number;
  /** How long the breaker stays open once tripped. */
  breakerCooldownMs: number;
  /** §9.5: the pairing window starts here. */
  queueWindowStart: number;
  /** §9.5: and widens by this much. */
  queueWindowStep: number;
  /** §9.5: every this many milliseconds. */
  queueWindowStepMs: number;
  /** §9.5: after this long the window is uncapped. */
  queueWindowUncappedAfterMs: number;
  /** §9.5: the sweeper's period. */
  queueSweepMs: number;
  /** How long an unclaimed room code stays joinable. */
  roomCodeTtlMs: number;
};

// ---------------------------------------------------------------------------
// Catalog (SPEC §9.4: static, versioned, shipped with the client)
// ---------------------------------------------------------------------------

export type CatalogInfo = {
  /** The version the client must match at save and at queue (§9.4). */
  version: string;
  defs: Readonly<Record<string, CardDef>>;
  cardIds: readonly string[];
  isToken: (cardId: string) => boolean;
  isBanned: (cardId: string) => boolean;
};

// ---------------------------------------------------------------------------
// Loadout validation (SPEC §9.4 L1–L6) — one module shared by client and server.
// The composition root adapts `@jackioh/validator` to this port; handlers never restate a rule.
// ---------------------------------------------------------------------------

export type LoadoutIssue = {
  /** "L1".."L6". */
  rule: string;
  message: string;
  /**
   * The deck the rule names, 1-based, exactly as `@jackioh/validator` reports it; absent on
   * loadout-wide failures (L1, L4, L5). §9.4: "a queue-time failure names the deck and the card".
   */
  deck?: number;
  cardId?: string;
};

export type LoadoutValidateInput = {
  decks: readonly (readonly string[])[];
  catalogVersion: string;
  catalog: CatalogInfo;
  /** cardId -> quantity owned, for L5. */
  owned: ReadonlyMap<string, number>;
};

export type LoadoutValidator = (input: LoadoutValidateInput) => LoadoutIssue[];

// ---------------------------------------------------------------------------
// Managed auth (SPEC §9.4: managed auth provider, email and password)
// ---------------------------------------------------------------------------

export type AuthUser = {
  /** The provider's user id (Supabase `auth.users.id`). */
  userId: string;
  email: string | null;
  emailVerified: boolean;
  /**
   * Provider-controlled claims only. Never read user-controlled metadata for an authorization
   * decision: in Supabase `user_metadata` is user-editable, `app_metadata` is not.
   */
  appMetadata: Readonly<Record<string, unknown>>;
};

export type AuthSession = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  user: AuthUser;
};

export type AuthProvider = {
  /** Verify a bearer token. Returns null for anything not currently valid. */
  verifyAccessToken: (token: string) => Promise<AuthUser | null>;
  signUp: (email: string, password: string) => Promise<AuthSession | { pendingEmailVerification: true; userId: string }>;
  signInWithPassword: (email: string, password: string) => Promise<AuthSession>;
};

// ---------------------------------------------------------------------------
// Hashing (SPEC §9.4: codes stored hashed; §9.8: per-IP-hash limits)
// ---------------------------------------------------------------------------

export type Hashes = {
  /** Deterministic keyed hash of a normalized invite code, for lookup by hash. */
  code: (plain: string) => string;
  /** Keyed hash of a client address; the raw address is never stored. */
  ip: (raw: string) => string;
};

// ---------------------------------------------------------------------------
// Store: the persistence port. `src/db/**` implements it against Postgres.
// Every method is domain-level, so column names stay inside the db package.
// ---------------------------------------------------------------------------

export type ProfileStatus = "pending" | "active" | "banned";

export type Profile = {
  id: string;
  /** The managed-auth user id. */
  userId: string;
  email: string;
  status: ProfileStatus;
  rating: number;
  /** Non-null while the profile is in a match (§9.5: every ending clears it). */
  inMatchId: string | null;
  createdAt: number;
};

export type ProfileStore = {
  getById: (profileId: string) => Promise<Profile | null>;
  getByUserId: (userId: string) => Promise<Profile | null>;
  getMany: (profileIds: readonly string[]) => Promise<Profile[]>;
  create: (input: { userId: string; email: string; rating: number; at: number }) => Promise<Profile>;
  setStatus: (profileId: string, status: ProfileStatus) => Promise<void>;
  setRating: (profileId: string, rating: number) => Promise<void>;
  /** Pass null to clear. §9.5: every terminal reason clears both players'. */
  setInMatch: (profileId: string, matchId: string | null) => Promise<void>;
};

export type InviteCode = {
  id: string;
  codeHash: string;
  maxUses: number;
  uses: number;
  revoked: boolean;
  /** Epoch ms, or null for "never expires". */
  expiresAt: number | null;
  createdAt: number;
};

export type CodeAttemptResult = "ok" | "rejected";

export type CodeAttempt = {
  profileId: string | null;
  ipHash: string;
  result: CodeAttemptResult;
  /** A coarse reason for operators; never returned to the client (§9.4). */
  reason: string;
  at: number;
};

/**
 * Exactly the strings `app.redeem_invite_code(uuid, text, text)` returns — migration 0001 §6 lists
 * them, and nothing else is a legal answer. The set is the SQL function's contract, so the port
 * states it rather than a shape that would be pleasanter in TypeScript:
 *
 *  - `not_pending` covers "no such profile", "banned" and "already active" together, because the
 *    function decides all three from one `select ... for update` and cannot tell a caller which.
 *    R145 requires those three to be reported *distinctly* to the client, so `codes.ts` decides
 *    them from the caller's own resolved profile before it calls here and treats this result as
 *    the race it is: the account stopped being pending between the two. R170 fixes what that race
 *    answers — a conflict, never a second 401 after authorization has already passed.
 *  - `email_unverified` is the function's own read of `auth.users.email_confirmed_at`, which
 *    `public.profiles` does not carry. The server already knows the answer from the access token
 *    (R159) and refuses first; this is the database's independent second opinion.
 *  - `circuit_open` is the *database-side* half of §9.4's breaker (`app.settings.redemption_enabled`
 *    plus the function's own failure count). It is not the same object as the server's R106
 *    breaker in `codes.ts`, which alerts, backs `GET /api/codes/status` and is checked before this
 *    port is touched at all. Both answer 503.
 *  - missing, revoked, expired and exhausted all collapse onto `invalid_code`, which is §9.4's
 *    "Missing, expired and exhausted codes return an identical error" at the storage layer as well
 *    as at the wire.
 */
export type RedeemResult =
  | "ok"
  | "not_pending"
  | "email_unverified"
  | "rate_limited_profile"
  | "rate_limited_ip"
  | "circuit_open"
  | "invalid_code";

export type RedeemInviteCodeInput = {
  profileId: string;
  /**
   * The keyed hash of the normalized code (`Hashes.code`); the store never sees plaintext.
   *
   * `null` means the caller has already established that this string could never be a code at all
   * — wrong length, or a character outside §9.4's alphabet (R104). It is passed down rather than
   * refused early because §9.4 orders the attempt log (step 4) *before* the lookup (step 5): a
   * malformed code must still cost the caller a row in `code_attempts`, or it would be the one
   * cheap probe in an interface built to make probing expensive. Both implementations answer
   * `invalid_code` for it, indistinguishably from a code that was simply never minted.
   */
  codeHash: string | null;
  ipHash: string;
};

export type CodeStore = {
  insert: (code: InviteCode) => Promise<void>;
  findByHash: (codeHash: string) => Promise<InviteCode | null>;
  /**
   * §9.4 step 6: one atomic statement. Increments `uses` only while the code is unrevoked,
   * unexpired and unexhausted; returns false otherwise. Two concurrent callers cannot both win
   * the last use.
   *
   * Redemption does not call this — `Store.redeem` is the whole transaction. It stays because the
   * in-memory stores build step 6 out of it and the contract suite drives it directly.
   */
  claim: (codeId: string, now: number) => Promise<boolean>;
  /** §9.4 step 4: the attempt is logged either way. Written by `Store.redeem`. */
  logAttempt: (attempt: CodeAttempt) => Promise<void>;
  countAttemptsByProfile: (profileId: string, since: number) => Promise<number>;
  /**
   * When this profile's oldest attempt at or after `since` was made (epoch ms), or null when it
   * made none. R192: `GET /api/codes/status` adds the window to it to say when an account that has
   * used up §9.4 step 2's tries gets one back.
   */
  oldestAttemptAtByProfile: (profileId: string, since: number) => Promise<number | null>;
  countAttemptsByIp: (ipHash: string, since: number) => Promise<number>;
  /** §9.4: the server-side circuit breaker's input — system-wide failures in a window (R106). */
  countFailures: (since: number) => Promise<number>;
};

export type CollectionEntry = { cardId: string; quantity: number };

export type CollectionGrant = {
  profileId: string;
  cardId: string;
  /**
   * The signed change this grant applied, not the resulting total — the db agent's
   * `collection_grants.delta` column, which is constrained `<> 0`. Named `delta` and not
   * `quantity` on purpose: `CollectionEntry.quantity` next door is an absolute total, and one
   * adapter reading the ledger as a total would double every grant.
   */
  delta: number;
  /** Constrained to a closed set in the schema: pack, craft, reward, refund, admin, launch. */
  reason: string;
  at: number;
};

/**
 * §9.4: the collection is an entitlement ledger. `upsertQuantities` and `appendGrants` are the
 * two writes every mutation makes, and callers must make them inside one `Store.tx`.
 */
export type CollectionStore = {
  get: (profileId: string) => Promise<CollectionEntry[]>;
  /**
   * SETS each card's quantity to the absolute value given; it does not add to it. The caller has
   * already read the current total inside the same transaction and computed the new one, so a
   * Postgres adapter must `set quantity = excluded.quantity`, never `quantity + excluded`.
   */
  upsertQuantities: (profileId: string, entries: readonly CollectionEntry[]) => Promise<void>;
  /** Append-only (§9.4). Each row's `delta` is the change, so the ledger sums to the total. */
  appendGrants: (grants: readonly CollectionGrant[]) => Promise<void>;
};

export type StoredLoadout = {
  catalogVersion: string;
  /** Exactly 3 decks of DECK_SIZE ids (§9.4 L1, L2). */
  decks: string[][];
  updatedAt: number;
};

export type LoadoutStore = {
  get: (profileId: string) => Promise<StoredLoadout | null>;
  /**
   * §9.4: writes all three decks or nothing. The db implementation runs inside one transaction
   * and relies on the unique index on `(profile_id, card_id)` for L4.
   */
  replace: (
    profileId: string,
    catalogVersion: string,
    decks: readonly (readonly string[])[],
    at: number,
  ) => Promise<void>;
};

export type MatchStatus = "live" | "finished";

export type MatchRow = {
  id: string;
  seed: string;
  /** Seat order: index 0 is p1, index 1 is p2. */
  players: [string, string];
  /** The decks frozen into the tickets or the room (§9.4, §9.5). */
  decks: [string[], string[]];
  catalogVersion: string;
  status: MatchStatus;
  createdAt: number;
  finishedAt: number | null;
  /** Deadlines the clients render (§9.5: the grace countdown is stored on the match). */
  clocks: MatchClocks;
};

export type MatchClocks = {
  /** Epoch ms the active player's turn clock expires, or null while it is paused. */
  turnDeadline: number | null;
  /** Epoch ms the open prompt's own clock expires (R79), or null. */
  promptDeadline: number | null;
  /** Per-player disconnect grace deadlines (§9.5). */
  graceDeadline: { p1: number | null; p2: number | null };
  /** Epoch ms the hard ceiling is reached (R79). */
  ceilingAt: number;
};

export type MatchActionRow = {
  matchId: string;
  /** 1-based, gapless, append-only. */
  seq: number;
  action: Action;
  at: number;
};

export type MatchStore = {
  create: (match: MatchRow) => Promise<void>;
  get: (matchId: string) => Promise<MatchRow | null>;
  /** Append-only (§9.3). Rejects a seq that already exists. */
  appendActions: (rows: readonly MatchActionRow[]) => Promise<void>;
  actions: (matchId: string) => Promise<MatchActionRow[]>;
  setClocks: (matchId: string, clocks: MatchClocks) => Promise<void>;
  finish: (matchId: string, at: number) => Promise<void>;
  /** For the reaper (§9.5). */
  live: () => Promise<MatchRow[]>;
};

export type Room = {
  code: string;
  hostProfileId: string;
  hostDeck: string[];
  catalogVersion: string;
  createdAt: number;
  expiresAt: number;
  /** Set once, atomically, by the first joiner. */
  guestProfileId: string | null;
  matchId: string | null;
};

export type RoomStore = {
  /** False when the code is already taken. */
  create: (room: Room) => Promise<boolean>;
  get: (code: string) => Promise<Room | null>;
  /**
   * Atomic single-claim: sets guest and match id only while the room is unclaimed and unexpired.
   * Returns the claimed room, or null when someone else got there first.
   */
  claim: (code: string, guestProfileId: string, matchId: string, at: number) => Promise<Room | null>;
};

export type TicketStatus = "open" | "matched" | "cancelled";

export type Ticket = {
  id: string;
  profileId: string;
  rating: number;
  /** §9.4, §9.5: the deck is frozen into the ticket; editing the loadout later cannot change it. */
  deck: string[];
  catalogVersion: string;
  enqueuedAt: number;
  status: TicketStatus;
  matchId: string | null;
};

export type TicketStore = {
  insert: (ticket: Ticket) => Promise<void>;
  get: (ticketId: string) => Promise<Ticket | null>;
  openForProfile: (profileId: string) => Promise<Ticket | null>;
  listOpen: () => Promise<Ticket[]>;
  countOpen: () => Promise<number>;
  /**
   * §9.5: "both tickets are claimed in one atomic statement". Returns false unless both were
   * still open, so two concurrent matchers cannot pair the same ticket twice.
   */
  claimPair: (aId: string, bId: string, matchId: string, at: number) => Promise<boolean>;
  cancel: (ticketId: string, at: number) => Promise<void>;
};

export type ResultRow = {
  matchId: string;
  /** Seat order, matching MatchRow.players. */
  players: [string, string];
  /** null for a draw (R79: the ceiling and an accepted draw are draws). */
  winnerProfileId: string | null;
  reason: GameOverReason;
  turns: number;
  endedAt: number;
  ratingBefore: [number, number];
  ratingAfter: [number, number];
};

/**
 * A profile's finished-match record, counted from `results`.
 *
 * A draw is a row with no winner — §9.5 makes the ceiling, a mutual hero death and an accepted
 * draw all winnerless — so wins + losses + draws is every match the profile has finished, and
 * nothing needs a separate "played" column to stay consistent with them.
 */
export type ProfileRecord = { wins: number; losses: number; draws: number };

export type ResultStore = {
  /** One row per match (§9.5). Rejects a second row for the same match. */
  insert: (row: ResultRow) => Promise<void>;
  getByMatch: (matchId: string) => Promise<ResultRow | null>;
  /** Every finished match this profile played, as wins/losses/draws. */
  recordFor: (profileId: string) => Promise<ProfileRecord>;
};

/**
 * `tx` runs `fn` against a handle scoped to one database transaction and rolls back if `fn`
 * throws. Nested `tx` joins the enclosing transaction.
 */
export type Store = {
  tx: <T>(fn: (t: Store) => Promise<T>) => Promise<T>;
  /**
   * SPEC §9.4's redemption, whole: "Redemption is one server-side transaction: (1) reject unless
   * the account is pending with a verified email; (2) reject if this profile made more than 5
   * attempts in the last hour; (3) reject if this IP hash made more than 20; (4) log the attempt
   * either way; (5) look up by hash and reject if revoked, expired or exhausted; (6) increment
   * uses and set the account active, atomically."
   *
   * It sits beside `tx` rather than under `codes` because it *is* a transaction and it writes
   * three tables (`profiles`, `invite_codes`, `code_attempts`); it is not an operation on the code
   * table. In Postgres it is one statement — `select app.redeem_invite_code(...)`, migration 0001
   * §6 — which is why the result type is that function's return values verbatim.
   *
   * Two orderings the spec fixes and both implementations keep:
   *  - steps 2 and 3 reject BEFORE step 4, so a caller already over the limit does not pin their
   *    own counter by retrying and a flood is cheap to refuse;
   *  - a rejection is RETURNED, never thrown, so the attempt row step 4 owes is never rolled back
   *    by a later rejection in the same transaction.
   *
   * What it deliberately does not do is time: §9.4's "identical error in identical time" is R107's
   * response floor, which is the server's job (`codes.ts`) and which SQL cannot deliver.
   */
  redeem: (input: RedeemInviteCodeInput) => Promise<RedeemResult>;
  profiles: ProfileStore;
  codes: CodeStore;
  collection: CollectionStore;
  loadouts: LoadoutStore;
  matches: MatchStore;
  rooms: RoomStore;
  tickets: TicketStore;
  results: ResultStore;
};

// ---------------------------------------------------------------------------
// Live matches: the API side of the actor registry, so `queue.ts` and the room endpoints can
// start a match without importing the actor.
// ---------------------------------------------------------------------------

export type MatchSeat = { profileId: string; player: PlayerId; deck: string[] };

export type StartMatchInput = {
  matchId: string;
  seed: string;
  catalogVersion: string;
  seats: [MatchSeat, MatchSeat];
};

export type MatchDirectory = {
  start: (input: StartMatchInput) => Promise<void>;
  has: (matchId: string) => boolean;
  /** Drop the in-memory actor; the log stays. Used by the reaper and by tests. */
  stop: (matchId: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Ids and logging
// ---------------------------------------------------------------------------

/** Every id and every seed comes from here, so tests can make them deterministic. */
export type Ids = {
  uuid: () => string;
  /** A match seed; the engine is seeded only from this (SPEC §9.3). */
  seed: () => string;
  /** `length` characters from the invite-code alphabet. */
  code: (length: number) => string;
};

export type Logger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  /** §9.4: the circuit breaker alerts; §9.8: unusual rejection rates raise an alert. */
  alert: (event: string, data?: Record<string, unknown>) => void;
};

// ---------------------------------------------------------------------------
// What every handler is handed
// ---------------------------------------------------------------------------

export type ServerDeps = {
  store: Store;
  auth: AuthProvider;
  timers: Timers;
  hashes: Hashes;
  ids: Ids;
  config: ServerConfig;
  limits: ApiLimits;
  catalog: CatalogInfo;
  validateLoadout: LoadoutValidator;
  matches: MatchDirectory;
  log: Logger;
  /**
   * BUILD M8's `E2E=1` test server. Absent (and therefore false) in every real deployment; set
   * only by `src/index.ts` from `env.E2E`, which `src/env.ts` refuses together with
   * `NODE_ENV=production`.
   *
   * A handler reads this for exactly one thing: R143's optional `seed`. "The server mints it; a
   * client never supplies one. In end-to-end mode the room and queue endpoints accept an optional
   * seed and use it verbatim so a networked spec can be seeded, and outside that mode the field is
   * rejected." A flag on the deps, rather than an import of `src/env.ts`, keeps that rule testable
   * both ways and keeps `src/api/**` free of the environment (see this file's header).
   */
  e2e?: boolean;
  /**
   * SPEC §11 R190: how many `X-Forwarded-For` entries, counted from the right, this deployment's own
   * proxies wrote. Set by `src/index.ts` from `env.TRUSTED_PROXY_HOPS`; when absent the router uses
   * `DEFAULT_TRUSTED_PROXY_HOPS`. 0 ignores the header and keys every request on its peer address.
   */
  trustedProxyHops?: number;
};

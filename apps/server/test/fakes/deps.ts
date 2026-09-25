/**
 * The test doubles every server test shares: a manual clock, a scripted auth provider, a small
 * catalog, a permissive loadout validator, a recording logger and a `ServerDeps` builder.
 *
 * The clock is manual rather than `vi.useFakeTimers()` because every deadline in the server goes
 * through the `Timers` port (SPEC §9.3 keeps time out of the engine, and this keeps it out of the
 * tests' way): `timers.advance(ms)` fires exactly the callbacks that are due, in order.
 */

import type {
  ApiLimits,
  AuthProvider,
  AuthSession,
  AuthUser,
  CatalogInfo,
  Ids,
  Logger,
  LoadoutValidator,
  MatchDirectory,
  ServerConfig,
  ServerDeps,
  StartMatchInput,
  Store,
  Timers,
} from "../../src/api/ports";
import { createHashes } from "../../src/api/crypto";
import { seedHash } from "./engine";
import { createMemoryStore, type MemoryStore } from "./store";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export type ManualTimers = Timers & {
  /** Runs every callback due within `ms`, advancing `now` as it goes. */
  advance: (ms: number) => void;
  set: (epochMs: number) => void;
  readonly pending: number;
};

export function createManualTimers(start = 1_700_000_000_000): ManualTimers {
  let now = start;
  let nextId = 1;
  let scheduled: { id: number; at: number; fn: () => void }[] = [];

  const timers: ManualTimers = {
    now: () => now,
    after: (ms, fn) => {
      const id = nextId;
      nextId += 1;
      scheduled.push({ id, at: now + Math.max(ms, 0), fn });
      return { cancel: () => { scheduled = scheduled.filter((entry) => entry.id !== id); } };
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = scheduled
          .filter((entry) => entry.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id);
        const next = due[0];
        if (next === undefined) break;
        scheduled = scheduled.filter((entry) => entry.id !== next.id);
        now = Math.max(now, next.at);
        next.fn();
      }
      now = Math.max(now, target);
    },
    set: (epochMs) => {
      now = epochMs;
    },
    get pending() {
      return scheduled.length;
    },
  };
  return timers;
}

/**
 * A clock for code that must `await` its own timer, which `createManualTimers` cannot serve: a
 * request already in flight has no way to call `advance()` for itself, so `padTo`'s sleep
 * (`src/api/http.ts`) would never resolve.
 *
 * `after` therefore fires on the host's microtask queue while the *virtual* clock — the only clock
 * the server reads — jumps to the deadline. A sleep costs no real time and `now()` moves by exactly
 * the milliseconds that were asked for, so a test can measure a response in milliseconds without a
 * wall clock and without a tolerance.
 *
 * `charge(ms)` is the other half: it advances the clock the way *work* would, so a test can give a
 * fake store a cost model and then assert what the code under test does about it (BUILD M6-T1's
 * timing test does exactly that).
 *
 * One in-flight sleep at a time: callbacks fire in the order they were scheduled rather than in
 * deadline order, which is all the server's padded responses need and keeps this fake honest about
 * what it is. Anything driving several overlapping deadlines wants `createManualTimers` instead.
 */
export type VirtualTimers = Timers & {
  /** Advances the clock by `ms` of work, as a real store round trip or hash would. */
  charge: (ms: number) => void;
  set: (epochMs: number) => void;
};

export function createVirtualTimers(start = 1_700_000_000_000): VirtualTimers {
  let now = start;

  return {
    now: () => now,
    after: (ms, fn) => {
      const at = now + Math.max(ms, 0);
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        now = Math.max(now, at);
        fn();
      });
      return {
        cancel: () => {
          cancelled = true;
        },
      };
    },
    charge: (ms) => {
      now += Math.max(ms, 0);
    },
    set: (epochMs) => {
      now = epochMs;
    },
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type FakeAuth = AuthProvider & {
  /** Registers a user and returns the bearer token that verifies as them. */
  addUser: (input: { userId: string; email: string; emailVerified?: boolean }) => string;
  setEmailVerified: (userId: string, verified: boolean) => void;
};

export function createFakeAuth(): FakeAuth {
  const users = new Map<string, AuthUser>();
  const passwords = new Map<string, string>();
  const tokens = new Map<string, string>();

  const session = (user: AuthUser): AuthSession => ({
    accessToken: `token-${user.userId}`,
    refreshToken: `refresh-${user.userId}`,
    expiresAt: null,
    user,
  });

  return {
    addUser: ({ userId, email, emailVerified = true }) => {
      const user: AuthUser = { userId, email, emailVerified, appMetadata: {} };
      users.set(userId, user);
      tokens.set(`token-${userId}`, userId);
      return `token-${userId}`;
    },
    setEmailVerified: (userId, verified) => {
      const user = users.get(userId);
      if (user !== undefined) users.set(userId, { ...user, emailVerified: verified });
    },
    verifyAccessToken: async (token) => {
      const userId = tokens.get(token);
      if (userId === undefined) return null;
      return users.get(userId) ?? null;
    },
    signUp: async (email, password) => {
      const userId = `user-${users.size + 1}`;
      const user: AuthUser = { userId, email, emailVerified: false, appMetadata: {} };
      users.set(userId, user);
      passwords.set(email, password);
      tokens.set(`token-${userId}`, userId);
      return { pendingEmailVerification: true, userId };
    },
    signInWithPassword: async (email, password) => {
      const user = [...users.values()].find((candidate) => candidate.email === email);
      if (user === undefined || passwords.get(email) !== password) {
        throw new Error("invalid login credentials");
      }
      return session(user);
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog and validator
// ---------------------------------------------------------------------------

export const TEST_CATALOG_VERSION = "test-1";

/** 24 playable ids plus one token, enough for L3/L6 tests without the real 100-card catalog. */
export function createTestCatalog(version = TEST_CATALOG_VERSION, count = 24): CatalogInfo {
  const cardIds = Array.from({ length: count }, (_, i) => `core-${String(i + 1).padStart(3, "0")}`);
  const tokens = ["token-sheep"];
  const banned = new Set<string>(["core-999"]);
  return {
    version,
    defs: {},
    cardIds: [...cardIds, ...tokens],
    isToken: (cardId) => tokens.includes(cardId),
    isBanned: (cardId) => banned.has(cardId),
  };
}

/**
 * The default `LoadoutValidator` on `createTestDeps`: it approves everything.
 *
 * NOT because `@jackioh/validator` is unfinished — it is implemented and has its own suite (BUILD
 * M6-T3's "unit test per rule with the specific error message"). It is a no-op because of the
 * catalog next door: `createTestCatalog` is 24 synthetic ids with `defs: {}`, so the real L1–L6
 * would answer L6 ("no such card in catalog version test-1") for every card in every fixture in
 * this directory, and L2 for every deck, and not one of the suites that merely *needs a loadout*
 * — the queue, the rooms, the actor — would be testing what it is about any more.
 *
 * So the split is deliberate: a test whose subject is not loadout legality gets this and a
 * synthetic catalog, and a test whose subject IS loadout legality builds deps on the real catalog
 * (`loadCatalog()`) with the real adapter (`sharedLoadoutValidator`) instead. Both do:
 * `test/api/catalog.test.ts` drives the adapter directly, and `test/api/queue.test.ts` drives the
 * Best-of-1 and Best-of-3 refusals (R253) through `POST /api/queue` itself.
 *
 * Nothing in `src/` restates a loadout rule; `test/validator-single-source.test.ts` is the grep
 * that keeps it that way.
 */
export const permissiveValidator: LoadoutValidator = () => [];

/**
 * `deck` is 1-based here, exactly as `@jackioh/validator`'s `LoadoutError.deck` is (and as
 * `LoadoutIssue.deck` in ports.ts documents): a 0-based fake would hide an adapter that forgot
 * the conversion. Note that a legacy `deckIndex` is a 0-based position in the saved-deck list
 * instead — a request parameter, not a rule's report — so the two must never be fed to each other.
 *
 * It honours the port's `scope` (L1 only for a trio, R253) and `names` (a message names the deck
 * by its saved name, falling back to `Deck <n>`), as the real adapter does.
 */
export const strictTestValidator: LoadoutValidator = ({ decks, names, scope, catalog, owned }) => {
  const issues: { rule: string; message: string; deck?: number; cardId?: string }[] = [];
  if ((scope ?? "trio") === "trio" && decks.length !== 3) {
    issues.push({ rule: "L1", message: "a trio holds exactly 3 decks" });
  }
  decks.forEach((deck, index) => {
    const label = names?.[index] ?? `Deck ${index + 1}`;
    for (const cardId of deck) {
      if (!catalog.cardIds.includes(cardId) || catalog.isBanned(cardId)) {
        issues.push({ rule: "L6", message: `${label}: ${cardId} is not playable`, deck: index + 1, cardId });
      }
      if ((owned.get(cardId) ?? 0) < 1) {
        issues.push({ rule: "L5", message: `${label}: you do not own ${cardId}`, deck: index + 1, cardId });
      }
    }
  });
  return issues;
};

/**
 * `ServerDeps.dealRandomDeck` for the suite (R258): deterministic from the seed, over the catalog's
 * playable ids. The real deal is `buildAiDeck` behind `src/match/engine.real.ts` and is tested there
 * (`test/match/engine.real.test.ts`); here the question is only which seed a caller asks for and
 * where the dealt deck goes, so a rotation of the pool is enough. Half the pool, so two seeds' decks
 * are told apart at a glance.
 */
export function fakeRandomDealer(catalog: CatalogInfo): (seed: string) => string[] {
  const playable = catalog.cardIds.filter((cardId) => !catalog.isToken(cardId) && !catalog.isBanned(cardId));
  return (seed) => {
    const offset = seedHash(seed) % Math.max(playable.length, 1);
    const rotated = [...playable.slice(offset), ...playable.slice(0, offset)];
    return rotated.slice(0, Math.ceil(playable.length / 2));
  };
}

// ---------------------------------------------------------------------------
// Ids, logger, match directory
// ---------------------------------------------------------------------------

export function createFakeIds(): Ids {
  let n = 0;
  return {
    uuid: () => {
      n += 1;
      return `id-${n}`;
    },
    seed: () => {
      n += 1;
      return `seed-${n}`;
    },
    code: (length) => {
      n += 1;
      return `CODE${String(n)}`.padEnd(length, "X").slice(0, length);
    },
  };
}

export type RecordingLogger = Logger & {
  entries: { level: "info" | "warn" | "alert"; event: string; data?: Record<string, unknown> }[];
};

export function createRecordingLogger(): RecordingLogger {
  const entries: RecordingLogger["entries"] = [];
  return {
    entries,
    info: (event, data) => entries.push({ level: "info", event, ...(data ? { data } : {}) }),
    warn: (event, data) => entries.push({ level: "warn", event, ...(data ? { data } : {}) }),
    alert: (event, data) => entries.push({ level: "alert", event, ...(data ? { data } : {}) }),
  };
}

export type FakeMatchDirectory = MatchDirectory & { started: StartMatchInput[] };

/**
 * `start` WRITES THE MATCH ROW, because the real one does.
 *
 * This fake used to only record the call. `createMatchRegistry`'s `start` (src/match/registry.ts)
 * builds the row -- seed, both frozen decks, R79's clocks, status live -- and calls
 * `store.matches.create` itself, so a fake that wrote nothing made the store's create invisible to
 * every test that goes through the directory. That is not a small gap: matchmaking also created
 * the row in `startPairedMatch`, so production wrote it TWICE for one id and the second player's
 * enqueue returned 500 on every single pair, while the server suite stayed 100% green because no
 * test ever saw the second write.
 *
 * `store` is OPT-IN rather than the default. Handing it to every test breaks the ones that
 * pre-create a match row and then call `start`, because `test/fakes/store.ts`'s `create` throws
 * `duplicate match` for ANY existing row while the real `src/db/store.ts` promotes an `open` one
 * ("nothing -> insert; an `open` row -> complete it; anything else -> the id is taken"). That
 * divergence is worth closing on its own; until it is, the store goes only to the test that needs
 * the write to be real — `queue.test.ts`'s duplicate-create regression.
 */
export function createFakeMatchDirectory(store?: Store): FakeMatchDirectory {
  const started: StartMatchInput[] = [];
  const live = new Set<string>();
  return {
    started,
    start: async (input) => {
      started.push(input);
      live.add(input.matchId);
      if (store !== undefined) {
        const [first, second] = input.seats;
        await store.matches.create({
          id: input.matchId,
          seed: input.seed,
          players: [first.profileId, second.profileId],
          decks: [[...first.deck], [...second.deck]],
          catalogVersion: input.catalogVersion,
          status: "live",
          createdAt: 0,
          finishedAt: null,
          clocks: {
            turnDeadline: null,
            promptDeadline: null,
            graceDeadline: { p1: null, p2: null },
            ceilingAt: 0,
          },
        });
      }
    },
    has: (matchId) => live.has(matchId),
    stop: async (matchId) => {
      live.delete(matchId);
    },
  };
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** R79's shape with small numbers, so a fake-timer test does not advance 75 real seconds. */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    turnClockSeconds: 75,
    promptClockSeconds: 30,
    disconnectGraceSeconds: 60,
    matchCeilingMinutes: 60,
    roomCodeLength: 6,
    eloK: 32,
    eloStart: 1000,
    ...overrides,
  };
}

export function testLimits(overrides: Partial<ApiLimits> = {}): ApiLimits {
  return {
    redeemPerProfilePerHour: 5,
    redeemPerIpPerHour: 20,
    redeemWindowMs: 3_600_000,
    // Small on purpose: the §9.4 suites that drive redemption run on the *real* clock (a request in
    // flight cannot advance a manual one), so every padded response in them is a real wait. BUILD
    // M6-T1's timing test is the exception — it runs on `createVirtualTimers` and overrides this
    // with the production `REDEMPTION_RESPONSE_FLOOR_MS`, which costs it nothing.
    redeemConstantMs: 20,
    breakerFailureThreshold: 100,
    breakerWindowMs: 600_000,
    breakerCooldownMs: 600_000,
    queueWindowStart: 100,
    queueWindowStep: 50,
    queueWindowStepMs: 10_000,
    queueWindowUncappedAfterMs: 60_000,
    queueSweepMs: 3_000,
    roomCodeTtlMs: 900_000,
    ...overrides,
  };
}

export type TestDeps = ServerDeps & {
  store: MemoryStore;
  timers: ManualTimers;
  auth: FakeAuth;
  log: RecordingLogger;
  matches: FakeMatchDirectory;
};

export function createTestDeps(overrides: Partial<ServerDeps> = {}): TestDeps {
  // The clock and the limits are settled first because the store reads both: §9.4's redemption is
  // one store transaction (`Store.redeem`), so the attempt windows and the clock stamped on
  // `code_attempts.at` belong to the store, and a test that swaps either must have its fake store
  // swap with it.
  const timers = overrides.timers ?? createManualTimers();
  const limits = overrides.limits ?? testLimits();
  // Hoisted out of the literal below so the match directory can be handed the same store: its
  // `start` writes the match row exactly as `createMatchRegistry` does.
  const store =
    (overrides.store as Store | undefined) ??
    createMemoryStore({
      now: () => timers.now(),
      redemption: {
        attemptsPerProfilePerHour: limits.redeemPerProfilePerHour,
        attemptsPerIpPerHour: limits.redeemPerIpPerHour,
        attemptWindowMs: limits.redeemWindowMs,
      },
    });
  const catalog = overrides.catalog ?? createTestCatalog();
  const base = {
    store,
    auth: createFakeAuth(),
    timers,
    hashes: createHashes({ code: "test-code-pepper", ip: "test-ip-pepper" }),
    ids: createFakeIds(),
    config: testConfig(),
    limits,
    catalog,
    validateLoadout: permissiveValidator,
    dealRandomDeck: fakeRandomDealer(catalog),
    matches: createFakeMatchDirectory(),
    log: createRecordingLogger(),
    // `jsonRequest` writes the `X-Forwarded-For` entry a proxy would, so the tests model the
    // deployed server behind one proxy hop (`render.yaml`). The server's own default is 0 (R190),
    // and `client-address.test.ts` covers it by passing `trustedProxyHops: undefined`.
    trustedProxyHops: 1,
  };
  return { ...base, ...overrides } as TestDeps;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  init: { token?: string; ip?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.token !== undefined) headers.set("authorization", `Bearer ${init.token}`);
  headers.set("x-forwarded-for", init.ip ?? "203.0.113.7");
  return new Request(`https://server.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

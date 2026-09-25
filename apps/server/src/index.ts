/**
 * The composition root: the only file that knows about the host, the framework and the driver.
 *
 * Everything below it depends on the ports in `src/api/ports.ts` and `src/match/contracts.ts`, so
 * this is where the abstract runtime becomes a concrete one — Supabase Auth for identity,
 * Postgres for the `Store`, `@hono/node-server` for HTTP, `ws` for sockets, and the real engine
 * for the rules. Hand it a Supabase project's URL and keys and it runs (see README.md).
 *
 * Nothing here decides a rule or states a constant. `ServerConfig` and `ApiLimits` come from
 * `src/api/deps.ts`, which is the one reader of `src/config.ts` (R79).
 *
 * BUILD M8's `E2E=1` mode is chosen here and nowhere else. When `env.E2E` is true this file binds
 * two ports differently — the in-memory `Store` of `src/api/e2e-store.ts` and the fixture
 * `AuthProvider` of `src/api/e2e.ts` — and runs R144's reseed before the port opens. Everything
 * else, the route table included, is the same server. `src/env.ts` refuses `E2E` together with
 * `NODE_ENV=production`, so none of it is reachable in a production deployment.
 */

import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";

import { createAuthRoutes, createSupabaseAuth } from "./api/auth";
import { createCatalogRoutes, loadCatalog } from "./api/catalog";
import { createCodesRoutes } from "./api/codes";
import { createCollectionRoutes } from "./api/collection";
import { VITE_DEV_ORIGINS, withCors } from "./api/cors";
import { createHashes, systemIds } from "./api/crypto";
import { consoleLogger, defaultConfig, defaultLimits } from "./api/deps";
import { createE2EAuth, seedE2EFixtures } from "./api/e2e";
import { createDeckRoutes } from "./api/decks";
import { createE2EStore, type E2EStore } from "./api/e2e-store";
import { createRouter, type RequestContext, type Route } from "./api/http";
import { sharedLoadoutValidator } from "./api/loadout-validator";
import type { Logger, ServerDeps, Store } from "./api/ports";
import { systemTimers } from "./api/ports";
import { createQueueRoutes, startMatchmaker } from "./api/queue";
import { createRecordResult, reapStuckMatches } from "./api/results";
import { createSeriesRoutes, startSeriesSweeper } from "./api/series";
import { MATCH_REAPER_INTERVAL_SECONDS } from "./config";
import { loadEnv, type ServerEnv } from "./env";
import { createMatchClock } from "./match/clock";
import { loadEnginePort } from "./match/engine";
import { createMatchRegistry, type MatchRegistry } from "./match/registry";
import { createRoomRoutes } from "./match/rooms";
import { WS_PATH, attachWebSocketServer } from "./match/wsServer";

/**
 * The `Store` implementation lives in `src/db/**`, which the database agent owns. It is reached
 * through a dynamic import so this app typechecks and tests before that module lands, and so the
 * failure — when it has not landed — is a startup message naming exactly what is expected rather
 * than a compile error in an unrelated file.
 *
 * Expected contract: a module at `./db/store` exporting
 * `createPostgresStore(options: { connectionString: string }): Store`.
 */
const STORE_EXPORT_CANDIDATES = ["createPostgresStore", "createStore", "postgresStore"] as const;

export class StoreUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      `./db/store must export one of ${STORE_EXPORT_CANDIDATES.join(", ")} ` +
        `as (options: { connectionString: string }) => Store (see src/api/ports.ts). ${String(cause ?? "")}`,
    );
    this.name = "StoreUnavailableError";
  }
}

export async function loadStore(env: ServerEnv, log?: Logger): Promise<Store> {
  const specifier = "./db/store";
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (cause) {
    throw new StoreUnavailableError(cause);
  }
  for (const name of STORE_EXPORT_CANDIDATES) {
    const factory = mod[name];
    if (typeof factory === "function") {
      return (
        factory as (options: {
          connectionString: string;
          onError?: (error: Error) => void;
        }) => Store
      )({
        connectionString: env.DATABASE_URL,
        // `warn`, not `alert`: a pooler closing an idle connection is routine, and the store has
        // already dropped the dead client. It is logged rather than silent so that a *persistent*
        // failure is visible as a stream of these instead of as nothing at all.
        onError: (error) => {
          log?.warn("store.pool.error", { message: error.message });
        },
      });
    }
  }
  throw new StoreUnavailableError("no matching export");
}

// ---------------------------------------------------------------------------
// BUILD M8's `E2E=1` mode
// ---------------------------------------------------------------------------

/**
 * Not in SPEC, and no R-row: boot ergonomics for the test mode, not a rule. These are placeholders
 * so `E2E=1 pnpm --dir apps/server dev` — the command `e2e/README.md` documents — boots in a
 * checkout with no `.env`. The one value here that is a rule is `CATALOG_VERSION`, and it is not
 * decided here: `core-1` is R105's Core-set version, seeded by migration
 * `0001_profiles_and_invites.sql` and written in `.env.example`.
 *
 * `src/env.ts` validates the whole contract whatever the mode, and end-to-end mode reaches neither
 * Supabase (the fixture `AuthProvider` replaces it) nor Postgres (the in-memory `Store` replaces
 * it), so demanding a project URL and a connection string would only be a puzzle for whoever runs
 * the suite. Every value below is filled in ONLY when the variable is unset, so a deployment that
 * does configure one keeps it, and none of this is reachable outside end-to-end mode — `env.ts`
 * refuses `E2E` together with `NODE_ENV=production`.
 *
 * `CODE_PEPPER` is a throwaway: the fixture invite codes are checked into `e2e/support/config.ts`,
 * so their hashes protect nothing. `CATALOG_VERSION` matches `.env.example`; the specs read the
 * version back from the server rather than asserting a literal.
 */
const E2E_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  SUPABASE_URL: "https://e2e-fixture-auth.invalid",
  SUPABASE_SECRET_KEY: "e2e-fixture-auth-has-no-supabase",
  DATABASE_URL: "memory://e2e-fixture-store",
  CODE_PEPPER: "e2e-fixture-code-pepper-not-a-secret-abcdefgh",
  PUBLIC_ORIGINS: VITE_DEV_ORIGINS.join(","),
  CATALOG_VERSION: "core-1",
};

function e2eRequested(source: Record<string, string | undefined>): boolean {
  const raw = source.E2E?.trim();
  return raw === "1" || raw === "true";
}

/**
 * `loadEnv`, with the end-to-end placeholders applied first when `E2E` asks for them. The
 * production path is `loadEnv(process.env)` exactly as before: when `E2E` is unset or false this
 * function adds nothing and changes no message.
 */
export function loadServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  if (!e2eRequested(source)) return loadEnv(source);
  const merged: Record<string, string | undefined> = { ...source };
  for (const [key, value] of Object.entries(E2E_ENV_DEFAULTS)) {
    if ((merged[key] ?? "").trim().length === 0) merged[key] = value;
  }
  return loadEnv(merged);
}

/**
 * The browser origins this deployment trusts: `PUBLIC_ORIGINS` for CORS and the WebSocket `Origin`
 * check (`src/env.ts`), plus Vite's dev origins in end-to-end mode.
 */
export function browserOrigins(env: ServerEnv): string[] {
  const configured = [...env.PUBLIC_ORIGINS];
  if (!env.E2E) return configured;
  return [...configured, ...VITE_DEV_ORIGINS.filter((origin) => !configured.includes(origin))];
}

export type Runtime = {
  deps: ServerDeps;
  /** The same object as `deps.matches`, with the two extra methods a socket needs. */
  registry: MatchRegistry;
  /** BUILD M8: the fixture store R144 reseeds into, or null outside end-to-end mode. */
  e2eStore: E2EStore | null;
};

/**
 * Assembles the runtime from the environment. Every port is bound exactly once, here.
 *
 * The registry is built last and then installed as `deps.matches`, because it needs the deps it
 * is part of: `queue.ts` and `rooms.ts` start matches through the `MatchDirectory` half while the
 * actor inside it reduces them.
 */
export async function createRuntime(
  env: ServerEnv,
  overrides: Partial<ServerDeps> = {},
): Promise<Runtime> {
  const log: Logger = overrides.log ?? consoleLogger;
  const engine = await loadEnginePort();
  const catalog = overrides.catalog ?? (await loadCatalog({ version: env.CATALOG_VERSION }));
  const timers = overrides.timers ?? systemTimers;

  // BUILD M8, R144: end-to-end mode swaps exactly two ports — the `Store` and the `AuthProvider` —
  // and nothing else about this file changes. `loadStore(env)` and `createSupabaseAuth(...)` are
  // untouched on the production path, including the `StoreUnavailableError` a missing `./db/store`
  // still raises there.
  const e2eStore = env.E2E && overrides.store === undefined
    ? createE2EStore({ catalog, now: timers.now })
    : null;

  const deps: ServerDeps = {
    store: overrides.store ?? e2eStore ?? (await loadStore(env, log)),
    auth:
      overrides.auth ??
      (env.E2E
        ? createE2EAuth()
        : createSupabaseAuth({
            url: env.SUPABASE_URL,
            secretKey: env.SUPABASE_SECRET_KEY,
            jwksUrl: env.SUPABASE_JWKS_URL,
            jwtSecret: env.SUPABASE_JWT_SECRET,
          })),
    timers,
    // §9.4, §9.8: one pepper in the environment, two domains. Separating them means an invite-code
    // hash and an IP hash can never collide, and neither is reversible without the pepper.
    hashes: overrides.hashes ?? createHashes({ code: `${env.CODE_PEPPER}:code`, ip: `${env.CODE_PEPPER}:ip` }),
    ids: overrides.ids ?? systemIds,
    config: overrides.config ?? defaultConfig(),
    limits: overrides.limits ?? defaultLimits(),
    catalog,
    validateLoadout: overrides.validateLoadout ?? sharedLoadoutValidator,
    // R258: All Random's decks come from the engine port, the one path to the card catalog.
    dealRandomDeck: overrides.dealRandomDeck ?? engine.dealRandomDeck,
    // Replaced two lines down; a placeholder rather than a lie, so a mistake is loud.
    matches: {
      start: async () => {
        throw new Error("the match registry is not wired yet");
      },
      has: () => false,
      stop: async () => {},
    },
    log,
    // R190: how many `X-Forwarded-For` entries, from the right, this deployment's proxies wrote.
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
  };

  const registry = createMatchRegistry({
    store: deps.store,
    timers: deps.timers,
    config: deps.config,
    log: deps.log,
    engine,
    createClock: createMatchClock,
    recordResult: createRecordResult(deps),
  });
  deps.matches = overrides.matches ?? registry;
  // R143: the one thing a handler reads this for is the optional seed on `POST /api/queue`.
  deps.e2e = overrides.e2e ?? env.E2E;

  return { deps, registry, e2eStore };
}

/** Every route the server serves, in one table (see README.md for the surface). */
export function allRoutes(): Route[] {
  return [
    ...createAuthRoutes(),
    ...createCatalogRoutes(),
    ...createCodesRoutes(),
    ...createCollectionRoutes(),
    ...createDeckRoutes(),
    ...createQueueRoutes(),
    ...createRoomRoutes(),
    ...createSeriesRoutes(),
  ];
}

export type RunningServer = { close: () => Promise<void> };

export async function start(env: ServerEnv = loadServerEnv()): Promise<RunningServer> {
  const { deps, registry, e2eStore } = await createRuntime(env);

  if (env.E2E) {
    // Loud, and at `alert` level, because a server holding fixture accounts that accept three
    // hard-coded bearer tokens must never be mistaken for a real one.
    deps.log.alert("server.e2e_mode", {
      warning:
        "BUILD M8 fixture mode: static test tokens, an in-memory store and no database. Never a production deployment.",
      store: e2eStore === null ? "overridden" : "in-memory",
      auth: "fixture",
    });
    // R144: reseeded on every start, before the port opens, so no request can land on half a
    // fixture set and so spec 10 is repeatable run after run.
    if (e2eStore !== null) await seedE2EFixtures(deps, e2eStore);
  }

  const origins = browserOrigins(env);
  const router = createRouter(allRoutes(), deps);
  // The browser and the API are separate origins (§9.2); without this every `fetch` from
  // `apps/web` is blocked before a handler runs. Preflights never reach the router.
  const handler = withCors(
    (request: Request, context?: RequestContext) => router(request, context),
    { origins, log: deps.log },
  );

  // R190: the socket's peer address travels with the request, because a request that did not come
  // through the trusted proxy chain is keyed on it rather than on anything the caller wrote.
  const server = serve({
    fetch: (request, bindings) =>
      handler(request, { peerAddress: bindings?.incoming?.socket?.remoteAddress ?? null }),
    port: env.PORT,
  });
  // SPEC §9.2: one WebSocket per player, upgraded on the same listener the API serves.
  const sockets = attachWebSocketServer(server, deps, registry, {
    path: WS_PATH,
    allowedOrigins: origins,
  });
  deps.log.info("server.listening", {
    port: env.PORT,
    catalogVersion: deps.catalog.version,
    origins,
    e2e: env.E2E,
    trustedProxyHops: deps.trustedProxyHops,
  });

  // §9.5: pairing runs on enqueue plus a sweeper, and a reaper resolves anything past the ceiling.
  const matchmaker = startMatchmaker(deps);
  // R260, R263: the series sweeper runs the pick clock and starts a game a restart left unstarted.
  const seriesSweeper = startSeriesSweeper(deps);

  let reaper = deps.timers.after(MATCH_REAPER_INTERVAL_SECONDS * 1000, sweep);
  let stopped = false;
  function sweep(): void {
    void reapStuckMatches(deps)
      .then((ids) => {
        if (ids.length > 0) deps.log.warn("matches.reaped", { ids });
      })
      .catch((error: unknown) => {
        deps.log.warn("matches.reaper_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (!stopped) reaper = deps.timers.after(MATCH_REAPER_INTERVAL_SECONDS * 1000, sweep);
      });
  }

  return {
    close: async () => {
      stopped = true;
      matchmaker.stop();
      seriesSweeper.stop();
      reaper.cancel();
      await sockets.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// `tsx src/index.ts` starts it; importing it does not.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void start().catch((error: unknown) => {
    consoleLogger.alert("server.start_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}

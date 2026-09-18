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
 */

import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";

import { createAuthRoutes, createSupabaseAuth } from "./api/auth";
import { loadCatalog } from "./api/catalog";
import { createCodesRoutes } from "./api/codes";
import { createCollectionRoutes } from "./api/collection";
import { createHashes, systemIds } from "./api/crypto";
import { consoleLogger, defaultConfig, defaultLimits } from "./api/deps";
import { createRouter, type Route } from "./api/http";
import { createLoadoutRoutes } from "./api/loadouts";
import { sharedLoadoutValidator } from "./api/loadout-validator";
import type { Logger, ServerDeps, Store } from "./api/ports";
import { systemTimers } from "./api/ports";
import { createQueueRoutes, startMatchmaker } from "./api/queue";
import { createRecordResult, reapStuckMatches } from "./api/results";
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

export async function loadStore(env: ServerEnv): Promise<Store> {
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
      return (factory as (options: { connectionString: string }) => Store)({
        connectionString: env.DATABASE_URL,
      });
    }
  }
  throw new StoreUnavailableError("no matching export");
}

export type Runtime = {
  deps: ServerDeps;
  /** The same object as `deps.matches`, with the two extra methods a socket needs. */
  registry: MatchRegistry;
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

  const deps: ServerDeps = {
    store: overrides.store ?? (await loadStore(env)),
    auth:
      overrides.auth ??
      createSupabaseAuth({
        url: env.SUPABASE_URL,
        secretKey: env.SUPABASE_SECRET_KEY,
        jwksUrl: env.SUPABASE_JWKS_URL,
        jwtSecret: env.SUPABASE_JWT_SECRET,
      }),
    timers: overrides.timers ?? systemTimers,
    // §9.4, §9.8: one pepper in the environment, two domains. Separating them means an invite-code
    // hash and an IP hash can never collide, and neither is reversible without the pepper.
    hashes: overrides.hashes ?? createHashes({ code: `${env.CODE_PEPPER}:code`, ip: `${env.CODE_PEPPER}:ip` }),
    ids: overrides.ids ?? systemIds,
    config: overrides.config ?? defaultConfig(),
    limits: overrides.limits ?? defaultLimits(),
    catalog,
    validateLoadout: overrides.validateLoadout ?? sharedLoadoutValidator,
    // Replaced two lines down; a placeholder rather than a lie, so a mistake is loud.
    matches: {
      start: async () => {
        throw new Error("the match registry is not wired yet");
      },
      has: () => false,
      stop: async () => {},
    },
    log,
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

  return { deps, registry };
}

/** Every route the server serves, in one table (see README.md for the surface). */
export function allRoutes(): Route[] {
  return [
    ...createAuthRoutes(),
    ...createCodesRoutes(),
    ...createCollectionRoutes(),
    ...createLoadoutRoutes(),
    ...createQueueRoutes(),
    ...createRoomRoutes(),
  ];
}

export type RunningServer = { close: () => Promise<void> };

export async function start(env: ServerEnv = loadEnv()): Promise<RunningServer> {
  const { deps, registry } = await createRuntime(env);
  const router = createRouter(allRoutes(), deps);

  const server = serve({ fetch: (request: Request) => router(request), port: env.PORT });
  // SPEC §9.2: one WebSocket per player, upgraded on the same listener the API serves.
  const sockets = attachWebSocketServer(server, deps, registry, {
    path: WS_PATH,
    allowedOrigins: env.PUBLIC_ORIGINS,
  });
  deps.log.info("server.listening", { port: env.PORT, catalogVersion: deps.catalog.version });

  // §9.5: pairing runs on enqueue plus a sweeper, and a reaper resolves anything past the ceiling.
  const matchmaker = startMatchmaker(deps);

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

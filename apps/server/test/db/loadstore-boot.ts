/**
 * The boot path, run the way the server actually runs it: `tsx`, `src/index.ts`, `loadStore`.
 *
 * `postgres.spec.ts` executes this file in a subprocess and asserts what it prints. It cannot just
 * call `loadStore` in-process, because `loadStore` reaches `src/db/store.ts` through a dynamic
 * import of a VARIABLE specifier (`const specifier = "./db/store"`) — deliberate, so the module
 * graph does not require the file to exist — and vitest's module runner cannot resolve an
 * extensionless specifier that way. `tsx`, which is what `pnpm --dir apps/server start` uses, can.
 * So the only honest test of the real boot path is the real runner.
 *
 * Prints `loadstore: ok <n>` and exits 0 when the store `src/index.ts` found actually answers a
 * query; anything else is a failure the spec reports.
 */

import { loadStore } from "../../src/index.ts";
import { DEFAULT_TRUSTED_PROXY_HOPS } from "../../src/config.ts";
import type { ServerEnv } from "../../src/env.ts";

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl === "") {
  process.stderr.write("loadstore: DATABASE_URL is not set\n");
  process.exit(1);
}

const env: ServerEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "not-used-by-the-store",
  DATABASE_URL: databaseUrl,
  SUPABASE_JWKS_URL: "https://example.supabase.co/auth/v1/.well-known/jwks.json",
  SUPABASE_JWT_SECRET: undefined,
  CODE_PEPPER: "0123456789abcdef0123456789abcdef0123456789",
  PORT: 8787,
  PUBLIC_ORIGINS: ["https://example.test"],
  NODE_ENV: "test",
  E2E: false,
  CATALOG_VERSION: "core-1",
  TRUSTED_PROXY_HOPS: DEFAULT_TRUSTED_PROXY_HOPS,
};

// Before `src/db/store.ts` existed this threw `StoreUnavailableError`, and the server could only
// boot with `E2E=1` against the in-memory fixture.
const store = await loadStore(env);
const open = await store.tickets.countOpen();
process.stdout.write(`loadstore: ok ${String(open)}\n`);
await (store as unknown as { close: () => Promise<void> }).close();

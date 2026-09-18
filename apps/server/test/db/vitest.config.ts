import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The database suite. Deliberately NOT a project of the root `vitest.config.ts`: `pnpm test` stays
 * hermetic and needs no Docker, exactly as `pnpm test:sql` is kept out of it. `test/db/run.sh`
 * (`pnpm test:db`) stands a Postgres up, applies the schema and runs this config.
 *
 * `*.spec.ts`, so `apps/server/vitest.config.ts` — which includes `test/` files named `*.test.ts`
 * — cannot pick these up by accident.
 */
export default defineConfig({
  // `run.sh` is invoked from the repo root, and vitest resolves `include` against the ROOT, not
  // against the config file. Without this the run finds no test files and exits 1 — which looks
  // exactly like a suite that passed nothing.
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Keep vite's cache out of `test/db`, which would otherwise grow a `node_modules/.vite` of its
  // own next to the specs.
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite", import.meta.url)),
  test: {
    name: "db",
    include: ["*.spec.ts"],
    // One database, shared tables, `truncate` between tests: the files must not run at the same
    // time in different workers.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

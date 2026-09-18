/**
 * The two things about `src/db/store.ts` that must be true before a single query is sent, and that
 * need no database — so they run in `pnpm test` with everything else.
 *
 * Both are about the boot contract in `src/index.ts`: `loadStore` looks for one of three export
 * names and hands it `{ connectionString: env.DATABASE_URL }`. A store that loaded and then failed
 * later, or one that accepted end-to-end mode's `memory://` placeholder as if it were a database,
 * would be worse than the `StoreUnavailableError` this file's subject replaced.
 */

import { describe, expect, it } from "vitest";

import { createPostgresStore, createStore, postgresStore } from "../../src/db/store";

describe("createPostgresStore", () => {
  /** The three names `STORE_EXPORT_CANDIDATES` in `src/index.ts` tries, in its order. */
  it("exports all three names `loadStore` looks for", () => {
    expect(typeof createPostgresStore).toBe("function");
    expect(createStore).toBe(createPostgresStore);
    expect(postgresStore).toBe(createPostgresStore);
  });

  it("refuses anything that is not a Postgres connection string", () => {
    // BUILD M8's end-to-end placeholder. `src/index.ts` binds the in-memory store before it ever
    // calls `loadStore` in that mode, so reaching here with this value means the wiring is wrong —
    // and a store that shrugged would fail later, somewhere less obvious.
    expect(() => createPostgresStore({ connectionString: "memory://e2e-fixture-store" })).toThrow(
      /must be a Postgres connection string/,
    );
    expect(() => createPostgresStore({ connectionString: "" })).toThrow(/DATABASE_URL/);
  });
});

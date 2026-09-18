/**
 * The two ends of the store contract: the in-memory fixture of `src/api/e2e-store.ts` and the real
 * Postgres store of `src/db/store.ts`. `contract.ts` runs the same assertions against both.
 *
 * The Postgres harness expects `DATABASE_URL` to point at a database that already has
 * `test/db/bootstrap.sql`, the four migrations and `test/db/grants.sql` applied — which is what
 * `test/db/run.sh` does with a throwaway Docker container in a couple of seconds.
 */

import { Client } from "pg";

import { createE2EStore } from "../../src/api/e2e-store";
import { createPostgresStore, type PostgresStore } from "../../src/db/store";
import type { CardDef } from "@jackioh/shared";
import type { CatalogInfo, Store } from "../../src/api/ports";

// ---------------------------------------------------------------------------
// A fixture catalog big enough for a legal loadout
// ---------------------------------------------------------------------------

/** SPEC §9.4 L2: `DECK_SIZE` is 20, and L1 says three decks, so 60 ids is the floor. */
export const CATALOG_VERSION = "core-1";
export const PLAYABLE_IDS: readonly string[] = Array.from({ length: 64 }, (_, i) =>
  `core-${String(i + 1).padStart(3, "0")}`,
);
/** §9.4 L3: "no Token-tagged cards" — here so the R111 launch grant can be seen skipping them. */
export const TOKEN_IDS: readonly string[] = ["core-001.1", "core-002.1"];

export function fixtureCatalog(): CatalogInfo {
  const all = [...PLAYABLE_IDS, ...TOKEN_IDS];
  const tokens = new Set(TOKEN_IDS);
  return {
    version: CATALOG_VERSION,
    // The contract never renders a card, so the defs stay empty: `CatalogInfo` is consulted here
    // only for `cardIds`, `isToken` and `isBanned` (the three R111 reads).
    defs: {} as Readonly<Record<string, CardDef>>,
    cardIds: all,
    isToken: (cardId) => tokens.has(cardId),
    isBanned: () => false,
  };
}

// ---------------------------------------------------------------------------
// The harness the contract drives
// ---------------------------------------------------------------------------

export type StoreHarness = {
  /** Appears in the test names, so a failure says which store broke. */
  name: string;
  store: Store;
  /** Empties every table. Called before each test. */
  reset: () => Promise<void>;
  /**
   * Provisions the managed-auth identity a profile needs and returns its user id (§9.4: "managed
   * auth provider"). In Postgres that is an `auth.users` row, which `profiles.id` references.
   */
  newUserId: (email: string) => Promise<string>;
  close: () => Promise<void>;
  playableIds: readonly string[];
  tokenIds: readonly string[];
  catalogVersion: string;
  now: () => number;
};

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export function memoryHarness(): StoreHarness {
  const catalog = fixtureCatalog();
  const store = createE2EStore({ catalog, now: () => Date.now() });
  let nextUser = 1;
  return {
    name: "e2e-store (in memory)",
    store,
    reset: async () => {
      store.reset();
      nextUser = 1;
    },
    newUserId: async () => {
      const id = `user-${String(nextUser)}`;
      nextUser += 1;
      return id;
    },
    close: async () => undefined,
    playableIds: PLAYABLE_IDS,
    tokenIds: TOKEN_IDS,
    catalogVersion: CATALOG_VERSION,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/** Every table the migrations create, children first. `cards` is seeded once and kept. */
const TRUNCATE = `truncate
  public.results, public.match_actions, public.tickets, public.matches,
  public.loadout_deck_cards, public.loadout_decks, public.loadouts,
  public.collection_grants, public.collection,
  public.code_attempts, public.invite_codes, public.profiles, auth.users
  restart identity cascade`;

export function databaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL is not set. These specs need a real Postgres: run `pnpm test:db`, which " +
        "stands one up in Docker, applies test/db/bootstrap.sql, the four migrations and " +
        "test/db/grants.sql, and then runs this suite.",
    );
  }
  return url;
}

/** A raw superuser connection, for the setup and teardown the store deliberately cannot do. */
export async function adminClient(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  return client;
}

export async function seedCards(client: Client): Promise<void> {
  await client.query(
    `insert into public.cards (id, card_index, name, set_id, type, tags, rarity, token, cost, catalog_version)
     select c.id, c.ord::text, 'Fixture ' || c.id, 'Core', 'Unit', '{}'::text[],
            case when c.token then 'Token' else 'Common' end, c.token, '1'::jsonb, $3::text
       from (
         select t.id, false as token, t.ord from unnest($1::text[]) with ordinality as t(id, ord)
         union all
         select t.id, true, 1000 + t.ord from unnest($2::text[]) with ordinality as t(id, ord)
       ) as c
     on conflict (id) do nothing`,
    [[...PLAYABLE_IDS], [...TOKEN_IDS], CATALOG_VERSION],
  );
}

export async function postgresHarness(): Promise<StoreHarness> {
  const admin = await adminClient();
  await admin.query(TRUNCATE);
  await seedCards(admin);

  const store: PostgresStore = createPostgresStore({ connectionString: databaseUrl() });

  return {
    name: "postgres store (src/db/store.ts)",
    store,
    reset: async () => {
      await admin.query(TRUNCATE);
    },
    newUserId: async (email) => {
      const { rows } = await admin.query<{ id: string }>(
        `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
        [email],
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error("auth.users insert returned no id");
      // Migration 0001's `on_auth_user_created` trigger has just made the pending profile row.
      // The contract exercises `profiles.create` itself — the path `resolveCaller` takes for a
      // user whose row is missing — so the trigger's row is removed here and asserted separately
      // in `postgres.spec.ts`, where it belongs.
      await admin.query(`delete from public.profiles where id = $1`, [id]);
      return id;
    },
    close: async () => {
      await store.close();
      await admin.end();
    },
    playableIds: PLAYABLE_IDS,
    tokenIds: TOKEN_IDS,
    catalogVersion: CATALOG_VERSION,
    now: () => Date.now(),
  };
}

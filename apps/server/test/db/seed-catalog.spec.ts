/**
 * `db:seed-catalog` against a real Postgres: `seedCatalog` writes the real
 * `packages/cards/catalog.json` into `public.cards`, where every migration's constraints apply.
 *
 * Before migration 0010, `cards_tags_check` (0002) did not admit 'Jlockeed', the tag R278 puts on
 * #13 and #14. The seed runs in one transaction, so those two rows failed the whole catalog.
 * `seed-catalog.test.ts` compares the tags with the migrations' text in `pnpm test`; this spec
 * checks that the database really accepts them.
 *
 * The rest of this suite runs against the harness's fixture catalog (`seedCards`), and its launch
 * grant gives every non-token card in `public.cards`. So `afterAll` removes the real catalog and
 * puts the fixture rows back, whichever spec file runs next.
 *
 * Run with `pnpm test:db`; `.spec.ts` keeps it out of `pnpm test`.
 */

import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";

import { readCatalog, seedCatalog } from "../../src/db/seed-catalog";
import { adminClient, CATALOG_VERSION, databaseUrl, seedCards } from "./harness";

const REAL_CATALOG = resolve(import.meta.dirname, "../../../../packages/cards/catalog.json");

/** The harness's truncate: every table but `public.cards`, including the three that reference it. */
const TRUNCATE = `truncate
  public.series, public.results, public.match_actions, public.tickets, public.matches,
  public.trios, public.decks,
  public.loadout_deck_cards, public.loadout_decks, public.loadouts,
  public.collection_grants, public.collection,
  public.code_attempts, public.invite_codes, public.profiles, auth.users
  restart identity cascade`;

async function restoreFixtureCatalog(admin: Client): Promise<void> {
  await admin.query(TRUNCATE);
  await admin.query("delete from public.cards");
  await seedCards(admin);
}

describe("R278 db:seed-catalog writes the real catalog, Jlockeed tags included", () => {
  let admin: Client;

  beforeAll(async () => {
    admin = await adminClient();
    await admin.query(TRUNCATE);
  });

  afterAll(async () => {
    await restoreFixtureCatalog(admin);
    await admin.end();
  });

  it("R278 seeds all 110 entries, with #13 and #14 tagged Jlockeed and no other row", async () => {
    const entries = await readCatalog(REAL_CATALOG);
    const written = await seedCatalog(databaseUrl(), CATALOG_VERSION, entries);
    expect(written).toBe(110);

    const { rows } = await admin.query<{ id: string; tags: string[]; catalog_version: string }>(
      `select id, tags, catalog_version from public.cards where id = any($1::text[]) order by id`,
      [entries.map((entry) => entry.id)],
    );
    expect(rows).toHaveLength(110);
    expect(rows.every((row) => row.catalog_version === CATALOG_VERSION)).toBe(true);
    expect(rows.filter((row) => row.tags.includes("Jlockeed")).map((row) => row.id)).toEqual([
      "core-013",
      "core-014",
    ]);
    // Each row's tags are the catalog's, so the check admitted them and nothing rewrote them.
    const byId = new Map(entries.map((entry) => [entry.id, entry.tags]));
    for (const row of rows) expect(row.tags, row.id).toEqual(byId.get(row.id));
  });

  it("R278 a second seed of the same catalog updates in place, and the tag check still refuses an unknown tag", async () => {
    const entries = await readCatalog(REAL_CATALOG);
    await expect(seedCatalog(databaseUrl(), CATALOG_VERSION, entries)).resolves.toBe(110);

    const [first] = entries;
    if (first === undefined) throw new Error("the catalog is empty");
    const refused = seedCatalog(databaseUrl(), CATALOG_VERSION, [{ ...first, tags: ["Jlocked"] }]);
    await expect(refused).rejects.toThrow(/cards_tags_check/);
    // One transaction: the refused seed left the row as the real catalog wrote it.
    const { rows } = await admin.query<{ tags: string[] }>(`select tags from public.cards where id = $1`, [
      first.id,
    ]);
    expect(rows[0]?.tags).toEqual(first.tags);
  });
});

// Catalog loader. Copies `packages/cards/catalog.json` into `public.cards`, stamping every row with
// CATALOG_VERSION.
//
// SPEC §9.4: "catalog is static, versioned, shipped with the client". The client renders card text
// from its own bundled copy; this table exists so `collection.card_id` and `loadout_deck_cards.card_id`
// have something to reference and so the server can run L6 ("every card exists in the current catalog
// version and is not banned") in SQL. Nothing here is a source of truth for card rules.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = resolve(HERE, "../../../../packages/cards/catalog.json");

/** The subset of BUILD M4-T1's per-card schema that `public.cards` stores. */
type CatalogEntry = {
  id: string;
  index: string;
  name: string;
  set: string;
  type: string;
  tags: string[];
  rarity: string;
  token: boolean;
  cost: unknown;
};

function isEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row["id"] === "string" &&
    typeof row["index"] === "string" &&
    typeof row["name"] === "string" &&
    typeof row["set"] === "string" &&
    typeof row["type"] === "string" &&
    Array.isArray(row["tags"]) &&
    row["tags"].every((tag) => typeof tag === "string") &&
    typeof row["rarity"] === "string" &&
    typeof row["token"] === "boolean" &&
    row["cost"] !== undefined
  );
}

/**
 * The three shapes a catalog file may arrive in, reduced to a list of entries. `undefined` means
 * none of the three.
 *
 * The third is the one that matters: `packages/cards/catalog.json` is a **record keyed by card
 * id**, which is what `CardDefs` is and what `src/api/catalog.ts` parses it as. Reading only an
 * array meant the seeder and the API disagreed about the shape of the one file they share, and
 * the seeder lost — `db:seed-catalog` could not load the real catalog at all.
 */
function catalogRows(parsed: unknown, path: string): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const wrapped = (parsed as { cards?: unknown }).cards;
  if (Array.isArray(wrapped)) return wrapped;

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return undefined;

  // The key and the entry's own `id` must agree. `seedCatalog` inserts `card.id`, so a record
  // that disagrees with itself would seed a row under an id nothing else in the catalog uses,
  // and `collection.card_id`'s foreign key would point at the wrong card rather than fail.
  for (const [key, value] of entries) {
    const id: unknown = (value as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id !== key) {
      throw new Error(
        `${path}: entry keyed ${JSON.stringify(key)} carries id ${JSON.stringify(id)}`,
      );
    }
  }
  return entries.map(([, value]) => value);
}

export async function readCatalog(path: string): Promise<CatalogEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `cannot read ${path}. packages/cards/catalog.json arrives with BUILD M4-T1; ` +
        `pass an explicit path as the first argument to seed a fixture catalog instead.`,
    );
  }

  const parsed: unknown = JSON.parse(text);
  const rows = catalogRows(parsed, path);
  if (rows === undefined) {
    throw new Error(
      `${path}: expected an array of cards, a { "cards": [...] } wrapper, or an object keyed ` +
        `by card id`,
    );
  }

  const entries: CatalogEntry[] = [];
  for (const [i, row] of rows.entries()) {
    if (!isEntry(row)) throw new Error(`${path}: entry ${i} does not match the M4-T1 card schema`);
    entries.push(row);
  }
  return entries;
}

export async function seedCatalog(
  connectionString: string,
  catalogVersion: string,
  entries: readonly CatalogEntry[],
): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    // One transaction: either the whole catalog version is present or none of it is, so a queue or
    // save request can never see half a catalog (§9.4, "stale catalog version is rejected").
    await client.query("begin");
    for (const card of entries) {
      await client.query(
        `insert into public.cards
           (id, card_index, name, set_id, type, tags, rarity, token, cost, catalog_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         on conflict (id) do update set
           card_index = excluded.card_index,
           name = excluded.name,
           set_id = excluded.set_id,
           type = excluded.type,
           tags = excluded.tags,
           rarity = excluded.rarity,
           token = excluded.token,
           cost = excluded.cost,
           catalog_version = excluded.catalog_version`,
        [
          card.id,
          card.index,
          card.name,
          card.set,
          card.type,
          card.tags,
          card.rarity,
          card.token,
          JSON.stringify(card.cost),
          catalogVersion,
        ],
      );
    }
    // The version the server and the client compare against (`app.assert_catalog_version`).
    await client.query(
      `insert into app.settings (key, value) values ('catalog_version', $1::jsonb)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(catalogVersion)],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  return entries.length;
}

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    throw new Error("DATABASE_URL is not set (see docs/architecture.md, env-var contract).");
  }
  const catalogVersion = process.env["CATALOG_VERSION"];
  if (catalogVersion === undefined || catalogVersion === "") {
    throw new Error("CATALOG_VERSION is not set (see docs/architecture.md, env-var contract).");
  }

  const path = process.argv[2] ?? DEFAULT_CATALOG;
  const entries = await readCatalog(path);
  const count = await seedCatalog(connectionString, catalogVersion, entries);
  process.stdout.write(`seed-catalog: wrote ${count} cards at catalog version ${catalogVersion}\n`);
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

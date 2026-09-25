/**
 * `readCatalog` against the file it actually has to read.
 *
 * `packages/cards/catalog.json` is a record keyed by card id — the `CardDefs` shape
 * `src/api/catalog.ts` parses — and the seeder used to accept only an array, so step 6 of
 * docs/architecture.md's bring-up checklist failed on the real catalog with "expected an array
 * of cards". Nothing caught it because no test read the real file. This one does.
 */

import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readCatalog } from "../../src/db/seed-catalog";

const REAL_CATALOG = resolve(import.meta.dirname, "../../../../packages/cards/catalog.json");
const MIGRATIONS = resolve(import.meta.dirname, "../../src/db/migrations");

/**
 * The tags `public.cards.cards_tags_check` admits once every migration has run: the array in the
 * last migration, in apply order, that adds the check. 0002 defines it and 0010 re-adds it.
 */
function admittedTags(): { file: string; tags: string[] } {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  let found: { file: string; tags: string[] } | undefined;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const match of sql.matchAll(/constraint\s+cards_tags_check\s+check\s*\(([\s\S]*?)\]::text\[\]/gi)) {
      const body = (match[1] ?? "").replace(/--[^\n]*/g, "");
      found = { file, tags: [...body.matchAll(/'([^']*)'/g)].map((tag) => tag[1] ?? "") };
    }
  }
  if (found === undefined) throw new Error(`no migration in ${MIGRATIONS} adds cards_tags_check`);
  return found;
}

/** A card that satisfies the M4-T1 subset `isEntry` checks. */
function card(id: string) {
  return {
    id,
    index: id.slice(-3),
    name: `Card ${id}`,
    set: "Core",
    type: "Unit",
    tags: ["Human"],
    rarity: "Common",
    token: false,
    cost: 2,
  };
}

async function fileHolding(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jackioh-catalog-"));
  const path = join(dir, "catalog.json");
  await writeFile(path, JSON.stringify(contents), "utf8");
  return path;
}

describe("readCatalog", () => {
  it("reads the real packages/cards/catalog.json: 110 entries (100 cards + 10 tokens)", async () => {
    const entries = await readCatalog(REAL_CATALOG);
    expect(entries).toHaveLength(110);
    expect(entries.filter((entry) => entry.token)).toHaveLength(10);
    expect(entries.map((entry) => entry.id)).toContain("core-001");
  });

  it("accepts a bare array and a { cards: [...] } wrapper too", async () => {
    expect(await readCatalog(await fileHolding([card("core-001")]))).toHaveLength(1);
    expect(await readCatalog(await fileHolding({ cards: [card("core-001")] }))).toHaveLength(1);
  });

  it("accepts a record keyed by card id", async () => {
    const entries = await readCatalog(await fileHolding({ "core-001": card("core-001") }));
    expect(entries.map((entry) => entry.id)).toEqual(["core-001"]);
  });

  /** `seedCatalog` inserts `card.id`, so a key that disagrees would seed the wrong row. */
  it("refuses a record whose key disagrees with the entry's own id", async () => {
    const path = await fileHolding({ "core-002": card("core-001") });
    await expect(readCatalog(path)).rejects.toThrow(/keyed "core-002" carries id "core-001"/);
  });

  it("still refuses a shape that is none of the three", async () => {
    await expect(readCatalog(await fileHolding({}))).rejects.toThrow(/expected an array of cards/);
    await expect(readCatalog(await fileHolding(7))).rejects.toThrow(/expected an array of cards/);
  });

  it("names the missing file rather than throwing an ENOENT", async () => {
    await expect(readCatalog("/nowhere/catalog.json")).rejects.toThrow(/cannot read/);
  });
});

/**
 * The seed writes the whole catalog in one transaction, so one tag the schema refuses fails every
 * row. 0002's check had no 'Jlockeed', and #13 and #14 broke `db:seed-catalog` against a real
 * database, which only Docker could see. This reads the migrations instead, so `pnpm test` catches a
 * tag that reaches the catalog before the schema. `pnpm test:sql` CHECK 18 and `pnpm test:db`
 * (seed-catalog.spec.ts) prove the same against Postgres.
 */
describe("R278 the catalog's tags and the cards table's tag check", () => {
  it("R278 every tag the real catalog carries, Jlockeed included, is one the latest cards_tags_check admits", async () => {
    const entries = await readCatalog(REAL_CATALOG);
    const { file, tags } = admittedTags();
    expect(file, "0010 re-adds the check with Jlockeed").toBe("0010_jlockeed_tag.sql");
    const carried = [...new Set(entries.flatMap((entry) => entry.tags))].sort();
    expect(carried).toContain("Jlockeed");
    expect(carried.filter((tag) => !tags.includes(tag)), "tags the schema would refuse").toEqual([]);
    // No stale name either: every tag the check admits is one some catalog entry carries.
    expect([...tags].sort()).toEqual(carried);
  });
});

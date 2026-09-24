/**
 * `readCatalog` against the file it actually has to read.
 *
 * `packages/cards/catalog.json` is a record keyed by card id — the `CardDefs` shape
 * `src/api/catalog.ts` parses — and the seeder used to accept only an array, so step 6 of
 * docs/architecture.md's bring-up checklist failed on the real catalog with "expected an array
 * of cards". Nothing caught it because no test read the real file. This one does.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readCatalog } from "../../src/db/seed-catalog";

const REAL_CATALOG = resolve(import.meta.dirname, "../../../../packages/cards/catalog.json");

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

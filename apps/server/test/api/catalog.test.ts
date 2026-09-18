// The catalog and validator bindings (src/api/catalog.ts, src/api/loadout-validator.ts): the two
// places the server reaches data and rules that live in other packages (SPEC §9.4).

import { describe, expect, it } from "vitest";

import {
  CatalogUnavailableError,
  catalogFrom,
  catalogUrl,
  loadCatalog,
  versionOf,
} from "../../src/api/catalog";
import { sharedLoadoutValidator } from "../../src/api/loadout-validator";

describe("catalog", () => {
  it("loads packages/cards/catalog.json through the workspace link", async () => {
    expect(catalogUrl().pathname).toContain("packages/cards/catalog.json");
    const catalog = await loadCatalog();
    // §8: 100 cards plus 9 tokens.
    expect(catalog.cardIds.length).toBe(109);
    expect(catalog.defs["core-001"]?.name.length).toBeGreaterThan(0);
  });

  it("derives a version from the catalog's own bytes, so it cannot drift from the data", () => {
    expect(versionOf("{}")).toMatch(/^c1-[0-9a-f]{12}$/);
    expect(versionOf("{}")).toBe(versionOf("{}"));
    expect(versionOf("{}")).not.toBe(versionOf("{ }"));
  });

  it("lets the environment pin the version instead (§9.4: both halves must agree)", async () => {
    const catalog = await loadCatalog({ version: "core-2026-09" });
    expect(catalog.version).toBe("core-2026-09");
  });

  it("marks tokens as tokens (§9.4 L3: no Token-tagged cards in a deck)", async () => {
    const catalog = await loadCatalog();
    const tokens = catalog.cardIds.filter((id) => catalog.isToken(id));
    expect(tokens.length).toBe(9);
  });

  it("refuses to invent a catalog when the file is missing or malformed", async () => {
    await expect(loadCatalog({ url: new URL("file:///nope/catalog.json") })).rejects.toThrow(
      CatalogUnavailableError,
    );
  });

  it("catalogFrom keeps the ban hook available for L6", () => {
    const catalog = catalogFrom({}, "v0");
    expect(catalog.cardIds).toEqual([]);
    expect(catalog.isBanned("core-001")).toBe(false);
  });
});

describe("loadout validator binding (§9.4: one module, shared)", () => {
  it("adapts the shared module's verdict without restating a rule", async () => {
    const catalog = await loadCatalog();
    const legal = catalog.cardIds.filter((id) => !catalog.isToken(id)).slice(0, 60);
    const owned = new Map(legal.map((cardId) => [cardId, 1] as const));

    const issues = sharedLoadoutValidator({
      decks: [legal.slice(0, 20), legal.slice(20, 40), legal.slice(40, 60)],
      catalogVersion: catalog.version,
      catalog,
      owned,
    });
    expect(issues).toEqual([]);

    // One deck short of DECK_SIZE: the shared module names the rule, the deck and the card.
    const short = sharedLoadoutValidator({
      decks: [legal.slice(0, 19), legal.slice(20, 40), legal.slice(40, 60)],
      catalogVersion: catalog.version,
      catalog,
      owned,
    });
    expect(short.map((issue) => issue.rule)).toContain("L2");
    expect(short[0]?.message.length).toBeGreaterThan(0);
  });

  it("reports a card the profile does not own (L5) rather than silently allowing it", async () => {
    const catalog = await loadCatalog();
    const legal = catalog.cardIds.filter((id) => !catalog.isToken(id)).slice(0, 60);
    const issues = sharedLoadoutValidator({
      decks: [legal.slice(0, 20), legal.slice(20, 40), legal.slice(40, 60)],
      catalogVersion: catalog.version,
      catalog,
      owned: new Map(),
    });
    expect(issues.map((issue) => issue.rule)).toContain("L5");
  });
});

// The catalog and validator bindings (src/api/catalog.ts, src/api/loadout-validator.ts): the two
// places the server reaches data and rules that live in other packages (SPEC §9.4).
//
// Two SPEC §11 rulings live here as well:
//   * R163 — the catalog endpoint a client that ships none can read: whole, unprojected,
//     unauthenticated, carrying R105's version.
//   * R164 — where L6's ban list lives: server state, never a flag on a card definition, read
//     through the catalog handle.

import { describe, expect, it } from "vitest";

import {
  CatalogUnavailableError,
  catalogFrom,
  catalogUrl,
  createCatalogRoutes,
  loadCatalog,
  versionOf,
} from "../../src/api/catalog";
import { createRouter, ok, route } from "../../src/api/http";
import type { CardDefs } from "@jackioh/shared";
import type { CatalogInfo } from "../../src/api/ports";
import { sharedLoadoutValidator } from "../../src/api/loadout-validator";
import { createTestDeps, jsonRequest, readJson } from "../fakes/deps";

describe("catalog", () => {
  it("loads packages/cards/catalog.json through the workspace link", async () => {
    expect(catalogUrl().pathname).toContain("packages/cards/catalog.json");
    const catalog = await loadCatalog();
    // §8: 100 cards plus 9 tokens.
    expect(catalog.cardIds.length).toBe(110);
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
    expect(tokens.length).toBe(10);
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

  it("R141 makes L5 unreachable on its own, given R111's launch grant of one copy of each", async () => {
    const catalog = await loadCatalog();
    const legal = catalog.cardIds.filter((id) => !catalog.isToken(id)).slice(0, 60);
    // R111's launch grant, exactly: one copy of every non-token card, which is what every active
    // profile owns. The test above owns *nothing*, which R111 makes impossible — so L5 on its own
    // is only reachable there, never in a real collection.
    const owned = new Map(catalog.cardIds.filter((id) => !catalog.isToken(id)).map((id) => [id, 1] as const));
    const token = catalog.cardIds.find((id) => catalog.isToken(id)) ?? "";
    const decks = (first: readonly string[]): string[][] => [
      [...first],
      legal.slice(20, 40),
      legal.slice(40, 60),
    ];

    const ways = [
      // A second copy of a card: L3 (MAX_COPIES) is broken before L5 can be.
      { name: "a repeated card", decks: decks([...legal.slice(0, 19), legal[0] ?? ""]) },
      // The same card in two decks: L4.
      { name: "a card in two decks", decks: [legal.slice(0, 20), [legal[0] ?? "", ...legal.slice(21, 40)], legal.slice(40, 60)] },
      // A Token, and an id the catalog does not have: L3 and L6.
      { name: "a token", decks: decks([...legal.slice(0, 19), token]) },
      { name: "an unknown id", decks: decks([...legal.slice(0, 19), "core-does-not-exist"]) },
    ];

    let sawL5 = false;
    for (const way of ways) {
      const rules = sharedLoadoutValidator({
        decks: way.decks,
        catalogVersion: catalog.version,
        catalog,
        owned,
      }).map((issue) => issue.rule);

      expect(rules, `${way.name} should be refused`).not.toEqual([]);
      // The ruling itself: whenever L5 fires against an R111 collection, the rule that made it
      // reachable fired too. Change R111's quantity or MAX_COPIES and this is the test that goes red.
      if (rules.includes("L5")) {
        sawL5 = true;
        expect(rules.filter((rule) => rule !== "L5"), `${way.name}: L5 was the only rule`).not.toEqual([]);
      }
    }
    // Otherwise the loop above would prove the claim by never reaching L5 at all.
    expect(sawL5, "no case reached L5, so this proves nothing").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R163 — "The catalog a client that ships none can read"
// ---------------------------------------------------------------------------

type CatalogBody = { version: string; defs: CardDefs };

describe("R163 — the catalog endpoint (§9.1, §9.4, R105)", () => {
  it("R163 serves the whole, unprojected catalog to a caller with no account at all", async () => {
    const catalog = await loadCatalog();
    const deps = createTestDeps({ catalog });
    // A second, `active` route on the same router, so "the anonymous call worked" is not just
    // "this router lets everybody through": §9.4's gate has to be demonstrably awake.
    const router = createRouter(
      [...createCatalogRoutes(), route("GET", "/api/collection", "active", async () => ok({}))],
      deps,
    );

    // PREMISE: the gate is on. The same request with no token is refused by the guarded route.
    const gated = await router(jsonRequest("GET", "/api/collection"));
    expect(gated.status).toBe(401);

    const response = await router(jsonRequest("GET", "/api/catalog"));
    expect(response.status).toBe(200);
    const body = await readJson<CatalogBody>(response);

    // R105's version, so a stale client learns it is stale before it builds a deck.
    expect(body.version).toBe(catalog.version);
    expect(body.version).toMatch(/^c1-[0-9a-f]{12}$/);

    // Whole: §8's 100 cards plus 9 tokens, every one of them.
    expect(Object.keys(body.defs)).toHaveLength(110);
    expect(body.defs).toEqual(catalog.defs);

    // Unprojected: not one field is trimmed off a card on the way out. A trimmed card would be a
    // second, weaker copy of the catalog, and the deckbuilder's verdict (UX) would stop being the
    // verdict the save runs (law).
    for (const cardId of Object.keys(catalog.defs)) {
      expect(Object.keys(body.defs[cardId] ?? {}).sort()).toEqual(
        Object.keys(catalog.defs[cardId] ?? {}).sort(),
      );
    }
  });

  it('R163 declares `auth: "none"`, like the file it stands in for', () => {
    const routes = createCatalogRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe("/api/catalog");
    // "The same bytes for everybody, naming no profile": §9.4's gate is about collection, loadout,
    // queue and match, and card data is none of those.
    expect(routes[0]?.auth).toBe("none");
  });

  it("R163 hands a pending account and an anonymous caller the identical bytes", async () => {
    const catalog = await loadCatalog();
    const deps = createTestDeps({ catalog });
    const router = createRouter(createCatalogRoutes(), deps);
    deps.store.seedProfile({ id: "pending", userId: "user-pending", status: "pending" });
    const token = deps.auth.addUser({ userId: "user-pending", email: "pending@example.test" });

    const anonymous = await router(jsonRequest("GET", "/api/catalog"));
    const pending = await router(jsonRequest("GET", "/api/catalog", undefined, { token }));

    expect(anonymous.status).toBe(200);
    expect(pending.status).toBe(200);
    // It names no profile, so it cannot differ by one.
    expect(await pending.text()).toBe(await anonymous.text());
  });
});

// ---------------------------------------------------------------------------
// R164 — "Where L6's ban list lives"
// ---------------------------------------------------------------------------

/** A ban held as server state: the catalog data is untouched, only the handle answers differently. */
function withBan(catalog: CatalogInfo, bannedId: string): CatalogInfo {
  return { ...catalog, isBanned: (cardId) => cardId === bannedId };
}

describe("R164 — where L6's ban list lives (§9.4, R105)", () => {
  it("R164 reads bannedness through the catalog handle, never off a card definition", async () => {
    const catalog = await loadCatalog();
    const playable = catalog.cardIds.filter((cardId) => !catalog.isToken(cardId)).slice(0, 60);
    const victim = playable[0] ?? "";
    const owned = new Map(playable.map((cardId) => [cardId, 1] as const));
    const decks = [playable.slice(0, 20), playable.slice(20, 40), playable.slice(40, 60)];

    // PREMISE: the loadout is legal today, so the L6 below comes from the ban and nothing else.
    expect(
      sharedLoadoutValidator({ decks, catalogVersion: catalog.version, catalog, owned }),
    ).toEqual([]);

    const banned = withBan(catalog, victim);
    const issues = sharedLoadoutValidator({
      decks,
      catalogVersion: banned.version,
      catalog: banned,
      owned,
    });

    // L6: "every card exists in the current catalog version and is not banned".
    expect(issues.map((issue) => issue.rule)).toContain("L6");
    expect(issues.find((issue) => issue.rule === "L6")?.cardId).toBe(victim);
  });

  it("R164 keeps a ban out of the catalog data, so R105's version does not move", async () => {
    const catalog = await loadCatalog();
    const victim = catalog.cardIds[0] ?? "";
    const banned = withBan(catalog, victim);

    // The failure R164 exists to prevent: a flag on the card would mean a new R105 version, and
    // §9.4's stale-version rejection would invalidate every saved loadout in the game at once.
    expect(banned.version).toBe(catalog.version);
    expect(banned.defs).toEqual(catalog.defs);
    expect(banned.cardIds).toEqual(catalog.cardIds);
    // A card definition carries no ban flag for anything to have been written to.
    for (const def of Object.values(catalog.defs)) {
      const keys = Object.keys(def as unknown as Record<string, unknown>);
      expect(keys.filter((key) => /ban/iu.test(key))).toEqual([]);
    }
  });

  it("R164 never hands the client a copy of the list: the served bytes do not change", async () => {
    const catalog = await loadCatalog();
    const victim = catalog.cardIds[0] ?? "";

    const serve = async (info: CatalogInfo): Promise<string> => {
      const router = createRouter(createCatalogRoutes(), createTestDeps({ catalog: info }));
      return (await router(jsonRequest("GET", "/api/catalog"))).text();
    };

    // R163's route carries the catalog both sides ship; R164 keeps the ban list out of it, so the
    // client has no copy of a list it has no business being able to disagree with.
    expect(await serve(withBan(catalog, victim))).toBe(await serve(catalog));
  });

  it("R164 bans nothing in §8 at launch, and holds the hook open for when something is", async () => {
    const catalog = await loadCatalog();
    // "Nothing in §8 is banned at launch" — every one of the 110, not just a sample.
    expect(catalog.cardIds.filter((cardId) => catalog.isBanned(cardId))).toEqual([]);
    // The single hook, which reads the db agent's `cards` table once there is something to ban.
    expect(catalogFrom({}, "v0").isBanned("core-001")).toBe(false);
  });
});

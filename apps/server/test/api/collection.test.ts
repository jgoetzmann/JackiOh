/**
 * SPEC §9.4's entitlement ledger, and §9.8's first row ("Claiming unowned cards → the collection
 * is server-owned").
 *
 * Two of BUILD M6-T2's three acceptance items are proved here:
 *  - "a grant with `reason` writes both tables or neither (fault-injection test)" — the fake
 *    store's `onCall` seam fails one of the two writes mid-transaction, once each way round;
 *  - "a direct insert attempt through the public API is impossible (no endpoint)" — asserted over
 *    the route table itself, so a mutating route cannot be added without this file going red.
 *
 * The third ('a stale `catalogVersion` gets "update required"') belongs to the loadout endpoints
 * and lives in `loadouts.test.ts`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createCollectionRoutes,
  grantCards,
  grantEntireCatalog,
  ownedMap,
} from "../../src/api/collection";
import { ApiError, createRouter } from "../../src/api/http";
import type { CatalogInfo } from "../../src/api/ports";
import {
  createTestCatalog,
  createTestDeps,
  jsonRequest,
  readJson,
  type TestDeps,
} from "../fakes/deps";

const PROFILE = "p1";
const USER = "u1";

let deps: TestDeps;
let token: string;

function activeProfile(target: TestDeps, id = PROFILE, userId = USER): string {
  target.store.seedProfile({ id, userId, status: "active" });
  return target.auth.addUser({ userId, email: `${id}@example.test` });
}

beforeEach(() => {
  deps = createTestDeps();
  token = activeProfile(deps);
});

describe("grantCards (§9.4: one transaction, both tables)", () => {
  it("writes both tables or neither: a fault on collection.appendGrants leaves collection unchanged", async () => {
    deps.store.onCall = (method) => {
      if (method === "collection.appendGrants") throw new Error("injected fault");
    };

    await expect(
      grantCards(deps, {
        profileId: PROFILE,
        entries: [{ cardId: "core-001", quantity: 1 }],
        reason: "reward",
      }),
    ).rejects.toThrow("injected fault");

    expect(deps.store.tables.collection).toEqual([]);
    expect(deps.store.tables.grants).toEqual([]);
  });

  it("writes both tables or neither: a fault on collection.upsertQuantities leaves grants unchanged", async () => {
    deps.store.onCall = (method) => {
      if (method === "collection.upsertQuantities") throw new Error("injected fault");
    };

    await expect(
      grantCards(deps, {
        profileId: PROFILE,
        entries: [{ cardId: "core-001", quantity: 1 }],
        reason: "reward",
      }),
    ).rejects.toThrow("injected fault");

    expect(deps.store.tables.grants).toEqual([]);
    expect(deps.store.tables.collection).toEqual([]);
  });

  it("the mirror case cannot pass by accident: a fault on either write rolls back an existing row too", async () => {
    await grantCards(deps, {
      profileId: PROFILE,
      entries: [{ cardId: "core-001", quantity: 1 }],
      reason: "reward",
    });
    const before = structuredClone(deps.store.tables.collection);

    deps.store.onCall = (method) => {
      if (method === "collection.appendGrants") throw new Error("injected fault");
    };
    await expect(
      grantCards(deps, {
        profileId: PROFILE,
        entries: [{ cardId: "core-001", quantity: 1 }],
        reason: "reward",
      }),
    ).rejects.toThrow("injected fault");

    expect(deps.store.tables.collection).toEqual(before);
    expect(deps.store.tables.grants).toHaveLength(1);
  });

  it("the happy path leaves matching rows in both tables and the grant carries the reason", async () => {
    await grantCards(deps, {
      profileId: PROFILE,
      entries: [
        { cardId: "core-001", quantity: 1 },
        { cardId: "core-002", quantity: 2 },
      ],
      reason: "reward",
    });

    expect(deps.store.tables.collection).toEqual([
      { profileId: PROFILE, cardId: "core-001", quantity: 1 },
      { profileId: PROFILE, cardId: "core-002", quantity: 2 },
    ]);
    expect(deps.store.tables.grants).toEqual([
      {
        profileId: PROFILE,
        cardId: "core-001",
        delta: 1,
        reason: "reward",
        at: deps.timers.now(),
      },
      {
        profileId: PROFILE,
        cardId: "core-002",
        delta: 2,
        reason: "reward",
        at: deps.timers.now(),
      },
    ]);
  });

  it("the ledger accumulates: a second grant adds to the quantity and appends its own row", async () => {
    const entries = [{ cardId: "core-001", quantity: 1 }];
    await grantCards(deps, { profileId: PROFILE, entries, reason: "reward" });
    await grantCards(deps, { profileId: PROFILE, entries, reason: "admin" });

    expect(await ownedMap(deps, PROFILE)).toEqual(new Map([["core-001", 2]]));
    expect(deps.store.tables.grants.map((row) => row.reason)).toEqual(["reward", "admin"]);
  });

  it("sums a card repeated inside one grant instead of writing it twice", async () => {
    await grantCards(deps, {
      profileId: PROFILE,
      entries: [
        { cardId: "core-001", quantity: 1 },
        { cardId: "core-001", quantity: 2 },
      ],
      reason: "reward",
    });

    expect(deps.store.tables.collection).toEqual([
      { profileId: PROFILE, cardId: "core-001", quantity: 3 },
    ]);
    expect(deps.store.tables.grants).toHaveLength(1);
  });

  it("refuses a delta that is not a positive whole number, and writes nothing", async () => {
    for (const quantity of [0, -1, 1.5]) {
      await expect(
        grantCards(deps, {
          profileId: PROFILE,
          entries: [{ cardId: "core-001", quantity }],
          reason: "reward",
        }),
      ).rejects.toBeInstanceOf(ApiError);
    }
    expect(deps.store.tables.collection).toEqual([]);
    expect(deps.store.tables.grants).toEqual([]);
  });

  it("an empty grant opens no transaction and appends no zero-delta row", async () => {
    let calls = 0;
    deps.store.onCall = () => {
      calls += 1;
    };
    await grantCards(deps, { profileId: PROFILE, entries: [], reason: "reward" });
    expect(calls).toBe(0);
    expect(deps.store.tables.grants).toEqual([]);
  });
});

describe("grantEntireCatalog (BUILD M6-T2: launch mode grants every card)", () => {
  it("grants every non-token, non-banned id exactly once", async () => {
    const banned = "core-003";
    const catalog: CatalogInfo = {
      ...createTestCatalog(),
      isBanned: (cardId) => cardId === banned,
    };
    const local = createTestDeps({ catalog });
    activeProfile(local);

    await grantEntireCatalog(local, PROFILE);

    const expected = catalog.cardIds.filter(
      (cardId) => !catalog.isToken(cardId) && cardId !== banned,
    );
    const owned = await ownedMap(local, PROFILE);
    expect([...owned.keys()].sort()).toEqual([...expected].sort());
    expect([...owned.values()].every((quantity) => quantity === 1)).toBe(true);
    expect(local.store.tables.grants).toHaveLength(expected.length);
  });

  it("skips tokens (§9.4 L3 bans them from a deck, so owning one is meaningless)", async () => {
    await grantEntireCatalog(deps, PROFILE);
    const owned = await ownedMap(deps, PROFILE);
    const tokens = deps.catalog.cardIds.filter((cardId) => deps.catalog.isToken(cardId));
    expect(tokens.length).toBeGreaterThan(0);
    for (const cardId of tokens) expect(owned.has(cardId)).toBe(false);
  });

  it("is idempotent: a second call neither doubles a quantity nor appends a duplicate row", async () => {
    await grantEntireCatalog(deps, PROFILE);
    const collection = structuredClone(deps.store.tables.collection);
    const grants = structuredClone(deps.store.tables.grants);

    await grantEntireCatalog(deps, PROFILE);

    expect(deps.store.tables.collection).toEqual(collection);
    expect(deps.store.tables.grants).toEqual(grants);
  });

  it("tops up a profile that already owns part of the catalog, without re-granting the rest", async () => {
    await grantCards(deps, {
      profileId: PROFILE,
      entries: [{ cardId: "core-001", quantity: 1 }],
      reason: "reward",
    });
    await grantEntireCatalog(deps, PROFILE);

    const forCore001 = deps.store.tables.grants.filter((row) => row.cardId === "core-001");
    expect(forCore001).toHaveLength(1);
    expect(forCore001[0]?.reason).toBe("reward");
    expect((await ownedMap(deps, PROFILE)).get("core-001")).toBe(1);
  });

  it("records the reason it was given, so the ledger distinguishes a launch grant", async () => {
    await grantEntireCatalog(deps, PROFILE, "admin");
    expect(new Set(deps.store.tables.grants.map((row) => row.reason))).toEqual(new Set(["admin"]));
  });
});

describe("ownedMap (§9.4 L5's input)", () => {
  it("is empty for a profile that owns nothing", async () => {
    expect(await ownedMap(deps, PROFILE)).toEqual(new Map());
  });

  it("does not leak another profile's entitlements", async () => {
    deps.store.seedProfile({ id: "p2", userId: "u2", status: "active" });
    await grantCards(deps, {
      profileId: "p2",
      entries: [{ cardId: "core-001", quantity: 1 }],
      reason: "reward",
    });
    expect(await ownedMap(deps, PROFILE)).toEqual(new Map());
    expect(await ownedMap(deps, "p2")).toEqual(new Map([["core-001", 1]]));
  });
});

describe("the routes (§9.4: no client path writes the collection)", () => {
  it("exposes GET /api/collection and nothing else", () => {
    const routes = createCollectionRoutes();
    expect(routes.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /api/collection",
    ]);
    expect(routes.every((entry) => entry.method === "GET")).toBe(true);
    expect(routes.every((entry) => entry.auth === "active")).toBe(true);
  });

  it("has no mutating route at all: POST, PUT, PATCH and DELETE are not routed", async () => {
    const router = createRouter(createCollectionRoutes(), deps);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await router(
        jsonRequest(method, "/api/collection", { cardId: "core-001", quantity: 99 }, { token }),
      );
      expect([404, 405]).toContain(response.status);
      expect(deps.store.tables.collection).toEqual([]);
      expect(deps.store.tables.grants).toEqual([]);
    }
  });

  it("GET returns the catalog version and the owned entries", async () => {
    await grantCards(deps, {
      profileId: PROFILE,
      entries: [
        { cardId: "core-002", quantity: 1 },
        { cardId: "core-001", quantity: 2 },
      ],
      reason: "reward",
    });

    const router = createRouter(createCollectionRoutes(), deps);
    const response = await router(jsonRequest("GET", "/api/collection", undefined, { token }));
    expect(response.status).toBe(200);
    expect(
      await readJson<{ catalogVersion: string; entries: { cardId: string; quantity: number }[] }>(
        response,
      ),
    ).toEqual({
      catalogVersion: deps.catalog.version,
      entries: [
        { cardId: "core-001", quantity: 2 },
        { cardId: "core-002", quantity: 1 },
      ],
    });
  });

  it("a pending account gets 403 (§9.4: no collection before an invite code is redeemed)", async () => {
    const local = createTestDeps();
    local.store.seedProfile({ id: PROFILE, userId: USER, status: "pending" });
    const pendingToken = local.auth.addUser({ userId: USER, email: "pending@example.test" });

    const router = createRouter(createCollectionRoutes(), local);
    const response = await router(
      jsonRequest("GET", "/api/collection", undefined, { token: pendingToken }),
    );
    expect(response.status).toBe(403);
    expect(
      (await readJson<{ error: { code: string } }>(response)).error.code,
    ).toBe("account_pending");
  });

  it("an unauthenticated request gets 401", async () => {
    const router = createRouter(createCollectionRoutes(), deps);
    const response = await router(jsonRequest("GET", "/api/collection"));
    expect(response.status).toBe(401);
  });
});

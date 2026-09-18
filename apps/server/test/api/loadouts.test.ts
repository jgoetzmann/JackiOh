/**
 * SPEC §9.4's loadout save and its queue-time re-check.
 *
 * What this file is NOT: a test of L1–L6. Those rules live in `@jackioh/validator` and are tested
 * there (BUILD M6-T3's "unit test per rule with the specific error message"). Here the validator
 * is a port, and the questions are the endpoint's own: is the catalog version current, is a
 * refusal whole, is a save all-or-nothing, and does a rejection name the deck and the card.
 *
 * Covers BUILD M6-T2's third acceptance item ('a stale `catalogVersion` gets "update required"')
 * and the port-level half of M6-T3's "the unique index rejects a duplicate across decks even when
 * the application check is bypassed" — the fake store's `loadouts.replace` mimics the unique index
 * on `(profile_id, card_id)`. The raw-SQL version of that test belongs to the db agent.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { grantEntireCatalog, ownedMap } from "../../src/api/collection";
import { loadCatalog } from "../../src/api/catalog";
import { sharedLoadoutValidator } from "../../src/api/loadout-validator";
import {
  createLoadoutRoutes,
  deckFor,
  saveLoadout,
  validateStoredLoadout,
} from "../../src/api/loadouts";
import { ApiError, createRouter } from "../../src/api/http";
import type { CatalogInfo, LoadoutIssue, StoredLoadout } from "../../src/api/ports";
import {
  createTestDeps,
  jsonRequest,
  readJson,
  strictTestValidator,
  type TestDeps,
} from "../fakes/deps";

const PROFILE = "p1";
const USER = "u1";

let deps: TestDeps;
let token: string;

/**
 * Three disjoint decks, sliced out of whatever playable ids the test catalog holds. The sizes are
 * deliberately not stated: L2's count is `@jackioh/validator`'s business, and the validator on
 * `deps` here is the permissive one, so a legal-to-this-file deck is only "distinct playable ids".
 */
function decksFrom(target: TestDeps): string[][] {
  const playable = target.catalog.cardIds.filter((cardId) => !target.catalog.isToken(cardId));
  const per = Math.floor(playable.length / 3);
  return [0, 1, 2].map((index) => playable.slice(index * per, (index + 1) * per));
}

function activeProfile(target: TestDeps, id = PROFILE, userId = USER): string {
  target.store.seedProfile({ id, userId, status: "active" });
  return target.auth.addUser({ userId, email: `${id}@example.test` });
}

async function apiError(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected the call to reject");
}

beforeEach(() => {
  deps = createTestDeps();
  token = activeProfile(deps);
});

describe('the catalog version (§9.4: "rejected at save and queue")', () => {
  it('a stale catalogVersion gets "update required" at save, and writes nothing', async () => {
    const error = await apiError(() =>
      saveLoadout(deps, {
        profileId: PROFILE,
        catalogVersion: "stale-0",
        decks: decksFrom(deps),
      }),
    );

    expect(error.code).toBe("update_required");
    expect(error.message).toBe("update required");
    expect(error.status).toBe(409);
    expect(deps.store.tables.loadouts).toEqual([]);
  });

  it('PUT /api/loadout answers 409 "update required" for a stale client', async () => {
    const router = createRouter(createLoadoutRoutes(), deps);
    const response = await router(
      jsonRequest(
        "PUT",
        "/api/loadout",
        { catalogVersion: "stale-0", decks: decksFrom(deps) },
        { token },
      ),
    );

    expect(response.status).toBe(409);
    const body = await readJson<{ error: { code: string; message: string } }>(response);
    expect(body.error.code).toBe("update_required");
    expect(body.error.message).toBe("update required");
    expect(deps.store.tables.loadouts).toEqual([]);
  });

  it("the version is checked on every save, not only the first", async () => {
    await saveLoadout(deps, {
      profileId: PROFILE,
      catalogVersion: deps.catalog.version,
      decks: decksFrom(deps),
    });
    const error = await apiError(() =>
      saveLoadout(deps, {
        profileId: PROFILE,
        catalogVersion: "stale-0",
        decks: decksFrom(deps),
      }),
    );
    expect(error.code).toBe("update_required");
    expect(deps.store.tables.loadouts[0]?.loadout.catalogVersion).toBe(deps.catalog.version);
  });

  it("rejects the same way at queue time when the request's version is stale", async () => {
    await saveLoadout(deps, {
      profileId: PROFILE,
      catalogVersion: deps.catalog.version,
      decks: decksFrom(deps),
    });

    const error = await apiError(() => validateStoredLoadout(deps, PROFILE, "stale-0"));
    expect(error.code).toBe("update_required");
    expect(error.message).toBe("update required");
  });

  it("rejects at queue time when the STORED loadout was saved under an older catalog version", async () => {
    // Seeded through the store, not the endpoint: the endpoint refuses to write a stale version in
    // the first place, so an aged row is the only way this state arises in production.
    await deps.store.loadouts.replace(PROFILE, "old-0", decksFrom(deps), 0);

    const error = await apiError(() =>
      validateStoredLoadout(deps, PROFILE, deps.catalog.version),
    );
    expect(error.code).toBe("update_required");
    expect(error.message).toBe("update required");
  });
});

describe("validation is the shared validator's job (§9.4)", () => {
  it("refuses the whole save when the validator returns issues, and leaves the table untouched", async () => {
    const strict = createTestDeps({ validateLoadout: strictTestValidator });
    activeProfile(strict);
    const decks = decksFrom(strict);

    // Nothing granted, so L5 ("copies across the loadout never exceed the quantity owned") fails.
    const error = await apiError(() =>
      saveLoadout(strict, {
        profileId: PROFILE,
        catalogVersion: strict.catalog.version,
        decks,
      }),
    );

    expect(error.code).toBe("loadout_invalid");
    expect(error.status).toBe(422);
    expect(strict.store.tables.loadouts).toEqual([]);

    // §9.4: "a queue-time failure names the deck and the card." The issues reach the client
    // exactly as the validator reported them: nothing here renumbers a deck index (ports.ts
    // documents `LoadoutIssue.deck` as 1-based, "exactly as `@jackioh/validator` reports it") or
    // recomposes a message, so the sentence the deckbuilder shows and the one the API returns are
    // the same string.
    const reported = strictTestValidator({
      decks,
      catalogVersion: strict.catalog.version,
      catalog: strict.catalog,
      owned: new Map(),
    });
    const issues = error.details as LoadoutIssue[];
    expect(issues).toEqual(reported);
    expect(error.message).toBe(reported[0]?.message);
    expect(issues[0]?.rule).toBe("L5");
    expect(issues[0]?.cardId).toBe(decks[0]?.[0]);
    expect(error.message).toContain(String(decks[0]?.[0]));
    // Every issue names a deck and a card, so the builder can highlight all of them at once.
    expect(issues.every((issue) => issue.deck !== undefined && issue.cardId !== undefined)).toBe(
      true,
    );
    // Failures beyond the first deck are reported too, not just the first one found.
    expect(new Set(issues.map((issue) => issue.deck)).size).toBe(3);
  });

  it("names the deck and the card at queue time as well", async () => {
    const strict = createTestDeps({ validateLoadout: strictTestValidator });
    activeProfile(strict);
    const decks = decksFrom(strict);
    await grantEntireCatalog(strict, PROFILE);
    await saveLoadout(strict, {
      profileId: PROFILE,
      catalogVersion: strict.catalog.version,
      decks,
    });

    // The collection is server-owned and can move after a save (§9.8): drop the entitlements and
    // the same stored loadout stops validating.
    strict.store.tables.collection.length = 0;

    const error = await apiError(() =>
      validateStoredLoadout(strict, PROFILE, strict.catalog.version),
    );
    expect(error.code).toBe("loadout_invalid");
    const issues = error.details as LoadoutIssue[];
    expect(issues).toEqual(
      strictTestValidator({
        decks,
        catalogVersion: strict.catalog.version,
        catalog: strict.catalog,
        owned: new Map(),
      }),
    );
    expect(issues[0]?.deck).toBeDefined();
    expect(issues[0]?.cardId).toBe(decks[0]?.[0]);
  });

  it("hands the validator the owned quantities, the catalog and the claimed version", async () => {
    const seen: { owned: number; version: string; catalogVersion: string; decks: number }[] = [];
    const spy = createTestDeps({
      validateLoadout: (input) => {
        seen.push({
          owned: input.owned.size,
          version: input.catalog.version,
          catalogVersion: input.catalogVersion,
          decks: input.decks.length,
        });
        return [];
      },
    });
    activeProfile(spy);
    await grantEntireCatalog(spy, PROFILE);

    await saveLoadout(spy, {
      profileId: PROFILE,
      catalogVersion: spy.catalog.version,
      decks: decksFrom(spy),
    });

    const playable = spy.catalog.cardIds.filter((cardId) => !spy.catalog.isToken(cardId));
    expect(seen).toEqual([
      {
        owned: playable.length,
        version: spy.catalog.version,
        catalogVersion: spy.catalog.version,
        decks: 3,
      },
    ]);
  });

  // R165: §9.4's L1 assumes a loadout exists and so cannot state this case, but the player is in
  // exactly the position L1 describes — they do not have three decks — and the remedy is the same.
  // The endpoint-level half (a 422 out of `POST /api/queue`, and the control that the same profile
  // queues fine once it has saved) is in `queue.test.ts`.
  it("R165 makes queueing without a saved loadout a loadout failure, not a missing resource", async () => {
    const error = await apiError(() =>
      validateStoredLoadout(deps, PROFILE, deps.catalog.version),
    );
    expect(error.code).toBe("loadout_invalid");
    // "A 404 would say the endpoint found nothing, sending a client looking for a route that is
    // working correctly" — so the status has to be the loadout one, not the missing-resource one.
    expect(error.status).toBe(422);
    expect(error.status).not.toBe(404);
    // Nor is it a staleness problem: only a catalog mismatch reports as stale.
    expect(error.code).not.toBe("stale_catalog");

    // The premise the refusal rests on: this profile really has saved nothing.
    expect(await deps.store.loadouts.get(PROFILE)).toBeNull();
  });

  it("returns the stored loadout when everything checks out at queue time", async () => {
    const strict = createTestDeps({ validateLoadout: strictTestValidator });
    activeProfile(strict);
    await grantEntireCatalog(strict, PROFILE);
    const decks = decksFrom(strict);
    await saveLoadout(strict, {
      profileId: PROFILE,
      catalogVersion: strict.catalog.version,
      decks,
    });

    const stored = await validateStoredLoadout(strict, PROFILE, strict.catalog.version);
    expect(stored.catalogVersion).toBe(strict.catalog.version);
    expect(stored.decks).toEqual(decks);
  });
});

describe("saving is all-or-nothing (§9.4: one transaction, no per-deck save)", () => {
  it("writes all three decks in one go and GET /api/loadout reads them back", async () => {
    const decks = decksFrom(deps);
    const router = createRouter(createLoadoutRoutes(), deps);

    const put = await router(
      jsonRequest("PUT", "/api/loadout", { catalogVersion: deps.catalog.version, decks }, { token }),
    );
    expect(put.status).toBe(200);
    expect((await readJson<{ loadout: StoredLoadout }>(put)).loadout.decks).toEqual(decks);

    // One row holding all three decks: there is no partial state to be in.
    expect(deps.store.tables.loadouts).toHaveLength(1);

    const get = await router(jsonRequest("GET", "/api/loadout", undefined, { token }));
    expect(get.status).toBe(200);
    expect(await readJson<{ catalogVersion: string; loadout: StoredLoadout }>(get)).toEqual({
      catalogVersion: deps.catalog.version,
      loadout: { catalogVersion: deps.catalog.version, decks, updatedAt: deps.timers.now() },
    });
  });

  it("GET answers null for a profile that has never saved", async () => {
    const router = createRouter(createLoadoutRoutes(), deps);
    const response = await router(jsonRequest("GET", "/api/loadout", undefined, { token }));
    expect(response.status).toBe(200);
    expect((await readJson<{ loadout: StoredLoadout | null }>(response)).loadout).toBeNull();
  });

  it("a fault on loadouts.replace leaves no partial row", async () => {
    deps.store.onCall = (method) => {
      if (method === "loadouts.replace") throw new Error("injected fault");
    };

    await expect(
      saveLoadout(deps, {
        profileId: PROFILE,
        catalogVersion: deps.catalog.version,
        decks: decksFrom(deps),
      }),
    ).rejects.toThrow("injected fault");

    expect(deps.store.tables.loadouts).toEqual([]);
  });

  it("a fault on a re-save leaves the previous loadout exactly as it was", async () => {
    const first = decksFrom(deps);
    await saveLoadout(deps, {
      profileId: PROFILE,
      catalogVersion: deps.catalog.version,
      decks: first,
    });

    deps.store.onCall = (method) => {
      if (method === "loadouts.replace") throw new Error("injected fault");
    };
    await expect(
      saveLoadout(deps, {
        profileId: PROFILE,
        catalogVersion: deps.catalog.version,
        decks: [first[2] ?? [], first[1] ?? [], first[0] ?? []],
      }),
    ).rejects.toThrow("injected fault");

    expect(deps.store.tables.loadouts[0]?.loadout.decks).toEqual(first);
  });

  it("L4's backstop: a card repeated across two decks is refused even with the application check bypassed", async () => {
    // `deps.validateLoadout` is `permissiveValidator`, so nothing in the application layer looks
    // at L4 here. The fake store enforces the unique index on `(profile_id, card_id)` exactly as
    // migration 0003 does, which is what §9.4 means by "also enforced by a unique index".
    const decks = decksFrom(deps);
    const shared = decks[0]?.[0] ?? "core-001";
    const withDuplicate = [decks[0] ?? [], [shared, ...(decks[1] ?? [])], decks[2] ?? []];

    expect(deps.validateLoadout({
      decks: withDuplicate,
      catalogVersion: deps.catalog.version,
      catalog: deps.catalog,
      owned: new Map(),
    })).toEqual([]);

    await expect(
      saveLoadout(deps, {
        profileId: PROFILE,
        catalogVersion: deps.catalog.version,
        decks: withDuplicate,
      }),
    ).rejects.toThrow(/unique/iu);

    expect(deps.store.tables.loadouts).toEqual([]);
  });
});

describe("deckFor (§9.4: the chosen deck is frozen into the ticket)", () => {
  const loadout: StoredLoadout = {
    catalogVersion: "test-1",
    decks: [["a"], ["b"], ["c"]],
    updatedAt: 0,
  };

  it("picks the deck at the 0-based index", () => {
    expect(deckFor(loadout, 0)).toEqual(["a"]);
    expect(deckFor(loadout, 1)).toEqual(["b"]);
    expect(deckFor(loadout, 2)).toEqual(["c"]);
  });

  it("returns a copy, so a frozen deck cannot alias the stored loadout", () => {
    const frozen = deckFor(loadout, 0);
    frozen.push("tampered");
    expect(loadout.decks[0]).toEqual(["a"]);
  });

  it("rejects an out-of-range or non-integer index with bad_request", () => {
    for (const index of [3, -1, 1.5, Number.NaN]) {
      let caught: unknown;
      try {
        deckFor(loadout, index);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("bad_request");
      expect((caught as ApiError).status).toBe(400);
    }
  });
});

describe("the routes (§9.4: a pending account sees no loadout)", () => {
  it("exposes GET and PUT /api/loadout, both gated on an active account", () => {
    const routes = createLoadoutRoutes();
    expect(routes.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /api/loadout",
      "PUT /api/loadout",
    ]);
    expect(routes.every((entry) => entry.auth === "active")).toBe(true);
  });

  it("a pending account gets 403 from both routes", async () => {
    const local = createTestDeps();
    local.store.seedProfile({ id: PROFILE, userId: USER, status: "pending" });
    const pendingToken = local.auth.addUser({ userId: USER, email: "pending@example.test" });
    const router = createRouter(createLoadoutRoutes(), local);

    const get = await router(
      jsonRequest("GET", "/api/loadout", undefined, { token: pendingToken }),
    );
    expect(get.status).toBe(403);
    expect((await readJson<{ error: { code: string } }>(get)).error.code).toBe("account_pending");

    const put = await router(
      jsonRequest(
        "PUT",
        "/api/loadout",
        { catalogVersion: local.catalog.version, decks: decksFrom(local) },
        { token: pendingToken },
      ),
    );
    expect(put.status).toBe(403);
    expect(local.store.tables.loadouts).toEqual([]);
  });

  it("rejects a malformed PUT body before touching the store", async () => {
    const router = createRouter(createLoadoutRoutes(), deps);
    for (const body of [
      {},
      { catalogVersion: "test-1" },
      { catalogVersion: "test-1", decks: "nope" },
      { catalogVersion: "test-1", decks: [["core-001"], "nope"] },
      { catalogVersion: 7, decks: [] },
    ]) {
      const response = await router(jsonRequest("PUT", "/api/loadout", body, { token }));
      expect(response.status).toBe(400);
    }
    expect(deps.store.tables.loadouts).toEqual([]);
  });

  it("one profile's PUT never reaches another profile's loadout", async () => {
    deps.store.seedProfile({ id: "p2", userId: "u2", status: "active" });
    const otherToken = deps.auth.addUser({ userId: "u2", email: "p2@example.test" });
    const router = createRouter(createLoadoutRoutes(), deps);
    const decks = decksFrom(deps);

    await router(
      jsonRequest("PUT", "/api/loadout", { catalogVersion: deps.catalog.version, decks }, { token }),
    );
    const get = await router(
      jsonRequest("GET", "/api/loadout", undefined, { token: otherToken }),
    );
    expect((await readJson<{ loadout: StoredLoadout | null }>(get)).loadout).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L1–L6 through the production wiring
// ---------------------------------------------------------------------------

/**
 * Everything above runs on `permissiveValidator`, which is the right double for the questions it
 * asks (see `test/fakes/deps.ts`) but means the save path never actually refuses a deck. This block
 * closes that: the real §8 catalog (`loadCatalog()`), the real adapter (`sharedLoadoutValidator`),
 * the real route — the composition root's wiring, in memory — and one illegal loadout per rule.
 *
 * It does not re-test L1–L6 themselves; `packages/validator` does that, rule by rule and message by
 * message. The question here is the join: does an illegal deck reach the store anyway, and does the
 * refusal carry the shared module's own sentence out to the client. So no message is typed out
 * below — every expectation is the verdict `sharedLoadoutValidator` gives for the same input, which
 * is the only way to assert "the validator's own message" without making a second copy of it.
 */
describe("the real validator through the real save route (§9.4 L1–L6)", () => {
  let realCatalog: CatalogInfo;

  beforeAll(async () => {
    realCatalog = await loadCatalog();
  });

  /**
   * Three legal decks of real cards. The deck size is deliberately not spelled: BUILD §2 keeps
   * `DECK_SIZE` in the engine's config and nothing restates it, so this grows three slices of the
   * pool until the shared module stops objecting and lets the number be the module's. Failing to
   * find one is a failure in itself — every test below rests on a legal loadout existing.
   */
  async function legalDecks(target: TestDeps): Promise<string[][]> {
    const pool = target.catalog.cardIds.filter(
      (cardId) => !target.catalog.isToken(cardId) && !target.catalog.isBanned(cardId),
    );
    const owned = await ownedMap(target, PROFILE);
    for (let size = 1; size * 3 <= pool.length; size += 1) {
      const decks = [0, 1, 2].map((index) => pool.slice(index * size, (index + 1) * size));
      const issues = sharedLoadoutValidator({
        decks,
        catalogVersion: target.catalog.version,
        catalog: target.catalog,
        owned,
      });
      if (issues.length === 0) return decks;
    }
    throw new Error("no legal loadout could be built from the real catalog");
  }

  /** The production wiring: real catalog, real adapter, R111's launch grant, an active profile. */
  async function realWiring(): Promise<{ real: TestDeps; realToken: string; decks: string[][] }> {
    const real = createTestDeps({
      catalog: realCatalog,
      validateLoadout: sharedLoadoutValidator,
    });
    const realToken = activeProfile(real);
    await grantEntireCatalog(real, PROFILE);
    return { real, realToken, decks: await legalDecks(real) };
  }

  async function put(
    target: TestDeps,
    bearer: string,
    decks: readonly (readonly string[])[],
  ): Promise<Response> {
    const router = createRouter(createLoadoutRoutes(), target);
    return router(
      jsonRequest(
        "PUT",
        "/api/loadout",
        { catalogVersion: target.catalog.version, decks },
        { token: bearer },
      ),
    );
  }

  /** What the shared module says about this input, for the route's answer to be compared against. */
  async function issuesFor(
    target: TestDeps,
    decks: readonly (readonly string[])[],
  ): Promise<LoadoutIssue[]> {
    return sharedLoadoutValidator({
      decks,
      catalogVersion: target.catalog.version,
      catalog: target.catalog,
      owned: await ownedMap(target, PROFILE),
    });
  }

  type ErrorBody = { error: { code: string; message: string; details: LoadoutIssue[] } };

  /**
   * The shape every rule below is asserted in: refused 422 with `loadout_invalid`, the shared
   * module's own issues passed through untouched, its first sentence as the message, the rule and
   * the card named — and not a row written.
   */
  async function expectRefusal(
    target: TestDeps,
    bearer: string,
    decks: readonly (readonly string[])[],
    rule: string,
    cardId: string,
  ): Promise<void> {
    const response = await put(target, bearer, decks);
    const body = await readJson<ErrorBody>(response);
    const expected = await issuesFor(target, decks);

    // PREMISE: the shared module really refuses this loadout, and for the rule named.
    expect(expected[0]?.rule, `the validator's first issue for ${rule}`).toBe(rule);

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("loadout_invalid");
    // Passed through as reported: no renumbering, no recomposed sentence (§9.4 names the deck and
    // the card, and the deckbuilder wants every failure at once).
    expect(body.error.details).toEqual(expected);
    expect(body.error.message).toBe(expected[0]?.message);
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(expected[0]?.cardId).toBe(cardId);
    expect(body.error.message).toContain(cardId);
    // The save is all-or-nothing, and an illegal loadout never becomes a partial one.
    expect(target.store.tables.loadouts).toEqual([]);
  }

  it("the premise: a legal loadout of real cards saves through the real validator", async () => {
    const { real, realToken, decks } = await realWiring();

    const response = await put(real, realToken, decks);

    expect(response.status).toBe(200);
    expect((await readJson<{ loadout: StoredLoadout }>(response)).loadout.decks).toEqual(decks);
    expect(real.store.tables.loadouts).toHaveLength(1);
  });

  it("L2 refuses an oversized deck, with the validator's own message", async () => {
    const { real, realToken, decks } = await realWiring();
    // A card the loadout does not already hold, so the only thing wrong is the count.
    const spare =
      real.catalog.cardIds.find(
        (cardId) => !real.catalog.isToken(cardId) && !decks.flat().includes(cardId),
      ) ?? "";
    expect(spare).not.toBe("");
    const oversized = [[...(decks[0] ?? []), spare], decks[1] ?? [], decks[2] ?? []];

    const response = await put(real, realToken, oversized);
    const body = await readJson<ErrorBody>(response);
    const expected = await issuesFor(real, oversized);

    expect(expected[0]?.rule).toBe("L2");
    expect(response.status).toBe(422);
    expect(body.error.code).toBe("loadout_invalid");
    expect(body.error.details).toEqual(expected);
    expect(body.error.message).toBe(expected[0]?.message);
    // L2 is a whole-deck failure, so it names the deck rather than a card (§9.4).
    expect(expected[0]?.deck).toBe(1);
    expect(expected[0]?.cardId).toBeUndefined();
    expect(real.store.tables.loadouts).toEqual([]);
  });

  it("L4 refuses a card repeated across two decks in the application layer, before the unique index", async () => {
    const { real, realToken, decks } = await realWiring();
    const shared = decks[0]?.[0] ?? "";
    const duplicated = [decks[0] ?? [], [shared, ...(decks[1] ?? []).slice(1)], decks[2] ?? []];

    await expectRefusal(real, realToken, duplicated, "L4", shared);

    // The point of doing it here rather than with the permissive validator: with the real module
    // wired in, the refusal is the validator's 422 and the store is never reached, so the unique
    // index on `(profile_id, card_id)` stays the backstop it is meant to be and not the check.
    // (The backstop itself is tested above, with the application check deliberately absent.)
    expect(real.store.tables.loadouts).toEqual([]);
  });

  it("L3 refuses a Token-tagged card, with the validator's own message", async () => {
    const { real, realToken, decks } = await realWiring();
    const token = real.catalog.cardIds.find((cardId) => real.catalog.isToken(cardId)) ?? "";
    expect(token).not.toBe("");
    const withToken = [[token, ...(decks[0] ?? []).slice(1)], decks[1] ?? [], decks[2] ?? []];

    await expectRefusal(real, realToken, withToken, "L3", token);
  });

  it("L6 refuses an id the catalog does not have, with the validator's own message", async () => {
    const { real, realToken, decks } = await realWiring();
    const unknown = "core-does-not-exist";
    expect(real.catalog.cardIds).not.toContain(unknown);
    const withUnknown = [[unknown, ...(decks[0] ?? []).slice(1)], decks[1] ?? [], decks[2] ?? []];

    await expectRefusal(real, realToken, withUnknown, "L6", unknown);
    // L6's sentence quotes the version the id was not found in, so a stale client can tell the two
    // refusals apart (a missing card, versus the 409 `assertCurrentCatalog` raises).
    expect((await issuesFor(real, withUnknown))[0]?.message).toContain(real.catalog.version);
  });

  it("L5 refuses the same stored loadout at queue time once the collection moves", async () => {
    // §9.4: "at save and again at queue", because the collection is server-owned and can change
    // after a save. This is the one rule the save path cannot reach on its own — R141: against
    // R111's launch grant of one copy of each, L5 never fires alone — so it is asked here, where
    // the entitlements are taken away between the two checks.
    const { real, realToken, decks } = await realWiring();
    expect((await put(real, realToken, decks)).status).toBe(200);

    real.store.tables.collection.length = 0;

    const error = await apiError(() =>
      validateStoredLoadout(real, PROFILE, real.catalog.version),
    );

    const expected = await issuesFor(real, decks);
    expect(expected[0]?.rule).toBe("L5");
    expect(error.code).toBe("loadout_invalid");
    expect(error.status).toBe(422);
    expect(error.details).toEqual(expected);
    expect(error.message).toBe(expected[0]?.message);
    expect(error.message).toContain(decks[0]?.[0] ?? "");
    // The stored loadout is untouched: a queue-time refusal reports, it does not edit.
    expect(real.store.tables.loadouts[0]?.loadout.decks).toEqual(decks);
  });
});

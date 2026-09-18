/**
 * BUILD M8's `E2E=1` test server: the in-memory `Store`, R111's launch-grant trigger, R144's
 * reseed, the fixture `AuthProvider`, R143's optional seed and the CORS wrapper.
 *
 * The invite-gate assertions here are the unit-test half of `e2e/cypress/e2e/10-invite-gate.cy.ts`:
 * that spec activates the pending fixture account and spends the good code, so without R144 it
 * passes once and fails on every later run. Running the reseed twice and then redeeming twice is
 * the whole of that claim, and it is checked here rather than in Cypress because a spec cannot
 * restart the server it is talking to.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createAuthRoutes } from "../../src/api/auth";
import { createCatalogRoutes } from "../../src/api/catalog";
import { createCodesRoutes } from "../../src/api/codes";
import { createCollectionRoutes, LAUNCH_COPIES, LAUNCH_GRANT_REASON } from "../../src/api/collection";
import { isOriginAllowed, withCors } from "../../src/api/cors";
import {
  createE2EAuth,
  seedE2EFixtures,
  E2E_ACCOUNTS,
  E2E_INVITE_CODES,
  type E2EAccount,
} from "../../src/api/e2e";
import { createE2EStore, type E2EStore } from "../../src/api/e2e-store";
import { ApiError, createRouter, type Route, type Router } from "../../src/api/http";
import { createQueueRoutes, e2eSeedCount } from "../../src/api/queue";
import { systemTimers, type CatalogInfo, type ServerDeps } from "../../src/api/ports";
import { REDEMPTION_IDENTICAL_ERROR } from "../../src/config";
import {
  createFakeMatchDirectory,
  createTestDeps,
  jsonRequest,
  readJson,
  type FakeMatchDirectory,
} from "../fakes/deps";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAYABLE = ["core-001", "core-002", "core-003", "core-004"];
const TOKEN = "token-sheep";
const BANNED = "core-666";

/** §9.4 L3 bans Tokens from a deck and L6 bans banned ids, so R111 grants neither. */
function grantCatalog(version = "test-1"): CatalogInfo {
  return {
    version,
    defs: {},
    cardIds: [...PLAYABLE, TOKEN, BANNED],
    isToken: (cardId) => cardId === TOKEN,
    isBanned: (cardId) => cardId === BANNED,
  };
}

type Harness = {
  deps: ServerDeps;
  store: E2EStore;
  matches: FakeMatchDirectory;
  router: Router;
};

/**
 * A runtime with end-to-end mode's two ports and the real routes on top. The clock is the system
 * clock because §9.4's response padding is scheduled through the `Timers` port and a request in
 * flight cannot advance a manual one; `testLimits()`'s floor is 20 ms, so the suite stays fast.
 */
function harness(options: { catalog?: CatalogInfo; e2e?: boolean; routes?: Route[] } = {}): Harness {
  const catalog = options.catalog ?? grantCatalog();
  const store = createE2EStore({ catalog, now: systemTimers.now });
  const matches = createFakeMatchDirectory();
  const deps: ServerDeps = {
    ...createTestDeps({ timers: systemTimers }),
    store,
    auth: createE2EAuth(),
    catalog,
    matches,
    e2e: options.e2e ?? true,
  };
  const routes =
    options.routes ??
    [...createAuthRoutes(), ...createCatalogRoutes(), ...createCodesRoutes(), ...createCollectionRoutes()];
  return { deps, store, matches, router: createRouter(routes, deps) };
}

function account(userId: string): E2EAccount {
  const found = E2E_ACCOUNTS.find((candidate) => candidate.userId === userId);
  if (found === undefined) throw new Error(`no fixture account ${userId}`);
  return found;
}

const PENDING = account("e2e-pending");
const P1 = account("e2e-p1");

type RedeemBody = {
  status?: string;
  needsInviteCode?: boolean;
  error?: { code: string; message: string; details?: unknown };
};

function redeem(h: Harness, code: string, token = PENDING.token): Promise<Response> {
  return h.router(jsonRequest("POST", "/api/codes/redeem", { code }, { token }));
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe("the end-to-end Store", () => {
  it("rolls a transaction back when the callback throws, so a partial write cannot survive", async () => {
    const { store } = harness();
    const profile = await store.profiles.create({
      userId: "u1",
      email: "u1@example.test",
      rating: 1000,
      at: 1,
    });

    await expect(
      store.tx(async (t) => {
        await t.profiles.setInMatch(profile.id, "match-1");
        await t.collection.upsertQuantities(profile.id, [{ cardId: "core-001", quantity: 3 }]);
        throw new Error("the second write failed");
      }),
    ).rejects.toThrow("the second write failed");

    expect((await store.profiles.getById(profile.id))?.inMatchId).toBeNull();
    expect(await store.collection.get(profile.id)).toEqual([]);
  });

  it("commits a transaction that returns, and lets a nested tx join it", async () => {
    const { store } = harness();
    const profile = await store.profiles.create({
      userId: "u1",
      email: "u1@example.test",
      rating: 1000,
      at: 1,
    });

    await store.tx(async (t) => {
      await t.profiles.setInMatch(profile.id, "match-1");
      await t.tx(async (inner) => {
        await inner.collection.upsertQuantities(profile.id, [{ cardId: "core-001", quantity: 2 }]);
      });
    });

    expect((await store.profiles.getById(profile.id))?.inMatchId).toBe("match-1");
    expect(await store.collection.get(profile.id)).toEqual([{ cardId: "core-001", quantity: 2 }]);
  });

  it("claims an invite code once (§9.4 step 6: two callers cannot both win the last use)", async () => {
    const { store } = harness();
    await store.codes.insert({
      id: "code-1",
      codeHash: "hash-1",
      maxUses: 1,
      uses: 0,
      revoked: false,
      expiresAt: null,
      createdAt: 0,
    });
    const [first, second] = await Promise.all([
      store.codes.claim("code-1", 10),
      store.codes.claim("code-1", 10),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await store.codes.findByHash("hash-1"))?.uses).toBe(1);
  });

  it("claims a room once (§9.5: the loser of a join race gets nothing)", async () => {
    const { store } = harness();
    await store.rooms.create({
      code: "ABCDEF",
      hostProfileId: "host",
      hostDeck: [],
      catalogVersion: "test-1",
      createdAt: 0,
      expiresAt: 1_000,
      guestProfileId: null,
      matchId: null,
    });
    expect(await store.rooms.claim("ABCDEF", "guest-a", "match-a", 1)).not.toBeNull();
    expect(await store.rooms.claim("ABCDEF", "guest-b", "match-b", 1)).toBeNull();
    // ...and an expired room is not joinable at all.
    expect(await store.rooms.claim("ABCDEF", "guest-c", "match-c", 2_000)).toBeNull();
  });

  it("claims a pair of tickets in one statement (§9.5) and refuses a second pairing", async () => {
    const { store } = harness();
    const ticket = (id: string, profileId: string) => ({
      id,
      profileId,
      rating: 1000,
      deck: [],
      catalogVersion: "test-1",
      enqueuedAt: 0,
      status: "open" as const,
      matchId: null,
    });
    await store.tickets.insert(ticket("t1", "p1"));
    await store.tickets.insert(ticket("t2", "p2"));
    await store.tickets.insert(ticket("t3", "p3"));

    expect(await store.tickets.claimPair("t1", "t2", "match-1", 1)).toBe(true);
    // t1 is already matched, so no second matcher can pair it with anyone.
    expect(await store.tickets.claimPair("t1", "t3", "match-2", 1)).toBe(false);
    expect((await store.tickets.get("t3"))?.status).toBe("open");
    expect(await store.tickets.countOpen()).toBe(1);
  });

  it("refuses a second open ticket for one profile (`tickets_profile_queued_key`)", async () => {
    const { store } = harness();
    const ticket = (id: string) => ({
      id,
      profileId: "p1",
      rating: 1000,
      deck: [],
      catalogVersion: "test-1",
      enqueuedAt: 0,
      status: "open" as const,
      matchId: null,
    });
    await store.tickets.insert(ticket("t1"));
    await expect(store.tickets.insert(ticket("t2"))).rejects.toThrow(/already queued/u);
  });

  it("refuses a card id in two decks (§9.4 L4's unique index) and a replayed match seq (§9.3)", async () => {
    const { store } = harness();
    await expect(
      store.loadouts.replace("p1", "test-1", [["core-001"], ["core-001"]], 0),
    ).rejects.toThrow(/loadout_card_unique/u);

    await store.matches.appendActions([
      { matchId: "m1", seq: 1, action: { type: "endTurn" } as never, at: 0 },
    ]);
    await expect(
      store.matches.appendActions([
        { matchId: "m1", seq: 1, action: { type: "endTurn" } as never, at: 0 },
      ]),
    ).rejects.toThrow(/append-only/u);
  });
});

// ---------------------------------------------------------------------------
// R111
// ---------------------------------------------------------------------------

describe("R111 — the launch grant on `pending → active`", () => {
  it("grants one copy of every non-token, unbanned card and writes both tables", async () => {
    const { store } = harness();
    const profile = await store.profiles.create({
      userId: "u1",
      email: "u1@example.test",
      rating: 1000,
      at: 1,
    });

    expect(await store.collection.get(profile.id)).toEqual([]);
    await store.profiles.setStatus(profile.id, "active");

    const entries = await store.collection.get(profile.id);
    expect(entries.map((entry) => entry.cardId).sort()).toEqual([...PLAYABLE].sort());
    for (const entry of entries) expect(entry.quantity).toBe(LAUNCH_COPIES);

    // §9.4: "Every collection change writes `collection` and `collection_grants`."
    const grants = store.grantsFor(profile.id);
    expect(grants).toHaveLength(PLAYABLE.length);
    for (const grant of grants) {
      expect(grant.delta).toBe(LAUNCH_COPIES);
      expect(grant.reason).toBe(LAUNCH_GRANT_REASON);
    }
  });

  it("is idempotent: a second `pending → active` transition writes no row at all", async () => {
    const { store } = harness();
    const profile = await store.profiles.create({
      userId: "u1",
      email: "u1@example.test",
      rating: 1000,
      at: 1,
    });

    await store.profiles.setStatus(profile.id, "active");
    const afterFirst = await store.collection.get(profile.id);
    const grantsAfterFirst = store.grantsFor(profile.id).length;

    // Back to pending and active again: the trigger fires, the deltas are all zero, and
    // `collection_grants.delta <> 0` means nothing may be appended.
    await store.profiles.setStatus(profile.id, "pending");
    await store.profiles.setStatus(profile.id, "active");

    expect(await store.collection.get(profile.id)).toEqual(afterFirst);
    expect(store.grantsFor(profile.id)).toHaveLength(grantsAfterFirst);
  });

  it("does not fire on any other status change", async () => {
    const { store } = harness();
    const profile = await store.profiles.create({
      userId: "u1",
      email: "u1@example.test",
      rating: 1000,
      at: 1,
    });
    await store.profiles.setStatus(profile.id, "banned");
    expect(await store.collection.get(profile.id)).toEqual([]);
    expect(store.grantsFor(profile.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R144
// ---------------------------------------------------------------------------

describe("R144 — the reseed at boot", () => {
  it("seeds the three fixture accounts, two of them active and owning every card", async () => {
    const h = harness();
    await seedE2EFixtures(h.deps, h.store);

    for (const fixture of E2E_ACCOUNTS) {
      const profile = await h.store.profiles.getByUserId(fixture.userId);
      expect(profile, `${fixture.userId} has a profile`).not.toBeNull();
      expect(profile?.status).toBe(fixture.status);
      const owned = await h.store.collection.get(profile?.id ?? "");
      // A6: `e2e-p1` and `e2e-p2` "own every card"; `e2e-pending` owns nothing until it redeems.
      expect(owned).toHaveLength(fixture.status === "active" ? PLAYABLE.length : 0);
    }
  });

  it("seeds the good, expired and exhausted codes, and never the missing one", async () => {
    const h = harness();
    await seedE2EFixtures(h.deps, h.store);

    const byKind = async (code: string) => h.store.codes.findByHash(h.deps.hashes.code(code));
    expect(await byKind(E2E_INVITE_CODES.good)).not.toBeNull();
    expect(await byKind(E2E_INVITE_CODES.expired)).not.toBeNull();
    expect(await byKind(E2E_INVITE_CODES.exhausted)).not.toBeNull();
    // The whole point of the "missing" fixture: spec 10's first failure kind is a lookup miss.
    expect(await byKind(E2E_INVITE_CODES.missing)).toBeNull();

    const expired = await byKind(E2E_INVITE_CODES.expired);
    expect(expired?.expiresAt).not.toBeNull();
    expect(expired?.expiresAt ?? Number.MAX_SAFE_INTEGER).toBeLessThan(h.deps.timers.now());

    const exhausted = await byKind(E2E_INVITE_CODES.exhausted);
    expect(exhausted?.uses).toBeGreaterThanOrEqual(exhausted?.maxUses ?? 0);
  });

  it("hashes a code the way a typed one is hashed, so formatting and case cannot miss it", async () => {
    const h = harness();
    await seedE2EFixtures(h.deps, h.store);
    const typed = E2E_INVITE_CODES.good.toLowerCase().replaceAll("-", " ");
    expect(await h.store.codes.findByHash(h.deps.hashes.code(typed))).not.toBeNull();
  });

  it("is repeatable: reseeding twice, the good code still activates once and then conflicts", async () => {
    const h = harness();
    // R144: "the server reseeds ... at boot". Two boots.
    await seedE2EFixtures(h.deps, h.store);
    const first = await seedE2EFixtures(h.deps, h.store);
    expect(first.grantedCards).toBe(PLAYABLE.length);

    const pendingProfile = await h.store.profiles.getByUserId(PENDING.userId);
    expect(pendingProfile?.status, "the reseed put it back to pending").toBe("pending");

    // Spec 10's three failure kinds first, which is also §9.4's per-profile attempt budget being
    // respected: three failures plus one success is four logged attempts.
    for (const code of [
      E2E_INVITE_CODES.missing,
      E2E_INVITE_CODES.expired,
      E2E_INVITE_CODES.exhausted,
    ]) {
      const response = await redeem(h, code);
      expect(response.status).toBe(400);
      const body = await readJson<RedeemBody>(response);
      expect(body.error?.code).toBe("invalid_code");
      expect(body.error?.message).toBe(REDEMPTION_IDENTICAL_ERROR);
      expect(body.error?.details, "§9.4 keeps the operator-facing reason out of the client").toBeUndefined();
    }

    const good = await redeem(h, E2E_INVITE_CODES.good);
    expect(good.status).toBe(200);
    expect(await readJson<RedeemBody>(good)).toEqual({ status: "active", needsInviteCode: false });

    // R111/R145: an already-active account is a conflict about the *account*, reported distinctly
    // from the three code failures because it leaks nothing about the code space.
    const again = await redeem(h, E2E_INVITE_CODES.good);
    expect(again.status).toBe(409);
    const againBody = await readJson<RedeemBody>(again);
    expect(againBody.error?.message).not.toBe(REDEMPTION_IDENTICAL_ERROR);

    // ...and the freshly activated account owns exactly one copy of everything, once.
    const collection = await h.router(
      jsonRequest("GET", "/api/collection", undefined, { token: PENDING.token }),
    );
    expect(collection.status).toBe(200);
    const owned = await readJson<{ entries: { cardId: string; quantity: number }[] }>(collection);
    expect(owned.entries).toHaveLength(PLAYABLE.length);
    for (const entry of owned.entries) expect(entry.quantity).toBe(LAUNCH_COPIES);
  });

  it("refuses a fixture code that §9.4 would call malformed, rather than seeding a dead code", async () => {
    const h = harness();
    await expect(
      seedE2EFixtures(h.deps, h.store, {
        codes: { ...E2E_INVITE_CODES, good: "OOOO-OOOO-OOOO-OOOO" },
      }),
    ).rejects.toThrow(/CODE_ALPHABET/u);
  });

  it("refuses two fixture codes that are the same code", async () => {
    const h = harness();
    await expect(
      seedE2EFixtures(h.deps, h.store, {
        codes: { ...E2E_INVITE_CODES, missing: E2E_INVITE_CODES.good },
      }),
    ).rejects.toThrow(/same code/u);
  });
});

// ---------------------------------------------------------------------------
// The fixture auth provider
// ---------------------------------------------------------------------------

describe("the fixture AuthProvider", () => {
  it("verifies each static token from `e2e/support/config.ts` and nothing else", async () => {
    const auth = createE2EAuth();
    for (const fixture of E2E_ACCOUNTS) {
      const user = await auth.verifyAccessToken(fixture.token);
      expect(user?.userId).toBe(fixture.userId);
      expect(user?.email).toBe(fixture.email);
      // §9.4 makes a verified email a precondition of redemption, and spec 10 asserts it on the
      // pending account.
      expect(user?.emailVerified).toBe(true);
      expect(user?.appMetadata).toEqual({});
    }
    expect(await auth.verifyAccessToken("e2e-token-nobody")).toBeNull();
    expect(await auth.verifyAccessToken("")).toBeNull();
  });

  it("signs in with the fixture email and password, and refuses anything else", async () => {
    const auth = createE2EAuth();
    const session = await auth.signInWithPassword(P1.email, P1.password);
    expect(session.accessToken).toBe(P1.token);
    expect(session.user.userId).toBe(P1.userId);

    await expect(auth.signInWithPassword(P1.email, "wrong")).rejects.toThrow();
    await expect(auth.signInWithPassword("nobody@jackioh.test", P1.password)).rejects.toThrow();
  });

  it("cannot create an account", async () => {
    const auth = createE2EAuth();
    await expect(auth.signUp("new@jackioh.test", "password")).rejects.toBeInstanceOf(ApiError);
  });

  it("carries a pending account through `/api/auth/me` exactly as the code screen reads it", async () => {
    const h = harness();
    await seedE2EFixtures(h.deps, h.store);
    const response = await h.router(
      jsonRequest("GET", "/api/auth/me", undefined, { token: PENDING.token }),
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      profile: { status: "pending" },
      needsInviteCode: true,
      emailVerified: true,
    });
  });

  it("closes §9.4's gate on the pending account", async () => {
    const h = harness();
    await seedE2EFixtures(h.deps, h.store);
    const response = await h.router(
      jsonRequest("GET", "/api/collection", undefined, { token: PENDING.token }),
    );
    expect(response.status).toBe(403);
    expect(await readJson<RedeemBody>(response)).toMatchObject({
      error: { code: "account_pending" },
    });
  });

  it("has not drifted from `e2e/support/config.ts`, which is the suite's source of truth", () => {
    // `e2e/` is its own pnpm root and that file calls `Cypress.expose`, so it cannot be imported:
    // its defaults are read as text instead. If this fails, one of the two files moved alone.
    const source = readFileSync(new URL("../../../../e2e/support/config.ts", import.meta.url), "utf8");
    for (const fixture of E2E_ACCOUNTS) {
      expect(source, `${fixture.userId}'s email`).toContain(`"${fixture.email}"`);
      expect(source, `${fixture.userId}'s password`).toContain(`"${fixture.password}"`);
      expect(source, `${fixture.userId}'s token`).toContain(`"${fixture.token}"`);
    }
    for (const code of Object.values(E2E_INVITE_CODES)) {
      expect(source, `the ${code} invite code`).toContain(`"${code}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// R143
// ---------------------------------------------------------------------------

describe("R143 — the optional seed", () => {
  async function queueHarness(e2e: boolean): Promise<Harness & { tokens: string[] }> {
    const h = harness({ e2e, routes: createQueueRoutes() });
    await seedE2EFixtures(h.deps, h.store);
    const tokens: string[] = [];
    for (const fixture of E2E_ACCOUNTS.filter((candidate) => candidate.status === "active")) {
      const profile = await h.store.profiles.getByUserId(fixture.userId);
      const id = profile?.id ?? "";
      await h.store.loadouts.replace(id, h.deps.catalog.version, [PLAYABLE, [], []], 0);
      tokens.push(fixture.token);
    }
    return { ...h, tokens };
  }

  it("rejects `seed` outside end-to-end mode — it is refused, never ignored", async () => {
    const h = await queueHarness(false);
    const response = await h.router(
      jsonRequest("POST", "/api/queue", { deckIndex: 0, seed: "spec-05" }, { token: h.tokens[0] }),
    );
    expect(response.status).toBe(400);
    const body = await readJson<RedeemBody>(response);
    expect(body.error?.code).toBe("bad_request");
    expect(body.error?.message).toMatch(/seed/u);
  });

  it("uses a supplied seed verbatim for the match the pair becomes, in end-to-end mode", async () => {
    const h = await queueHarness(true);
    const seed = "05-reconnect";

    const first = await h.router(
      jsonRequest("POST", "/api/queue", { deckIndex: 0, seed }, { token: h.tokens[0] }),
    );
    expect(first.status).toBe(200);
    const second = await h.router(
      jsonRequest("POST", "/api/queue", { deckIndex: 0 }, { token: h.tokens[1] }),
    );
    expect(second.status).toBe(200);

    expect(h.matches.started).toHaveLength(1);
    expect(h.matches.started[0]?.seed).toBe(seed);
    // The seed is consumed with the pair, so nothing accumulates across a long-running server.
    expect(e2eSeedCount()).toBe(0);
  });

  it("still mints a seed when none is supplied (§9.3: the server owns it)", async () => {
    const h = await queueHarness(true);
    for (const token of h.tokens) {
      const response = await h.router(
        jsonRequest("POST", "/api/queue", { deckIndex: 0 }, { token }),
      );
      expect(response.status).toBe(200);
    }
    expect(h.matches.started).toHaveLength(1);
    expect(h.matches.started[0]?.seed).toMatch(/^seed-/u);
  });

  it("refuses a `seed` that is not a non-empty string, even in end-to-end mode", async () => {
    const h = await queueHarness(true);
    const response = await h.router(
      jsonRequest("POST", "/api/queue", { deckIndex: 0, seed: 7 }, { token: h.tokens[0] }),
    );
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// CORS and the catalog route
// ---------------------------------------------------------------------------

describe("CORS", () => {
  const origins = ["http://localhost:5173"];
  const nothing = async (): Promise<Response> => new Response("{}", { status: 200 });

  it("matches an origin regardless of a trailing slash, and nothing else", () => {
    expect(isOriginAllowed(origins, "http://localhost:5173")).toBe(true);
    expect(isOriginAllowed(["http://localhost:5173/"], "http://localhost:5173")).toBe(true);
    expect(isOriginAllowed(origins, "http://evil.example")).toBe(false);
    expect(isOriginAllowed(origins, null)).toBe(false);
  });

  it("answers a preflight for an allowed origin with the headers the client sends", async () => {
    const handler = withCors(nothing, { origins });
    const response = await handler(
      new Request("http://localhost:8787/api/loadout", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "authorization, content-type",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(response.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("never sends a wildcard and never sends credentials", async () => {
    const handler = withCors(nothing, { origins });
    const response = await handler(
      new Request("http://localhost:8787/api/auth/me", {
        headers: { origin: "http://localhost:5173" },
      }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("gives an unlisted origin the ordinary response and no CORS headers", async () => {
    const handler = withCors(nothing, { origins });
    const response = await handler(
      new Request("http://localhost:8787/api/auth/me", {
        headers: { origin: "http://evil.example" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await handler(
      new Request("http://localhost:8787/api/auth/me", {
        method: "OPTIONS",
        headers: { origin: "http://evil.example", "access-control-request-method": "GET" },
      }),
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("leaves a request with no `Origin` header alone (curl, cy.request, the wsPlayer task)", async () => {
    const handler = withCors(nothing, { origins });
    const response = await handler(new Request("http://localhost:8787/api/auth/me"));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GET /api/catalog", () => {
  it("serves the whole CardDefs record and the version, with no token", async () => {
    const catalog: CatalogInfo = {
      ...grantCatalog("catalog-9"),
      defs: { "core-001": { id: "core-001", name: "One", tags: [], base: {} } as never },
    };
    const h = harness({ catalog, routes: createCatalogRoutes() });
    const response = await h.router(new Request("http://server.test/api/catalog"));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      version: "catalog-9",
      defs: { "core-001": { id: "core-001", name: "One", tags: [], base: {} } },
    });
  });
});

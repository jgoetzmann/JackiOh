/**
 * SPEC §11 R159 and R160 — the two rulings `src/api/auth.ts` makes about §9.4's front door.
 *
 *  - **R159**: §9.4 step 1's "verified email" is read from the auth provider, and only the
 *    *positive* answer may be remembered, briefly and per user id. A provider that cannot be
 *    reached fails closed.
 *  - **R160**: sign-up and sign-in answer identically for every outcome that depends on whether an
 *    account exists, so neither endpoint becomes an account-enumeration oracle — one error per
 *    endpoint, not one shared between them.
 *
 * Nothing here touches the network or the wall clock. `createSupabaseAuth` takes three seams and
 * all three are used: `clientFactory` supplies the admin and password clients, `now` is
 * `createVirtualTimers()` from `test/fakes/deps.ts`, and `keySet` is a JWKS that always throws so
 * tier 1 fails *locally* instead of fetching `.well-known/jwks.json`. `fetchImpl` throws too, so
 * an accidental round trip is a loud failure rather than a slow test.
 *
 * Tokens are signed here with jose against `SUPABASE_JWT_SECRET`, which is `verifyAccessToken`'s
 * tier 2 — the shortest honest path to a verified identity. They carry no `exp` and no `iat`, so
 * jose reads no clock either.
 */

import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  createSupabaseAuth,
  type AdminLookup,
  type AuthApiResult,
  type AuthApiUser,
  type SupabaseAuthClients,
} from "../../src/api/auth";
import { createAuthRoutes } from "../../src/api/auth";
import { ApiError, createRouter, type Router } from "../../src/api/http";
import type { AuthProvider } from "../../src/api/ports";
import { createTestDeps, createVirtualTimers, jsonRequest, type VirtualTimers } from "../fakes/deps";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_URL = "https://project.supabase.test";
const ISSUER = `${PROJECT_URL}/auth/v1`;
const JWT_SECRET = "hs256-secret-used-only-by-this-test";
const SECRET_BYTES = new TextEncoder().encode(JWT_SECRET);

const ALICE = "user-alice";
const BOB = "user-bob";

/** A tier-2 token: signed with the legacy shared secret, with §9.2's issuer and audience. */
async function tokenFor(userId: string, email = `${userId}@example.test`): Promise<string> {
  return new SignJWT({ email, app_metadata: { provider: "email" } })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .sign(SECRET_BYTES);
}

/** A confirmed GoTrue user: `email_confirmed_at` is the only field §9.4 step 1 reads. */
function confirmedUser(userId: string): AuthApiUser {
  return {
    id: userId,
    email: `${userId}@example.test`,
    email_confirmed_at: "2026-01-01T00:00:00.000Z",
    app_metadata: { provider: "email" },
  };
}

function unconfirmedUser(userId: string): AuthApiUser {
  return { ...confirmedUser(userId), email_confirmed_at: null };
}

type AdminSpy = {
  /** How many times the auth server was actually asked, per user id. */
  lookups: () => Record<string, number>;
  total: () => number;
  /** What the auth server answers next, for every user id. */
  answer: (reply: (userId: string) => AdminLookup) => void;
};

type Harness = {
  auth: AuthProvider;
  admin: AdminSpy;
  timers: VirtualTimers;
};

/**
 * The provider under test, with every door into the outside world closed.
 *
 * `password` is whatever the caller scripts (null models a deployment with no publishable key,
 * which is the normal one per §9.2).
 */
function providerWith(
  options: {
    admin?: (userId: string) => AdminLookup;
    password?: SupabaseAuthClients["password"];
  } = {},
): Harness {
  const timers = createVirtualTimers();
  const counts: Record<string, number> = {};
  let reply = options.admin ?? ((userId: string): AdminLookup => ({ kind: "ok", user: confirmedUser(userId) }));

  const admin: AdminSpy = {
    lookups: () => ({ ...counts }),
    total: () => Object.values(counts).reduce((sum, n) => sum + n, 0),
    answer: (next) => {
      reply = next;
    },
  };

  const auth = createSupabaseAuth({
    url: PROJECT_URL,
    secretKey: "secret-key",
    jwtSecret: JWT_SECRET,
    now: timers.now,
    // Tier 1 must fail without a network round trip.
    keySet: () => {
      throw new Error("this test publishes no JWKS");
    },
    // Tier 3 must never be reached; if it is, this is a loud failure rather than a real request.
    fetchImpl: () => {
      throw new Error("no network in a unit test");
    },
    clientFactory: () => ({
      password: options.password ?? null,
      admin: {
        getUserById: async (userId) => {
          counts[userId] = (counts[userId] ?? 0) + 1;
          return reply(userId);
        },
      },
    }),
  });

  return { auth, admin, timers };
}

/**
 * `EMAIL_CONFIRMED_CACHE_TTL_MS` in `src/api/auth.ts`. R159 says only "briefly", so this is read
 * as an order of magnitude and never asserted exactly: the tests below check that *some* window
 * exists (a hit one millisecond later) and that it *ends* (a miss ten windows later), which stays
 * true for any sane value of the constant.
 */
const CACHE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// R159
// ---------------------------------------------------------------------------

describe("R159 — how long a verified email stays verified (§9.2, §9.4)", () => {
  it("R159 remembers a confirmed email briefly and per user id, and asks again once it lapses", async () => {
    const h = providerWith();
    const alice = await tokenFor(ALICE);
    const bob = await tokenFor(BOB);

    // PREMISE: the yes came from the auth server, not from the token. Without this first lookup
    // every "still 1" below would be satisfied by a provider that never asks anybody anything.
    const first = await h.auth.verifyAccessToken(alice);
    expect(first?.userId).toBe(ALICE);
    expect(first?.emailVerified).toBe(true);
    expect(h.admin.lookups()).toEqual({ [ALICE]: 1 });

    // A second call inside the window is answered from the cache: no round trip in front of it.
    h.timers.charge(1);
    expect((await h.auth.verifyAccessToken(alice))?.emailVerified).toBe(true);
    expect(h.admin.lookups()).toEqual({ [ALICE]: 1 });

    // Per user id: Alice's yes says nothing about Bob, who is asked for on his own.
    expect((await h.auth.verifyAccessToken(bob))?.emailVerified).toBe(true);
    expect(h.admin.lookups()).toEqual({ [ALICE]: 1, [BOB]: 1 });

    // …and the window ends. Ten times the constant is past any reading of "briefly".
    h.timers.charge(CACHE_TTL_MS * 10);
    expect((await h.auth.verifyAccessToken(alice))?.emailVerified).toBe(true);
    expect(h.admin.lookups()).toEqual({ [ALICE]: 2, [BOB]: 1 });
  });

  it("R159 never caches the no, so an account that has just clicked its link is unlocked at once", async () => {
    const h = providerWith({ admin: (userId) => ({ kind: "ok", user: unconfirmedUser(userId) }) });
    const alice = await tokenFor(ALICE);

    const before = await h.auth.verifyAccessToken(alice);
    expect(before?.userId).toBe(ALICE);
    expect(before?.emailVerified).toBe(false);
    expect(h.admin.total()).toBe(1);

    // Asked again immediately: a negative is never remembered, so the provider is consulted afresh.
    expect((await h.auth.verifyAccessToken(alice))?.emailVerified).toBe(false);
    expect(h.admin.total()).toBe(2);

    // The link is clicked. The clock does NOT move: R159's whole point is that the code screen
    // unlocks now rather than after a cache window.
    h.admin.answer((userId) => ({ kind: "ok", user: confirmedUser(userId) }));
    expect((await h.auth.verifyAccessToken(alice))?.emailVerified).toBe(true);
    expect(h.admin.total()).toBe(3);
  });

  it("R159 fails closed when the provider cannot be reached: the identity stands, the email does not", async () => {
    const h = providerWith({ admin: () => ({ kind: "unavailable" }) });
    const alice = await tokenFor(ALICE);

    const outage = await h.auth.verifyAccessToken(alice);
    // The signature proved who this is, so the identity survives…
    expect(outage?.userId).toBe(ALICE);
    expect(outage?.email).toBe(`${ALICE}@example.test`);
    expect(outage?.appMetadata).toEqual({ provider: "email" });
    // …but nothing proved the email, so §9.4 step 1 must not pass.
    expect(outage?.emailVerified).toBe(false);
    expect(h.admin.total()).toBe(1);

    // An outage caches nothing either, in either direction: the next call asks again and the
    // recovered provider is believed immediately, with no clock movement.
    h.admin.answer((userId) => ({ kind: "ok", user: confirmedUser(userId) }));
    expect((await h.auth.verifyAccessToken(alice))?.emailVerified).toBe(true);
    expect(h.admin.total()).toBe(2);
  });

  it("R159 caches only what the provider gave: a deleted user is refused, never remembered", async () => {
    const h = providerWith({ admin: () => ({ kind: "missing" }) });
    const alice = await tokenFor(ALICE);

    // "The cache can only ever shorten the path to a yes the provider already gave" — a `missing`
    // is not a yes, so it writes nothing and the token is simply not honoured.
    expect(await h.auth.verifyAccessToken(alice)).toBeNull();
    expect(await h.auth.verifyAccessToken(alice)).toBeNull();
    expect(h.admin.total()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// R160
// ---------------------------------------------------------------------------

/** A GoTrue rejection, as `PasswordAuthClient` reports one. */
function rejection(message: string): AuthApiResult {
  return { user: null, session: null, error: { message } };
}

/**
 * GoTrue's obfuscated sign-up: with email confirmation on, an address that already has an account
 * comes back as a user with no session, exactly like a brand-new one.
 */
function pendingSignUp(userId: string): AuthApiResult {
  return { user: unconfirmedUser(userId), session: null, error: null };
}

type Scripted = { calls: { method: string; email: string }[]; client: SupabaseAuthClients["password"] };

function scriptedPassword(script: {
  signUp: (email: string) => AuthApiResult;
  signIn: (email: string) => AuthApiResult;
}): Scripted {
  const calls: { method: string; email: string }[] = [];
  return {
    calls,
    client: {
      signUp: async (email) => {
        calls.push({ method: "signUp", email });
        return script.signUp(email);
      },
      signInWithPassword: async (email) => {
        calls.push({ method: "signIn", email });
        return script.signIn(email);
      },
    },
  };
}

function routerFor(auth: AuthProvider): Router {
  return createRouter(createAuthRoutes(), createTestDeps({ auth }));
}

/** Status plus the exact bytes, which is the pair R145's test compares and R160 extends. */
async function wire(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

describe("R160 — the identical sign-up and sign-in error (§9.2, §9.4, §9.8; extends R145)", () => {
  it("R160 answers 'no such account' and 'wrong password' byte-identically at sign-in", async () => {
    // Three provider rejections a real GoTrue distinguishes between, in its own words.
    const script = scriptedPassword({
      signUp: () => rejection("unused"),
      signIn: (email) =>
        rejection(
          email === "ghost@example.test"
            ? "User not found"
            : email === "alice@example.test"
              ? "Invalid login credentials"
              : "Email not confirmed",
        ),
    });
    const h = providerWith({ password: script.client });
    const router = routerFor(h.auth);

    const signIn = async (email: string): Promise<{ status: number; body: string }> =>
      wire(await router(jsonRequest("POST", "/api/auth/signin", { email, password: "hunter2" })));

    const responses = [
      await signIn("ghost@example.test"), // no such account
      await signIn("alice@example.test"), // wrong password
      await signIn("bob@example.test"), // unconfirmed — also "does an account exist?"
    ];

    // PREMISE: all three really reached the provider, each with its own address. Without this the
    // identical bodies below could come from a handler that rejected the request before asking.
    expect(script.calls).toEqual([
      { method: "signIn", email: "ghost@example.test" },
      { method: "signIn", email: "alice@example.test" },
      { method: "signIn", email: "bob@example.test" },
    ]);

    expect(new Set(responses.map((response) => response.status)).size).toBe(1);
    expect(responses[0]?.status).toBe(401);
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
    // Not a shred of the provider's own wording survives.
    for (const response of responses) {
      expect(response.body).not.toContain("User not found");
      expect(response.body).not.toContain("Invalid login credentials");
      expect(response.body).not.toContain("Email not confirmed");
    }
  });

  it("R160 answers 'already registered' identically to every other sign-up rejection", async () => {
    const script = scriptedPassword({
      signUp: (email) =>
        rejection(email === "taken@example.test" ? "User already registered" : "Database error saving new user"),
      signIn: () => rejection("unused"),
    });
    const h = providerWith({ password: script.client });
    const router = routerFor(h.auth);

    const signUp = async (email: string): Promise<{ status: number; body: string }> =>
      wire(await router(jsonRequest("POST", "/api/auth/signup", { email, password: "hunter2" })));

    const taken = await signUp("taken@example.test");
    const other = await signUp("fresh@example.test");

    expect(script.calls.map((call) => call.method)).toEqual(["signUp", "signUp"]);
    expect(taken.status).toBe(401);
    expect(taken.status).toBe(other.status);
    expect(taken.body).toBe(other.body);
    expect(taken.body).not.toContain("already registered");
    expect(taken.body).not.toContain("Database error");
  });

  it("R160 makes an address that already has an account look exactly like a new one", async () => {
    // GoTrue's own obfuscation when confirmation is on: a user, no session, no error — the same
    // shape for a taken address as for a free one. `auth.ts` turns both into the pending answer.
    const script = scriptedPassword({
      signUp: (email) => pendingSignUp(email === "taken@example.test" ? "obfuscated-id" : "brand-new-id"),
      signIn: () => rejection("unused"),
    });
    const h = providerWith({ password: script.client });
    const router = routerFor(h.auth);

    const signUp = async (email: string): Promise<Record<string, unknown>> => {
      const response = await router(
        jsonRequest("POST", "/api/auth/signup", { email, password: "hunter2" }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };

    const taken = await signUp("taken@example.test");
    const fresh = await signUp("fresh@example.test");

    // Everything but the opaque id is identical, and the id says nothing about existence.
    expect(taken["pendingEmailVerification"]).toBe(true);
    expect(taken["session"]).toBeNull();
    expect(Object.keys(taken).sort()).toEqual(Object.keys(fresh).sort());
    expect({ ...taken, userId: "-" }).toEqual({ ...fresh, userId: "-" });
  });

  it("R160 is one error per endpoint, not one shared between them", async () => {
    const script = scriptedPassword({
      signUp: () => rejection("User already registered"),
      signIn: () => rejection("Invalid login credentials"),
    });
    const h = providerWith({ password: script.client });
    const router = routerFor(h.auth);

    const up = await wire(
      await router(jsonRequest("POST", "/api/auth/signup", { email: "a@b.test", password: "p" })),
    );
    const inn = await wire(
      await router(jsonRequest("POST", "/api/auth/signin", { email: "a@b.test", password: "p" })),
    );

    expect(up.status).toBe(401);
    expect(inn.status).toBe(401);
    // The route already distinguishes them, so the two doors may say different things — and do.
    expect(up.body).not.toBe(inn.body);
  });

  it("R160's control: the same endpoints still tell four other outcomes apart", async () => {
    // Without this, "byte-identical" above would be satisfied by an endpoint that answers the same
    // thing to absolutely everything, which proves nothing about enumeration.
    const script = scriptedPassword({
      signUp: () => rejection("User already registered"),
      signIn: (email) =>
        email === "good@example.test"
          ? {
              user: confirmedUser(ALICE),
              session: { access_token: "at", refresh_token: "rt", expires_at: 1_700_000_000 },
              error: null,
            }
          : rejection("Invalid login credentials"),
    });
    const h = providerWith({ password: script.client });
    const router = routerFor(h.auth);

    // 1. The account-existence rejection: 401, the flattened wording.
    const refused = await wire(
      await router(jsonRequest("POST", "/api/auth/signin", { email: "x@y.test", password: "p" })),
    );
    expect(refused.status).toBe(401);

    // 2. A sign-in that works: 200, with a session. Plainly distinguishable.
    const accepted = await wire(
      await router(jsonRequest("POST", "/api/auth/signin", { email: "good@example.test", password: "p" })),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toContain("accessToken");
    expect(accepted.body).not.toBe(refused.body);

    // 3. A malformed body: 400, and nothing ever reached the provider.
    const callsBefore = script.calls.length;
    const malformed = await wire(
      await router(jsonRequest("POST", "/api/auth/signin", { email: "x@y.test" })),
    );
    expect(malformed.status).toBe(400);
    expect(script.calls.length).toBe(callsBefore);
    expect(malformed.body).not.toBe(refused.body);

    // 4. A deployment with no publishable key: 503, saying where sign-in actually happens (§9.2).
    const noPassword = providerWith();
    const disabled = await wire(
      await routerFor(noPassword.auth)(
        jsonRequest("POST", "/api/auth/signin", { email: "x@y.test", password: "p" }),
      ),
    );
    expect(disabled.status).toBe(503);
    expect(disabled.body).not.toBe(refused.body);

    // Four distinct answers, so the identity above is a property of the account-existence cases
    // and not of the endpoint.
    expect(new Set([refused.body, accepted.body, malformed.body, disabled.body]).size).toBe(4);
  });

  it("R160 flattens a provider that throws, too, not only one that reports an error", async () => {
    // `callProvider` is the other half: anything the provider raises becomes the same 401, so a
    // transport failure cannot be told from a refusal either.
    const thrower: AuthProvider = {
      verifyAccessToken: async () => null,
      signUp: async () => {
        throw new Error("getaddrinfo ENOTFOUND project.supabase.test");
      },
      signInWithPassword: async () => {
        throw new Error("User not found: alice@example.test");
      },
    };
    const router = routerFor(thrower);

    const inn = await wire(
      await router(jsonRequest("POST", "/api/auth/signin", { email: "a@b.test", password: "p" })),
    );
    expect(inn.status).toBe(401);
    expect(inn.body).not.toContain("User not found");
    expect(inn.body).not.toContain("alice@example.test");

    const up = await wire(
      await router(jsonRequest("POST", "/api/auth/signup", { email: "a@b.test", password: "p" })),
    );
    expect(up.status).toBe(401);
    expect(up.body).not.toContain("ENOTFOUND");
  });

  it("R160 keeps the 503 for an unconfigured password path an ApiError, not a flattened 401", async () => {
    // The one rejection that is *not* about an account: it is passed through unchanged, which is
    // what makes the control above honest.
    const h = providerWith();
    await expect(h.auth.signInWithPassword("a@b.test", "p")).rejects.toBeInstanceOf(ApiError);
    await expect(h.auth.signUp("a@b.test", "p")).rejects.toBeInstanceOf(ApiError);
  });
});

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
import type { AuthProvider, FrozenTrio, SeriesRow } from "../../src/api/ports";
import { AUTH_SESSION_LIVE_CACHE_SECONDS } from "../../src/config";
import {
  createTestDeps,
  createVirtualTimers,
  jsonRequest,
  readJson,
  type VirtualTimers,
} from "../fakes/deps";

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
// R194: a session the provider has ended is not honoured here either
// ---------------------------------------------------------------------------

/** A tier-2 token that names its provider session, as every Supabase access token does. */
async function sessionTokenFor(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ email: `${userId}@example.test`, session_id: sessionId, app_metadata: { provider: "email" } })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .sign(SECRET_BYTES);
}

/** What `GET /auth/v1/user` answers next: the session's user, ended, or nobody there. */
type UserEndpoint = (token: string) => Response | "unreachable";

/**
 * The provider with its `/auth/v1/user` scripted (R194's session check) and the admin lookup
 * counted, as `providerWith` does.
 */
function providerWithSessions(user: UserEndpoint): Harness & { userCalls: () => number; answerUser: (next: UserEndpoint) => void } {
  const timers = createVirtualTimers();
  const counts: Record<string, number> = {};
  let userCalls = 0;
  let reply = user;
  const auth = createSupabaseAuth({
    url: PROJECT_URL,
    secretKey: "secret-key",
    jwtSecret: JWT_SECRET,
    now: timers.now,
    keySet: () => {
      throw new Error("this test publishes no JWKS");
    },
    fetchImpl: async (input, init) => {
      if (String(input) !== `${ISSUER}/user`) throw new Error(`unexpected request to ${String(input)}`);
      userCalls += 1;
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      const answer = reply(bearer.replace(/^Bearer /u, ""));
      if (answer === "unreachable") throw new TypeError("fetch failed");
      return answer;
    },
    clientFactory: () => ({
      password: null,
      admin: {
        getUserById: async (userId) => {
          counts[userId] = (counts[userId] ?? 0) + 1;
          return { kind: "ok", user: confirmedUser(userId) };
        },
      },
    }),
  });
  return {
    auth,
    timers,
    admin: {
      lookups: () => ({ ...counts }),
      total: () => Object.values(counts).reduce((sum, n) => sum + n, 0),
      answer: () => undefined,
    },
    userCalls: () => userCalls,
    answerUser: (next) => {
      reply = next;
    },
  };
}

function liveUser(userId: string, confirmedEmail = true): () => Response {
  return () => Response.json(confirmedEmail ? confirmedUser(userId) : unconfirmedUser(userId));
}

/** GoTrue's answer once `/logout` has deleted the session the token names. */
function sessionEnded(): Response {
  return Response.json({ code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" }, { status: 403 });
}

/** `AUTH_SESSION_LIVE_CACHE_SECONDS`, read as an order of magnitude (like `CACHE_TTL_MS`). */
const LIVE_TTL_MS = AUTH_SESSION_LIVE_CACHE_SECONDS * 1000;

describe("R194 — an ended session's access token is refused here too (§9.2, §9.4)", () => {
  it("R194 refuses a well-signed, unexpired token whose session the provider has ended", async () => {
    const h = providerWithSessions(() => sessionEnded());
    const token = await sessionTokenFor(ALICE, "session-revoked");

    // The signature and the audience are good: only the provider knows the session is gone.
    expect(await h.auth.verifyAccessToken(token)).toBeNull();
    expect(h.userCalls()).toBe(1);

    // Through the router: /api/auth/me answers 401, so a copied token cannot read the account.
    const router = createRouter(createAuthRoutes(), createTestDeps({ auth: h.auth }));
    const res = await router(new Request("http://api.test/api/auth/me", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(401);
  });

  it("R194 remembers a live session only briefly, so an ending takes effect within the window", async () => {
    const h = providerWithSessions(liveUser(ALICE));
    const token = await sessionTokenFor(ALICE, "session-a");

    const first = await h.auth.verifyAccessToken(token);
    expect(first?.userId).toBe(ALICE);
    expect(first?.emailVerified).toBe(true);
    expect(h.userCalls()).toBe(1);
    // The provider's answer was the authoritative user: no admin lookup in front of it.
    expect(h.admin.total()).toBe(0);

    // Signed out elsewhere. Inside the window the live answer still stands…
    h.answerUser(() => sessionEnded());
    h.timers.charge(1);
    expect((await h.auth.verifyAccessToken(token))?.userId).toBe(ALICE);
    expect(h.userCalls()).toBe(1);

    // …and once it lapses the provider is asked again, and the token is refused.
    h.timers.charge(LIVE_TTL_MS);
    expect(await h.auth.verifyAccessToken(token)).toBeNull();
    expect(h.userCalls()).toBe(2);
  });

  it("R194 remembers each session on its own: one session's answer says nothing about another's", async () => {
    const h = providerWithSessions(liveUser(ALICE));
    const kept = await sessionTokenFor(ALICE, "session-kept");
    const other = await sessionTokenFor(ALICE, "session-other");

    expect((await h.auth.verifyAccessToken(kept))?.userId).toBe(ALICE);
    h.answerUser((token) => (token === other ? sessionEnded() : liveUser(ALICE)()));
    // The same user, another session: asked on its own, and refused.
    expect(await h.auth.verifyAccessToken(other)).toBeNull();
    expect((await h.auth.verifyAccessToken(kept))?.userId).toBe(ALICE);
    expect(h.userCalls()).toBe(2);
  });

  it("R194 a provider that cannot be reached signs nobody out, and proves no email (R159)", async () => {
    const h = providerWithSessions(() => "unreachable");
    const token = await sessionTokenFor(ALICE, "session-a");

    const outage = await h.auth.verifyAccessToken(token);
    expect(outage?.userId).toBe(ALICE);
    // The admin lookup still decides the email, as before the session check existed.
    expect(h.admin.total()).toBe(1);
    // Nothing was remembered: the next call asks the provider again.
    h.answerUser(() => sessionEnded());
    expect(await h.auth.verifyAccessToken(token)).toBeNull();
  });

  it("R194 the session check cannot hang a request: it goes out with a timeout", async () => {
    let signal: AbortSignal | null | undefined;
    const h = providerWithSessions(() => Response.json(confirmedUser(ALICE)));
    const auth = createSupabaseAuth({
      url: PROJECT_URL,
      secretKey: "secret-key",
      jwtSecret: JWT_SECRET,
      now: h.timers.now,
      keySet: () => {
        throw new Error("this test publishes no JWKS");
      },
      fetchImpl: async (_input, init) => {
        signal = init?.signal;
        return Response.json(confirmedUser(ALICE));
      },
      clientFactory: () => ({ password: null, admin: null }),
    });
    expect((await auth.verifyAccessToken(await sessionTokenFor(ALICE, "session-a")))?.userId).toBe(ALICE);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("R194 never honours a token on another user's answer", async () => {
    const h = providerWithSessions(liveUser(BOB));
    const token = await sessionTokenFor(ALICE, "session-a");
    expect(await h.auth.verifyAccessToken(token)).toBeNull();
  });

  it("R194 a token that names no session is verified as before (the admin lookup, no session check)", async () => {
    const h = providerWithSessions(() => {
      throw new Error("a token with no session_id must not reach /auth/v1/user");
    });
    const token = await tokenFor(ALICE);
    expect((await h.auth.verifyAccessToken(token))?.emailVerified).toBe(true);
    expect(h.userCalls()).toBe(0);
    expect(h.admin.total()).toBe(1);
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

// ---------------------------------------------------------------------------
// `currentMatchId` on /api/auth/me (§9.5)
// ---------------------------------------------------------------------------

/**
 * The read that makes a two-player game reachable.
 *
 * In both lobby flows only ONE player's HTTP response carried the match id — the joiner of a room,
 * or whoever enqueued second. The other player was already in the match and had no way to learn
 * it: `/api/auth/me` returned status and rating and nothing else, and there is no other route that
 * names a profile's match. So one player sat on /play while their opponent sat on the board, and
 * the only way to actually play was to paste the URL across.
 *
 * `profiles.current_match_id` is set when a match starts and cleared by every ending (§9.5), so
 * reporting it here is the authoritative answer to "am I in a match" for the player who waited,
 * and the way back in after a reload that lost the URL.
 */
describe("/api/auth/me reports the caller's own current match (§9.5)", () => {
  it("is null for an account that is not in a match", async () => {
    const deps = createTestDeps();
    const token = deps.auth.addUser({ userId: ALICE, email: "alice@example.test" });
    const profile = await deps.store.profiles.create({
      userId: ALICE,
      email: "alice@example.test",
      rating: 1000,
      at: 1,
    });
    expect(profile.inMatchId, "premise: not in a match").toBeNull();

    const router = createRouter(createAuthRoutes(), deps);
    const res = await router(jsonRequest("GET", "/api/auth/me", undefined, { token }));
    const body = (await readJson(res)) as { currentMatchId: string | null };

    expect(res.status).toBe(200);
    expect(body.currentMatchId).toBeNull();
  });

  it("names the match once the player is in one, which is what the waiting player reads", async () => {
    const deps = createTestDeps();
    const token = deps.auth.addUser({ userId: ALICE, email: "alice@example.test" });
    const profile = await deps.store.profiles.create({
      userId: ALICE,
      email: "alice@example.test",
      rating: 1000,
      at: 1,
    });
    await deps.store.tx(async (t) => {
      await t.profiles.setInMatch(profile.id, "match-42");
    });

    const router = createRouter(createAuthRoutes(), deps);
    const res = await router(jsonRequest("GET", "/api/auth/me", undefined, { token }));
    const body = (await readJson(res)) as { currentMatchId: string | null };

    expect(res.status).toBe(200);
    expect(body.currentMatchId, "the id /play navigates to").toBe("match-42");
  });

  it("names the caller's own Best-of-3 series while it is not over, and only then (R259, R264)", async () => {
    const deps = createTestDeps();
    const token = deps.auth.addUser({ userId: ALICE, email: "alice@example.test" });
    const profile = await deps.store.profiles.create({
      userId: ALICE,
      email: "alice@example.test",
      rating: 1000,
      at: 1,
    });
    const router = createRouter(createAuthRoutes(), deps);
    const read = async (): Promise<{ currentMatchId: string | null; currentSeriesId: string | null }> =>
      (await readJson(await router(jsonRequest("GET", "/api/auth/me", undefined, { token })))) as {
        currentMatchId: string | null;
        currentSeriesId: string | null;
      };

    expect((await read()).currentSeriesId, "premise: in no series").toBeNull();

    // Between the games of a series nobody is in a match, and this is how the player who waited
    // learns there is a deck to pick.
    const trio: FrozenTrio = {
      name: "t",
      decks: [
        { name: "a", cards: [] },
        { name: "b", cards: [] },
        { name: "c", cards: [] },
      ],
    };
    const series: SeriesRow = {
      id: "series-7",
      sides: [
        { profileId: profile.id, trio, wins: 0, pick: null },
        { profileId: "rival", trio, wins: 0, pick: null },
      ],
      catalogVersion: deps.catalog.version,
      seedBase: "s",
      status: "picking",
      games: [],
      nextMatchId: "reserved",
      pickDeadline: null,
      winner: null,
      endReason: null,
      ratingBefore: null,
      ratingAfter: null,
      createdAt: 0,
      updatedAt: 0,
      endedAt: null,
      version: 1,
    };
    await deps.store.series.create(series);

    const during = await read();
    expect(during.currentSeriesId).toBe("series-7");
    expect(during.currentMatchId).toBeNull();

    // Over, it is nobody's current series.
    await deps.store.series.update({ ...series, status: "over", version: 2 });
    expect((await read()).currentSeriesId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/profile (§9.5) — the account screen's read
// ---------------------------------------------------------------------------

describe("/api/profile reports identity and the ladder record", () => {
  async function activeProfile(deps: ReturnType<typeof createTestDeps>) {
    const token = deps.auth.addUser({ userId: ALICE, email: "alice@example.test" });
    const profile = await deps.store.profiles.create({
      userId: ALICE,
      email: "alice@example.test",
      rating: 1000,
      at: 1,
    });
    await deps.store.profiles.setStatus(profile.id, "active");
    return { token, profile };
  }

  it("reports the address the account is tied to, so a player can see who they are", async () => {
    const deps = createTestDeps();
    const { token } = await activeProfile(deps);

    const router = createRouter(createAuthRoutes(), deps);
    const res = await router(jsonRequest("GET", "/api/profile", undefined, { token }));
    const body = (await readJson(res)) as { email: string | null; status: string };

    expect(res.status).toBe(200);
    expect(body.email).toBe("alice@example.test");
    expect(body.status).toBe("active");
  });

  /** Nothing played is not the same claim as a 0% win rate, so it is null rather than 0. */
  it("is a null win rate, not zero, before any match is finished", async () => {
    const deps = createTestDeps();
    const { token } = await activeProfile(deps);

    const router = createRouter(createAuthRoutes(), deps);
    const res = await router(jsonRequest("GET", "/api/profile", undefined, { token }));
    const body = (await readJson(res)) as {
      record: { wins: number; losses: number; draws: number };
      winRate: number | null;
    };

    expect(body.record).toEqual({ wins: 0, losses: 0, draws: 0 });
    expect(body.winRate).toBeNull();
  });

  /**
   * A winnerless row is a DRAW (§9.5 makes the ceiling, a mutual hero death and an accepted draw
   * all winnerless), and a draw counts as played while being neither a win nor a loss — so one
   * win, one loss and one draw is a third, not a half.
   */
  it("counts wins, losses and draws from results, and rates on all three", async () => {
    const deps = createTestDeps();
    const { token, profile } = await activeProfile(deps);
    const other = await deps.store.profiles.create({
      userId: "user-bob",
      email: "bob@example.test",
      rating: 1000,
      at: 1,
    });

    const row = (matchId: string, winner: string | null) => ({
      matchId,
      players: [profile.id, other.id] as [string, string],
      winnerProfileId: winner,
      reason: (winner === null ? "match-ceiling" : "concede") as never,
      turns: 3,
      ratingBefore: [1000, 1000] as [number, number],
      ratingAfter: [1000, 1000] as [number, number],
      endedAt: 10,
    });
    await deps.store.results.insert(row("m1", profile.id));
    await deps.store.results.insert(row("m2", other.id));
    await deps.store.results.insert(row("m3", null));

    const router = createRouter(createAuthRoutes(), deps);
    const res = await router(jsonRequest("GET", "/api/profile", undefined, { token }));
    const body = (await readJson(res)) as {
      record: { wins: number; losses: number; draws: number };
      winRate: number | null;
    };

    expect(body.record).toEqual({ wins: 1, losses: 1, draws: 1 });
    expect(body.winRate).toBeCloseTo(1 / 3, 5);
  });
});

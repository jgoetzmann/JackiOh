/**
 * Managed auth (SPEC §9.4: "Managed auth provider" for email and password) over Supabase Auth,
 * plus the endpoints the invite gate needs.
 *
 * Topology, per SPEC §9.2: the browser has its own HTTPS arrow to the auth provider, separate
 * from its arrow to the API functions. The browser signs up and signs in against Supabase Auth
 * directly with the *publishable* key; this server's job is to **verify** the bearer token that
 * comes back, so `verifyAccessToken` is the load-bearing method here. `signUp` /
 * `signInWithPassword` stay on the `AuthProvider` port (it requires them, and BUILD M8's fixture
 * accounts use them) but they are a secondary path that needs a publishable key configured
 * explicitly; without one they fail with a 503 that says where sign-in actually happens. They are
 * never run with the secret key: a service-role sign-up bypasses the provider's own rate limits
 * and its email-confirmation behaviour, which is exactly what §9.4's invite gate relies on.
 *
 * SPEC §9.4 lets a pending account "log in, verify its email and see the code screen, and nothing
 * else", so `/api/auth/me` is declared `auth: "user"` rather than `"active"`: it is the code
 * screen's only read. The gate itself lives in `http.ts` (`assertActive`), never here.
 *
 * Security notes (the Supabase security checklist, and §9.8's "Invite code brute force" row,
 * whose mitigation list includes "verified email"):
 *
 *  - `emailVerified` NEVER comes from the access token's `user_metadata`. In Supabase that claim
 *    is *user-editable* (`raw_user_meta_data` is writable through `auth.updateUser`), so trusting
 *    a self-set `user_metadata.email_verified` would walk straight past §9.4 step 1's "verified
 *    email" requirement and hand a scripted attacker unlimited invite-code attempts. It is read
 *    from the authoritative auth server instead — `email_confirmed_at`, which only GoTrue writes.
 *  - `AuthUser.appMetadata` is filled from the `app_metadata` claim only (provider-controlled).
 *  - the secret key stays inside this closure: it is never returned, never logged, and never put
 *    into a response body. Nothing in this file logs a token or a key either.
 *  - Supabase caveat worth naming: deleting a user does not invalidate tokens already issued.
 *    The admin lookup below turns an explicit "no such user" into a failed verification, and
 *    `profiles.status` (§9.4) remains the only authority on what an account may do.
 *  - The same is true of ending a SESSION (R194). A signature and an unexpired `exp` prove only
 *    that the provider issued the token; a sign-out, a link's session the client dropped, or a
 *    password reset that signed other devices out ends the session at the provider, and its access
 *    token is still well-signed for up to an hour. So a token that names its session
 *    (`session_id`, which every Supabase access token carries) is checked against the provider
 *    (`GET /auth/v1/user`, which refuses a token whose session is gone), and only the answer that
 *    it is live is remembered, per session, for `AUTH_SESSION_LIVE_CACHE_SECONDS`. That one answer
 *    is also the authoritative user, so it stands in for the admin lookup when it is fresh.
 */

import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { AUTH_PROVIDER_TIMEOUT_SECONDS, AUTH_SESSION_LIVE_CACHE_SECONDS } from "../config";
import { ApiError, ok, route, str, type Route } from "./http";
import {
  systemTimers,
  type AuthProvider,
  type AuthSession,
  type AuthUser,
  type ServerDeps,
} from "./ports";

// ---------------------------------------------------------------------------
// Tunables SPEC does not pin down
// ---------------------------------------------------------------------------

// NOT IN SPEC, and no R-row yet — PROPOSED RULING for §11:
//   Topic: How long a verified email stays verified
//   Ruling: §9.4 step 1's "verified email" is read from the auth provider, and only the
//     *positive* answer may be remembered — for 30 seconds, per user id. Caching the positive is
//     safe because confirmation does not go backwards in normal use, and refusing to cache the
//     negative is what lets an account that has just clicked its confirmation link see the code
//     screen unlock at once rather than after a cache window. The alternative, asking the auth
//     server on every request, puts a round trip in front of every authenticated call, and the
//     alternative of caching both directions makes a freshly verified account wait for no reason.
//     A provider that cannot be reached still fails closed (`AdminLookup.unavailable`): the
//     identity stands and the email counts as unverified, so the cache can only ever shorten the
//     path to a `yes` the provider already gave.
//   Affects: §9.4 (redemption step 1), §9.2; `api/auth.ts`, `api/codes.ts`.
//
// SPEC §9.4 requires a verified email at redemption but says nothing about how the server learns
// of it, which is the gap above.
const EMAIL_CONFIRMED_CACHE_TTL_MS = 30_000;

/** Supabase issues project JWTs with this audience for a signed-in user. */
const AUTHENTICATED_AUDIENCE = "authenticated";

// NOT IN SPEC, and no R-row yet — PROPOSED RULING for §11:
//   Topic: The scope of the identical sign-up and sign-in error (extends R145)
//   Ruling: Sign-up and sign-in answer identically for every outcome that depends on **whether an
//     account exists** — "no such account", "wrong password" and "already registered" — so neither
//     endpoint becomes an account-enumeration oracle. This is R145's principle one door earlier:
//     R145 makes the redemption error identical for everything that depends on the code and
//     distinct for everything that depends only on the caller's own account, and an email address
//     is exactly the fact an unauthenticated caller must not be able to probe. §9.8's brute-force
//     row asks for the invite gate to resist enumeration, which a sign-up endpoint that says "that
//     address is taken" undoes. One error per endpoint rather than one for both, because the two
//     endpoints are already distinguishable by the route.
//   Affects: §9.2, §9.4, §9.8, R145; `api/auth.ts`.
//
// §9.4 does not write these strings; the ruling above is about their being one string, not about
// their wording.
const SIGN_UP_FAILED_MESSAGE = "Could not create that account.";
const SIGN_IN_FAILED_MESSAGE = "That email and password do not match an account.";

// Not in SPEC, and no R-row: wording only. §9.2 puts sign-in in the browser against Supabase Auth,
// so a server with no publishable key is the normal deployment and this sentence is an operator
// diagnostic for whoever called a route this deployment does not broker. Nothing branches on it.
const PASSWORD_PATH_DISABLED_MESSAGE =
  "This server does not broker passwords: sign up and sign in against Supabase Auth from the client.";

// ---------------------------------------------------------------------------
// The slice of the provider's shapes this file reads
// ---------------------------------------------------------------------------

/**
 * GoTrue's user object, narrowed to the fields §9.4 needs. `user_metadata` is deliberately absent:
 * it is user-editable, so this file has no way to read it by accident.
 */
export type AuthApiUser = {
  id: string;
  email?: string | null;
  /** The auth server's own verification timestamp; null/absent until the link is clicked. */
  email_confirmed_at?: string | null;
  /** Provider-controlled claims (`app_metadata`), safe for authorization. */
  app_metadata?: Record<string, unknown>;
};

export type AuthApiSession = {
  access_token: string;
  refresh_token?: string | null;
  /** Epoch *seconds* (GoTrue's unit), converted on the way into `AuthSession`. */
  expires_at?: number | null;
};

export type AuthApiResult = {
  user: AuthApiUser | null;
  session: AuthApiSession | null;
  error: { message: string } | null;
};

/**
 * The password half of the provider (publishable key only). Absent when this server has no
 * publishable key configured, which is the expected deployment.
 *
 * Not in SPEC, and no R-row: a test seam, not a rule. An injectable interface rather than a direct
 * `createClient` call inside each method, because `@supabase/supabase-js` builds its own transport
 * and without the seam these paths could only be exercised against a live project. Which shape the
 * seam takes changes nothing a client or a player can observe.
 */
export type PasswordAuthClient = {
  signUp: (email: string, password: string) => Promise<AuthApiResult>;
  signInWithPassword: (email: string, password: string) => Promise<AuthApiResult>;
};

/** What an admin lookup of a user can say. */
export type AdminLookup =
  | { kind: "ok"; user: AuthApiUser }
  /** The auth server has no such user any more (deleted); the token must not be honoured. */
  | { kind: "missing" }
  /** Nobody answered. The identity stands, but the email counts as unverified (fail closed). */
  | { kind: "unavailable" };

/** The admin half (secret key only): §9.4 step 1's authoritative `email_confirmed_at`. */
export type AdminAuthClient = {
  getUserById: (userId: string) => Promise<AdminLookup>;
};

export type SupabaseAuthClients = {
  password: PasswordAuthClient | null;
  admin: AdminAuthClient | null;
};

export type SupabaseAuthClientInput = {
  url: string;
  secretKey: string;
  publishableKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export type SupabaseAuthInput = {
  /** `ServerEnv.SUPABASE_URL`, e.g. `https://<ref>.supabase.co`. */
  url: string;
  /** `ServerEnv.SUPABASE_SECRET_KEY`. Server-only; bypasses RLS; never leaves this module. */
  secretKey: string;
  /**
   * `VITE_SUPABASE_PUBLISHABLE_KEY`'s value, only if this deployment wants the server-side
   * password path at all (BUILD M8's fixture accounts). Omitted in a normal deployment.
   */
  publishableKey?: string;
  /** `ServerEnv.SUPABASE_JWKS_URL`; defaults to the project's own well-known endpoint. */
  jwksUrl?: string;
  /** `ServerEnv.SUPABASE_JWT_SECRET`: the legacy HS256 shared secret, if the project still signs with one. */
  jwtSecret?: string;
  fetchImpl?: typeof fetch;
  /** Not in SPEC, and no R-row: test seam; see `PasswordAuthClient`. */
  clientFactory?: (input: SupabaseAuthClientInput) => SupabaseAuthClients;
  /**
   * Not in SPEC, and no R-row: test seam for the JWKS. Production leaves it unset and gets
   * `createRemoteJWKSet` against `jwksUrl`; jose 5 offers no way to hand that a custom fetch, so
   * a test injects a local key set instead.
   */
  keySet?: JWTVerifyGetKey;
  /**
   * Not in SPEC, and no R-row: test seam for the clock behind `EMAIL_CONFIRMED_CACHE_TTL_MS`;
   * defaults to the host clock. The cache's *duration* is the proposed ruling above; that it can
   * be driven by an injected clock is how it is tested.
   */
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** §9.4 step 1's "verified email", as the auth server states it. */
function isEmailConfirmed(user: AuthApiUser): boolean {
  const at = user.email_confirmed_at;
  return typeof at === "string" && at.length > 0;
}

function asAuthApiUser(value: unknown): AuthApiUser | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  const email = record["email"];
  const confirmedAt = record["email_confirmed_at"];
  return {
    id,
    email: typeof email === "string" ? email : null,
    email_confirmed_at: typeof confirmedAt === "string" ? confirmedAt : null,
    app_metadata: asRecord(record["app_metadata"]),
  };
}

function toAuthUser(user: AuthApiUser): AuthUser {
  return {
    userId: user.id,
    email: user.email ?? null,
    // Authoritative, not `user_metadata` — see the file header.
    emailVerified: isEmailConfirmed(user),
    appMetadata: user.app_metadata ?? {},
  };
}

function toSession(session: AuthApiSession, user: AuthApiUser): AuthSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token ?? null,
    // Not in SPEC, and no R-row: a unit conversion, not a choice. `AuthSession.expiresAt` carries
    // no unit in ports.ts, so it is pinned here to epoch milliseconds to match `Timers.now()` —
    // the only clock this server compares it against — while GoTrue's `expires_at` is epoch
    // seconds. There is no second defensible answer once `Timers.now()` is milliseconds, so this
    // documents a contract rather than deciding one. (It does reach the client, in
    // `apps/web/src/net/api.ts`'s `session.expiresAt`; if §11 ever writes out the wire shapes,
    // that is where this belongs.)
    expiresAt:
      typeof session.expires_at === "number" ? Math.round(session.expires_at * 1000) : null,
    user: toAuthUser(user),
  };
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

// ---------------------------------------------------------------------------
// The real Supabase clients, adapted onto the two narrow interfaces above
// ---------------------------------------------------------------------------

export function createRealClients(input: SupabaseAuthClientInput): SupabaseAuthClients {
  // No session is persisted and nothing is refreshed in the background: this process holds no
  // user session of its own.
  const options = {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(input.fetchImpl === undefined ? {} : { global: { fetch: input.fetchImpl } }),
  };

  type RawResult = {
    data: { user: AuthApiUser | null; session: AuthApiSession | null };
    error: { message: string } | null;
  };
  const adapt = (result: RawResult): AuthApiResult => ({
    user: result.data.user ?? null,
    session: result.data.session ?? null,
    error: result.error,
  });

  const password: PasswordAuthClient | null =
    input.publishableKey === undefined
      ? null
      : (() => {
          const client = createClient(input.url, input.publishableKey, options);
          return {
            signUp: async (email, password_) =>
              adapt((await client.auth.signUp({ email, password: password_ })) as unknown as RawResult),
            signInWithPassword: async (email, password_) =>
              adapt(
                (await client.auth.signInWithPassword({
                  email,
                  password: password_,
                })) as unknown as RawResult,
              ),
          };
        })();

  const adminClient = createClient(input.url, input.secretKey, options);
  const admin: AdminAuthClient = {
    getUserById: async (userId) => {
      let result: Awaited<ReturnType<typeof adminClient.auth.admin.getUserById>>;
      try {
        result = await adminClient.auth.admin.getUserById(userId);
      } catch {
        return { kind: "unavailable" };
      }
      if (result.error !== null) {
        // 404 is the auth server stating the user does not exist; anything else is a fault.
        return (result.error as { status?: number }).status === 404
          ? { kind: "missing" }
          : { kind: "unavailable" };
      }
      const user = asAuthApiUser(result.data.user);
      return user === null ? { kind: "missing" } : { kind: "ok", user };
    },
  };

  return { password, admin };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

type LocalClaims = {
  sub: string;
  email: string | null;
  appMetadata: Record<string, unknown>;
  /** The provider's session this token belongs to (`session_id`), when the token names one. */
  sessionId: string | null;
};

/** What the provider said about a verified token's session (R194). */
type SessionCheck =
  /** It was live a moment ago (remembered); nothing new was learned about the user. */
  | { kind: "remembered" }
  /** Asked just now: live, and this is the authoritative user. */
  | { kind: "live"; user: AuthApiUser }
  /** The provider has ended the session (or the user): the token must not be honoured. */
  | { kind: "ended" }
  /** Nobody answered. The identity stands, as for R159's outage; see `verifyAccessToken`. */
  | { kind: "unavailable" };

/** Unit conversion, not configuration. */
const MS_PER_SECOND = 1000;

export function createSupabaseAuth(input: SupabaseAuthInput): AuthProvider {
  const baseUrl = trimTrailingSlash(input.url);
  const authBase = `${baseUrl}/auth/v1`;
  const jwksUrl = input.jwksUrl ?? `${authBase}/.well-known/jwks.json`;
  const doFetch: typeof fetch = input.fetchImpl ?? ((...args) => fetch(...args));
  const now = input.now ?? systemTimers.now;
  const buildClients = input.clientFactory ?? createRealClients;

  let clients: SupabaseAuthClients | null = null;
  const lazyClients = (): SupabaseAuthClients => {
    clients ??= buildClients({
      url: baseUrl,
      secretKey: input.secretKey,
      publishableKey: input.publishableKey,
      fetchImpl: input.fetchImpl,
    });
    return clients;
  };

  // Built on first use so constructing the provider does no I/O.
  let keySet: JWTVerifyGetKey | null = input.keySet ?? null;
  const keys = (): JWTVerifyGetKey => {
    keySet ??= createRemoteJWKSet(new URL(jwksUrl));
    return keySet;
  };

  // env.ts calls the shared secret "discouraged": a leaked one lets an attacker mint any `sub`.
  // It is only tried when the JWKS path has already failed, and only if configured.
  const hsKey = input.jwtSecret === undefined ? null : new TextEncoder().encode(input.jwtSecret);

  /** userId -> when its *confirmed* email was last read from the auth server. */
  const confirmed = new Map<string, { at: number; email: string | null }>();

  /** session id -> when the provider last said that session is live (R194). Positives only. */
  const liveSessions = new Map<string, number>();
  const liveSessionTtlMs = AUTH_SESSION_LIVE_CACHE_SECONDS * MS_PER_SECOND;

  const verifyOptions = { issuer: authBase, audience: AUTHENTICATED_AUDIENCE };

  const claimsFrom = (payload: JWTPayload): LocalClaims | null => {
    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0) return null;
    const email = payload["email"];
    const sessionId = payload["session_id"];
    return {
      sub,
      email: typeof email === "string" ? email : null,
      // `app_metadata` only. `user_metadata` is user-editable and is never read.
      appMetadata: asRecord(payload["app_metadata"]),
      sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null,
    };
  };

  // Both verifiers swallow their error: it covers a forged or expired token, a project that
  // signs symmetrically (the JWKS then publishes no matching key and jose throws) and a JWKS
  // that could not be fetched. The caller falls through to the next tier.
  const verifyAgainstJwks = async (token: string): Promise<LocalClaims | null> => {
    try {
      const { payload } = await jwtVerify(token, keys(), verifyOptions);
      return claimsFrom(payload);
    } catch {
      return null;
    }
  };

  const verifyAgainstSecret = async (
    token: string,
    key: Uint8Array,
  ): Promise<LocalClaims | null> => {
    try {
      const { payload } = await jwtVerify(token, key, verifyOptions);
      return claimsFrom(payload);
    } catch {
      return null;
    }
  };

  /**
   * Ask the auth server who a token belongs to. Two callers: tier 3, the last-resort verification
   * for a project still signing with a symmetric secret this server has not been given, and
   * `checkSession` (R194), since the provider refuses a token whose session it has ended. The
   * `apikey` header is the publishable key when one is configured, otherwise the secret key — both
   * are Supabase's own credentials and neither is ever echoed back to a caller.
   */
  const fetchUserByToken = async (token: string): Promise<AdminLookup> => {
    let response: Response;
    try {
      response = await doFetch(`${authBase}/user`, {
        method: "GET",
        headers: {
          apikey: input.publishableKey ?? input.secretKey,
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        // The session check (R194) sits in front of API requests: a provider that hangs must cost
        // them a bounded wait, after which the answer is "unavailable" and the identity stands.
        signal: AbortSignal.timeout(AUTH_PROVIDER_TIMEOUT_SECONDS * MS_PER_SECOND),
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (response.status === 401 || response.status === 403) return { kind: "missing" };
    if (!response.ok) return { kind: "unavailable" };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "unavailable" };
    }
    const user = asAuthApiUser(body);
    return user === null ? { kind: "unavailable" } : { kind: "ok", user };
  };

  /** §9.4 step 1's input, taken from the auth server rather than from the token. */
  const authoritativeUser = async (userId: string): Promise<AdminLookup> => {
    const cached = confirmed.get(userId);
    if (cached !== undefined && now() - cached.at < EMAIL_CONFIRMED_CACHE_TTL_MS) {
      return {
        kind: "ok",
        user: {
          id: userId,
          email: cached.email,
          // Only confirmed emails are cached, so a hit means confirmed. The timestamp's value is
          // never shown to anyone; `isEmailConfirmed` only asks whether it is set.
          email_confirmed_at: new Date(cached.at).toISOString(),
        },
      };
    }

    const admin = lazyClients().admin;
    if (admin === null) return { kind: "unavailable" };
    const lookup = await admin.getUserById(userId).catch(
      (): AdminLookup => ({ kind: "unavailable" }),
    );
    if (lookup.kind === "ok" && isEmailConfirmed(lookup.user)) {
      confirmed.set(userId, { at: now(), email: lookup.user.email ?? null });
    }
    return lookup;
  };

  /**
   * R194: is the session this verified token names still live at the provider? Asked of
   * `GET /auth/v1/user` with the token itself, which the provider refuses once the session (or the
   * user) is gone. Only a live answer is remembered, per session, so a session ended at the
   * provider is refused here within `AUTH_SESSION_LIVE_CACHE_SECONDS`.
   */
  const checkSession = async (sessionId: string, sub: string, token: string): Promise<SessionCheck> => {
    const at = liveSessions.get(sessionId);
    if (at !== undefined && now() - at < liveSessionTtlMs) return { kind: "remembered" };

    const lookup = await fetchUserByToken(token);
    if (lookup.kind === "unavailable") return { kind: "unavailable" };
    // `/user` answers for the token's own user; any other id is the provider misbehaving, and a
    // token is never honoured on someone else's answer.
    if (lookup.kind === "missing" || lookup.user.id !== sub) {
      liveSessions.delete(sessionId);
      return { kind: "ended" };
    }

    const checkedAt = now();
    // Forget sessions whose answer has lapsed, so the map holds only the recently active ones.
    for (const [id, seen] of liveSessions) {
      if (checkedAt - seen >= liveSessionTtlMs) liveSessions.delete(id);
    }
    liveSessions.set(sessionId, checkedAt);
    // The same answer is R159's authoritative user: a confirmed email is remembered as the admin
    // lookup's would be.
    if (isEmailConfirmed(lookup.user)) confirmed.set(sub, { at: checkedAt, email: lookup.user.email ?? null });
    return { kind: "live", user: lookup.user };
  };

  const requirePasswordClient = (): PasswordAuthClient => {
    const password = lazyClients().password;
    if (password === null) throw new ApiError("unavailable", PASSWORD_PATH_DISABLED_MESSAGE);
    return password;
  };

  return {
    verifyAccessToken: async (token) => {
      if (token.length === 0) return null;

      // Tier 1: the project's published asymmetric keys, its issuer and the `authenticated`
      // audience — no round trip, which is why §9.2's browser-to-auth arrow can stay separate.
      let claims = await verifyAgainstJwks(token);
      // Tier 2: the legacy HS256 shared secret, when the deployment has one.
      if (claims === null && hsKey !== null) claims = await verifyAgainstSecret(token, hsKey);

      if (claims !== null) {
        if (claims.sessionId !== null) {
          const session = await checkSession(claims.sessionId, claims.sub, token);
          // Ended at the provider (a sign-out, a dropped link, a reset elsewhere): not valid.
          if (session.kind === "ended") return null;
          if (session.kind === "live") {
            const authoritative = toAuthUser(session.user);
            return {
              userId: claims.sub,
              email: authoritative.email ?? claims.email,
              emailVerified: authoritative.emailVerified,
              appMetadata: claims.appMetadata,
            };
          }
          // `remembered` or `unavailable`: the admin lookup below decides the email. A provider
          // that cannot be reached does not sign every player out (sign-in is down with it); the
          // identity stands, and the email counts as unverified unless it was already known (R159).
        }
        const lookup = await authoritativeUser(claims.sub);
        // The auth server says this user no longer exists: not currently valid.
        if (lookup.kind === "missing") return null;
        if (lookup.kind === "unavailable") {
          // Fail closed on the security-relevant field: the signature proved who this is, but
          // nothing proved the email is confirmed, so §9.4 step 1 must not pass.
          return {
            userId: claims.sub,
            email: claims.email,
            emailVerified: false,
            appMetadata: claims.appMetadata,
          };
        }
        const authoritative = toAuthUser(lookup.user);
        return {
          userId: claims.sub,
          email: authoritative.email ?? claims.email,
          emailVerified: authoritative.emailVerified,
          // From the verified token's provider-controlled claim, not from the lookup.
          appMetadata: claims.appMetadata,
        };
      }

      // Tier 3: unverifiable locally — ask the auth server, which is the authority either way.
      const lookup = await fetchUserByToken(token);
      if (lookup.kind !== "ok") return null;
      return toAuthUser(lookup.user);
    },

    signUp: async (email, password) => {
      const result = await requirePasswordClient().signUp(email, password);
      if (result.error !== null || result.user === null) {
        throw new ApiError("unauthorized", SIGN_UP_FAILED_MESSAGE);
      }
      // §9.4: "A pending account can log in, verify its email and see the code screen." When the
      // project requires confirmation, GoTrue returns a user with no session; when confirmation
      // is disabled it returns a session and an already-set `email_confirmed_at`. Requiring both
      // means an unconfirmed account never leaves here holding an active session.
      if (result.session === null || !isEmailConfirmed(result.user)) {
        return { pendingEmailVerification: true, userId: result.user.id };
      }
      return toSession(result.session, result.user);
    },

    signInWithPassword: async (email, password) => {
      const result = await requirePasswordClient().signInWithPassword(email, password);
      if (result.error !== null || result.user === null || result.session === null) {
        throw new ApiError("unauthorized", SIGN_IN_FAILED_MESSAGE);
      }
      return toSession(result.session, result.user);
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Anything the provider throws becomes a 401 rather than a 500: a rejected sign-in is an expected
 * outcome, not a server fault, and the provider's own wording never reaches the client (it would
 * distinguish "no such account" from "wrong password"). An `ApiError` the provider raised itself
 * (the 503 for a server with no publishable key) is passed through unchanged.
 */
async function callProvider<T>(
  deps: ServerDeps,
  event: string,
  message: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Tokens and keys are never part of these arguments, so nothing secret is logged.
    deps.log.warn(event, { reason: error instanceof Error ? error.message : String(error) });
    throw new ApiError("unauthorized", message);
  }
}

function sessionBody(session: AuthSession): Record<string, unknown> {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
  };
}

export function createAuthRoutes(): Route[] {
  return [
    // §9.2 puts sign-up in the browser, against Supabase Auth. This route is the optional
    // server-side equivalent for a deployment that configures a publishable key (BUILD M8's
    // fixture accounts); otherwise it answers 503 with `PASSWORD_PATH_DISABLED_MESSAGE`.
    route("POST", "/api/auth/signup", "none", async (req, deps) => {
      const email = str(req.body, "email");
      const password = str(req.body, "password");
      const result = await callProvider(deps, "auth.signup_rejected", SIGN_UP_FAILED_MESSAGE, () =>
        deps.auth.signUp(email, password),
      );

      if ("pendingEmailVerification" in result) {
        // §9.4: the account exists and is pending; it verifies its email, then sees the code
        // screen. No session is handed out until the provider says the email is confirmed.
        return ok({ pendingEmailVerification: true, userId: result.userId, session: null });
      }
      return ok({
        pendingEmailVerification: false,
        userId: result.user.userId,
        session: sessionBody(result),
      });
    }),

    route("POST", "/api/auth/signin", "none", async (req, deps) => {
      const email = str(req.body, "email");
      const password = str(req.body, "password");
      const session = await callProvider(
        deps,
        "auth.signin_rejected",
        SIGN_IN_FAILED_MESSAGE,
        () => deps.auth.signInWithPassword(email, password),
      );
      return ok({
        userId: session.user.userId,
        emailVerified: session.user.emailVerified,
        session: sessionBody(session),
      });
    }),

    // §9.4: declared `user`, not `active`, because this *is* the code screen's read — a pending
    // account must be able to see that it needs a code. Every other authenticated endpoint is
    // `active` and 403s for the same caller (BUILD M6-T1).
    /**
     * The account screen: who you are signed in as, and how you have done.
     *
     * Separate from `/api/auth/me` rather than folded into it because `me` is the GATE's read —
     * every guarded route resolves through it — and counting a profile's whole results history on
     * each of those would put a scan behind every page load. This one is `active`, so it is only
     * reachable by an account that can actually have a record.
     */
    route("GET", "/api/profile", "active", async (req, deps) => {
      const { profile, user } = req;
      if (profile === null || user === null) throw new ApiError("unauthorized", "sign in first");
      const record = await deps.store.results.recordFor(profile.id);
      return ok({
        id: profile.id,
        email: user.email,
        status: profile.status,
        rating: profile.rating,
        record,
        // Computed here so the client cannot disagree with itself about what counts as a played
        // match. Draws count as played and as neither win nor loss, which is the convention every
        // ladder uses; null rather than 0 when nothing has been played, so the screen can say
        // "no matches yet" instead of "0%".
        winRate:
          record.wins + record.losses + record.draws === 0
            ? null
            : record.wins / (record.wins + record.losses + record.draws),
      });
    }),

    route("GET", "/api/auth/me", "user", async (req, deps) => {
      const { profile, user } = req;
      if (profile === null || user === null) throw new ApiError("unauthorized", "sign in first");
      // R259, R264: the Best-of-3 series this profile is in, while it is not over. Between games
      // `currentMatchId` is null and this is the only way a player who waited — the older ticket,
      // or the room's host — learns there is a deck to pick. Its own series only, like the match.
      const series = await deps.store.series.activeFor(profile.id);
      return ok({
        profile: { id: profile.id, status: profile.status, rating: profile.rating },
        // §9.4: "Redeeming an invite code flips pending to active", so only a pending account is
        // shown the code screen. A banned account is not offered a way out of it.
        needsInviteCode: profile.status === "pending",
        emailVerified: user.emailVerified,
        // §9.5: non-null while this profile is in a match, cleared by every ending. Without it a
        // player who was WAITING — the host of a room, or the first ticket in the queue — is never
        // told the match they are already in: the other player's HTTP response carried the id and
        // theirs did not, so they sat on /play while their opponent sat on the board. It is also
        // the only way back into a match after a reload that lost the URL.
        //
        // Safe to return to its owner: it is this caller's own profile row, the same row whose
        // status and rating are already here, and a match id is not a capability — the socket
        // still authenticates and the actor still stamps the seat from the token (§9.3).
        currentMatchId: profile.inMatchId,
        currentSeriesId: series?.id ?? null,
        // The address this account is tied to, so a player can see WHICH account they are signed
        // in as. Read from the auth provider's user (the same place §9.4 step 1 reads
        // `emailVerified` from), never from the token's user_metadata, which is user-editable.
        email: user.email,
      });
    }),
  ];
}

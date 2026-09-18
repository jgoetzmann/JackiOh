/**
 * The HTTP layer: web-standard `Request` in, web-standard `Response` out, no framework.
 *
 * Handlers are plain functions so every endpoint is unit-testable without a listener, and the
 * composition root can mount `createRouter(...)` under whatever host it runs on (a Node listener,
 * a Hono app, an edge worker). Route declarations carry their own auth requirement, which is how
 * SPEC §9.4's "a pending account can see the code screen and nothing else" is enforced in one
 * place instead of at the top of every handler.
 */

import { floodLimits } from "./deps";
import type { AuthUser, Profile, ServerDeps, Timers } from "./ports";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "email_unverified"
  | "account_pending"
  | "account_banned"
  | "not_found"
  | "conflict"
  | "already_in_match"
  | "already_queued"
  | "invalid_code"
  | "update_required"
  | "loadout_invalid"
  | "rate_limited"
  | "unavailable"
  | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  email_unverified: 403,
  account_pending: 403,
  account_banned: 403,
  not_found: 404,
  conflict: 409,
  already_in_match: 409,
  already_queued: 409,
  invalid_code: 400,
  update_required: 409,
  loadout_invalid: 422,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/** The one error shape the client ever sees. */
export type ApiErrorBody = {
  error: { code: ApiErrorCode; message: string; details?: unknown };
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  body(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError("bad_request", message);
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function ok(body: unknown): Response {
  return json(200, body);
}

export function errorResponse(error: ApiError): Response {
  return json(error.status, error.body());
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type ApiRequest = {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly params: Readonly<Record<string, string>>;
  /** Parsed JSON body; `{}` for a request without one. Rejects anything but a JSON object. */
  readonly body: Readonly<Record<string, unknown>>;
  /** §9.4, §9.8: the client address is only ever seen hashed. */
  readonly ipHash: string;
  /** Set when the route declares `auth: "user"` or `"active"`. */
  readonly user: AuthUser | null;
  readonly profile: Profile | null;
};

/** Reads the client address the same way behind a proxy and in a test. */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.length > 0) {
    const first = forwarded.split(",")[0];
    if (first !== undefined && first.trim().length > 0) return first.trim();
  }
  return headers.get("cf-connecting-ip") ?? headers.get("x-real-ip") ?? "0.0.0.0";
}

export function bearerToken(headers: Headers): string | null {
  const raw = headers.get("authorization");
  if (raw === null) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(raw.trim());
  return match?.[1] ?? null;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const text = await request.text();
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("the request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("the request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// Small typed readers, so no handler repeats `typeof x !== "string"`.

export function str(body: Readonly<Record<string, unknown>>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw badRequest(`"${key}" must be a string`);
  return value;
}

export function optionalStr(body: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`"${key}" must be a string`);
  return value;
}

export function bool(body: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = body[key];
  if (typeof value !== "boolean") throw badRequest(`"${key}" must be a boolean`);
  return value;
}

export function stringList(body: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw badRequest(`"${key}" must be an array of strings`);
  }
  return value as string[];
}

export function deckList(body: Readonly<Record<string, unknown>>, key: string): string[][] {
  const value = body[key];
  const bad = badRequest(`"${key}" must be an array of arrays of card ids`);
  if (!Array.isArray(value)) throw bad;
  return value.map((deck) => {
    if (!Array.isArray(deck) || deck.some((entry) => typeof entry !== "string")) throw bad;
    return deck as string[];
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export type Handler = (req: ApiRequest, deps: ServerDeps) => Promise<Response>;

/**
 * - `none`: open (sign-up, sign-in, queue population).
 * - `user`: a valid access token and a profile, whatever its status — the code screen (§9.4).
 * - `active`: additionally `profiles.status === "active"`, which is what gives a pending account
 *   a 403 from collection, loadout and queue (§9.4, BUILD M6-T1).
 */
export type RouteAuth = "none" | "user" | "active";

export type Route = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `/api/rooms/:code/join`; `:name` segments land in `req.params`. */
  path: string;
  auth: RouteAuth;
  handler: Handler;
};

export function route(
  method: Route["method"],
  path: string,
  auth: RouteAuth,
  handler: Handler,
): Route {
  return { method, path, auth, handler };
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const segment = want[i] ?? "";
    const actual = got[i] ?? "";
    if (segment.startsWith(":")) {
      if (actual.length === 0) return null;
      params[segment.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (segment !== actual) return null;
  }
  return params;
}

/**
 * Resolves the caller. A token that does not verify is 401; a verified user with no profile row
 * gets one created lazily as `pending` (§9.4: the account exists the moment auth says so, and it
 * stays pending until a code is redeemed).
 */
export async function resolveCaller(
  deps: ServerDeps,
  headers: Headers,
): Promise<{ user: AuthUser; profile: Profile }> {
  const token = bearerToken(headers);
  if (token === null) throw new ApiError("unauthorized", "sign in first");
  const user = await deps.auth.verifyAccessToken(token);
  if (user === null) throw new ApiError("unauthorized", "sign in first");

  const existing = await deps.store.profiles.getByUserId(user.userId);
  if (existing !== null) return { user, profile: existing };

  const profile = await deps.store.profiles.create({
    userId: user.userId,
    email: user.email ?? "",
    rating: deps.config.eloStart,
    at: deps.timers.now(),
  });
  return { user, profile };
}

/** §9.4: the gate. Exported so a non-HTTP caller (the WebSocket upgrade) uses the same rule. */
export function assertActive(profile: Profile): void {
  if (profile.status === "banned") throw new ApiError("account_banned", "this account is banned");
  if (profile.status === "pending") {
    throw new ApiError(
      "account_pending",
      "redeem an invite code to activate this account",
    );
  }
}

// ---------------------------------------------------------------------------
// §9.8's per-account rate limit
// ---------------------------------------------------------------------------

/**
 * Unit conversion, not configuration: R109 states its API allowance *per minute*, and
 * `API_REQUESTS_PER_MINUTE` (via `floodLimits`) is the number itself.
 */
const API_RATE_WINDOW_MS = 60_000;

/** §9.8, R109: the bucket a request is counted in. Never one shared counter — see `createRouter`. */
export function accountKey(profileId: string): string {
  return `account:${profileId}`;
}

/**
 * The bucket for a request that named no account: an `auth: "none"` route, or a token that did not
 * verify. Prefixed apart from `accountKey` so an IP hash can never land in a profile's bucket.
 */
export function addressKey(ipHash: string): string {
  return `address:${ipHash}`;
}

export type RateLimiter = {
  /** True while this key is still inside its allowance; false once it is over it. */
  allow: (key: string, now: number) => boolean;
  /** How many keys are being tracked, so a test can see idle ones dropped. */
  readonly size: number;
};

/**
 * §9.8: "per-account rate limit at the API", R109: 300 requests per minute per account.
 *
 * One sliding window per key, the same shape as the actor's per-seat `floodExceeded`
 * (`src/match/actor.ts`) — the other half of the same §9.8 row — so the two limits are one
 * mechanism read twice rather than two mechanisms that can drift.
 *
 * A request that is over the limit is **not** recorded: like §9.4's attempt log (`codes.ts`), the
 * window drains, so a caller who keeps hammering cannot pin their own counter open for ever.
 *
 * Idle keys are swept once per window rather than left to accumulate, so a long-lived process does
 * not hold a timestamp array for every account that ever called it.
 */
export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>();
  let sweptAt = 0;

  const drop = (times: number[], now: number): void => {
    while (times.length > 0 && (times[0] ?? 0) <= now - windowMs) times.shift();
  };

  return {
    get size() {
      return hits.size;
    },
    allow: (key, now) => {
      if (now - sweptAt >= windowMs) {
        sweptAt = now;
        for (const [candidate, times] of hits) {
          if ((times.at(-1) ?? 0) <= now - windowMs) hits.delete(candidate);
        }
      }

      const times = hits.get(key) ?? [];
      hits.set(key, times);
      drop(times, now);
      if (times.length >= limit) return false;
      times.push(now);
      return true;
    },
  };
}

export type Router = (request: Request) => Promise<Response>;

export function createRouter(routes: readonly Route[], deps: ServerDeps): Router {
  /**
   * §9.8's "per-account rate limit at the API", held here for the same reason `createCodesRoutes`
   * holds its circuit breaker in a closure: a fresh router starts with an empty window, so one
   * test's flood cannot leak into the next.
   *
   * R137's reasoning applies to this half of §9.8 as much as to the actor's: a single shared
   * counter lets one caller spend everybody else's budget, turning the anti-abuse limit into the
   * abuse. So the key is the **account** — `profiles.id`, the row §9.4 owns, not the auth user id
   * and not the bearer token, either of which a caller can hold several of for one account.
   *
   * NOT IN SPEC: what to key a request that names no account on. §9.8 and R109 say "per account",
   * and an open route (sign-up, sign-in, the queue population) and a token that did not verify have
   * none. They are keyed on the request's IP hash instead — never on one shared bucket, which would
   * be exactly the failure R137 describes. The two namespaces are kept apart by their prefixes.
   */
  const limiter = createRateLimiter(floodLimits.apiRequestsPerMinute, API_RATE_WINDOW_MS);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let pathMatched = false;

    for (const candidate of routes) {
      const params = matchPath(candidate.path, url.pathname);
      if (params === null) continue;
      pathMatched = true;
      if (candidate.method !== request.method) continue;

      try {
        let user: AuthUser | null = null;
        let profile: Profile | null = null;
        // Resolved before the rate limit because only auth knows which account a request belongs
        // to, and the account is R109's key. A refusal is held rather than thrown, so a flood of
        // bad tokens is still counted — against its address, since it named no account.
        let authError: ApiError | null = null;
        if (candidate.auth !== "none") {
          try {
            const caller = await resolveCaller(deps, request.headers);
            user = caller.user;
            profile = caller.profile;
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            authError = error;
          }
        }

        // §9.4, §9.8: the client address is only ever seen hashed. Read once, for the limiter and
        // for the request alike.
        const ipHash = deps.hashes.ip(clientAddress(request.headers));

        // §9.8: "per-account rate limit at the API" (R109: 300 a minute). Checked before the body
        // is read and before §9.4's gate, so a flood costs the least work this router can manage.
        const key = profile === null ? addressKey(ipHash) : accountKey(profile.id);
        if (!limiter.allow(key, deps.timers.now())) {
          // §9.8: "Every rejected action is logged with its reason."
          deps.log.warn("api.rate_limited", { path: url.pathname, key });
          throw new ApiError("rate_limited", "too many requests; slow down");
        }

        if (authError !== null) throw authError;
        if (candidate.auth === "active" && profile !== null) assertActive(profile);

        const req: ApiRequest = {
          method: request.method,
          url,
          headers: request.headers,
          params,
          body: await readBody(request),
          ipHash,
          user,
          profile,
        };
        return await candidate.handler(req, deps);
      } catch (error) {
        if (error instanceof ApiError) return errorResponse(error);
        deps.log.warn("handler.threw", {
          path: url.pathname,
          message: error instanceof Error ? error.message : String(error),
        });
        return errorResponse(new ApiError("internal", "something went wrong"));
      }
    }

    if (pathMatched) {
      return errorResponse(new ApiError("not_found", "method not allowed for this path"));
    }
    return errorResponse(new ApiError("not_found", "no such endpoint"));
  };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export function sleep(timers: Timers, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    timers.after(ms, resolve);
  });
}

/**
 * §9.4: "Missing, expired and exhausted codes return an identical error in identical time."
 * Every redemption response is padded to the same floor measured from `startedAt`, so the work
 * each branch did is invisible from the outside.
 */
export async function padTo(timers: Timers, startedAt: number, floorMs: number): Promise<void> {
  await sleep(timers, floorMs - (timers.now() - startedAt));
}

/**
 * The HTTP layer: web-standard `Request` in, web-standard `Response` out, no framework.
 *
 * Handlers are plain functions so every endpoint is unit-testable without a listener, and the
 * composition root can mount `createRouter(...)` under whatever host it runs on (a Node listener,
 * a Hono app, an edge worker). Route declarations carry their own auth requirement, which is how
 * SPEC §9.4's "a pending account can see the code screen and nothing else" is enforced in one
 * place instead of at the top of every handler.
 */

import { isIPv4, isIPv6 } from "node:net";

import {
  API_MAX_BODY_BYTES,
  DEFAULT_TRUSTED_PROXY_HOPS,
  IPV6_RATE_LIMIT_PREFIX_BITS,
  MAX_TRUSTED_PROXY_HOPS,
} from "../config";
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

/**
 * SPEC §11 R192: a refusal because the caller is going too fast says so, with how long to wait.
 * The wait travels as `details.retryAfterMs` and, through `errorResponse`, as `Retry-After`.
 */
export function rateLimited(message: string, retryAfterMs: number): ApiError {
  return new ApiError("rate_limited", message, { retryAfterMs });
}

/** `details.retryAfterMs` of a `rate_limited` error when it is a finite number >= 0, else null. */
function retryAfterMsOf(error: ApiError): number | null {
  if (error.code !== "rate_limited") return null;
  const details = error.details;
  if (typeof details !== "object" || details === null) return null;
  const wait = (details as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0) return null;
  return wait;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS } });
}

export function ok(body: unknown): Response {
  return json(200, body);
}

/**
 * The one error response. A `rate_limited` error whose `details.retryAfterMs` is a finite number
 * >= 0 also carries `Retry-After` in whole seconds, rounded up (R192). No other error gains a
 * header: R145's `invalid_code` in particular stays byte for byte and header for header what it was.
 */
export function errorResponse(error: ApiError): Response {
  const wait = retryAfterMsOf(error);
  if (wait === null) return json(error.status, error.body());
  return new Response(JSON.stringify(error.body()), {
    status: error.status,
    headers: { ...JSON_HEADERS, "retry-after": String(Math.ceil(wait / 1000)) },
  });
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

/**
 * What the host knows about the connection a request arrived on, which the `Request` itself does
 * not carry. `src/index.ts` fills it from the socket; a test builds one by hand.
 */
export type RequestContext = { readonly peerAddress: string | null };

/** The address a request is keyed on when neither the forwarded chain nor the socket names one. */
export const UNKNOWN_CLIENT_ADDRESS = "unknown";

/** Every `X-Forwarded-For` entry, split on commas and trimmed, with empty entries dropped. */
function forwardedEntries(headers: Headers): string[] {
  const raw = headers.get("x-forwarded-for");
  if (raw === null) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * SPEC §11 R190: the address a per-IP limit counts (§9.4 step 3, R157).
 *
 * Behind a proxy every request arrives from the proxy, so the client's address is read from
 * `X-Forwarded-For` — but only from the entry the deployment's own proxies wrote. Each trusted hop
 * appends one entry on the right, so with `trustedProxyHops` hops the client is
 * `entries[length - hops]`. Everything to the left of it was written by the caller, who can put
 * anything there: reading the leftmost entry, as this function once did, let a caller pick a fresh
 * bucket for every request by changing one header. `CF-Connecting-IP` and `X-Real-IP` are never
 * read, for the same reason: nothing in this deployment writes them, so a caller can.
 *
 * With fewer entries than trusted hops (none included), or with `trustedProxyHops` 0, the request
 * came from something other than the proxy chain and is keyed on the socket's peer address, or on
 * `UNKNOWN_CLIENT_ADDRESS` when the host gave none.
 */
export function clientAddress(
  headers: Headers,
  peerAddress: string | null,
  trustedProxyHops: number,
): string {
  const entries = forwardedEntries(headers);
  if (trustedProxyHops >= 1 && entries.length >= trustedProxyHops) {
    const entry = entries[entries.length - trustedProxyHops];
    if (entry !== undefined) return entry;
  }
  const peer = peerAddress?.trim() ?? "";
  return peer.length > 0 ? peer : UNKNOWN_CLIENT_ADDRESS;
}

/** An IPv6 address as its eight 16-bit groups, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  if (!isIPv6(address)) return null;
  let text = address;
  // A trailing dotted IPv4 (`::ffff:192.0.2.1`) is the last two groups.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text);
  if (dotted !== null) {
    const octets = (dotted[2] ?? "").split(".").map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${dotted[1] ?? ""}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string): number[] =>
    part.length === 0 ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array.from({ length: zeros }, () => 0), ...right];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/**
 * SPEC §11 R190: the key a per-IP limit counts an address under, before it is hashed.
 *
 * An IPv4 address is itself. An IPv6 address is its first `IPV6_RATE_LIMIT_PREFIX_BITS` bits (a /56):
 * a host holds at least a /64 and often a whole /56 delegation, so keying on the full address gave
 * one host 2^64 fresh buckets for §9.4 step 3 and R157, and keying on the /64 still gave it 256. An
 * IPv4-mapped IPv6 address (`::ffff:192.0.2.1`, how
 * a dual-stack socket reports an IPv4 peer) is the IPv4 address, so one caller is one key whichever
 * way it arrived. Brackets, a zone and an IPv4 port are dropped first. Anything else (the
 * `UNKNOWN_CLIENT_ADDRESS` marker, a malformed entry) is keyed as written, lower-cased.
 */
export function rateLimitAddress(raw: string, prefixBits: number = IPV6_RATE_LIMIT_PREFIX_BITS): string {
  let address = raw.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(address);
  if (bracketed !== null) address = bracketed[1] ?? address;
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/u.exec(address);
  if (withPort !== null) address = withPort[1] ?? address;
  address = address.replace(/%.*$/u, "");
  if (isIPv4(address)) return address;

  const groups = ipv6Groups(address);
  if (groups === null) return raw.trim().toLowerCase();
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  const bits = Math.max(0, Math.min(128, Math.floor(prefixBits)));
  const masked = groups.map((group, index) => {
    const keep = Math.max(0, Math.min(16, bits - index * 16));
    return keep === 0 ? 0 : group & ((0xffff << (16 - keep)) & 0xffff);
  });
  return `${masked.map((group) => group.toString(16)).join(":")}/${String(bits)}`;
}

export function bearerToken(headers: Headers): string | null {
  const raw = headers.get("authorization");
  if (raw === null) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(raw.trim());
  return match?.[1] ?? null;
}

/** The refusal for a body past `API_MAX_BODY_BYTES`, raised before any JSON parsing. */
function bodyTooLarge(): ApiError {
  return badRequest("the request body is too large");
}

/**
 * The body as text, refused once it passes `API_MAX_BODY_BYTES`. A declared `content-length` over
 * the cap is refused without reading; otherwise the stream is read chunk by chunk and abandoned the
 * moment it passes the cap, so a huge body is never buffered whole.
 */
async function readBodyText(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > API_MAX_BODY_BYTES) throw bodyTooLarge();
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > API_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw bodyTooLarge();
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const text = await readBodyText(request);
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
  /**
   * R192: how long until this key has room again. 0 while it has room; otherwise the time until
   * the oldest counted hit leaves the window (`oldestCountedHit + windowMs - now`).
   */
  retryAfterMs: (key: string, now: number) => number;
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
    retryAfterMs: (key, now) => {
      const counted = (hits.get(key) ?? []).filter((at) => at > now - windowMs);
      if (counted.length < limit) return 0;
      const oldest = counted[0] ?? now;
      return Math.max(0, oldest + windowMs - now);
    },
  };
}

/** `context` is optional so a test or a non-socket host can call a router with a bare `Request`. */
export type Router = (request: Request, context?: RequestContext) => Promise<Response>;

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
   * SPEC §11 R157 settles what to key a request that names no account on: §9.8 and R109 say "per
   * account", and an open route (sign-up, sign-in, the queue population) and a token that did not
   * verify have none, so such a request "is counted against its IP hash instead, in a namespace of
   * its own" — never on one shared bucket, which would be exactly the failure R137 describes. R157
   * also fixes the account key as `profiles.id` rather than the auth user or the bearer token. The
   * two namespaces are kept apart by their prefixes.
   */
  const limiter = createRateLimiter(floodLimits.apiRequestsPerMinute, API_RATE_WINDOW_MS);

  /**
   * R190's operator signal: the FEWEST `X-Forwarded-For` entries any request has carried. A caller
   * can add entries on the left but never remove the ones the deployment's own proxies append, so
   * the lowest count seen is the number of hops those proxies add, and `TRUSTED_PROXY_HOPS` must not
   * be more than it (docs/architecture.md §10). One sample would not do: the first request after a
   * deploy may be a scanner that wrote its own entries, and raising the hops to its count would
   * hand the key back to the caller. So a line is logged each time a request carries fewer entries
   * than any before it. Counts past `MAX_TRUSTED_PROXY_HOPS + 1` are all "too many", so a caller
   * can cause at most a handful of lines per router. No address is ever logged: two numbers only.
   */
  let fewestForwarded: number | null = null;

  return async (request: Request, context?: RequestContext): Promise<Response> => {
    const url = new URL(request.url);
    let pathMatched = false;
    const trustedProxyHops = deps.trustedProxyHops ?? DEFAULT_TRUSTED_PROXY_HOPS;

    if (request.headers.has("x-forwarded-for")) {
      const entries = forwardedEntries(request.headers).length;
      const capped = Math.min(entries, MAX_TRUSTED_PROXY_HOPS + 1);
      if (fewestForwarded === null || capped < fewestForwarded) {
        fewestForwarded = capped;
        deps.log.info("api.forwarded_for", { fewestEntries: entries, trustedProxyHops });
      }
    }

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
        // for the request alike, and read as R190 says: the rightmost trusted hop, then the peer,
        // with an IPv6 client counted by its /56.
        const ipHash = deps.hashes.ip(
          rateLimitAddress(clientAddress(request.headers, context?.peerAddress ?? null, trustedProxyHops)),
        );

        // §9.8: "per-account rate limit at the API" (R109: 300 a minute). Checked before the body
        // is read and before §9.4's gate, so a flood costs the least work this router can manage.
        const key = profile === null ? addressKey(ipHash) : accountKey(profile.id);
        const now = deps.timers.now();
        if (!limiter.allow(key, now)) {
          // §9.8: "Every rejected action is logged with its reason."
          deps.log.warn("api.rate_limited", { path: url.pathname, key });
          // R192: the refusal says how long until the oldest counted request leaves the window.
          throw rateLimited("too many requests; slow down", limiter.retryAfterMs(key, now));
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

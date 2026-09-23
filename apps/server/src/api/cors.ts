/**
 * CORS for the REST surface.
 *
 * WHY IT IS NEEDED. SPEC §9.2 puts the browser and the API on separate arrows, and in this repo
 * they are separate origins: `apps/web` is served from `http://localhost:5173` (Vite) and calls
 * `apps/server` on `http://localhost:8787` (`apiBaseUrl()` in `apps/web/src/net/api.ts`). Without
 * these headers every `fetch` from the app is blocked by the browser before the handler is ever
 * reached, while a non-browser caller — `cy.request`, curl, the `wsPlayer` task — is unaffected.
 * That asymmetry is exactly the failure mode worth avoiding: the e2e suite's HTTP assertions would
 * pass while the screens they are about stay empty.
 *
 * `src/env.ts` already names the list this reads: "PUBLIC_ORIGINS: allowed browser origins for
 * CORS and WebSocket `Origin` checks". `src/match/wsServer.ts` was the only reader until now.
 *
 * THREE RULES THIS FILE KEEPS — never `*` and never credentials, `Vary: Origin` on everything it
 * touches, and an unlisted origin is refused by silence rather than by a status. They are stated
 * once, as the proposal below, rather than twice here.
 *
 * NOT IN SPEC, and no R-row yet — PROPOSED RULING for §11:
 *   Topic: The CORS contract for the REST surface
 *   Ruling: The API answers a browser from an allowed origin by echoing that one origin, never
 *     `*`, and never sends `Access-Control-Allow-Credentials`: §9.1's client authenticates with a
 *     bearer token in a header, so a cookie is never in play and the wildcard is never needed, and
 *     a response that carried credentials would make every allowed origin able to act as the
 *     player. Every response the layer touches carries `Vary: Origin`, because the answer depends
 *     on the request's origin and a shared cache must not serve one origin's answer to another.
 *     An unlisted origin is not an error: it gets the ordinary response with no CORS headers,
 *     which is what the browser needs in order to refuse it, where a 403 would tell a page nothing
 *     it could not already tell and would change the answer a non-browser caller gets — `cy.request`
 *     and the `wsPlayer` task are not subject to CORS at all, and §9.1 puts the rules in the
 *     server, so CORS must never be load-bearing for a refusal. The allowed list is
 *     `PUBLIC_ORIGINS`, the same list §9.2's WebSocket `Origin` check reads, so the two doors
 *     cannot diverge.
 *   Affects: §9.1, §9.2, §9.8; `api/cors.ts`, `match/wsServer.ts`, `env.ts`.
 *
 * §9 never writes out the header set itself, and it is derived rather than chosen: the two request
 * headers below are the two `apps/web/src/net/api.ts` sends (`authorization` and `content-type`)
 * and the methods are the five `Route["method"]` allows.
 */

import type { Logger } from "./ports";

/** The methods `Route["method"]` (http.ts) allows, plus the preflight itself. */
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/** Exactly what `apps/web/src/net/api.ts` sets on a request. */
const ALLOWED_HEADERS = "authorization, content-type";

/**
 * Not in SPEC, and no R-row: a tuning value with no consequence. Ten minutes of preflight caching
 * saves a round trip; nothing in the CORS contract above, and nothing a player or a client can
 * observe, changes if it is zero or an hour.
 */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * BUILD M8: "`E2E=1` pnpm --dir apps/web dev — must serve http://localhost:5173" (`e2e/README.md`).
 * End-to-end mode adds these to `PUBLIC_ORIGINS` so a checkout with no `.env` still lets the app
 * talk to the server; production adds nothing and reads only the environment.
 */
export const VITE_DEV_ORIGINS: readonly string[] = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export type CorsOptions = {
  /** `env.PUBLIC_ORIGINS`, plus the dev origins end-to-end mode adds. */
  origins: readonly string[];
  /** Optional: a refused preflight is worth one line when a screen mysteriously sees nothing. */
  log?: Logger;
};

/**
 * `http://localhost:5173/` and `http://localhost:5173` are the same origin; a browser always sends
 * the second form, but a hand-written `PUBLIC_ORIGINS` may hold the first.
 */
function canonicalOrigin(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

export function isOriginAllowed(origins: readonly string[], origin: string | null): boolean {
  if (origin === null || origin.length === 0) return false;
  const wanted = canonicalOrigin(origin);
  return origins.some((allowed) => canonicalOrigin(allowed) === wanted);
}

/** The headers an allowed origin gets on every response, preflight or not. */
function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": canonicalOrigin(origin),
    vary: "Origin",
  };
}

/**
 * Wraps a `Request -> Response` handler with CORS. Preflights are answered here and never reach
 * the router, which knows no `OPTIONS` route and would answer 404 for one.
 *
 * `context` is whatever the host knows about the connection (the router's `RequestContext`, which
 * carries the socket's peer address for R190). It is passed through unchanged: CORS never reads it.
 */
export function withCors<C>(
  handler: (request: Request, context?: C) => Promise<Response>,
  options: CorsOptions,
): (request: Request, context?: C) => Promise<Response> {
  const origins = options.origins.map(canonicalOrigin).filter((origin) => origin.length > 0);

  return async (request: Request, context?: C): Promise<Response> => {
    const origin = request.headers.get("origin");
    const allowed = isOriginAllowed(origins, origin);

    if (request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
      if (!allowed) {
        options.log?.warn("cors.preflight_refused", {
          origin: origin ?? "(none)",
          allowed: origins,
        });
        // No CORS headers: the browser refuses it, which is the correct outcome. `Vary: Origin`
        // still goes on, because R162 puts it on EVERY response this layer touches — the answer
        // depends on the request's origin, so a shared cache must not serve this one to an origin
        // that would have been allowed.
        return new Response(null, { status: 204, headers: { vary: "Origin" } });
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin ?? ""),
          "access-control-allow-methods": ALLOWED_METHODS,
          "access-control-allow-headers": ALLOWED_HEADERS,
          "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
        },
      });
    }

    const response = await handler(request, context);
    if (!allowed || origin === null) {
      // R162 again: the ordinary response an unlisted or origin-less caller gets is still an answer
      // that depended on the origin, so it is still cacheable-per-origin. Without this a shared
      // cache can store the no-CORS-headers answer and later hand it to an allowed origin, which is
      // exactly the failure the clause names.
      const bare = new Headers(response.headers);
      bare.set("vary", "Origin");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: bare,
      });
    }

    // `Response` headers are immutable once constructed by some runtimes, so the headers are
    // copied rather than mutated in place.
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

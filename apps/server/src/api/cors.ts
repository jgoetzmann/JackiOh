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
 * THREE RULES THIS FILE KEEPS.
 *
 *  - **Never `*`, and never credentials.** The client authenticates with a bearer token in a
 *    header (`apps/web/src/net/api.ts`), not with a cookie, so `Access-Control-Allow-Credentials`
 *    is never sent and the wildcard is never needed. A response either echoes one allowed origin
 *    or carries no CORS header at all.
 *  - **`Vary: Origin` on everything it touches**, because the answer depends on the request's
 *    origin and a shared cache must not serve one origin's answer to another.
 *  - **An unlisted origin is not an error.** It gets the ordinary response with no CORS headers,
 *    which is what the browser needs to see to refuse it; inventing a 403 would tell a page
 *    nothing it cannot already tell, and would change the answer a non-browser caller gets.
 *
 * NOT IN SPEC: SPEC §9 never writes out the header set. The two request headers below are the two
 * `apps/web/src/net/api.ts` sends (`authorization` and `content-type`) and the methods are the
 * five `Route["method"]` allows.
 */

import type { Logger } from "./ports";

/** The methods `Route["method"]` (http.ts) allows, plus the preflight itself. */
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

/** Exactly what `apps/web/src/net/api.ts` sets on a request. */
const ALLOWED_HEADERS = "authorization, content-type";

/** NOT IN SPEC: how long a browser may cache a preflight. Ten minutes; nothing depends on it. */
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
 */
export function withCors<H extends (request: Request) => Promise<Response>>(
  handler: H,
  options: CorsOptions,
): (request: Request) => Promise<Response> {
  const origins = options.origins.map(canonicalOrigin).filter((origin) => origin.length > 0);

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const allowed = isOriginAllowed(origins, origin);

    if (request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
      if (!allowed) {
        options.log?.warn("cors.preflight_refused", {
          origin: origin ?? "(none)",
          allowed: origins,
        });
        // No CORS headers: the browser refuses it, which is the correct outcome.
        return new Response(null, { status: 204 });
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

    const response = await handler(request);
    if (!allowed || origin === null) return response;

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

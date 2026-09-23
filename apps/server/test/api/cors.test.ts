/**
 * SPEC §11 R162 — the CORS contract for the REST surface (`src/api/cors.ts`).
 *
 * R162 fixes four things, and every one of them is a *negative* that a broken layer would satisfy
 * by accident:
 *
 *  - an allowed origin is echoed back **as itself**, never `*`;
 *  - `Access-Control-Allow-Credentials` is never sent, because §9.1's client carries a bearer
 *    token in a header and a credentialed response would let every allowed origin act as the
 *    player;
 *  - `Vary: Origin`, because the answer depends on the request's origin;
 *  - an unlisted origin gets **the ordinary response with no CORS headers**, not a 403 — CORS is
 *    never load-bearing for a refusal, since §9.1 puts the rules in the server and a non-browser
 *    caller (`cy.request`, the `wsPlayer` task) is not subject to CORS at all.
 *
 * The last one is the reason this file asserts the live case first, every time. "No CORS headers
 * for an unlisted origin" is also what a middleware that never ran produces, and "not a 403" is
 * what a handler that answered 500 produces — so each negative here is paired with the allowed
 * request that proves the layer is awake, and with a count of how many times the wrapped handler
 * was actually entered.
 *
 * Deterministic by construction: `withCors` is a pure `Request -> Response` wrapper with no clock,
 * no store and no network, so nothing here needs a timer port.
 */

import { describe, expect, it } from "vitest";
import { VITE_DEV_ORIGINS, isOriginAllowed, withCors } from "../../src/api/cors";
import { browserOrigins } from "../../src/index";
import { DEFAULT_TRUSTED_PROXY_HOPS } from "../../src/config";
import type { ServerEnv } from "../../src/env";
import { createRecordingLogger } from "../fakes/deps";

/** A complete `ServerEnv`, so `browserOrigins` is called with the shape it is declared for. */
function testEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    SUPABASE_URL: "https://project.supabase.test",
    SUPABASE_SECRET_KEY: "secret",
    DATABASE_URL: "postgres://localhost/jackioh",
    SUPABASE_JWKS_URL: "https://project.supabase.test/auth/v1/.well-known/jwks.json",
    SUPABASE_JWT_SECRET: undefined,
    CODE_PEPPER: "pepper",
    PORT: 8787,
    PUBLIC_ORIGINS: [],
    NODE_ENV: "test",
    E2E: false,
    CATALOG_VERSION: "test-1",
    TRUSTED_PROXY_HOPS: DEFAULT_TRUSTED_PROXY_HOPS,
    ...overrides,
  };
}

/** Two allowed origins, so "echoes the one that asked" can be told from "echoes the first". */
const APP = "http://localhost:5173";
const OTHER = "https://play.jackioh.test";
const ALLOWED = [APP, OTHER];

/** Never in the list. */
const STRANGER = "https://evil.example";

const PATH = "/api/queue/population";
const BODY = JSON.stringify({ population: 3 });

type Wrapped = {
  /** How many times the wrapped handler was entered — the premise every negative leans on. */
  calls: () => number;
  send: (init?: { origin?: string; method?: string; preflight?: boolean }) => Promise<Response>;
};

/**
 * `withCors` around a handler that records every entry and answers the same 200 every time, so a
 * difference in any response below comes from the CORS layer and from nothing else.
 */
function wrapped(origins: readonly string[] = ALLOWED): Wrapped {
  let calls = 0;
  const handler = withCors(
    async (_request: Request): Promise<Response> => {
      calls += 1;
      return new Response(BODY, { status: 200, headers: { "content-type": "application/json" } });
    },
    { origins, log: createRecordingLogger() },
  );

  return {
    calls: () => calls,
    send: async ({ origin, method = "GET", preflight = false } = {}) => {
      const headers = new Headers();
      if (origin !== undefined) headers.set("origin", origin);
      if (preflight) headers.set("access-control-request-method", "POST");
      return handler(
        new Request(`https://server.test${PATH}`, {
          method: preflight ? "OPTIONS" : method,
          headers,
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// R162
// ---------------------------------------------------------------------------

describe("R162 — the CORS contract for the REST surface (§9.1, §9.2, §9.8)", () => {
  it("R162 echoes the one origin that asked, never `*`, and never allows credentials", async () => {
    const layer = wrapped();

    const first = await layer.send({ origin: APP });
    const second = await layer.send({ origin: OTHER });

    // The premise: the layer is awake and the handler's own answer came through untouched.
    expect(layer.calls()).toBe(2);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(BODY);

    // Echoed *as itself*: each request gets its own origin back, not the first in the list.
    expect(first.headers.get("access-control-allow-origin")).toBe(APP);
    expect(second.headers.get("access-control-allow-origin")).toBe(OTHER);
    // Never the wildcard, whichever origin asked.
    for (const response of [first, second]) {
      expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
      // §9.1's bearer token is in a header, so no cookie is ever in play.
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      // The answer depends on the request's origin: a shared cache must key on it.
      expect(response.headers.get("vary")).toBe("Origin");
    }
  });

  it("R162 answers an allowed preflight itself, with the same echo and no credentials", async () => {
    const layer = wrapped();

    const preflight = await layer.send({ origin: APP, preflight: true });

    // The preflight never reaches the router, which knows no OPTIONS route and would 404 it.
    expect(layer.calls()).toBe(0);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(APP);
    expect(preflight.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    expect(preflight.headers.get("vary")).toBe("Origin");
    // The methods `Route["method"]` allows and the two headers `apps/web/src/net/api.ts` sends.
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
  });

  it("R162 gives an unlisted origin the ordinary response with no CORS headers, not a 403", async () => {
    const layer = wrapped();

    // PREMISE FIRST. Without this the assertions below would pass against a layer that never ran,
    // a handler that always 403s, or an `origins` list this test misspelled.
    const allowed = await layer.send({ origin: APP });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(APP);

    const unlisted = await layer.send({ origin: STRANGER });

    // The handler ran for the stranger too — the request was not refused by the CORS layer.
    expect(layer.calls()).toBe(2);
    // The *ordinary* response: byte for byte what the allowed origin got, minus the headers.
    expect(unlisted.status).toBe(200);
    expect(unlisted.status).not.toBe(403);
    expect(await unlisted.text()).toBe(BODY);
    expect(unlisted.headers.get("content-type")).toBe("application/json");
    // …and no CORS headers at all, which is what the browser needs in order to refuse it.
    expect(unlisted.headers.get("access-control-allow-origin")).toBeNull();
    expect(unlisted.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("R162 refuses an unlisted preflight by silence rather than by a status", async () => {
    const layer = wrapped();

    // PREMISE: the allowed preflight really is decorated, so "no headers" below means something.
    const allowed = await layer.send({ origin: APP, preflight: true });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(APP);

    const unlisted = await layer.send({ origin: STRANGER, preflight: true });

    expect(unlisted.status).toBe(204);
    expect(unlisted.status).not.toBe(403);
    expect(unlisted.headers.get("access-control-allow-origin")).toBeNull();
    expect(unlisted.headers.get("access-control-allow-methods")).toBeNull();
    // Neither preflight reached the router.
    expect(layer.calls()).toBe(0);
  });

  it("R162 leaves a caller with no Origin at all completely alone (§9.1: not a browser)", async () => {
    const layer = wrapped();

    // PREMISE: the same request *with* an allowed origin is decorated.
    expect((await layer.send({ origin: APP })).headers.get("access-control-allow-origin")).toBe(APP);

    const curl = await layer.send();

    expect(layer.calls()).toBe(2);
    expect(curl.status).toBe(200);
    expect(await curl.text()).toBe(BODY);
    expect(curl.headers.get("access-control-allow-origin")).toBeNull();
    // `cy.request` and the e2e `wsPlayer` task are not subject to CORS, so the server's own rules
    // must be the only thing that ever refuses them.
    expect(curl.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("R162 reads one list for both doors, so CORS and the WebSocket origin check cannot diverge", () => {
    // `src/index.ts` builds the list once and hands the same array to `withCors` and to
    // `attachWebSocketServer`; `isOriginAllowed` is the predicate the CORS half applies to it.
    const origins = browserOrigins(testEnv({ PUBLIC_ORIGINS: [OTHER], E2E: true }));
    expect(origins).toContain(OTHER);
    for (const dev of VITE_DEV_ORIGINS) expect(origins).toContain(dev);

    expect(isOriginAllowed(origins, OTHER)).toBe(true);
    expect(isOriginAllowed(origins, APP)).toBe(true);
    expect(isOriginAllowed(origins, STRANGER)).toBe(false);
    // An absent origin is not "allowed"; it is simply not a browser (see the test above).
    expect(isOriginAllowed(origins, null)).toBe(false);

    // A hand-written PUBLIC_ORIGINS may carry a trailing slash; a browser never sends one.
    expect(isOriginAllowed([`${OTHER}/`], OTHER)).toBe(true);
  });

  // R162's remaining clause, which was a real gap when this file was written and is now closed:
  // "every response the layer touches carries `Vary: Origin`". `corsHeaders` only runs on the two
  // ALLOWED paths (asserted above), so the refused preflight and the ordinary response to an
  // unlisted or absent origin used to come back bare — and a shared cache could then store the
  // no-CORS answer and hand it to an origin that would have been allowed, which is the exact
  // failure the clause names.
  it("R162 carries Vary: Origin on every response the layer touches, refusals included", async () => {
    const layer = wrapped();

    // Premise: the allowed path really does set it, so a blanket failure cannot pass this test.
    const allowed = await layer.send({ origin: APP });
    expect(allowed.headers.get("vary")).toBe("Origin");

    // A refused preflight: no CORS headers, but still an origin-dependent answer, so still varied.
    const refused = await layer.send({ origin: STRANGER, preflight: true });
    expect(refused.status).toBe(204);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    expect(refused.headers.get("vary")).toBe("Origin");

    // An unlisted origin gets the ordinary answer — body intact, no CORS headers, still varied.
    const unlisted = await layer.send({ origin: STRANGER });
    expect(unlisted.status).toBe(200);
    expect(await unlisted.text()).toBe(BODY);
    expect(unlisted.headers.get("access-control-allow-origin")).toBeNull();
    expect(unlisted.headers.get("vary")).toBe("Origin");

    // And a caller with no Origin at all, which is every non-browser client.
    const anonymous = await layer.send({});
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("vary")).toBe("Origin");
  });
});

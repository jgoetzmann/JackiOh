/**
 * SPEC §9.8's second flood limit: "Per-match rate limit in the actor, **per-account rate limit at
 * the API**", with R109's number — 300 requests per minute per account.
 *
 * The per-match half lives in `src/match/actor.ts` and is covered by `test/match/actor.test.ts`;
 * this is the API half, enforced in `createRouter` for every route at once rather than at the top
 * of each handler, so a new endpoint cannot forget it.
 *
 * The number under test is the real `API_REQUESTS_PER_MINUTE`, read through `floodLimits` rather
 * than restated here, so this suite is what makes that constant enforced rather than merely
 * declared.
 */

import { describe, expect, it } from "vitest";

import { floodLimits } from "../../src/api/deps";
import {
  accountKey,
  addressKey,
  createRateLimiter,
  createRouter,
  ok,
  route,
  type Router,
} from "../../src/api/http";
import { createTestDeps, jsonRequest, readJson, type TestDeps } from "../fakes/deps";

/** R109's allowance, as the server itself carries it. */
const LIMIT = floodLimits.apiRequestsPerMinute;
const MINUTE_MS = 60_000;

type ErrorBody = { error: { code: string; message: string } };

/** One open route and one that needs a caller, so both halves of the key are reachable. */
function harness(): { deps: TestDeps; router: Router } {
  const deps = createTestDeps();
  const router = createRouter(
    [
      route("GET", "/api/open", "none", async () => ok({ pong: true })),
      route("GET", "/api/mine", "user", async () => ok({ pong: true })),
    ],
    deps,
  );
  return { deps, router };
}

function signIn(deps: TestDeps, id: string): string {
  const userId = `user-${id}`;
  const token = deps.auth.addUser({ userId, email: `${id}@example.test` });
  deps.store.seedProfile({ id, userId, status: "active" });
  return token;
}

/** Sends `n` requests to one path and returns the status of each. */
async function burst(
  router: Router,
  n: number,
  path: string,
  init: { token?: string; ip?: string } = {},
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) {
    statuses.push((await router(jsonRequest("GET", path, undefined, init))).status);
  }
  return statuses;
}

describe("§9.8: the per-account API rate limit (R109)", () => {
  it("R109 lets an account through 300 requests in a minute and refuses the 301st with 429", async () => {
    const { deps, router } = harness();
    const token = signIn(deps, "regular");

    const inside = await burst(router, LIMIT, "/api/mine", { token });
    expect(new Set(inside)).toEqual(new Set([200]));

    const overflow = await router(jsonRequest("GET", "/api/mine", undefined, { token }));
    expect(overflow.status).toBe(429);
    const body = await readJson<ErrorBody>(overflow);
    expect(body.error.code).toBe("rate_limited");

    // §9.8: "Every rejected action is logged with its reason."
    const logged = deps.log.entries.filter((entry) => entry.event === "api.rate_limited");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.data?.["key"]).toBe(accountKey("regular"));
  });

  it("R137's reasoning at the API too: one account's flood never spends another's budget", async () => {
    const { deps, router } = harness();
    const flooder = signIn(deps, "flooder");
    const bystander = signIn(deps, "bystander");

    const statuses = await burst(router, LIMIT + 5, "/api/mine", { token: flooder });
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);

    // The victim of a shared counter would be refused here. The key is the account, so they are not.
    const theirs = await router(jsonRequest("GET", "/api/mine", undefined, { token: bystander }));
    expect(theirs.status).toBe(200);
  });

  it("R157 keys a request that names no account on its address, and keeps those apart too", async () => {
    const { router } = harness();

    const noisy = await burst(router, LIMIT + 1, "/api/open", { ip: "203.0.113.9" });
    expect(noisy.at(-1)).toBe(429);

    // A different address has its own budget: the open routes are not one shared bucket either.
    const quiet = await router(jsonRequest("GET", "/api/open", undefined, { ip: "198.51.100.4" }));
    expect(quiet.status).toBe(200);
  });

  it("counts a request whose token did not verify, so a flood of bad tokens is bounded", async () => {
    const { router } = harness();

    const statuses = await burst(router, LIMIT + 1, "/api/mine", {
      token: "not-a-token",
      ip: "203.0.113.11",
    });
    // Every one of them is refused for being unauthenticated, until the address runs out of budget.
    expect(statuses.filter((status) => status === 401)).toHaveLength(LIMIT);
    expect(statuses.at(-1)).toBe(429);
  });

  it("refuses the overflow before §9.4's gate, so a pending account cannot flood for free", async () => {
    const deps = createTestDeps();
    const userId = "user-pending";
    const token = deps.auth.addUser({ userId, email: "pending@example.test" });
    deps.store.seedProfile({ id: "pending", userId, status: "pending" });
    const router = createRouter([route("GET", "/api/gated", "active", async () => ok({}))], deps);

    const statuses = await burst(router, LIMIT + 1, "/api/gated", { token });
    // 403 while the gate is what refuses them (§9.4), then 429 once the budget is gone.
    expect(statuses.filter((status) => status === 403)).toHaveLength(LIMIT);
    expect(statuses.at(-1)).toBe(429);
  });

  it("rolls the window: a minute later the account is served again", async () => {
    const { deps, router } = harness();
    const token = signIn(deps, "patient");

    await burst(router, LIMIT, "/api/mine", { token });
    expect((await router(jsonRequest("GET", "/api/mine", undefined, { token }))).status).toBe(429);

    deps.timers.advance(MINUTE_MS);
    expect((await router(jsonRequest("GET", "/api/mine", undefined, { token }))).status).toBe(200);
  });

  it("is per router, not module state: a second router starts with an empty window", async () => {
    const { deps, router } = harness();
    const token = signIn(deps, "twice");
    await burst(router, LIMIT, "/api/mine", { token });
    expect((await router(jsonRequest("GET", "/api/mine", undefined, { token }))).status).toBe(429);

    const fresh = createRouter([route("GET", "/api/mine", "user", async () => ok({}))], deps);
    expect((await fresh(jsonRequest("GET", "/api/mine", undefined, { token }))).status).toBe(200);
  });
});

describe("the sliding window itself", () => {
  it("refuses the request over the limit without recording it, so the window drains", () => {
    const limiter = createRateLimiter(2, 1000);
    expect(limiter.allow("k", 0)).toBe(true);
    expect(limiter.allow("k", 100)).toBe(true);
    // Over the limit: refused, and not counted — otherwise retrying would keep it pinned open.
    expect(limiter.allow("k", 200)).toBe(false);
    expect(limiter.allow("k", 300)).toBe(false);

    // The two that *were* counted age out, and nothing the refusals did extends the window.
    expect(limiter.allow("k", 1100)).toBe(true);
  });

  it("drops a key that has gone quiet for a whole window, so the map does not grow for ever", () => {
    const limiter = createRateLimiter(5, 1000);
    for (let i = 0; i < 50; i += 1) limiter.allow(addressKey(`ip-${String(i)}`), 0);
    expect(limiter.size).toBe(50);

    limiter.allow(accountKey("still-here"), 2000);
    expect(limiter.size).toBe(1);
  });
});

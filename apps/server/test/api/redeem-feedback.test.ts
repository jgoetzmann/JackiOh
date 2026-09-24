/**
 * R192, docs/polish/5-sign-in.md B7, B8, B9 and B13: what the code screen is told, and what it is
 * never told.
 *
 *  - B7: `GET /api/codes/status` says how many tries this account has left in §9.4's window.
 *  - B8: a refusal at §9.4 step 2 or 3 is a 429 `rate_limited` whose wait is the whole attempt
 *    window (`details.retryAfterMs` and `Retry-After`), while every code-dependent refusal keeps
 *    R145's identical bytes and gains no header.
 *  - B9: R109's API-wide limiter says how long until its oldest counted request leaves the window.
 *  - B13: a request body larger than `API_MAX_BODY_BYTES` is refused before it is parsed.
 *
 * Redemption runs on the real clock with `testLimits()`' 20 ms floor, as `codes.test.ts` does. The
 * API limiter runs on `createManualTimers`, which it can: nothing in that path sleeps.
 */

import { describe, expect, it } from "vitest";

import { createCodesRoutes, mintInviteCode } from "../../src/api/codes";
import { floodLimits } from "../../src/api/deps";
import {
  createRateLimiter,
  createRouter,
  errorResponse,
  ok,
  rateLimited,
  route,
  type Router,
} from "../../src/api/http";
import { systemTimers, type ApiLimits, type Ids } from "../../src/api/ports";
import {
  API_MAX_BODY_BYTES,
  CODE_ALPHABET,
  REDEMPTION_IDENTICAL_ERROR,
} from "../../src/config";
import {
  createManualTimers,
  createTestDeps,
  jsonRequest,
  readJson,
  testLimits,
  type TestDeps,
} from "../fakes/deps";
import { createMemoryStore } from "../fakes/store";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const MS_PER_SECOND = 1000;

/** R109's allowance, as the server carries it. */
const LIMIT = floodLimits.apiRequestsPerMinute;

/** R145's refusal, exactly as it goes over the wire. */
const IDENTICAL_BODY = JSON.stringify({
  error: { code: "invalid_code", message: REDEMPTION_IDENTICAL_ERROR },
});

/** A well-formed code inside R104's alphabet that is never minted. */
const UNMINTED_CODE = "ABCD-EFGH-JKMN-PQRT";

const DEFAULT_IP = "203.0.113.7"; // `jsonRequest`'s default `x-forwarded-for`.

type ErrorBody = {
  error: { code: string; message: string; details?: { retryAfterMs?: unknown } & Record<string, unknown> };
};
type StatusBody = {
  redemptionEnabled: boolean;
  retryAfterMs: number;
  attemptsRemaining: number;
  attemptsRetryAfterMs: number;
};

/** Distinct 16-symbol codes, all inside the alphabet, as the real `systemIds.code` makes. */
function alphabetIds(): Ids {
  let n = 0;
  const next = (): number => {
    n += 1;
    return n;
  };
  return {
    uuid: () => `id-${String(next())}`,
    seed: () => `seed-${String(next())}`,
    code: (length) => {
      const head = CODE_ALPHABET[next() % CODE_ALPHABET.length] ?? "A";
      return `${head}${CODE_ALPHABET.slice(0, length - 1)}`.slice(0, length);
    },
  };
}

function codeDeps(limits: Partial<ApiLimits> = {}): TestDeps {
  return createTestDeps({ timers: systemTimers, ids: alphabetIds(), limits: testLimits(limits) });
}

function seedCaller(deps: TestDeps, id: string): { token: string; profileId: string } {
  const userId = `user-${id}`;
  const token = deps.auth.addUser({ userId, email: `${id}@example.test`, emailVerified: true });
  const profile = deps.store.seedProfile({ id, userId, status: "pending" });
  return { token, profileId: profile.id };
}

async function redeem(router: Router, token: string, code: string, ip = DEFAULT_IP): Promise<Response> {
  return router(jsonRequest("POST", "/api/codes/redeem", { code }, { token, ip }));
}

async function codeStatus(router: Router, token: string): Promise<StatusBody> {
  const response = await router(jsonRequest("GET", "/api/codes/status", undefined, { token }));
  expect(response.status).toBe(200);
  return readJson<StatusBody>(response);
}

async function logAttempts(
  deps: TestDeps,
  count: number,
  attempt: { profileId: string | null; ipHash: string; at: number },
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await deps.store.codes.logAttempt({ ...attempt, result: "rejected", reason: "missing" });
  }
}

function retryAfterHeaderFor(ms: number): string {
  return String(Math.ceil(ms / MS_PER_SECOND));
}

// ---------------------------------------------------------------------------------------------
// B7: tries left
// ---------------------------------------------------------------------------------------------

describe("R192 B7 GET /api/codes/status reports the tries left in the window", () => {
  it("R192 B7 gives a fresh pending account redeemPerProfilePerHour + 1 tries", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "fresh");

    const status = await codeStatus(router, token);

    expect(status.redemptionEnabled).toBe(true);
    expect(typeof status.retryAfterMs).toBe("number");
    expect(status.attemptsRemaining).toBe(deps.limits.redeemPerProfilePerHour + 1);
  });

  it("R192 B7 takes one try off for each attempt this profile made in the window", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "counted");
    const made = 2;
    await logAttempts(deps, made, { profileId, ipHash: deps.hashes.ip(DEFAULT_IP), at: systemTimers.now() });

    const status = await codeStatus(router, token);

    expect(status.attemptsRemaining).toBe(deps.limits.redeemPerProfilePerHour + 1 - made);
  });

  it("R192 B7 never reports fewer than zero tries", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "overdrawn");
    await logAttempts(deps, deps.limits.redeemPerProfilePerHour + 3, {
      profileId,
      ipHash: deps.hashes.ip(DEFAULT_IP),
      at: systemTimers.now(),
    });

    const status = await codeStatus(router, token);

    expect(status.attemptsRemaining).toBe(0);
  });

  it("R192 B7 ignores another profile's attempts from the same address", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "bystander");
    const neighbour = seedCaller(deps, "neighbour");
    await logAttempts(deps, deps.limits.redeemPerProfilePerHour, {
      profileId: neighbour.profileId,
      ipHash: deps.hashes.ip(DEFAULT_IP),
      at: systemTimers.now(),
    });

    const status = await codeStatus(router, token);

    expect(status.attemptsRemaining).toBe(deps.limits.redeemPerProfilePerHour + 1);
    // And the neighbour's own count is theirs.
    expect((await codeStatus(router, neighbour.token)).attemptsRemaining).toBe(1);
  });

  it("R192 B7 does not count attempts older than the window", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "yesterday");
    await logAttempts(deps, deps.limits.redeemPerProfilePerHour + 1, {
      profileId,
      ipHash: deps.hashes.ip(DEFAULT_IP),
      at: systemTimers.now() - deps.limits.redeemWindowMs - 1,
    });

    const status = await codeStatus(router, token);

    expect(status.attemptsRemaining).toBe(deps.limits.redeemPerProfilePerHour + 1);
  });

  it("R192 B7 drops by exactly one after a refused redemption", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "one-miss");

    const before = (await codeStatus(router, token)).attemptsRemaining;
    const refused = await redeem(router, token, UNMINTED_CODE);
    expect(refused.status).toBe(400);
    const after = (await codeStatus(router, token)).attemptsRemaining;

    expect(after).toBe(before - 1);
  });

  it("R192 B7 says when an account with no tries left gets one back: its oldest attempt leaving the window", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "waiting");
    const ipHash = deps.hashes.ip(DEFAULT_IP);
    const now = systemTimers.now();
    const age = Math.floor(deps.limits.redeemWindowMs / 4);
    await logAttempts(deps, 1, { profileId, ipHash, at: now - age });
    await logAttempts(deps, deps.limits.redeemPerProfilePerHour, { profileId, ipHash, at: now });

    const status = await codeStatus(router, token);

    expect(status.attemptsRemaining).toBe(0);
    const expected = deps.limits.redeemWindowMs - age;
    expect(status.attemptsRetryAfterMs).toBeLessThanOrEqual(expected);
    // The request itself takes a moment on the real clock.
    expect(status.attemptsRetryAfterMs).toBeGreaterThan(expected - 5_000);
  });

  it("R192 B7 states no wait while the account has tries left", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "not-waiting");
    await logAttempts(deps, deps.limits.redeemPerProfilePerHour, {
      profileId,
      ipHash: deps.hashes.ip(DEFAULT_IP),
      at: systemTimers.now(),
    });

    const status = await codeStatus(router, token);

    expect(status.attemptsRemaining).toBe(1);
    expect(status.attemptsRetryAfterMs).toBe(0);
  });

  it("R192 B7 agrees with §9.4 step 2: one try left is let through, none left is refused", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const last = seedCaller(deps, "last-try");
    const none = seedCaller(deps, "no-tries");
    const at = systemTimers.now();
    const ipHash = deps.hashes.ip(DEFAULT_IP);
    await logAttempts(deps, deps.limits.redeemPerProfilePerHour, { profileId: last.profileId, ipHash, at });
    await logAttempts(deps, deps.limits.redeemPerProfilePerHour + 1, { profileId: none.profileId, ipHash, at });

    expect((await codeStatus(router, last.token)).attemptsRemaining).toBe(1);
    expect((await codeStatus(router, none.token)).attemptsRemaining).toBe(0);

    // One left: the attempt reaches the lookup (step 5) and fails there.
    const lastTry = await redeem(router, last.token, UNMINTED_CODE, "198.51.100.71");
    expect(lastTry.status).toBe(400);
    expect((await readJson<ErrorBody>(lastTry)).error.code).toBe("invalid_code");
    // None left: step 2 refuses it as a rate limit.
    const noTry = await redeem(router, none.token, UNMINTED_CODE, "198.51.100.72");
    expect(noTry.status).toBe(429);
    expect((await readJson<ErrorBody>(noTry)).error.code).toBe("rate_limited");
  });
});

// ---------------------------------------------------------------------------------------------
// B8: a rate limit is reported as a rate limit; R145's identical error stays identical
// ---------------------------------------------------------------------------------------------

describe("R192 B8 refusals at §9.4 steps 2 and 3", () => {
  it("R192 B8 step 2 answers 429 rate_limited with the whole attempt window as its wait", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "step-two");
    await logAttempts(deps, deps.limits.redeemPerProfilePerHour + 1, {
      profileId,
      ipHash: deps.hashes.ip(DEFAULT_IP),
      at: systemTimers.now(),
    });

    const response = await redeem(router, token, UNMINTED_CODE);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(retryAfterHeaderFor(deps.limits.redeemWindowMs));
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details).toEqual({ retryAfterMs: deps.limits.redeemWindowMs });
    // R145 is not borrowed: a rate limit is about the caller, never about the code.
    expect(body.error.message).not.toBe(REDEMPTION_IDENTICAL_ERROR);
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("R192 B8 step 3 answers the same way for a flooded address", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "step-three");
    const ipHash = deps.hashes.ip(DEFAULT_IP);
    const at = systemTimers.now();
    for (let i = 0; i < deps.limits.redeemPerIpPerHour + 1; i += 1) {
      await deps.store.codes.logAttempt({
        profileId: `neighbour-${String(i)}`,
        ipHash,
        result: "rejected",
        reason: "missing",
        at,
      });
    }

    const response = await redeem(router, token, UNMINTED_CODE);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(retryAfterHeaderFor(deps.limits.redeemWindowMs));
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details).toEqual({ retryAfterMs: deps.limits.redeemWindowMs });
    expect(body.error.message).not.toBe(REDEMPTION_IDENTICAL_ERROR);
  });

  it("R192 B8 a refusal at step 2 costs no try: nothing is logged and the count stays at zero", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "pinned-at-zero");
    const seeded = deps.limits.redeemPerProfilePerHour + 1;
    await logAttempts(deps, seeded, { profileId, ipHash: deps.hashes.ip(DEFAULT_IP), at: systemTimers.now() });

    const first = await redeem(router, token, UNMINTED_CODE);
    const second = await redeem(router, token, UNMINTED_CODE);

    expect([first.status, second.status]).toEqual([429, 429]);
    expect(deps.store.tables.attempts).toHaveLength(seeded);
    expect((await codeStatus(router, token)).attemptsRemaining).toBe(0);
  });

  it("R192 B8 step 3 can refuse a profile that still has tries left, and says so as a rate limit", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "shared-network");
    const ipHash = deps.hashes.ip(DEFAULT_IP);
    const at = systemTimers.now();
    for (let i = 0; i < deps.limits.redeemPerIpPerHour + 1; i += 1) {
      await deps.store.codes.logAttempt({
        profileId: `stranger-${String(i)}`,
        ipHash,
        result: "rejected",
        reason: "missing",
        at,
      });
    }

    // Advisory only: the profile's own window is untouched.
    expect((await codeStatus(router, token)).attemptsRemaining).toBe(deps.limits.redeemPerProfilePerHour + 1);
    const response = await redeem(router, token, UNMINTED_CODE);

    expect(response.status).toBe(429);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details).toEqual({ retryAfterMs: deps.limits.redeemWindowMs });
  });

  it("R192 B8 keeps every code-dependent refusal at R145's exact bytes, with no Retry-After", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const consumer = seedCaller(deps, "consumer");
    const expired = await mintInviteCode(deps, { expiresAt: systemTimers.now() - MS_PER_SECOND });
    const exhausted = await mintInviteCode(deps, { maxUses: 1 });
    const revoked = await mintInviteCode(deps);
    const revokedRow = deps.store.tables.codes.find((row) => row.id === revoked.id);
    if (revokedRow === undefined) throw new Error("the revoked code was not stored");
    revokedRow.revoked = true;
    expect((await redeem(router, consumer.token, exhausted.formatted, "198.51.100.80")).status).toBe(200);

    const kinds = [
      { name: "missing", code: UNMINTED_CODE },
      { name: "malformed", code: "ABCD-EFGH-JKMN-PQR0" },
      { name: "expired", code: expired.formatted },
      { name: "exhausted", code: exhausted.formatted },
      { name: "revoked", code: revoked.formatted },
    ];

    for (const [index, kind] of kinds.entries()) {
      const caller = seedCaller(deps, `asks-${kind.name}`);
      const response = await redeem(router, caller.token, kind.code, `198.51.100.${String(81 + index)}`);

      expect(response.status, kind.name).toBe(400);
      expect(await response.text(), kind.name).toBe(IDENTICAL_BODY);
      expect(response.headers.get("retry-after"), kind.name).toBeNull();
    }
  });

  it("R192 B8 gives the breaker's 503 no Retry-After: only rate_limited carries one", async () => {
    const deps = codeDeps({ breakerFailureThreshold: 1 });
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "trips-breaker");

    expect((await redeem(router, token, UNMINTED_CODE)).status).toBe(400);
    const blocked = await redeem(router, token, UNMINTED_CODE);

    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBeNull();
  });

  it("R192 a pause the database answers is reported by the status too, and the next press costs no try", async () => {
    const limits = testLimits();
    const store = createMemoryStore({
      now: () => systemTimers.now(),
      redemption: {
        attemptsPerProfilePerHour: limits.redeemPerProfilePerHour,
        attemptsPerIpPerHour: limits.redeemPerIpPerHour,
        attemptWindowMs: limits.redeemWindowMs,
        // The operator paused redemption in the database (app.settings.redemption_enabled = false).
        enabled: () => false,
      },
    });
    const deps = createTestDeps({ timers: systemTimers, ids: alphabetIds(), limits, store });
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "paused");
    const minted = await mintInviteCode(deps);

    // Before any redemption this process cannot know about the database's switch.
    expect((await codeStatus(router, token)).redemptionEnabled).toBe(true);
    expect((await redeem(router, token, minted.formatted)).status).toBe(503);

    // Now it does: the status says paused, with the breaker's cooldown as the wait…
    const paused = await codeStatus(router, token);
    expect(paused.redemptionEnabled).toBe(false);
    expect(paused.retryAfterMs).toBeGreaterThan(0);
    expect(paused.retryAfterMs).toBeLessThanOrEqual(limits.breakerCooldownMs);

    // …and a second press is refused before the store logs another attempt.
    expect((await redeem(router, token, minted.formatted)).status).toBe(503);
    expect((await codeStatus(router, token)).attemptsRemaining).toBe(paused.attemptsRemaining);
  });
});

describe("R192 B8 rateLimited and errorResponse", () => {
  it("R192 B8 turns the wait into a 429 with details.retryAfterMs and whole-second Retry-After", async () => {
    const response = errorResponse(rateLimited("slow down", 1_500));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await readJson<ErrorBody>(response)).toEqual({
      error: { code: "rate_limited", message: "slow down", details: { retryAfterMs: 1_500 } },
    });
  });

  it("R192 B8 rounds the header up to whole seconds", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0, "0"],
      [1, "1"],
      [999, "1"],
      [MS_PER_SECOND, "1"],
      [MS_PER_SECOND + 1, "2"],
      [testLimits().redeemWindowMs, retryAfterHeaderFor(testLimits().redeemWindowMs)],
    ];
    for (const [ms, header] of cases) {
      expect(errorResponse(rateLimited("wait", ms)).headers.get("retry-after"), String(ms)).toBe(header);
    }
  });

  it("R192 B8 adds no Retry-After for a negative or non-finite wait", () => {
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const response = errorResponse(rateLimited("wait", ms));
      expect(response.status, String(ms)).toBe(429);
      expect(response.headers.get("retry-after"), String(ms)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// B9: the API-wide limiter says how long to wait
// ---------------------------------------------------------------------------------------------

describe("R192 B9 the limiter's wait", () => {
  it("R192 B9 is 0 while a key has room, and for a key it has never seen", () => {
    const limiter = createRateLimiter(2, 1_000);
    expect(limiter.retryAfterMs("never-seen", 0)).toBe(0);
    expect(limiter.allow("k", 0)).toBe(true);
    expect(limiter.retryAfterMs("k", 50)).toBe(0);
  });

  it("R192 B9 is the time until the oldest counted hit leaves the window", () => {
    const limiter = createRateLimiter(2, 1_000);
    expect(limiter.allow("k", 0)).toBe(true);
    expect(limiter.allow("k", 100)).toBe(true);

    expect(limiter.retryAfterMs("k", 200)).toBe(800);
    expect(limiter.retryAfterMs("k", 999)).toBe(1);
  });

  it("R192 B9 is not moved by refused hits, which are never counted", () => {
    const limiter = createRateLimiter(2, 1_000);
    limiter.allow("k", 0);
    limiter.allow("k", 100);
    expect(limiter.allow("k", 200)).toBe(false);
    expect(limiter.allow("k", 300)).toBe(false);

    expect(limiter.retryAfterMs("k", 400)).toBe(600);
  });

  it("R192 B9 moves on to the next-oldest hit once the oldest has left", () => {
    const limiter = createRateLimiter(2, 1_000);
    limiter.allow("k", 0);
    limiter.allow("k", 100);
    expect(limiter.allow("k", 1_000)).toBe(true);

    expect(limiter.retryAfterMs("k", 1_050)).toBe(50);
  });
});

describe("R192 B9 the API limiter's 429 (R109)", () => {
  function signIn(deps: TestDeps, id: string): string {
    const userId = `user-${id}`;
    const token = deps.auth.addUser({ userId, email: `${id}@example.test` });
    deps.store.seedProfile({ id, userId, status: "active" });
    return token;
  }

  it("R192 B9 carries details.retryAfterMs, exact to the millisecond, and a matching Retry-After", async () => {
    const timers = createManualTimers();
    const deps = createTestDeps({ timers });
    const router = createRouter([route("GET", "/api/mine", "user", async () => ok({ pong: true }))], deps);
    const token = signIn(deps, "b9-account");
    const mine = async (): Promise<Response> => router(jsonRequest("GET", "/api/mine", undefined, { token }));
    const GAP_MS = 1_000;

    // The oldest counted request, then the rest of the allowance one gap later.
    expect((await mine()).status).toBe(200);
    timers.advance(GAP_MS);
    for (let i = 1; i < LIMIT; i += 1) expect((await mine()).status).toBe(200);
    timers.advance(GAP_MS);

    const refused = await mine();
    expect(refused.status).toBe(429);
    const body = await readJson<ErrorBody>(refused);
    expect(body.error.code).toBe("rate_limited");
    const wait = body.error.details?.retryAfterMs;
    if (typeof wait !== "number") throw new Error("the 429 carries no details.retryAfterMs");
    expect(wait).toBeGreaterThan(0);
    expect(refused.headers.get("retry-after")).toBe(retryAfterHeaderFor(wait));

    // One millisecond early is still refused, and says so.
    timers.advance(wait - 1);
    const early = await mine();
    expect(early.status).toBe(429);
    expect((await readJson<ErrorBody>(early)).error.details?.retryAfterMs).toBe(1);

    // On the dot, the oldest request has left the window and one slot is free.
    timers.advance(1);
    expect((await mine()).status).toBe(200);

    // The next wait is for the next-oldest request, which came one gap after the first.
    const next = await mine();
    expect(next.status).toBe(429);
    expect((await readJson<ErrorBody>(next)).error.details?.retryAfterMs).toBe(GAP_MS);
    expect(next.headers.get("retry-after")).toBe(retryAfterHeaderFor(GAP_MS));
  });

  it("R192 B9 carries the wait on an anonymous flood's 429 too (R157)", async () => {
    const deps = createTestDeps({ timers: createManualTimers() });
    const router = createRouter([route("GET", "/api/open", "none", async () => ok({ pong: true }))], deps);
    const open = async (): Promise<Response> =>
      router(jsonRequest("GET", "/api/open", undefined, { ip: "203.0.113.90" }));

    for (let i = 0; i < LIMIT; i += 1) expect((await open()).status).toBe(200);
    const refused = await open();

    expect(refused.status).toBe(429);
    const body = await readJson<ErrorBody>(refused);
    expect(body.error.code).toBe("rate_limited");
    const wait = body.error.details?.retryAfterMs;
    if (typeof wait !== "number") throw new Error("the 429 carries no details.retryAfterMs");
    expect(wait).toBeGreaterThan(0);
    expect(refused.headers.get("retry-after")).toBe(retryAfterHeaderFor(wait));
  });
});

// ---------------------------------------------------------------------------------------------
// B13: the body cap
// ---------------------------------------------------------------------------------------------

describe("B13 a request body larger than API_MAX_BODY_BYTES", () => {
  const TOO_LARGE_MESSAGE = "the request body is too large";

  function rawRedeem(token: string, body: string, ip: string): Request {
    return new Request("https://server.test/api/codes/redeem", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-forwarded-for": ip,
      },
      body,
    });
  }

  /** `{"code":"AAA…"}`, exactly `bytes` long. */
  function codeBodyOfBytes(bytes: number): string {
    const shell = JSON.stringify({ code: "" });
    const body = JSON.stringify({ code: "A".repeat(bytes - shell.length) });
    expect(new TextEncoder().encode(body).length).toBe(bytes);
    return body;
  }

  it("B13 is refused with 400 bad_request, and never reaches the redemption", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "big-body");

    const response = await router(rawRedeem(token, codeBodyOfBytes(API_MAX_BODY_BYTES + 1), "198.51.100.91"));

    expect(response.status).toBe(400);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBe(TOO_LARGE_MESSAGE);
    // Not an attempt: the handler never saw a code.
    expect(deps.store.tables.attempts).toHaveLength(0);
    expect(deps.store.tables.profiles.find((row) => row.id === profileId)?.status).toBe("pending");
  });

  it("B13 is refused for its size before JSON parsing, even when it is not JSON", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "big-garbage");

    const garbage = `{${"x".repeat(API_MAX_BODY_BYTES)}`;
    const response = await router(rawRedeem(token, garbage, "198.51.100.92"));

    expect(response.status).toBe(400);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toBe(TOO_LARGE_MESSAGE);
  });

  it("B13 counts bytes, not characters", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "wide-body");

    // Two UTF-8 bytes per "é": under the cap in characters, over it in bytes.
    const body = JSON.stringify({ code: "é".repeat(Math.ceil(API_MAX_BODY_BYTES / 2)) });
    expect(body.length).toBeLessThan(API_MAX_BODY_BYTES);
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(API_MAX_BODY_BYTES);
    const response = await router(rawRedeem(token, body, "198.51.100.93"));

    expect(response.status).toBe(400);
    const parsed = await readJson<ErrorBody>(response);
    expect(parsed.error.code).toBe("bad_request");
    expect(parsed.error.message).toBe(TOO_LARGE_MESSAGE);
  });

  it("B13 reads a body of exactly API_MAX_BODY_BYTES", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "full-body");

    const response = await router(rawRedeem(token, codeBodyOfBytes(API_MAX_BODY_BYTES), "198.51.100.94"));

    // Read and handled: the code is far past the input cap, so it is R145's identical error, not a
    // refusal of the body.
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(IDENTICAL_BODY);
    expect(deps.store.tables.attempts).toHaveLength(1);
  });
});

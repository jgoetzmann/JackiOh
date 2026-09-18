/**
 * BUILD M6-T1: "integration tests for each rejection step" of SPEC §9.4's six-step redemption
 * transaction, plus the identical-error requirement and the global circuit breaker. Each test
 * names the step it covers.
 *
 * Every test drives real HTTP through `createRouter`, so the route's auth declaration, the
 * §9.4 gate, the constant-time padding and the handler all take part.
 */

import { describe, expect, it } from "vitest";
import { createCodesRoutes, mintInviteCode } from "../../src/api/codes";
import { createRouter, ok, route, type Router } from "../../src/api/http";
import { systemTimers, type ApiLimits, type Ids, type ProfileStatus } from "../../src/api/ports";
import { CODE_ALPHABET, INVITE_CODE_LENGTH, REDEMPTION_IDENTICAL_ERROR } from "../../src/config";
import { formatCode } from "../../src/api/crypto";
import { createTestDeps, jsonRequest, readJson, testLimits, type TestDeps } from "../fakes/deps";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `createFakeIds()` emits codes like `CODE1XXXX…`, whose `1` is one of the four characters §9.4
 * excludes — redemption would (correctly) reject a code minted from it as malformed. This one
 * emits distinct 16-symbol codes that are all inside `CODE_ALPHABET`, which is what the real
 * `systemIds.code` does.
 */
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

/** A well-formed code (16 symbols, all inside the alphabet) that was never minted. */
const UNMINTED_CODE = formatCode("ABCDEFGHJKLMNPQR");

const DEFAULT_IP = "203.0.113.7"; // `jsonRequest`'s default `x-forwarded-for`.

/**
 * §9.4's response padding is scheduled through the `Timers` port, and the manual clock only fires
 * on `advance()` — which a request already in flight cannot do for itself. So this suite runs on
 * the real clock with `testLimits()`'s deliberately small 20 ms floor.
 */
function codeDeps(limits: Partial<ApiLimits> = {}): TestDeps {
  return createTestDeps({ timers: systemTimers, ids: alphabetIds(), limits: testLimits(limits) });
}

function seedCaller(
  deps: TestDeps,
  id: string,
  options: { status?: ProfileStatus; emailVerified?: boolean } = {},
): { token: string; profileId: string } {
  const userId = `user-${id}`;
  const token = deps.auth.addUser({
    userId,
    email: `${id}@example.test`,
    emailVerified: options.emailVerified ?? true,
  });
  // `resolveCaller` finds a profile by auth user id, so the seeded row must carry the same one.
  const profile = deps.store.seedProfile({ id, userId, status: options.status ?? "pending" });
  return { token, profileId: profile.id };
}

async function redeem(
  router: Router,
  token: string,
  code: string,
  ip = DEFAULT_IP,
): Promise<Response> {
  return router(jsonRequest("POST", "/api/codes/redeem", { code }, { token, ip }));
}

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

// ---------------------------------------------------------------------------
// Step 1 — "reject unless the account is pending with a verified email"
// ---------------------------------------------------------------------------

describe("§9.4 step 1: pending account with a verified email", () => {
  it("rejects a profile that is not pending, and never logs the attempt", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "already-active", { status: "active" });
    const minted = await mintInviteCode(deps);

    const response = await redeem(router, token, minted.formatted);

    expect(response.status).toBe(409);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("conflict");
    // Distinct from a code failure: nothing about the code was even looked at.
    expect(body.error.message).not.toBe(REDEMPTION_IDENTICAL_ERROR);
    expect(deps.store.tables.attempts).toHaveLength(0);
    expect(deps.store.tables.codes[0]?.uses).toBe(0);
  });

  it("rejects a banned profile with 403", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "banned", { status: "banned" });
    const minted = await mintInviteCode(deps);

    const response = await redeem(router, token, minted.formatted);

    expect(response.status).toBe(403);
    expect((await readJson<ErrorBody>(response)).error.code).toBe("account_banned");
    expect(deps.store.tables.attempts).toHaveLength(0);
  });

  it("rejects a pending profile whose email is not verified", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "unverified", { emailVerified: false });
    const minted = await mintInviteCode(deps);

    const response = await redeem(router, token, minted.formatted);

    expect(response.status).toBe(403);
    expect((await readJson<ErrorBody>(response)).error.code).toBe("email_unverified");
    // A good code is not consumed by an account that may not use it yet.
    expect(deps.store.tables.codes[0]?.uses).toBe(0);
    expect(deps.store.tables.attempts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Steps 2 and 3 — the per-profile and per-IP windows
// ---------------------------------------------------------------------------

describe("§9.4 steps 2 and 3: attempt limits", () => {
  it("step 2 rejects once this profile is over the per-profile limit", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "flooder");
    const ipHash = deps.hashes.ip(DEFAULT_IP);
    const at = systemTimers.now();

    // config.ts: the limit is strictly `>`, so the (limit + 1)-th attempt is the first rejection.
    for (let i = 0; i < deps.limits.redeemPerProfilePerHour + 1; i += 1) {
      await deps.store.codes.logAttempt({ profileId, ipHash, result: "rejected", reason: "missing", at });
    }

    const response = await redeem(router, token, UNMINTED_CODE);

    expect(response.status).toBe(429);
    expect((await readJson<ErrorBody>(response)).error.code).toBe("rate_limited");
  });

  it("step 2 lets the attempt through while the profile is exactly at the limit", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "borderline");
    const ipHash = deps.hashes.ip(DEFAULT_IP);
    const at = systemTimers.now();

    for (let i = 0; i < deps.limits.redeemPerProfilePerHour; i += 1) {
      await deps.store.codes.logAttempt({ profileId, ipHash, result: "rejected", reason: "missing", at });
    }

    const response = await redeem(router, token, UNMINTED_CODE);

    // Reached step 5 and failed there, not at step 2.
    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.code).toBe("invalid_code");
  });

  it("step 3 rejects once this IP hash is over the per-IP limit", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "shared-ip");
    const ipHash = deps.hashes.ip(DEFAULT_IP);
    const at = systemTimers.now();

    // Other accounts behind the same NAT, so step 2's per-profile count stays at zero.
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
    expect((await readJson<ErrorBody>(response)).error.code).toBe("rate_limited");
  });

  it("does not count attempts older than the window", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "yesterday");
    const ipHash = deps.hashes.ip(DEFAULT_IP);
    const at = systemTimers.now() - deps.limits.redeemWindowMs - 1;

    for (let i = 0; i < deps.limits.redeemPerProfilePerHour + 5; i += 1) {
      await deps.store.codes.logAttempt({ profileId, ipHash, result: "rejected", reason: "missing", at });
    }

    const response = await redeem(router, token, UNMINTED_CODE);

    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — "log the attempt either way"
// ---------------------------------------------------------------------------

describe("§9.4 step 4: the attempt log", () => {
  it("holds a row for a failed lookup", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "typo");

    await redeem(router, token, UNMINTED_CODE);

    expect(deps.store.tables.attempts).toHaveLength(1);
    const attempt = deps.store.tables.attempts[0];
    expect(attempt?.profileId).toBe(profileId);
    expect(attempt?.result).toBe("rejected");
    expect(attempt?.ipHash).toBe(deps.hashes.ip(DEFAULT_IP));
    // §9.4: the reason is for operators and never reaches the client.
    expect(attempt?.reason).toBe("missing");
  });

  it("holds no row for a rate-limited attempt, so the window drains", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "pinned");
    const ipHash = deps.hashes.ip(DEFAULT_IP);
    const at = systemTimers.now();

    const seeded = deps.limits.redeemPerProfilePerHour + 1;
    for (let i = 0; i < seeded; i += 1) {
      await deps.store.codes.logAttempt({ profileId, ipHash, result: "rejected", reason: "missing", at });
    }

    await redeem(router, token, UNMINTED_CODE);
    await redeem(router, token, UNMINTED_CODE);

    // Steps 2 and 3 reject before step 4: retrying while over the limit adds nothing.
    expect(deps.store.tables.attempts).toHaveLength(seeded);
  });

  it("holds an `ok` row for a redemption that succeeded", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "winner");
    const minted = await mintInviteCode(deps);

    await redeem(router, token, minted.formatted);

    expect(deps.store.tables.attempts).toHaveLength(1);
    expect(deps.store.tables.attempts[0]?.result).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Step 5 — "look up by hash and reject if revoked, expired or exhausted"
// ---------------------------------------------------------------------------

describe("§9.4 step 5: the lookup", () => {
  it("rejects a missing code", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "missing");

    const response = await redeem(router, token, UNMINTED_CODE);

    expect(response.status).toBe(400);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("invalid_code");
    expect(body.error.message).toBe(REDEMPTION_IDENTICAL_ERROR);
    expect(body.error.details).toBeUndefined();
  });

  it("rejects a malformed code down the identical path", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "malformed");

    // `0`, `O`, `1`, `I` and `l` are exactly what §9.4's alphabet leaves out.
    const response = await redeem(router, token, "0OI1-llll-0OI1-llll");

    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.message).toBe(REDEMPTION_IDENTICAL_ERROR);
    // Still logged (it got past steps 2 and 3), under an operator-only reason.
    expect(deps.store.tables.attempts[0]?.reason).toBe("malformed");
  });

  it("rejects a revoked code", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "revoked");
    const minted = await mintInviteCode(deps);
    const stored = deps.store.tables.codes.find((row) => row.id === minted.id);
    if (stored === undefined) throw new Error("the minted code was not stored");
    stored.revoked = true;

    const response = await redeem(router, token, minted.formatted);

    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.message).toBe(REDEMPTION_IDENTICAL_ERROR);
    expect(deps.store.tables.profiles[0]?.status).toBe("pending");
  });

  it("rejects an expired code", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "expired");
    const minted = await mintInviteCode(deps, { expiresAt: systemTimers.now() - 1_000 });

    const response = await redeem(router, token, minted.formatted);

    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.message).toBe(REDEMPTION_IDENTICAL_ERROR);
    expect(deps.store.tables.codes[0]?.uses).toBe(0);
  });

  it("rejects an exhausted code", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const first = seedCaller(deps, "first");
    const second = seedCaller(deps, "second");
    const minted = await mintInviteCode(deps, { maxUses: 1 });

    expect((await redeem(router, first.token, minted.formatted)).status).toBe(200);
    const response = await redeem(router, second.token, minted.formatted);

    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.message).toBe(REDEMPTION_IDENTICAL_ERROR);
    // The second attempt neither consumed a use nor activated the account.
    expect(deps.store.tables.codes[0]?.uses).toBe(1);
    expect(deps.store.tables.profiles.find((row) => row.id === "second")?.status).toBe("pending");
  });

  it("refuses a second redemption of the same single-use code by the same caller", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "twice");
    const minted = await mintInviteCode(deps, { maxUses: 1 });

    expect((await redeem(router, token, minted.formatted)).status).toBe(200);
    const response = await redeem(router, token, minted.formatted);

    // Step 1 now catches it: the account is already active, which is not a code failure.
    expect(response.status).toBe(409);
    expect(deps.store.tables.codes[0]?.uses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Step 6 — "increment uses and set the account active, atomically"
// ---------------------------------------------------------------------------

describe("§9.4 step 6: claiming the code", () => {
  it("flips pending to active and increments uses", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "activated");
    const minted = await mintInviteCode(deps, { maxUses: 2 });

    const response = await redeem(router, token, minted.formatted);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ status: "active", needsInviteCode: false });
    expect(deps.store.tables.profiles.find((row) => row.id === profileId)?.status).toBe("active");
    expect(deps.store.tables.codes[0]?.uses).toBe(1);
  });

  it("accepts the formatted code, lower case and unseparated alike", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "sloppy-typist");
    const minted = await mintInviteCode(deps);

    // §9.4 formats codes `XXXX-XXXX-XXXX-XXXX`; `normalizeCode` accepts what a human types.
    const response = await redeem(router, token, ` ${minted.formatted.toLowerCase()} `);

    expect(response.status).toBe(200);
  });

  it("stores only the hash: the plaintext is returned once and never persisted", async () => {
    const deps = codeDeps();
    const minted = await mintInviteCode(deps);

    const stored = JSON.stringify(deps.store.tables.codes);
    expect(stored).not.toContain(minted.formatted);
    expect(stored).not.toContain(minted.formatted.replaceAll("-", ""));
    expect(deps.store.tables.codes[0]?.codeHash).toBe(deps.hashes.code(minted.formatted));
    expect(minted.formatted).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/u);
    expect(minted.formatted.replaceAll("-", "")).toHaveLength(INVITE_CODE_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// "Missing, expired and exhausted codes return an identical error"
// ---------------------------------------------------------------------------

describe("§9.4: identical error for missing, expired and exhausted", () => {
  it("returns byte-identical bodies and identical status codes", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const winner = seedCaller(deps, "consumer");
    const missing = seedCaller(deps, "asks-missing");
    const expired = seedCaller(deps, "asks-expired");
    const exhausted = seedCaller(deps, "asks-exhausted");

    const expiredCode = await mintInviteCode(deps, { expiresAt: systemTimers.now() - 1_000 });
    const usedCode = await mintInviteCode(deps, { maxUses: 1 });
    expect((await redeem(router, winner.token, usedCode.formatted)).status).toBe(200);

    const responses = [
      await redeem(router, missing.token, UNMINTED_CODE),
      await redeem(router, expired.token, expiredCode.formatted),
      await redeem(router, exhausted.token, usedCode.formatted),
    ];
    const statuses = responses.map((response) => response.status);
    const bodies = await Promise.all(responses.map(async (response) => response.text()));

    expect(new Set(statuses).size).toBe(1);
    expect(statuses[0]).toBe(400);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(
      JSON.stringify({ error: { code: "invalid_code", message: REDEMPTION_IDENTICAL_ERROR } }),
    );
  });
});

// ---------------------------------------------------------------------------
// "A global circuit breaker disables redemption and alerts"
// ---------------------------------------------------------------------------

describe("§9.4: the global circuit breaker", () => {
  it("opens at the threshold, answers 503 and alerts exactly once", async () => {
    const threshold = 3;
    const deps = codeDeps({ breakerFailureThreshold: threshold });
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "brute-forcer");

    for (let i = 0; i < threshold; i += 1) {
      const response = await redeem(router, token, UNMINTED_CODE);
      expect(response.status).toBe(400);
    }

    const blocked = await redeem(router, token, UNMINTED_CODE);
    expect(blocked.status).toBe(503);
    expect((await readJson<ErrorBody>(blocked)).error.code).toBe("unavailable");

    // Blocked before step 1, so nothing more was logged.
    expect(deps.store.tables.attempts).toHaveLength(threshold);

    const again = await redeem(router, token, UNMINTED_CODE);
    expect(again.status).toBe(503);

    const alerts = deps.log.entries.filter((entry) => entry.event === "codes.breaker_open");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe("alert");
  });

  it("closes over a good code while it is still shut", async () => {
    const deps = codeDeps({ breakerFailureThreshold: 2 });
    const router = createRouter(createCodesRoutes(), deps);
    const flood = seedCaller(deps, "flood");
    const holder = seedCaller(deps, "holder");
    const minted = await mintInviteCode(deps);

    await redeem(router, flood.token, UNMINTED_CODE);
    await redeem(router, flood.token, UNMINTED_CODE);

    // A legitimate code is refused too: §9.4's breaker "disables redemption", not just failures.
    const response = await redeem(router, holder.token, minted.formatted);
    expect(response.status).toBe(503);
    expect(deps.store.tables.profiles.find((row) => row.id === "holder")?.status).toBe("pending");
  });

  it("reports itself through GET /api/codes/status", async () => {
    const deps = codeDeps({ breakerFailureThreshold: 1 });
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "watcher");

    const before = await readJson<{ redemptionEnabled: boolean }>(
      await router(jsonRequest("GET", "/api/codes/status", undefined, { token })),
    );
    expect(before.redemptionEnabled).toBe(true);

    await redeem(router, token, UNMINTED_CODE);

    const after = await readJson<{ redemptionEnabled: boolean; retryAfterMs: number }>(
      await router(jsonRequest("GET", "/api/codes/status", undefined, { token })),
    );
    expect(after.redemptionEnabled).toBe(false);
    expect(after.retryAfterMs).toBeGreaterThan(0);
  });

  it("is per-router, not module state: fresh routes start closed", async () => {
    const deps = codeDeps({ breakerFailureThreshold: 1 });
    const { token } = seedCaller(deps, "second-router");

    const first = createRouter(createCodesRoutes(), deps);
    await redeem(first, token, UNMINTED_CODE);
    expect((await redeem(first, token, UNMINTED_CODE)).status).toBe(503);

    const second = createRouter(createCodesRoutes(), deps);
    // Same store, so the failures are still on record; the new closure's breaker re-opens on the
    // next failure rather than inheriting an open one.
    const response = await redeem(second, token, UNMINTED_CODE);
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// BUILD M6-T1: "a pending account cannot call collection, loadout or queue endpoints (403)"
// ---------------------------------------------------------------------------

describe("§9.4: the gate around everything else", () => {
  it("403s a pending account on an `active` route while letting it redeem", async () => {
    const deps = codeDeps();
    const { token } = seedCaller(deps, "gated");
    // Stands in for M6-T2/T3/T4's endpoints, which declare `auth: "active"` the same way.
    const router = createRouter(
      [...createCodesRoutes(), route("GET", "/api/collection", "active", async () => ok({}))],
      deps,
    );

    const gated = await router(jsonRequest("GET", "/api/collection", undefined, { token }));
    expect(gated.status).toBe(403);
    expect((await readJson<ErrorBody>(gated)).error.code).toBe("account_pending");

    // The code screen itself stays reachable (§9.4).
    const allowed = await router(jsonRequest("GET", "/api/codes/status", undefined, { token }));
    expect(allowed.status).toBe(200);
  });
});

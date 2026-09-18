/**
 * BUILD M6-T1: "integration tests for each rejection step" of SPEC §9.4's six-step redemption
 * transaction, plus the identical-error requirement and the global circuit breaker. Each test
 * names the step it covers.
 *
 * Every test drives real HTTP through `createRouter`, so the route's auth declaration, the
 * §9.4 gate, the constant-time padding and the handler all take part.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INVITE_CODE_MAX_USES,
  createCodesRoutes,
  mintInviteCode,
} from "../../src/api/codes";
import { createRouter, ok, route, type Router } from "../../src/api/http";
import { systemTimers, type ApiLimits, type Ids, type ProfileStatus } from "../../src/api/ports";
import {
  CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  REDEMPTION_IDENTICAL_ERROR,
  REDEMPTION_RESPONSE_FLOOR_MS,
} from "../../src/config";
import { formatCode } from "../../src/api/crypto";
import {
  createTestDeps,
  createVirtualTimers,
  jsonRequest,
  readJson,
  testLimits,
  type TestDeps,
} from "../fakes/deps";

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

// R145: everything here depends on the caller's own account rather than on the code, so each one
// is reported distinctly — it leaks nothing about the code space.
describe("§9.4 step 1: pending account with a verified email (R145)", () => {
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

describe("R145 — the identical error for every code-dependent refusal (§9.4)", () => {
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
// BUILD M6-T1: "timing test shows the three failure responses within 5 ms of each other over 50
// samples" — §9.4's "identical time", delivered by R107's floor.
// ---------------------------------------------------------------------------

/** BUILD M6-T1's acceptance bound, as it writes it. */
const TIMING_SAMPLES = 50;
const TIMING_SPREAD_MS = 5;

/**
 * The cost model this test *injects*, so the padding has something real to hide.
 *
 * `STORE_CALL_MS` is a round trip to Postgres and `ROW_FETCH_MS` the extra cost of a lookup that
 * found its row — an index miss answers from the index alone, a hit goes on to the heap. That is
 * the asymmetry §9.4 is about: a missing code does strictly less work than an expired or exhausted
 * one, and without a floor the difference is readable from outside. The numbers are the test's own,
 * not the server's; what is asserted below is that they stop being observable, whatever they are.
 */
const STORE_CALL_MS = 3;
const ROW_FETCH_MS = 11;

type TimedDeps = { deps: TestDeps; workSinceLast: () => number };

/**
 * `codeDeps()` on the virtual clock, with every store call charged.
 *
 * Nothing here waits on the wall clock: `createVirtualTimers` advances only when work is charged or
 * a scheduled sleep comes due, so the measurement is exact and identical on a loaded CI box and on
 * an idle laptop. That is the whole reason this test can be trusted — a flaky security test is
 * worse than none.
 */
function timingDeps(): TimedDeps {
  const timers = createVirtualTimers();
  const deps = createTestDeps({
    timers,
    ids: alphabetIds(),
    limits: testLimits({
      // The production floor, which costs a virtual clock nothing to sit through.
      redeemConstantMs: REDEMPTION_RESPONSE_FLOOR_MS,
      // 150 deliberate failures would otherwise trip §9.4's breaker part-way through and turn the
      // remaining samples into 503s, which are a different branch than the three under test.
      breakerFailureThreshold: TIMING_SAMPLES * 3 + 1,
    }),
  });

  let work = 0;
  const charge = (ms: number): void => {
    work += ms;
    timers.charge(ms);
  };

  deps.store.onCall = () => charge(STORE_CALL_MS);
  const findByHash = deps.store.codes.findByHash;
  deps.store.codes.findByHash = async (codeHash) => {
    const row = await findByHash(codeHash);
    if (row !== null) charge(ROW_FETCH_MS);
    return row;
  };

  return {
    deps,
    workSinceLast: () => {
      const total = work;
      work = 0;
      return total;
    },
  };
}

describe("R107 — the constant-time failure floor (BUILD M6-T1)", () => {
  it("R107 answers missing, expired and exhausted within 5 ms of each other over 50 samples", async () => {
    const { deps, workSinceLast } = timingDeps();
    const router = createRouter(createCodesRoutes(), deps);

    const expiredCode = await mintInviteCode(deps, { expiresAt: deps.timers.now() - 1_000 });
    const usedCode = await mintInviteCode(deps, { maxUses: 1 });
    const consumer = seedCaller(deps, "timing-consumer");
    expect((await redeem(router, consumer.token, usedCode.formatted)).status).toBe(200);

    const kinds = [
      { name: "missing", code: UNMINTED_CODE },
      { name: "expired", code: expiredCode.formatted },
      { name: "exhausted", code: usedCode.formatted },
    ] as const;

    const elapsed: Record<string, number[]> = { missing: [], expired: [], exhausted: [] };
    const work: Record<string, number[]> = { missing: [], expired: [], exhausted: [] };

    // Interleaved, and a fresh profile and address per sample: §9.4's per-profile (5/h) and per-IP
    // (20/h) limits would otherwise start refusing part-way through, at step 2 or 3 instead of at
    // step 5, and those are not the branches this measures.
    for (let sample = 0; sample < TIMING_SAMPLES; sample += 1) {
      for (const kind of kinds) {
        const caller = seedCaller(deps, `timing-${kind.name}-${String(sample)}`);
        const ip = `198.51.100.${String(sample)}/${kind.name}`;
        workSinceLast();

        const startedAt = deps.timers.now();
        const response = await redeem(router, caller.token, kind.code, ip);
        elapsed[kind.name]?.push(deps.timers.now() - startedAt);
        work[kind.name]?.push(workSinceLast());

        // All three really are the refusal under test, not some other rejection.
        expect(response.status).toBe(400);
      }
    }

    const all = kinds.flatMap((kind) => elapsed[kind.name] ?? []);
    expect(all).toHaveLength(TIMING_SAMPLES * 3);

    // BUILD M6-T1: "the three failure responses within 5 ms of each other over 50 samples".
    expect(Math.max(...all) - Math.min(...all)).toBeLessThanOrEqual(TIMING_SPREAD_MS);
    // R107: and the floor is a floor — no branch is quicker than the budget it is padded to.
    expect(Math.min(...all)).toBeGreaterThanOrEqual(REDEMPTION_RESPONSE_FLOOR_MS);

    // The assertion above would pass on a code path that happened to be uniform, which would make
    // it a test of nothing. The work really was lopsided; the padding is what flattened it.
    const workPerKind = kinds.map((kind) => work[kind.name]?.[0] ?? 0);
    expect(Math.max(...workPerKind) - Math.min(...workPerKind)).toBeGreaterThan(TIMING_SPREAD_MS);
    expect(Math.max(...workPerKind)).toBeLessThan(REDEMPTION_RESPONSE_FLOOR_MS);
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
// R161 — "How many accounts one invite code activates: one, unless its mint says otherwise"
// ---------------------------------------------------------------------------

/**
 * Every other test in this file passes `maxUses` explicitly, which is exactly what R161's default
 * cannot be proved from: a code that was *told* to allow one use says nothing about what a code
 * that was told nothing allows. Both tests below mint through `mintInviteCode(deps)` with no
 * `maxUses` at all.
 */
describe("R161 — how many accounts one invite code activates (§9.4, §9.8)", () => {
  it("R161 activates exactly one account from a code minted with no maxUses", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const first = seedCaller(deps, "first-holder");
    const second = seedCaller(deps, "second-holder");

    const leaked = await mintInviteCode(deps);

    // PREMISE: the mint really did default, and defaulted to one.
    expect(DEFAULT_INVITE_CODE_MAX_USES).toBe(1);
    expect(deps.store.tables.codes[0]?.maxUses).toBe(1);
    expect(deps.store.tables.codes[0]?.uses).toBe(0);

    // The one account the code is worth.
    expect((await redeem(router, first.token, leaked.formatted)).status).toBe(200);
    expect(deps.store.tables.profiles.find((row) => row.id === "first-holder")?.status).toBe("active");

    // The second caller is refused — through R145's identical error, so the refusal itself says
    // nothing about *why*. One leaked code is one account, not an open door (§9.8).
    const refused = await redeem(router, second.token, leaked.formatted);
    expect(refused.status).toBe(400);
    expect((await readJson<ErrorBody>(refused)).error.message).toBe(REDEMPTION_IDENTICAL_ERROR);
    expect(deps.store.tables.codes[0]?.uses).toBe(1);
    expect(deps.store.tables.profiles.find((row) => row.id === "second-holder")?.status).toBe("pending");

    // CONTROL: the second caller is not refused for some reason of their own. A code with a use
    // left activates them on the spot, so what the first redemption consumed was the *code*.
    const another = await mintInviteCode(deps);
    expect((await redeem(router, second.token, another.formatted)).status).toBe(200);
    expect(deps.store.tables.profiles.find((row) => row.id === "second-holder")?.status).toBe("active");
  });

  it("R161 leaves a larger maximum available to whoever mints deliberately", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const callers = ["one", "two", "three", "four"].map((name) => seedCaller(deps, name));

    const batch = await mintInviteCode(deps, { maxUses: 3 });
    expect(deps.store.tables.codes[0]?.maxUses).toBe(3);

    for (const caller of callers.slice(0, 3)) {
      expect((await redeem(router, caller.token, batch.formatted)).status).toBe(200);
    }
    expect(deps.store.tables.codes[0]?.uses).toBe(3);

    // "One" is a default, not a law — and the counter still stops where the mint said it would.
    const fourth = await redeem(router, callers[3]?.token ?? "", batch.formatted);
    expect(fourth.status).toBe(400);
    expect(deps.store.tables.codes[0]?.uses).toBe(3);
    expect(deps.store.tables.profiles.find((row) => row.id === "four")?.status).toBe("pending");
  });

  it("R161 agrees with the schema, so minting through the API and inserting by hand match", () => {
    // The other half of "one unless the mint says otherwise": a row written straight into
    // `invite_codes` gets the same default the API applies.
    const migration = readFileSync(
      new URL("../../src/db/migrations/0001_profiles_and_invites.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toMatch(
      new RegExp(`max_uses\\s+int not null default ${String(DEFAULT_INVITE_CODE_MAX_USES)}\\b`),
    );
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

/**
 * R190, docs/polish/5-sign-in.md B10, B11 and B12: which address a per-IP limit counts.
 *
 * §9.4 step 3 (20 redemptions per IP hash per hour) and R157's anonymous API bucket both key on
 * "the IP hash". Behind a proxy every request arrives from the proxy, so the caller's address is
 * read from `X-Forwarded-For`, but only from the entry the deployment's own proxies wrote: the
 * `trustedProxyHops`-th from the right. Everything to its left was written by the caller. The
 * server once read the leftmost entry, which let a caller pick a fresh bucket per request by
 * changing one header.
 *
 *  - B10: with one trusted hop, the rightmost entry is the key, in `code_attempts.ipHash` and in
 *    the anonymous limiter alike.
 *  - B11: `CF-Connecting-IP` and `X-Real-IP` are never read; too few entries fall back to the
 *    socket's peer address (`RequestContext.peerAddress`), and no peer to
 *    `UNKNOWN_CLIENT_ADDRESS`.
 *  - B12: `TRUSTED_PROXY_HOPS` is parsed by `loadEnv` and defaults to 0 (no proxy trusted), and the
 *    router reports the fewest entries any request carried, never an address.
 *  - An IPv6 client is counted by its /56, and an IPv4-mapped address as the IPv4 address.
 */

import { describe, expect, it } from "vitest";

import { createCodesRoutes } from "../../src/api/codes";
import { withCors } from "../../src/api/cors";
import { floodLimits } from "../../src/api/deps";
import {
  UNKNOWN_CLIENT_ADDRESS,
  clientAddress,
  createRouter,
  ok,
  rateLimitAddress,
  route,
  type RequestContext,
  type Router,
} from "../../src/api/http";
import { systemTimers, type ServerDeps } from "../../src/api/ports";
import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  IPV6_RATE_LIMIT_PREFIX_BITS,
  MAX_TRUSTED_PROXY_HOPS,
  REDEMPTION_IDENTICAL_ERROR,
} from "../../src/config";
import { SERVER_ONLY_ENV_VARS, loadEnv } from "../../src/env";
import {
  createManualTimers,
  createRecordingLogger,
  createTestDeps,
  readJson,
  testLimits,
  type TestDeps,
} from "../fakes/deps";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** R109's allowance, as the server carries it. */
const LIMIT = floodLimits.apiRequestsPerMinute;

/** A well-formed code inside R104's alphabet that is never minted. */
const UNMINTED_CODE = "ABCD-EFGH-JKMN-PQRT";

/** The address our own proxy saw, and wrote last. */
const CLIENT = "203.0.113.20";
/** The socket's peer: the proxy itself, or a direct caller. */
const PEER = "192.0.2.10";

type ErrorBody = { error: { code: string; message: string } };

function headers(entries: Record<string, string | readonly string[]>): Headers {
  const built = new Headers();
  for (const [name, value] of Object.entries(entries)) {
    for (const one of typeof value === "string" ? [value] : value) built.append(name, one);
  }
  return built;
}

/** A redemption request with exactly the headers given, and nothing added. */
function redeemRequest(token: string, extra: Record<string, string> = {}): Request {
  return new Request("https://server.test/api/codes/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extra },
    body: JSON.stringify({ code: UNMINTED_CODE }),
  });
}

function openRequest(extra: Record<string, string> = {}): Request {
  return new Request("https://server.test/api/open", { method: "GET", headers: extra });
}

/** Redemption on the real clock with `testLimits()`' 20 ms floor, as `codes.test.ts` runs it. */
function codeDeps(overrides: Partial<ServerDeps> = {}): TestDeps {
  return createTestDeps({ timers: systemTimers, limits: testLimits(), ...overrides });
}

function seedCaller(deps: TestDeps, id: string): { token: string; profileId: string } {
  const userId = `user-${id}`;
  const token = deps.auth.addUser({ userId, email: `${id}@example.test`, emailVerified: true });
  const profile = deps.store.seedProfile({ id, userId, status: "pending" });
  return { token, profileId: profile.id };
}

function openRouter(deps: TestDeps): Router {
  return createRouter([route("GET", "/api/open", "none", async () => ok({ pong: true }))], deps);
}

/** Puts `address` over §9.4 step 3's per-IP limit, through other people's attempts. */
async function floodAddress(deps: TestDeps, address: string): Promise<void> {
  const ipHash = deps.hashes.ip(address);
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
}

/** The ip hash of the one attempt `profileId` has on record. */
function attemptIpHash(deps: TestDeps, profileId: string): string | undefined {
  const rows = deps.store.tables.attempts.filter((row) => row.profileId === profileId);
  expect(rows).toHaveLength(1);
  return rows[0]?.ipHash;
}

// ---------------------------------------------------------------------------------------------
// clientAddress
// ---------------------------------------------------------------------------------------------

describe("R190 clientAddress", () => {
  it("R190 B10 takes the rightmost X-Forwarded-For entry with one trusted hop", () => {
    const forwarded = headers({ "x-forwarded-for": `198.51.100.1, ${CLIENT}` });
    expect(clientAddress(forwarded, PEER, 1)).toBe(CLIENT);
  });

  it("R190 B10 counts the trusted hops from the right", () => {
    const forwarded = headers({ "x-forwarded-for": "198.51.100.1, 198.51.100.2, 198.51.100.3" });
    expect(clientAddress(forwarded, PEER, 1)).toBe("198.51.100.3");
    expect(clientAddress(forwarded, PEER, 2)).toBe("198.51.100.2");
    expect(clientAddress(forwarded, PEER, 3)).toBe("198.51.100.1");
  });

  it("R190 B10 trims every entry and drops empty ones", () => {
    const forwarded = headers({ "x-forwarded-for": ` 198.51.100.1 ,, ${CLIENT}  , ` });
    expect(clientAddress(forwarded, PEER, 1)).toBe(CLIENT);
    expect(clientAddress(forwarded, PEER, 2)).toBe("198.51.100.1");
  });

  it("R190 B10 reads every X-Forwarded-For header, not just the first", () => {
    const forwarded = headers({ "x-forwarded-for": ["198.51.100.1", CLIENT] });
    expect(clientAddress(forwarded, PEER, 1)).toBe(CLIENT);
    expect(clientAddress(forwarded, PEER, 2)).toBe("198.51.100.1");
  });

  it("R190 B10 gives the same answer whatever the caller writes to the left", () => {
    for (const spoofed of ["1.1.1.1", "10.0.0.1, 10.0.0.2", "not-an-address", "::1, 127.0.0.1"]) {
      const forwarded = headers({ "x-forwarded-for": `${spoofed}, ${CLIENT}` });
      expect(clientAddress(forwarded, PEER, 1), spoofed).toBe(CLIENT);
    }
  });

  it("R190 B11 falls back to the peer when there are fewer entries than trusted hops", () => {
    const forwarded = headers({ "x-forwarded-for": CLIENT });
    expect(clientAddress(forwarded, PEER, 2)).toBe(PEER);
    expect(clientAddress(forwarded, null, 2)).toBe(UNKNOWN_CLIENT_ADDRESS);
  });

  it("R190 B11 uses the peer when there is no X-Forwarded-For", () => {
    expect(clientAddress(new Headers(), PEER, 1)).toBe(PEER);
  });

  it("R190 B11 answers UNKNOWN_CLIENT_ADDRESS with no header and no peer", () => {
    expect(clientAddress(new Headers(), null, 1)).toBe(UNKNOWN_CLIENT_ADDRESS);
  });

  it("R190 B11 treats an X-Forwarded-For of only commas and spaces as none", () => {
    expect(clientAddress(headers({ "x-forwarded-for": " , ,, " }), PEER, 1)).toBe(PEER);
  });

  it("R190 B11 never reads CF-Connecting-IP or X-Real-IP", () => {
    const vendor = { "cf-connecting-ip": "198.51.100.66", "x-real-ip": "198.51.100.77" };
    expect(clientAddress(headers(vendor), PEER, 1)).toBe(PEER);
    expect(clientAddress(headers(vendor), null, 1)).toBe(UNKNOWN_CLIENT_ADDRESS);
    expect(clientAddress(headers({ ...vendor, "x-forwarded-for": CLIENT }), PEER, 1)).toBe(CLIENT);
  });

  it("R190 B12 ignores the header entirely with zero trusted hops", () => {
    const forwarded = headers({ "x-forwarded-for": `198.51.100.1, ${CLIENT}` });
    expect(clientAddress(forwarded, PEER, 0)).toBe(PEER);
    expect(clientAddress(forwarded, null, 0)).toBe(UNKNOWN_CLIENT_ADDRESS);
  });
});

// ---------------------------------------------------------------------------------------------
// The router: §9.4 step 3 and R157's anonymous bucket
// ---------------------------------------------------------------------------------------------

describe("R190 the per-IP keys behind a proxy", () => {
  it("R190 B10 hashes the rightmost entry into code_attempts.ipHash", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const first = seedCaller(deps, "left-one");
    const second = seedCaller(deps, "left-two");
    const context: RequestContext = { peerAddress: PEER };

    await router(redeemRequest(first.token, { "x-forwarded-for": `198.51.100.1, ${CLIENT}` }), context);
    await router(redeemRequest(second.token, { "x-forwarded-for": `198.51.100.2, 10.9.8.7, ${CLIENT}` }), context);

    expect(attemptIpHash(deps, first.profileId)).toBe(deps.hashes.ip(CLIENT));
    expect(attemptIpHash(deps, second.profileId)).toBe(deps.hashes.ip(CLIENT));
    expect(attemptIpHash(deps, first.profileId)).not.toBe(deps.hashes.ip("198.51.100.1"));
  });

  it("R190 B10 a fresh leftmost entry does not escape §9.4 step 3", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "spoofer");
    await floodAddress(deps, CLIENT);

    const spoofed = await router(
      redeemRequest(token, { "x-forwarded-for": `198.51.100.250, ${CLIENT}` }),
      { peerAddress: PEER },
    );
    expect(spoofed.status).toBe(429);
    expect((await readJson<ErrorBody>(spoofed)).error.code).toBe("rate_limited");

    // CONTROL: the same caller from an address with room reaches the lookup and fails there.
    const elsewhere = await router(
      redeemRequest(token, { "x-forwarded-for": `${CLIENT}, 203.0.113.21` }),
      { peerAddress: PEER },
    );
    expect(elsewhere.status).toBe(400);
    const body = await readJson<ErrorBody>(elsewhere);
    expect(body.error.code).toBe("invalid_code");
    expect(body.error.message).toBe(REDEMPTION_IDENTICAL_ERROR);
  });

  it("R190 B10 with two trusted hops, entries left of the second-from-right never change the bucket", async () => {
    const deps = codeDeps({ trustedProxyHops: 2 });
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "two-hop-spoofer");
    await floodAddress(deps, CLIENT);

    // Ours: `CLIENT` as the edge saw it, then the edge as the load balancer saw it.
    const spoofed = await router(
      redeemRequest(token, { "x-forwarded-for": `198.51.100.251, 198.51.100.252, ${CLIENT}, 10.0.0.5` }),
      { peerAddress: PEER },
    );

    expect(spoofed.status).toBe(429);
    expect((await readJson<ErrorBody>(spoofed)).error.code).toBe("rate_limited");
  });

  it("R190 B11 a fresh X-Real-IP does not escape §9.4 step 3 for a flooded peer", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "real-ip-spoofer");
    await floodAddress(deps, PEER);

    const response = await router(redeemRequest(token, { "x-real-ip": "198.51.100.253" }), {
      peerAddress: PEER,
    });

    expect(response.status).toBe(429);
    expect((await readJson<ErrorBody>(response)).error.code).toBe("rate_limited");
  });

  it("R190 B11 a fresh CF-Connecting-IP does not escape §9.4 step 3 for a flooded peer", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "cf-spoofer");
    await floodAddress(deps, PEER);

    const response = await router(redeemRequest(token, { "cf-connecting-ip": "198.51.100.254" }), {
      peerAddress: PEER,
    });

    expect(response.status).toBe(429);
    expect((await readJson<ErrorBody>(response)).error.code).toBe("rate_limited");
  });

  it("R190 B10 R157's anonymous bucket is shared by every request whose rightmost entry matches", async () => {
    const deps = createTestDeps({ timers: createManualTimers() });
    const router = openRouter(deps);
    const context: RequestContext = { peerAddress: PEER };

    for (let i = 0; i < LIMIT; i += 1) {
      const spoofed = `10.${String(i % 250)}.${String(Math.floor(i / 250))}.1`;
      const response = await router(openRequest({ "x-forwarded-for": `${spoofed}, ${CLIENT}` }), context);
      expect(response.status).toBe(200);
    }

    const next = await router(openRequest({ "x-forwarded-for": `172.16.0.1, ${CLIENT}` }), context);
    expect(next.status).toBe(429);
    expect((await readJson<ErrorBody>(next)).error.code).toBe("rate_limited");

    // CONTROL: a different client behind the same proxy has its own bucket.
    const other = await router(openRequest({ "x-forwarded-for": `172.16.0.1, 203.0.113.21` }), context);
    expect(other.status).toBe(200);
  });

  it("R190 B11 keys a request with no X-Forwarded-For on the peer, whatever CF-Connecting-IP says", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "direct");

    await router(
      redeemRequest(token, { "cf-connecting-ip": "198.51.100.66", "x-real-ip": "198.51.100.77" }),
      { peerAddress: PEER },
    );

    expect(attemptIpHash(deps, profileId)).toBe(deps.hashes.ip(PEER));
  });

  it("R190 B11 CF-Connecting-IP and X-Real-IP cannot open a fresh anonymous bucket", async () => {
    const deps = createTestDeps({ timers: createManualTimers() });
    const router = openRouter(deps);
    const context: RequestContext = { peerAddress: PEER };

    for (let i = 0; i < LIMIT; i += 1) {
      const spoofed = `10.${String(i % 250)}.${String(Math.floor(i / 250))}.2`;
      const response = await router(
        openRequest({ "cf-connecting-ip": spoofed, "x-real-ip": spoofed }),
        context,
      );
      expect(response.status).toBe(200);
    }

    const next = await router(
      openRequest({ "cf-connecting-ip": "172.16.0.2", "x-real-ip": "172.16.0.2" }),
      context,
    );
    expect(next.status).toBe(429);

    // CONTROL: a different peer is a different bucket.
    const other = await router(openRequest(), { peerAddress: "192.0.2.11" });
    expect(other.status).toBe(200);
  });

  it("R190 B11 keys a request with no header and no peer on UNKNOWN_CLIENT_ADDRESS", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const withoutContext = seedCaller(deps, "no-context");
    const nullPeer = seedCaller(deps, "null-peer");

    await router(redeemRequest(withoutContext.token));
    await router(redeemRequest(nullPeer.token, { "x-real-ip": "198.51.100.77" }), { peerAddress: null });

    expect(attemptIpHash(deps, withoutContext.profileId)).toBe(deps.hashes.ip(UNKNOWN_CLIENT_ADDRESS));
    expect(attemptIpHash(deps, nullPeer.profileId)).toBe(deps.hashes.ip(UNKNOWN_CLIENT_ADDRESS));
  });

  it("R190 B11 falls back to the peer when a request carries fewer entries than the trusted hops", async () => {
    const deps = codeDeps({ trustedProxyHops: 2 });
    const router = createRouter(createCodesRoutes(), deps);
    const short = seedCaller(deps, "one-entry");
    const full = seedCaller(deps, "two-entries");

    await router(redeemRequest(short.token, { "x-forwarded-for": CLIENT }), { peerAddress: PEER });
    await router(redeemRequest(full.token, { "x-forwarded-for": `${CLIENT}, 10.0.0.5` }), { peerAddress: PEER });

    expect(attemptIpHash(deps, short.profileId)).toBe(deps.hashes.ip(PEER));
    expect(attemptIpHash(deps, full.profileId)).toBe(deps.hashes.ip(CLIENT));
  });

  it("R190 B12 zero trusted hops keys on the peer even when X-Forwarded-For is present", async () => {
    const deps = codeDeps({ trustedProxyHops: 0 });
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "zero-hops");

    await router(redeemRequest(token, { "x-forwarded-for": `198.51.100.1, ${CLIENT}` }), { peerAddress: PEER });

    expect(attemptIpHash(deps, profileId)).toBe(deps.hashes.ip(PEER));
  });

  it("R190 B11 withCors hands the RequestContext through to the router", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const handler = withCors(router, { origins: [], log: createRecordingLogger() });
    const { token, profileId } = seedCaller(deps, "through-cors");

    await handler(redeemRequest(token), { peerAddress: PEER });

    expect(attemptIpHash(deps, profileId)).toBe(deps.hashes.ip(PEER));
  });
});

// ---------------------------------------------------------------------------------------------
// B12: TRUSTED_PROXY_HOPS in the environment
// ---------------------------------------------------------------------------------------------

/** A complete, valid environment for the server (apps/server/README.md's table), minus the hops. */
function validEnv(): Record<string, string> {
  return {
    SUPABASE_URL: "https://project.supabase.test",
    SUPABASE_SECRET_KEY: "sb_secret_0123456789abcdefghijklmnopqrstuv",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/jackioh",
    CODE_PEPPER: "a-pepper-of-at-least-thirty-two-characters",
    CATALOG_VERSION: "core-1",
    PUBLIC_ORIGINS: "https://play.jackioh.test",
    NODE_ENV: "test",
  };
}

describe("R190 B12 TRUSTED_PROXY_HOPS", () => {
  it("R190 B12 defaults to DEFAULT_TRUSTED_PROXY_HOPS when it is not set", () => {
    expect(loadEnv(validEnv()).TRUSTED_PROXY_HOPS).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
  });

  it("R190 B12 accepts every integer from 0 to MAX_TRUSTED_PROXY_HOPS", () => {
    for (let hops = 0; hops <= MAX_TRUSTED_PROXY_HOPS; hops += 1) {
      const env = loadEnv({ ...validEnv(), TRUSTED_PROXY_HOPS: String(hops) });
      expect(env.TRUSTED_PROXY_HOPS, String(hops)).toBe(hops);
    }
  });

  it("R190 B12 lists a value above MAX_TRUSTED_PROXY_HOPS as a problem", () => {
    expect(() =>
      loadEnv({ ...validEnv(), TRUSTED_PROXY_HOPS: String(MAX_TRUSTED_PROXY_HOPS + 1) }),
    ).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it("R190 B12 lists a negative value as a problem", () => {
    expect(() => loadEnv({ ...validEnv(), TRUSTED_PROXY_HOPS: "-1" })).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it("R190 B12 lists a fractional value as a problem", () => {
    expect(() => loadEnv({ ...validEnv(), TRUSTED_PROXY_HOPS: "1.5" })).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it("R190 B12 lists a value that is not a number as a problem", () => {
    for (const value of ["one", "NaN", "1 hop"]) {
      expect(() => loadEnv({ ...validEnv(), TRUSTED_PROXY_HOPS: value }), value).toThrow(
        /TRUSTED_PROXY_HOPS/,
      );
    }
  });

  it("R190 B12 adds its problem to the others rather than replacing them", () => {
    const { CODE_PEPPER: _pepper, ...withoutPepper } = validEnv();
    expect(() => loadEnv({ ...withoutPepper, TRUSTED_PROXY_HOPS: "-1" })).toThrow(/TRUSTED_PROXY_HOPS/);
    expect(() => loadEnv({ ...withoutPepper, TRUSTED_PROXY_HOPS: "-1" })).toThrow(/CODE_PEPPER/);
  });

  it("R190 B12 is a server-only variable", () => {
    expect(SERVER_ONLY_ENV_VARS).toContain("TRUSTED_PROXY_HOPS");
  });
});

// ---------------------------------------------------------------------------------------------
// B12: the api.forwarded_for calibration log
// ---------------------------------------------------------------------------------------------

describe("R190 B12 the api.forwarded_for log", () => {
  function forwardedLogs(deps: TestDeps): TestDeps["log"]["entries"] {
    return deps.log.entries.filter((entry) => entry.event === "api.forwarded_for");
  }

  it("R190 B12 logs the fewest entries seen so far, each time a request carries fewer, and never an address", async () => {
    const deps = createTestDeps({ timers: createManualTimers() });
    const router = openRouter(deps);
    const chain = ["198.51.100.61", "198.51.100.62", "203.0.113.63"];

    await router(openRequest({ "x-forwarded-for": chain.join(", ") }), { peerAddress: PEER });
    await router(openRequest({ "x-forwarded-for": "198.51.100.64, 203.0.113.65, 203.0.113.60" }), { peerAddress: PEER });
    await router(openRequest({ "x-forwarded-for": "203.0.113.66" }), { peerAddress: PEER });
    await router(openRequest({ "x-forwarded-for": "198.51.100.64, 203.0.113.65" }), { peerAddress: PEER });

    expect(forwardedLogs(deps).map((entry) => entry.data)).toEqual([
      { fewestEntries: chain.length, trustedProxyHops: 1 },
      { fewestEntries: 1, trustedProxyHops: 1 },
    ]);
    expect(forwardedLogs(deps).every((entry) => entry.level === "info")).toBe(true);

    const everything = JSON.stringify(deps.log.entries);
    for (const address of [...chain, "198.51.100.64", "203.0.113.65", "203.0.113.66", PEER]) {
      expect(everything).not.toContain(address);
    }

    // A second router reports for itself.
    const second = openRouter(deps);
    await second(openRequest({ "x-forwarded-for": "203.0.113.67" }), { peerAddress: PEER });
    expect(forwardedLogs(deps)).toHaveLength(3);
  });

  it("R190 B12 a caller who writes its own entries cannot raise the count the operator reads", async () => {
    // The adversarial panel's finding: one sample from whoever sent the first X-Forwarded-For
    // request was the whole signal, and a scanner could make it say anything. Callers only ever
    // ADD entries, so the minimum over every request is the proxies' own count.
    const deps = createTestDeps({ timers: createManualTimers() });
    const router = openRouter(deps);

    await router(openRequest({ "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3, 203.0.113.70" }), { peerAddress: PEER });
    await router(openRequest({ "x-forwarded-for": "203.0.113.71" }), { peerAddress: PEER });

    const latest = forwardedLogs(deps).at(-1)?.data as { fewestEntries: number } | undefined;
    expect(latest?.fewestEntries).toBe(1);
  });

  it("R190 B12 a hostile caller can cause only a handful of lines per router", async () => {
    const deps = createTestDeps({ timers: createManualTimers() });
    const router = openRouter(deps);

    // Every request one entry shorter than the one before, from far more entries than any proxy.
    for (let count = 40; count >= 1; count -= 1) {
      const chain = Array.from({ length: count }, (_, i) => `10.0.${String(Math.floor(i / 250))}.${String(i % 250)}`);
      await router(openRequest({ "x-forwarded-for": chain.join(", ") }), { peerAddress: PEER });
    }

    expect(forwardedLogs(deps).length).toBeLessThanOrEqual(MAX_TRUSTED_PROXY_HOPS + 2);
    expect((forwardedLogs(deps).at(-1)?.data as { fewestEntries: number }).fewestEntries).toBe(1);
  });

  it("R190 B12 waits for the first request that carries X-Forwarded-For", async () => {
    const deps = createTestDeps({ timers: createManualTimers() });
    const router = openRouter(deps);

    await router(openRequest(), { peerAddress: PEER });
    await router(openRequest({ "x-real-ip": "198.51.100.77" }), { peerAddress: PEER });
    expect(forwardedLogs(deps)).toHaveLength(0);

    await router(openRequest({ "x-forwarded-for": "198.51.100.68, 203.0.113.69" }), { peerAddress: PEER });
    expect(forwardedLogs(deps)).toEqual([
      { level: "info", event: "api.forwarded_for", data: { fewestEntries: 2, trustedProxyHops: 1 } },
    ]);
  });

  it("R190 B12 reports the trusted hops the router was given, and the default when none was", async () => {
    const hops = Math.min(MAX_TRUSTED_PROXY_HOPS, 2);
    const deps = createTestDeps({ timers: createManualTimers(), trustedProxyHops: hops });
    const router = openRouter(deps);
    await router(openRequest({ "x-forwarded-for": "198.51.100.70" }), { peerAddress: PEER });
    expect(forwardedLogs(deps).map((entry) => entry.data)).toEqual([{ fewestEntries: 1, trustedProxyHops: hops }]);

    const unset = withoutHops(createTestDeps({ timers: createManualTimers() }));
    await openRouter(unset)(openRequest({ "x-forwarded-for": "198.51.100.70" }), { peerAddress: PEER });
    expect(forwardedLogs(unset).map((entry) => entry.data)).toEqual([
      { fewestEntries: 1, trustedProxyHops: DEFAULT_TRUSTED_PROXY_HOPS },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// R190: the default trusts no proxy
// ---------------------------------------------------------------------------------------------

/** `deps` as a server with no `TRUSTED_PROXY_HOPS` configured sees them. */
function withoutHops(deps: TestDeps): TestDeps {
  const { trustedProxyHops: _hops, ...rest } = deps;
  return rest as TestDeps;
}

describe("R190 the default number of trusted hops", () => {
  it("R190 is zero, so a server with no proxy in front never reads a caller's X-Forwarded-For", () => {
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(0);
  });

  it("R190 a direct caller rotating X-Forwarded-For stays in its peer's R157 bucket under the default", async () => {
    const deps = withoutHops(createTestDeps({ timers: createManualTimers() }));
    const router = openRouter(deps);
    const direct: RequestContext = { peerAddress: "198.51.100.200" };

    for (let i = 0; i < LIMIT; i += 1) {
      const spoofed = `10.${String(i % 250)}.${String(Math.floor(i / 250))}.9`;
      expect((await router(openRequest({ "x-forwarded-for": spoofed }), direct)).status).toBe(200);
    }
    const next = await router(openRequest({ "x-forwarded-for": "172.16.9.9" }), direct);
    expect(next.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------------------------
// R190: an IPv6 client is counted by its /56
// ---------------------------------------------------------------------------------------------

describe("R190 rateLimitAddress", () => {
  it("R190 keys every address in one IPv6 /56 alike, and different /56s apart", () => {
    const key = rateLimitAddress("2001:db8:1:2::1");
    expect(IPV6_RATE_LIMIT_PREFIX_BITS).toBe(56);
    for (const same of [
      "2001:db8:1:2::2",
      "2001:DB8:1:2:ffff:ffff:ffff:ffff",
      "2001:0db8:0001:0002:0:0:0:9",
      "[2001:db8:1:2::3]:443",
      // Another /64 of the same /56: one home's delegation is one key.
      "2001:db8:1:ff::1",
    ]) {
      expect(rateLimitAddress(same), same).toBe(key);
    }
    expect(rateLimitAddress("2001:db8:1:102::1")).not.toBe(key);
  });

  it("R190 one host's /56 delegation cannot be split into a bucket per /64", () => {
    // The panel's pair: two /64s of one typical home /56.
    expect(rateLimitAddress("2a02:8108:1:abff::1")).toBe(rateLimitAddress("2a02:8108:1:ab00::1"));
    expect(rateLimitAddress("2a02:8108:1:ab00::1")).toBe(`2a02:8108:1:ab00:0:0:0:0/${String(IPV6_RATE_LIMIT_PREFIX_BITS)}`);
  });

  it("R190 reads an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(rateLimitAddress("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitAddress("::ffff:c000:201")).toBe("192.0.2.1");
  });

  it("R190 keeps an IPv4 address whole, without a port, and anything else as written", () => {
    expect(rateLimitAddress("192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitAddress("192.0.2.1:8080")).toBe("192.0.2.1");
    expect(rateLimitAddress(UNKNOWN_CLIENT_ADDRESS)).toBe(UNKNOWN_CLIENT_ADDRESS);
    expect(rateLimitAddress(" Not-An-Address ")).toBe("not-an-address");
  });

  it("R190 a host rotating addresses inside its /56 does not escape §9.4 step 3", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "rotator");
    await floodAddress(deps, rateLimitAddress("2001:db8:1:2::1"));

    const rotated = await router(redeemRequest(token, { "x-forwarded-for": "2001:db8:1:ee::2" }), {
      peerAddress: "10.0.0.1",
    });

    expect(rotated.status).toBe(429);
    expect((await readJson<ErrorBody>(rotated)).error.code).toBe("rate_limited");
  });

  it("R190 an IPv4 peer reported as IPv4-mapped IPv6 shares its bucket", async () => {
    const deps = codeDeps();
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "dual-stack");

    await router(redeemRequest(token), { peerAddress: "::ffff:192.0.2.10" });

    expect(attemptIpHash(deps, profileId)).toBe(deps.hashes.ip("192.0.2.10"));
  });
});

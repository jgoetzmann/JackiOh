/**
 * R191, docs/polish/5-sign-in.md B5 and B6: the server redeems exactly what the shared reading
 * says a typed or pasted code is.
 *
 * B5 runs every row of the shared table (`packages/shared/test/fixtures/code-input-cases.ts`)
 * through the real router. A row with a canonical code redeems a code minted as that canonical; a
 * row without one gets R145's identical error byte for byte, and the code the row was mangled
 * from (the table's base code, minted beside it) is left untouched. The web's code field is tested
 * against the same rows, so the two ends cannot drift apart without one of them going red.
 *
 * B6 is the input cap: a code longer than `CODE_INPUT_MAX_LENGTH` is refused unread, logged as
 * malformed, and padded to the redemption floor (R107) like every other outcome.
 *
 * The B5 rows run on the real clock with `testLimits()`' 20 ms floor, as `codes.test.ts` does,
 * each on fresh deps with its own profile and address so §9.4 steps 2 and 3 never refuse. The B6
 * timing tests run on `createVirtualTimers` with the production floor, which costs them nothing.
 */

import { describe, expect, it } from "vitest";

import { createCodesRoutes, mintInviteCode } from "../../src/api/codes";
import { createRouter, type Router } from "../../src/api/http";
import { systemTimers, type Ids, type ProfileStatus, type Timers } from "../../src/api/ports";
import {
  API_MAX_BODY_BYTES,
  CODE_INPUT_MAX_LENGTH,
  INVITE_CODE_FORMAT,
  REDEMPTION_IDENTICAL_ERROR,
  REDEMPTION_RESPONSE_FLOOR_MS,
} from "../../src/config";
import { CODE_INPUT_CASES } from "../../../../packages/shared/test/fixtures/code-input-cases";
import {
  createTestDeps,
  createVirtualTimers,
  jsonRequest,
  testLimits,
  type TestDeps,
} from "../fakes/deps";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** The table's base code: every malformed row is a mangled spelling of it. */
const BASE_CODE = "ABCDEFGHJKMNPQRS";

/** R145's refusal, exactly as it goes over the wire. */
const IDENTICAL_BODY = JSON.stringify({
  error: { code: "invalid_code", message: REDEMPTION_IDENTICAL_ERROR },
});

/** `Ids` whose `code` mints exactly `code`, so the test decides which code exists. */
function idsMinting(code: string): Ids {
  let n = 0;
  const next = (): number => {
    n += 1;
    return n;
  };
  return {
    uuid: () => `id-${String(next())}`,
    seed: () => `seed-${String(next())}`,
    code: () => code,
  };
}

function depsMinting(code: string, timers: Timers = systemTimers, floorMs?: number): TestDeps {
  return createTestDeps({
    timers,
    ids: idsMinting(code),
    limits: testLimits(floorMs === undefined ? {} : { redeemConstantMs: floorMs }),
  });
}

function seedCaller(
  deps: TestDeps,
  id: string,
  status: ProfileStatus = "pending",
): { token: string; profileId: string } {
  const userId = `user-${id}`;
  const token = deps.auth.addUser({ userId, email: `${id}@example.test`, emailVerified: true });
  const profile = deps.store.seedProfile({ id, userId, status });
  return { token, profileId: profile.id };
}

async function redeem(router: Router, token: string, code: string, ip: string): Promise<Response> {
  return router(jsonRequest("POST", "/api/codes/redeem", { code }, { token, ip }));
}

function statusOf(deps: TestDeps, profileId: string): string | undefined {
  return deps.store.tables.profiles.find((row) => row.id === profileId)?.status;
}

// ---------------------------------------------------------------------------------------------
// B5: every table row, redeemed
// ---------------------------------------------------------------------------------------------

describe("R191 B5 the server redeems every row of the shared table as the client reads it", () => {
  CODE_INPUT_CASES.forEach((row, index) => {
    const ip = `198.51.100.${String(index + 1)}`;

    if (row.canonical !== null) {
      const canonical = row.canonical;
      it(`R191 B5 redeems: ${row.name}`, async () => {
        const deps = depsMinting(canonical);
        const router = createRouter(createCodesRoutes(), deps);
        const { token, profileId } = seedCaller(deps, `parity-${String(index)}`);
        const minted = await mintInviteCode(deps);
        // PREMISE: the code on record is the row's canonical code.
        expect(minted.formatted.split(INVITE_CODE_FORMAT.separator).join("")).toBe(canonical);

        const response = await redeem(router, token, row.input, ip);

        expect(response.status).toBe(200);
        expect(statusOf(deps, profileId)).toBe("active");
        expect(deps.store.tables.codes[0]?.uses).toBe(1);
        expect(deps.store.tables.attempts.map((attempt) => attempt.result)).toEqual(["ok"]);
      });
    } else {
      it(`R191 B5 refuses with R145's identical error: ${row.name}`, async () => {
        // The base code exists, so a server that dropped, mapped or truncated its way to it
        // would activate the account here.
        const deps = depsMinting(BASE_CODE);
        const router = createRouter(createCodesRoutes(), deps);
        const { token, profileId } = seedCaller(deps, `parity-${String(index)}`);
        await mintInviteCode(deps);

        const response = await redeem(router, token, row.input, ip);

        expect(response.status).toBe(400);
        expect(await response.text()).toBe(IDENTICAL_BODY);
        expect(response.headers.get("retry-after")).toBeNull();
        expect(statusOf(deps, profileId)).toBe("pending");
        expect(deps.store.tables.codes[0]?.uses).toBe(0);
        // Past steps 2 and 3, so logged (step 4), under the operator-only reason.
        expect(deps.store.tables.attempts).toHaveLength(1);
        expect(deps.store.tables.attempts[0]?.reason).toBe("malformed");
      });
    }
  });
});

describe("R191 an empty code is read like every other input that holds no code", () => {
  it("R191 '' answers exactly as '----' and ' ' do, the account's own refusal included, never bad_request", async () => {
    const deps = depsMinting(BASE_CODE);
    const router = createRouter(createCodesRoutes(), deps);
    await mintInviteCode(deps);
    const active = seedCaller(deps, "empty-active", "active");
    const pending = seedCaller(deps, "empty-pending");

    // An active account is refused for its own state before any code is read (R145).
    const activeAnswers: string[] = [];
    for (const [index, code] of ["", "----", " "].entries()) {
      const response = await redeem(router, active.token, code, `198.51.100.${String(220 + index)}`);
      expect(response.status, JSON.stringify(code)).toBe(409);
      activeAnswers.push(await response.text());
    }
    expect(new Set(activeAnswers).size).toBe(1);

    // A pending one gets R145's identical error, and the attempt is logged as malformed.
    const empty = await redeem(router, pending.token, "", "198.51.100.230");
    expect(empty.status).toBe(400);
    expect(await empty.text()).toBe(IDENTICAL_BODY);
    const attempts = deps.store.tables.attempts.filter((row) => row.profileId === pending.profileId);
    expect(attempts.map((row) => row.reason)).toEqual(["malformed"]);
  });

  it("R191 a code that is not a string at all is still a malformed request", async () => {
    const deps = depsMinting(BASE_CODE);
    const router = createRouter(createCodesRoutes(), deps);
    const { token } = seedCaller(deps, "number-code");
    const response = await router(
      jsonRequest("POST", "/api/codes/redeem", { code: 42 }, { token, ip: "198.51.100.231" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });
});

// ---------------------------------------------------------------------------------------------
// B6: the input cap
// ---------------------------------------------------------------------------------------------

describe("R191 B6 a code longer than CODE_INPUT_MAX_LENGTH", () => {
  it("R191 B6 refuses a minted code padded past the cap, unread, with the identical error", async () => {
    const deps = depsMinting(BASE_CODE);
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "padded-past-cap");
    const minted = await mintInviteCode(deps);

    // The code itself is good; only the whitespace around it pushes the input over the cap.
    const input = minted.formatted.padEnd(CODE_INPUT_MAX_LENGTH + 1, " ");
    const response = await redeem(router, token, input, "198.51.100.201");

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(IDENTICAL_BODY);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(statusOf(deps, profileId)).toBe("pending");
    expect(deps.store.tables.codes[0]?.uses).toBe(0);
    expect(deps.store.tables.attempts).toHaveLength(1);
    expect(deps.store.tables.attempts[0]?.reason).toBe("malformed");
  });

  it("R191 B6 still redeems a minted code padded to exactly the cap", async () => {
    const deps = depsMinting(BASE_CODE);
    const router = createRouter(createCodesRoutes(), deps);
    const { token, profileId } = seedCaller(deps, "padded-to-cap");
    const minted = await mintInviteCode(deps);

    const input = minted.formatted.padEnd(CODE_INPUT_MAX_LENGTH, " ");
    expect(input).toHaveLength(CODE_INPUT_MAX_LENGTH);
    const response = await redeem(router, token, input, "198.51.100.202");

    expect(response.status).toBe(200);
    expect(statusOf(deps, profileId)).toBe("active");
  });

  it("R191 B6 answers a huge code with the same bytes as a missing one, and logs it as malformed", async () => {
    const deps = depsMinting(BASE_CODE);
    const router = createRouter(createCodesRoutes(), deps);
    const huge = seedCaller(deps, "huge-code");
    const missing = seedCaller(deps, "missing-code");
    await mintInviteCode(deps);

    // Well inside the body limit, far past the input cap.
    const hugeCode = BASE_CODE.repeat(Math.floor(API_MAX_BODY_BYTES / (2 * BASE_CODE.length)));
    expect(hugeCode.length).toBeGreaterThan(CODE_INPUT_MAX_LENGTH);
    const hugeResponse = await redeem(router, huge.token, hugeCode, "198.51.100.203");
    const missingResponse = await redeem(router, missing.token, "ABCD-EFGH-JKMN-PQRT", "198.51.100.204");

    expect(hugeResponse.status).toBe(400);
    expect(missingResponse.status).toBe(400);
    const bodies = [await hugeResponse.text(), await missingResponse.text()];
    expect(bodies).toEqual([IDENTICAL_BODY, IDENTICAL_BODY]);

    const hugeAttempts = deps.store.tables.attempts.filter((row) => row.profileId === huge.profileId);
    expect(hugeAttempts).toHaveLength(1);
    expect(hugeAttempts[0]?.result).toBe("rejected");
    expect(hugeAttempts[0]?.reason).toBe("malformed");
  });

  it("R191 B6 pads the refusal to the redemption floor like every other outcome (R107)", async () => {
    const timers = createVirtualTimers();
    const deps = depsMinting(BASE_CODE, timers, REDEMPTION_RESPONSE_FLOOR_MS);
    const router = createRouter(createCodesRoutes(), deps);
    const tooLong = seedCaller(deps, "floor-too-long");
    const missing = seedCaller(deps, "floor-missing");
    const minted = await mintInviteCode(deps);

    const startedTooLong = timers.now();
    const tooLongResponse = await redeem(
      router,
      tooLong.token,
      minted.formatted.padEnd(CODE_INPUT_MAX_LENGTH + 1, " "),
      "198.51.100.205",
    );
    const tooLongElapsed = timers.now() - startedTooLong;

    const startedMissing = timers.now();
    const missingResponse = await redeem(router, missing.token, "ABCD-EFGH-JKMN-PQRT", "198.51.100.206");
    const missingElapsed = timers.now() - startedMissing;

    expect(tooLongResponse.status).toBe(400);
    expect(missingResponse.status).toBe(400);
    expect(tooLongElapsed).toBeGreaterThanOrEqual(REDEMPTION_RESPONSE_FLOOR_MS);
    expect(missingElapsed).toBeGreaterThanOrEqual(REDEMPTION_RESPONSE_FLOOR_MS);
  });
});

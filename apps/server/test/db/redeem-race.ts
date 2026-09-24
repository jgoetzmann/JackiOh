/**
 * docs/polish/5-sign-in.md B14: concurrent redemptions, against both stores.
 *
 * §9.4 step 6 says "increment uses and set the account active, atomically", and `Store.redeem` is
 * the whole six-step transaction. `contract.ts` proves each step one call at a time; this proves
 * the transaction holds when calls overlap:
 *
 *  - one pending profile redeeming several good codes at once is activated once and spends exactly
 *    one code (the in-memory store once let both calls pass step 1 across an `await`, so one account
 *    used up two codes);
 *  - several profiles racing for a code's last use get exactly one `ok`;
 *  - at §9.4 step 3's per-IP boundary, concurrent redemptions from DIFFERENT profiles at one
 *    address get exactly one more lookup (Postgres once let 7 to 9 through: the count was not held
 *    across profiles until migration 0006's advisory lock);
 *  - a redemption that overlaps another request's transaction stays committed when that one rolls
 *    back (the in-memory stores once shared one snapshot between them).
 *
 * ONE suite, TWO stores, like `contract.ts`:
 *   pnpm test      -> redeem-race.memory.test.ts   (the in-memory fixture, hermetic)
 *   pnpm test:db   -> redeem-race.postgres.spec.ts (a throwaway Docker Postgres)
 *
 * Every call is started before any is awaited (`Promise.all`), so the stores see them overlap.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Profile, Store } from "../../src/api/ports";
import { CODE_ATTEMPTS_PER_IP_PER_HOUR } from "../../src/config";
import type { StoreHarness } from "./harness";

/** What `Store.redeem` answers, read off the port rather than restated. */
type RedeemResult = Awaited<ReturnType<Store["redeem"]>>;

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/** uuids, because the Postgres store types every id column as `uuid`. */
function id(): string {
  return crypto.randomUUID();
}

export function runRedeemRaceContract(makeHarness: () => Promise<StoreHarness>): void {
  let harness: StoreHarness;
  let store: Store;

  beforeAll(async () => {
    harness = await makeHarness();
    store = harness.store;
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
  });

  /** §9.4: pending until a code is redeemed, with a verified email (the harness default). */
  async function pendingProfile(): Promise<Profile> {
    const email = `${id()}@example.test`;
    const userId = await harness.newUserId(email);
    const existing = await store.profiles.getByUserId(userId);
    if (existing !== null) return existing;
    return store.profiles.create({ userId, email, rating: 1000, at: harness.now() });
  }

  async function mint(maxUses = 1): Promise<{ id: string; codeHash: string }> {
    const row = {
      id: id(),
      codeHash: `hash-${id()}`,
      maxUses,
      uses: 0,
      revoked: false,
      expiresAt: null,
      createdAt: harness.now(),
    };
    await store.codes.insert(row);
    return { id: row.id, codeHash: row.codeHash };
  }

  async function usesOf(codeHash: string): Promise<number> {
    return must(await store.codes.findByHash(codeHash), "the code").uses;
  }

  async function statusOf(profileId: string): Promise<string> {
    return must(await store.profiles.getById(profileId), "the profile").status;
  }

  function count(results: readonly RedeemResult[], wanted: RedeemResult): number {
    return results.filter((result) => result === wanted).length;
  }

  describe("B14 concurrent redemptions (SPEC §9.4 step 6)", () => {
    it("B14 one pending profile redeeming two good codes at once is activated once and spends one code", async () => {
      const profile = await pendingProfile();
      const codes = [await mint(), await mint()];

      const results = await Promise.all(
        codes.map((code, index) =>
          store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: `ip-race-${String(index)}` }),
        ),
      );

      expect(count(results, "ok")).toBe(1);
      expect(await statusOf(profile.id)).toBe("active");
      const uses = await Promise.all(codes.map(async (code) => usesOf(code.codeHash)));
      expect(uses.reduce((sum, value) => sum + value, 0)).toBe(1);
    });

    it("B14 one pending profile redeeming four good codes at once still spends exactly one", async () => {
      const profile = await pendingProfile();
      const codes = [await mint(), await mint(), await mint(), await mint()];

      const results = await Promise.all(
        codes.map((code, index) =>
          store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: `ip-many-${String(index)}` }),
        ),
      );

      expect(count(results, "ok")).toBe(1);
      expect(await statusOf(profile.id)).toBe("active");
      const uses = await Promise.all(codes.map(async (code) => usesOf(code.codeHash)));
      expect(uses.reduce((sum, value) => sum + value, 0)).toBe(1);
    });

    it("B14 two profiles racing for a single-use code get exactly one ok", async () => {
      const profiles = [await pendingProfile(), await pendingProfile()];
      const code = await mint(1);

      const results = await Promise.all(
        profiles.map((profile, index) =>
          store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: `ip-pair-${String(index)}` }),
        ),
      );

      expect([...results].sort()).toEqual(["invalid_code", "ok"]);
      expect(await usesOf(code.codeHash)).toBe(1);
      const statuses = await Promise.all(profiles.map(async (profile) => statusOf(profile.id)));
      expect([...statuses].sort()).toEqual(["active", "pending"]);
      // The winner is the one the store said won.
      const winner = results.indexOf("ok");
      expect(statuses[winner]).toBe("active");
    });

    it("B14 two profiles racing for the last use of a multi-use code get exactly one ok", async () => {
      const code = await mint(2);
      expect(await store.codes.claim(code.id, harness.now())).toBe(true);
      const profiles = [await pendingProfile(), await pendingProfile()];

      const results = await Promise.all(
        profiles.map((profile, index) =>
          store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: `ip-last-${String(index)}` }),
        ),
      );

      expect([...results].sort()).toEqual(["invalid_code", "ok"]);
      expect(await usesOf(code.codeHash)).toBe(2);
      const statuses = await Promise.all(profiles.map(async (profile) => statusOf(profile.id)));
      expect([...statuses].sort()).toEqual(["active", "pending"]);
    });

    it("B14 five profiles racing for a single-use code activate exactly one account", async () => {
      const profiles = [
        await pendingProfile(),
        await pendingProfile(),
        await pendingProfile(),
        await pendingProfile(),
        await pendingProfile(),
      ];
      const code = await mint(1);

      const results = await Promise.all(
        profiles.map((profile, index) =>
          store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: `ip-crowd-${String(index)}` }),
        ),
      );

      expect(count(results, "ok")).toBe(1);
      expect(count(results, "invalid_code")).toBe(profiles.length - 1);
      expect(await usesOf(code.codeHash)).toBe(1);
      const statuses = await Promise.all(profiles.map(async (profile) => statusOf(profile.id)));
      expect(statuses.filter((status) => status === "active")).toHaveLength(1);
    });

    it("B14 at the per-IP boundary, concurrent redemptions from different profiles get exactly one more lookup", async () => {
      const ipHash = `ip-boundary-${id()}`;
      // Exactly at the limit, one account at a time: §9.4 step 3 refuses "more than" it.
      for (let i = 0; i < CODE_ATTEMPTS_PER_IP_PER_HOUR; i += 1) {
        const profile = await pendingProfile();
        expect(await store.redeem({ profileId: profile.id, codeHash: `missing-${id()}`, ipHash })).toBe(
          "invalid_code",
        );
      }
      const burst = await Promise.all(Array.from({ length: 10 }, async () => pendingProfile()));

      const results = await Promise.all(
        burst.map(async (profile) => store.redeem({ profileId: profile.id, codeHash: `missing-${id()}`, ipHash })),
      );

      // The first to get through sees the limit (not more than it) and reaches the lookup; every
      // other one then sees one more than the limit.
      expect(count(results, "invalid_code"), results.join(",")).toBe(1);
      expect(count(results, "rate_limited_ip"), results.join(",")).toBe(burst.length - 1);
    });

    it("B14 a redemption that overlaps another transaction's rollback stays committed", async () => {
      const profile = await pendingProfile();
      const code = await mint();

      // Another request's transaction (a loadout save, a result) is still running, and then fails.
      const other = store
        .tx(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error("the other request's write failed");
        })
        .then(
          () => "committed",
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      const redeemed = await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: "ip-overlap" });
      expect(await other).toBe("the other request's write failed");

      expect(redeemed).toBe("ok");
      expect(await statusOf(profile.id)).toBe("active");
      expect(await usesOf(code.codeHash)).toBe(1);
    });

    it("B14 serves the next redemption normally once a race has settled", async () => {
      const racer = await pendingProfile();
      const raced = [await mint(), await mint()];
      await Promise.all(
        raced.map((code, index) =>
          store.redeem({ profileId: racer.id, codeHash: code.codeHash, ipHash: `ip-settle-${String(index)}` }),
        ),
      );

      const later = await pendingProfile();
      const fresh = await mint();
      expect(await store.redeem({ profileId: later.id, codeHash: fresh.codeHash, ipHash: "ip-later" })).toBe("ok");
      expect(await statusOf(later.id)).toBe("active");
      expect(await usesOf(fresh.codeHash)).toBe(1);
    });
  });
}

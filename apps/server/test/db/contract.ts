/**
 * ONE suite, TWO stores. Every assertion here runs against both `src/api/e2e-store.ts` (the
 * in-memory fixture 233 server tests already trust) and `src/db/store.ts` (the real Postgres
 * implementation), so "the fake and the real one agree" is a test result rather than a hope.
 *
 * It exists because of what went wrong without it: `src/db/store.ts` did not exist at all, the
 * server booted only in `E2E=1` mode, and nothing in `pnpm test` could notice — every server test
 * passed against a fake that nothing was ever compared to.
 *
 * What is asserted is the list in `e2e-store.ts`'s own header: the invariants SPEC §9.4 and §9.5
 * lean on, the ones "a laxer fixture would let a real bug pass the suite" past. Where the schema
 * and the port genuinely cannot hold the same information, the divergence is named in
 * `src/db/store.ts`'s KNOWN DIVERGENCES block and the assertion here is written to the weaker of
 * the two (deck order, action timestamps) rather than deleted.
 *
 *   pnpm test      -> contract.memory.test.ts  (hermetic, in the server project)
 *   pnpm test:db   -> contract.postgres.spec.ts (Docker Postgres, outside `pnpm test`)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Action } from "@jackioh/shared";
import type { MatchClocks, MatchRow, Profile, Store } from "../../src/api/ports";
import type { StoreHarness } from "./harness";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

/** The deck at `slot` of a legal three-deck loadout over the fixture catalog (§9.4 L1, L2, L4). */
function deckOf(harness: StoreHarness, slot: number): string[] {
  return harness.playableIds.slice(slot * 20, slot * 20 + 20);
}

function clocks(now: number): MatchClocks {
  return {
    turnDeadline: now + 75_000,
    promptDeadline: null,
    graceDeadline: { p1: null, p2: null },
    ceilingAt: now + 3_600_000,
  };
}

function matchRow(id: string, p1: string, p2: string, harness: StoreHarness, now: number): MatchRow {
  return {
    id,
    seed: "seed-1",
    players: [p1, p2],
    decks: [deckOf(harness, 0), deckOf(harness, 1)],
    catalogVersion: harness.catalogVersion,
    status: "live",
    createdAt: now,
    finishedAt: null,
    clocks: clocks(now),
  };
}

function action(playerId: "p1" | "p2", nonce: string): Action {
  return { type: "endTurn", playerId, nonce };
}

/** uuids for the Postgres store, which types every id column as `uuid`. */
function id(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export function runStoreContract(make: () => Promise<StoreHarness>): void {
  let harness: StoreHarness;
  let store: Store;

  beforeAll(async () => {
    harness = await make();
    store = harness.store;
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await harness.reset();
  });

  /** §9.4: the account exists the moment auth says so, and stays pending until a code is redeemed. */
  async function pendingProfile(email = `${id()}@example.test`): Promise<Profile> {
    const userId = await harness.newUserId(email);
    // Exactly what `resolveCaller` (src/api/http.ts) does.
    const existing = await store.profiles.getByUserId(userId);
    if (existing !== null) return existing;
    return store.profiles.create({ userId, email, rating: 1000, at: harness.now() });
  }

  async function activeProfile(email?: string): Promise<Profile> {
    const profile = await pendingProfile(email);
    await store.profiles.setStatus(profile.id, "active");
    return must(await store.profiles.getById(profile.id), "the profile after activation");
  }

  describe(`Store contract`, () => {
    // -----------------------------------------------------------------------
    // Profiles (SPEC §9.4)
    // -----------------------------------------------------------------------

    describe("profiles", () => {
      it("creates a pending profile and reads it back by id and by user id", async () => {
        const email = "pending@example.test";
        const userId = await harness.newUserId(email);
        const created = await store.profiles.create({ userId, email, rating: 1000, at: harness.now() });

        expect(created.status).toBe("pending");
        expect(created.rating).toBe(1000);
        expect(created.inMatchId).toBeNull();
        expect(created.email).toBe(email);
        expect(created.userId).toBe(userId);

        expect(await store.profiles.getById(created.id)).toEqual(created);
        expect(await store.profiles.getByUserId(userId)).toEqual(created);
      });

      it("returns null for an unknown profile", async () => {
        expect(await store.profiles.getById(id())).toBeNull();
      });

      it("reads many profiles at once", async () => {
        const a = await pendingProfile();
        const b = await pendingProfile();
        const many = await store.profiles.getMany([a.id, b.id, id()]);
        expect(sorted(many.map((p) => p.id))).toEqual(sorted([a.id, b.id]));
      });

      it("moves the rating and the in-match pointer", async () => {
        const profile = await activeProfile();
        const matchId = id();
        await store.matches.create(matchRow(matchId, profile.id, (await activeProfile()).id, harness, harness.now()));

        await store.profiles.setRating(profile.id, 1032);
        await store.profiles.setInMatch(profile.id, matchId);
        const rated = must(await store.profiles.getById(profile.id), "the rated profile");
        expect(rated.rating).toBe(1032);
        expect(rated.inMatchId).toBe(matchId);

        // §9.5: "Every ending ... clears both players' in-match state."
        await store.profiles.setInMatch(profile.id, null);
        expect(must(await store.profiles.getById(profile.id), "profile").inMatchId).toBeNull();
      });

      /**
       * R111, and the reason `e2e-store.ts` carries a trigger at all: "Becoming `active` grants one
       * copy of every non-token card, written by a trigger on the `pending → active` transition and
       * idempotent, so a repeated redemption cannot double a collection."
       */
      it("R111 grants one copy of every non-token card on pending → active, idempotently", async () => {
        const profile = await pendingProfile();
        expect(await store.collection.get(profile.id)).toEqual([]);

        await store.profiles.setStatus(profile.id, "active");
        const granted = await store.collection.get(profile.id);
        expect(sorted(granted.map((entry) => entry.cardId))).toEqual(sorted(harness.playableIds));
        expect(granted.every((entry) => entry.quantity === 1)).toBe(true);
        for (const tokenId of harness.tokenIds) {
          expect(granted.some((entry) => entry.cardId === tokenId)).toBe(false);
        }

        await store.profiles.setStatus(profile.id, "active");
        expect(await store.collection.get(profile.id)).toEqual(granted);
      });
    });

    // -----------------------------------------------------------------------
    // Invite codes (SPEC §9.4)
    // -----------------------------------------------------------------------

    describe("codes", () => {
      const code = (over: Partial<Parameters<Store["codes"]["insert"]>[0]> = {}) => ({
        id: id(),
        codeHash: `hash-${id()}`,
        maxUses: 1,
        uses: 0,
        revoked: false,
        expiresAt: null,
        createdAt: harness.now(),
        ...over,
      });

      it("round-trips a code by its hash", async () => {
        const row = code();
        await store.codes.insert(row);
        expect(await store.codes.findByHash(row.codeHash)).toEqual(row);
        expect(await store.codes.findByHash("no-such-hash")).toBeNull();
      });

      /** §9.4 step 6: "Two concurrent callers cannot both win the last use." */
      it("claims a single-use code exactly once", async () => {
        const row = code();
        await store.codes.insert(row);
        expect(await store.codes.claim(row.id, harness.now())).toBe(true);
        expect(await store.codes.claim(row.id, harness.now())).toBe(false);
        expect(must(await store.codes.findByHash(row.codeHash), "the code").uses).toBe(1);
      });

      it("refuses a revoked or expired code", async () => {
        const revoked = code({ revoked: true });
        const expired = code({ expiresAt: harness.now() - 1 });
        await store.codes.insert(revoked);
        await store.codes.insert(expired);
        expect(await store.codes.claim(revoked.id, harness.now())).toBe(false);
        expect(await store.codes.claim(expired.id, harness.now())).toBe(false);
      });

      /** §9.4 steps 2-4 and the circuit breaker read exactly these three counters. */
      it("counts attempts by profile, by ip hash and by failure", async () => {
        const profile = await pendingProfile();
        const now = harness.now();
        const ipHash = `ip-${id()}`;
        await store.codes.logAttempt({ profileId: profile.id, ipHash, result: "rejected", reason: "missing", at: now - 10 });
        await store.codes.logAttempt({ profileId: profile.id, ipHash, result: "ok", reason: "redeemed", at: now });
        await store.codes.logAttempt({ profileId: null, ipHash: "other", result: "rejected", reason: "missing", at: now });

        expect(await store.codes.countAttemptsByProfile(profile.id, now - 60_000)).toBe(2);
        expect(await store.codes.countAttemptsByProfile(profile.id, now + 1)).toBe(0);
        // R192: when the oldest counted attempt was made, so the status can say when it lapses.
        expect(await store.codes.oldestAttemptAtByProfile(profile.id, now - 60_000)).toBe(now - 10);
        expect(await store.codes.oldestAttemptAtByProfile(profile.id, now - 5)).toBe(now);
        expect(await store.codes.oldestAttemptAtByProfile(profile.id, now + 1)).toBeNull();
        expect(await store.codes.countAttemptsByIp(ipHash, now - 60_000)).toBe(2);
        expect(await store.codes.countFailures(now - 60_000)).toBe(2);
      });
    });

    // -----------------------------------------------------------------------
    // Redemption (SPEC §9.4's one server-side transaction)
    // -----------------------------------------------------------------------

    /**
     * `Store.redeem` is the whole of §9.4's six steps, and the two implementations of it are as
     * far apart as this port gets: one `select app.redeem_invite_code(...)` against migration
     * 0001's plpgsql, and `createInMemoryRedeem` walking the same six steps over the fake's
     * tables. Nothing above this block would notice if they disagreed — `src/api/codes.ts` calls
     * the port and the whole server suite runs on the fake — so every result code the port
     * declares is exercised here, against both.
     */
    describe("redeem (SPEC §9.4)", () => {
      /** The hash is opaque to the store; what matters is that it is the same one both times. */
      const codeHash = (): string => `hash-${id()}`;

      async function mint(
        over: { maxUses?: number; expiresAt?: number | null; revoked?: boolean } = {},
      ): Promise<{ id: string; codeHash: string }> {
        const row = {
          id: id(),
          codeHash: codeHash(),
          maxUses: over.maxUses ?? 1,
          uses: 0,
          revoked: over.revoked ?? false,
          expiresAt: over.expiresAt ?? null,
          createdAt: harness.now(),
        };
        await store.codes.insert(row);
        return { id: row.id, codeHash: row.codeHash };
      }

      /** Attempts logged for this profile inside §9.4's window — step 4's evidence. */
      async function attempts(profileId: string): Promise<number> {
        return store.codes.countAttemptsByProfile(profileId, harness.now() - 60_000);
      }

      async function usesOf(hash: string): Promise<number> {
        return must(await store.codes.findByHash(hash), "the code").uses;
      }

      async function statusOf(profileId: string): Promise<string> {
        return must(await store.profiles.getById(profileId), "the profile").status;
      }

      /** §9.4 step 6: "increment uses and set the account active, atomically." */
      it("activates a pending account, consumes one use and logs the attempt", async () => {
        const profile = await pendingProfile();
        const code = await mint();

        expect(
          await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: "ip-ok" }),
        ).toBe("ok");

        expect(await statusOf(profile.id)).toBe("active");
        expect(await usesOf(code.codeHash)).toBe(1);
        expect(await attempts(profile.id)).toBe(1);
        // R111's launch grant rides the pending → active transition, wherever it is made.
        expect(await store.collection.get(profile.id)).toHaveLength(harness.playableIds.length);
      });

      /**
       * §9.4: "Missing, expired and exhausted codes return an identical error." Revoked joins them
       * (step 5 names it) and so does a hash the caller has already established cannot be a code
       * (`codeHash: null`) — the one result code means no caller can tell the five apart.
       */
      it("answers missing, revoked, expired, exhausted and malformed identically", async () => {
        const revoked = await mint({ revoked: true });
        const expired = await mint({ expiresAt: harness.now() - 60_000 });
        const exhausted = await mint();
        expect(await store.codes.claim(exhausted.id, harness.now())).toBe(true);

        const cases: { name: string; hash: string | null }[] = [
          { name: "missing", hash: codeHash() },
          { name: "revoked", hash: revoked.codeHash },
          { name: "expired", hash: expired.codeHash },
          { name: "exhausted", hash: exhausted.codeHash },
          { name: "malformed", hash: null },
        ];

        for (const kind of cases) {
          const profile = await pendingProfile();
          expect(
            await store.redeem({ profileId: profile.id, codeHash: kind.hash, ipHash: `ip-${kind.name}` }),
            kind.name,
          ).toBe("invalid_code");
          // Refused, but not for free: §9.4 logs the attempt (step 4) before it looks anything up.
          expect(await statusOf(profile.id), kind.name).toBe("pending");
          expect(await attempts(profile.id), kind.name).toBe(1);
        }

        expect(await usesOf(revoked.codeHash)).toBe(0);
        expect(await usesOf(expired.codeHash)).toBe(0);
        expect(await usesOf(exhausted.codeHash)).toBe(1);
      });

      /**
       * §9.4 step 1, "reject unless the account is pending": one result for every account that is
       * not. R145 makes `src/api/codes.ts` tell banned from already-active from unknown, which it
       * does from the caller's own profile — the store cannot and does not.
       */
      it("refuses an account that is not pending, without logging an attempt", async () => {
        const profile = await activeProfile();
        const code = await mint({ maxUses: 5 });

        expect(
          await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: "ip" }),
        ).toBe("not_pending");
        expect(await usesOf(code.codeHash)).toBe(0);
        expect(await attempts(profile.id)).toBe(0);
      });

      /** §9.4 step 1's other half: "with a verified email". */
      it("refuses a pending account whose email is not verified", async () => {
        const profile = await pendingProfile();
        const code = await mint({ maxUses: 5 });
        await harness.setEmailVerified(profile.id, false);

        expect(
          await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: "ip" }),
        ).toBe("email_unverified");
        expect(await statusOf(profile.id)).toBe("pending");
        expect(await usesOf(code.codeHash)).toBe(0);
        expect(await attempts(profile.id)).toBe(0);

        // And verifying it is all that stood in the way.
        await harness.setEmailVerified(profile.id, true);
        expect(
          await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: "ip" }),
        ).toBe("ok");
      });

      /**
       * §9.4 step 2: "reject if this profile made more than 5 attempts in the last hour" — and
       * step 2 runs before step 4, so a caller already over the limit cannot pin their own counter
       * by retrying.
       */
      it("rate-limits a profile past its hourly attempts and logs nothing more", async () => {
        const profile = await pendingProfile();
        const code = await mint({ maxUses: 9 });
        const at = harness.now();
        for (let i = 0; i < 6; i += 1) {
          await store.codes.logAttempt({
            profileId: profile.id,
            ipHash: "ip-flood",
            result: "rejected",
            reason: "missing",
            at,
          });
        }

        expect(
          await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: "ip-flood" }),
        ).toBe("rate_limited_profile");
        expect(await attempts(profile.id)).toBe(6);
        expect(await statusOf(profile.id)).toBe("pending");
        expect(await usesOf(code.codeHash)).toBe(0);
      });

      /** §9.4 step 3: "reject if this IP hash made more than 20" — a different window, per address. */
      it("rate-limits an IP hash past its hourly attempts", async () => {
        const profile = await pendingProfile();
        const code = await mint({ maxUses: 9 });
        const ipHash = `ip-${id()}`;
        const at = harness.now();
        // Nobody's profile in particular: the neighbours behind one NAT, so step 2 stays at zero.
        for (let i = 0; i < 21; i += 1) {
          await store.codes.logAttempt({
            profileId: null,
            ipHash,
            result: "rejected",
            reason: "missing",
            at,
          });
        }

        expect(await attempts(profile.id)).toBe(0);
        expect(await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash })).toBe(
          "rate_limited_ip",
        );
        expect(await statusOf(profile.id)).toBe("pending");
      });

      /**
       * §9.4: "A global circuit breaker disables redemption." This is the database's own switch,
       * which the store answers `circuit_open` from; the server's R106 breaker (`codes.ts`) is a
       * separate object that never lets a request reach here while it is open.
       */
      it("refuses every redemption while the database's redemption switch is off", async () => {
        const profile = await pendingProfile();
        const code = await mint();
        await harness.setRedemptionEnabled(false);

        expect(
          await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: "ip" }),
        ).toBe("circuit_open");
        // A good code is refused too, unspent, and the attempt still costs the caller a row.
        expect(await statusOf(profile.id)).toBe("pending");
        expect(await usesOf(code.codeHash)).toBe(0);
        expect(await attempts(profile.id)).toBe(1);

        await harness.setRedemptionEnabled(true);
        expect(
          await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: "ip" }),
        ).toBe("ok");
      });

      /**
       * §9.4 step 6 again, from the other side: "Two concurrent callers cannot both win the last
       * use" (ports.ts). One code, two accounts, one activation.
       */
      it("lets a single-use code activate exactly one account", async () => {
        const first = await pendingProfile();
        const second = await pendingProfile();
        const code = await mint({ maxUses: 1 });

        expect(
          await store.redeem({ profileId: first.id, codeHash: code.codeHash, ipHash: "ip-a" }),
        ).toBe("ok");
        expect(
          await store.redeem({ profileId: second.id, codeHash: code.codeHash, ipHash: "ip-b" }),
        ).toBe("invalid_code");

        expect(await statusOf(first.id)).toBe("active");
        expect(await statusOf(second.id)).toBe("pending");
        expect(await usesOf(code.codeHash)).toBe(1);
      });

      /** R161: "a larger maximum stays available to whoever mints deliberately." */
      it("spends a multi-use code once per account until it is exhausted", async () => {
        const code = await mint({ maxUses: 2 });
        const profiles = [await pendingProfile(), await pendingProfile(), await pendingProfile()];
        const results = [];
        for (const profile of profiles) {
          results.push(
            await store.redeem({ profileId: profile.id, codeHash: code.codeHash, ipHash: "ip" }),
          );
        }

        expect(results).toEqual(["ok", "ok", "invalid_code"]);
        expect(await usesOf(code.codeHash)).toBe(2);
      });
    });

    // -----------------------------------------------------------------------
    // Collection (SPEC §9.4's entitlement ledger)
    // -----------------------------------------------------------------------

    describe("collection", () => {
      it("sets absolute quantities and appends grants", async () => {
        const profile = await pendingProfile();
        const [first, second] = [must(harness.playableIds[0], "a card"), must(harness.playableIds[1], "a card")];

        await store.collection.upsertQuantities(profile.id, [
          { cardId: first, quantity: 2 },
          { cardId: second, quantity: 1 },
        ]);
        await store.collection.appendGrants([
          { profileId: profile.id, cardId: first, delta: 2, reason: "admin", at: harness.now() },
          { profileId: profile.id, cardId: second, delta: 1, reason: "admin", at: harness.now() },
        ]);

        const owned = await store.collection.get(profile.id);
        expect(sorted(owned.map((e) => e.cardId))).toEqual(sorted([first, second]));
        expect(must(owned.find((e) => e.cardId === first), "the first card").quantity).toBe(2);

        // "SETS each card's quantity to the absolute value given; it does not add to it" (ports.ts).
        await store.collection.upsertQuantities(profile.id, [{ cardId: first, quantity: 5 }]);
        const after = await store.collection.get(profile.id);
        expect(must(after.find((e) => e.cardId === first), "the first card").quantity).toBe(5);
      });

      /** §9.4: "Every collection change writes `collection` and `collection_grants` in one transaction." */
      it("rolls both ledger writes back when the transaction throws", async () => {
        const profile = await activeProfile();
        const cardId = must(harness.playableIds[0], "a card");
        const before = await store.collection.get(profile.id);

        await expect(
          store.tx(async (t) => {
            await t.collection.upsertQuantities(profile.id, [{ cardId, quantity: 9 }]);
            await t.collection.appendGrants([
              { profileId: profile.id, cardId, delta: 8, reason: "admin", at: harness.now() },
            ]);
            throw new Error("fault injected after both writes");
          }),
        ).rejects.toThrow(/fault injected/);

        expect(await store.collection.get(profile.id)).toEqual(before);
      });

      it("commits what a transaction that returns wrote", async () => {
        const profile = await activeProfile();
        const cardId = must(harness.playableIds[0], "a card");
        await store.tx(async (t) => {
          await t.collection.upsertQuantities(profile.id, [{ cardId, quantity: 3 }]);
        });
        const owned = await store.collection.get(profile.id);
        expect(must(owned.find((e) => e.cardId === cardId), "the card").quantity).toBe(3);
      });
    });

    // -----------------------------------------------------------------------
    // Loadouts (SPEC §9.4 L1-L6)
    // -----------------------------------------------------------------------

    describe("loadouts", () => {
      it("returns null before anything is saved", async () => {
        const profile = await activeProfile();
        expect(await store.loadouts.get(profile.id)).toBeNull();
      });

      it("writes all three decks and reads them back", async () => {
        const profile = await activeProfile();
        const decks = [deckOf(harness, 0), deckOf(harness, 1), deckOf(harness, 2)];
        const at = harness.now();
        await store.loadouts.replace(profile.id, harness.catalogVersion, decks, at);

        const stored = must(await store.loadouts.get(profile.id), "the saved loadout");
        expect(stored.catalogVersion).toBe(harness.catalogVersion);
        expect(stored.decks).toHaveLength(3);
        // Deck ORDER is not preserved by the schema (`app.resolve_deck` sorts by card id, and
        // §9.3's seeded shuffle is what randomises draw order), so the comparison is by set.
        expect(stored.decks.map(sorted)).toEqual(decks.map(sorted));
      });

      it("replaces a loadout wholesale rather than merging", async () => {
        const profile = await activeProfile();
        await store.loadouts.replace(
          profile.id,
          harness.catalogVersion,
          [deckOf(harness, 0), deckOf(harness, 1), deckOf(harness, 2)],
          harness.now(),
        );
        const moved = [deckOf(harness, 2), deckOf(harness, 0), deckOf(harness, 1)];
        await store.loadouts.replace(profile.id, harness.catalogVersion, moved, harness.now());

        const stored = must(await store.loadouts.get(profile.id), "the saved loadout");
        expect(stored.decks.map(sorted)).toEqual(moved.map(sorted));
      });

      /** §9.4 L4: "a card id appears in at most one deck, also enforced by a unique index." */
      it("refuses a card id that appears in two decks", async () => {
        const profile = await activeProfile();
        const clash = deckOf(harness, 0);
        await expect(
          store.loadouts.replace(
            profile.id,
            harness.catalogVersion,
            [clash, clash, deckOf(harness, 2)],
            harness.now(),
          ),
        ).rejects.toThrow();
        expect(await store.loadouts.get(profile.id)).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // Matches (SPEC §9.3's log, §9.5's lifecycle)
    // -----------------------------------------------------------------------

    describe("matches", () => {
      async function liveMatch(): Promise<MatchRow> {
        const [p1, p2] = [await activeProfile(), await activeProfile()];
        const row = matchRow(id(), p1.id, p2.id, harness, harness.now());
        await store.matches.create(row);
        return row;
      }

      it("round-trips a match row, clocks included", async () => {
        const row = await liveMatch();
        expect(await store.matches.get(row.id)).toEqual(row);
        expect(await store.matches.get(id())).toBeNull();
      });

      it("refuses a second match with the same id", async () => {
        const row = await liveMatch();
        await expect(store.matches.create({ ...row, seed: "other" })).rejects.toThrow();
      });

      /** §9.3: "Append-only action log per match." */
      it("appends actions in order and reads them back", async () => {
        const row = await liveMatch();
        await store.matches.appendActions([
          { matchId: row.id, seq: 1, action: action("p1", "n1"), at: harness.now() },
        ]);
        await store.matches.appendActions([
          { matchId: row.id, seq: 2, action: action("p2", "n2"), at: harness.now() },
          { matchId: row.id, seq: 3, action: action("p1", "n3"), at: harness.now() },
        ]);

        const log = await store.matches.actions(row.id);
        expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3]);
        expect(log.map((entry) => entry.action)).toEqual([
          action("p1", "n1"),
          action("p2", "n2"),
          action("p1", "n3"),
        ]);
        // `at` is the database's clock in Postgres (`match_actions` is append-only, so the caller
        // cannot stamp it) — see KNOWN DIVERGENCES (action timestamps).
        expect(log.every((entry) => typeof entry.at === "number")).toBe(true);
      });

      it("refuses a seq that already exists", async () => {
        const row = await liveMatch();
        await store.matches.appendActions([
          { matchId: row.id, seq: 1, action: action("p1", "n1"), at: harness.now() },
        ]);
        await expect(
          store.matches.appendActions([
            { matchId: row.id, seq: 1, action: action("p2", "clash"), at: harness.now() },
          ]),
        ).rejects.toThrow();
        expect(await store.matches.actions(row.id)).toHaveLength(1);
      });

      it("stores the clocks the clients render", async () => {
        const row = await liveMatch();
        const now = harness.now();
        const next: MatchClocks = {
          turnDeadline: now + 1_000,
          promptDeadline: now + 2_000,
          graceDeadline: { p1: now + 3_000, p2: null },
          ceilingAt: now + 4_000,
        };
        await store.matches.setClocks(row.id, next);
        expect(must(await store.matches.get(row.id), "the match").clocks).toEqual(next);
      });

      it("finishes a match and drops it out of the live set", async () => {
        const row = await liveMatch();
        expect((await store.matches.live()).map((m) => m.id)).toContain(row.id);

        const at = harness.now();
        await store.matches.finish(row.id, at);
        const finished = must(await store.matches.get(row.id), "the finished match");
        expect(finished.status).toBe("finished");
        expect(finished.finishedAt).toBe(at);
        expect((await store.matches.live()).map((m) => m.id)).not.toContain(row.id);
      });
    });

    // -----------------------------------------------------------------------
    // Rooms (SPEC §9.5's direct challenge)
    // -----------------------------------------------------------------------

    describe("rooms", () => {
      async function room(code: string, host: string, over: Partial<Parameters<Store["rooms"]["create"]>[0]> = {}) {
        const now = harness.now();
        return {
          code,
          hostProfileId: host,
          hostDeck: deckOf(harness, 0),
          catalogVersion: harness.catalogVersion,
          createdAt: now,
          expiresAt: now + 600_000,
          guestProfileId: null,
          matchId: null,
          ...over,
        };
      }

      it("creates a room and reads it back by code", async () => {
        const host = await activeProfile();
        const created = await room("ABC234", host.id);
        expect(await store.rooms.create(created)).toBe(true);

        const found = must(await store.rooms.get("ABC234"), "the room");
        expect(found.hostProfileId).toBe(host.id);
        expect(found.hostDeck).toEqual(created.hostDeck);
        expect(found.catalogVersion).toBe(harness.catalogVersion);
        expect(found.expiresAt).toBe(created.expiresAt);
        expect(found.guestProfileId).toBeNull();
        expect(found.matchId).toBeNull();
        expect(await store.rooms.get("ZZZ999")).toBeNull();
      });

      it("refuses a code that is already taken", async () => {
        const host = await activeProfile();
        const other = await activeProfile();
        expect(await store.rooms.create(await room("ABC234", host.id))).toBe(true);
        expect(await store.rooms.create(await room("ABC234", other.id))).toBe(false);
      });

      /** §9.5: the atomic single-claim — the loser of a join race never gets a second match. */
      it("lets exactly one guest claim a room", async () => {
        const host = await activeProfile();
        const guest = await activeProfile();
        const loser = await activeProfile();
        await store.rooms.create(await room("ABC234", host.id));

        const matchId = id();
        const claimed = must(await store.rooms.claim("ABC234", guest.id, matchId, harness.now()), "the claim");
        expect(claimed.guestProfileId).toBe(guest.id);
        expect(claimed.matchId).toBe(matchId);
        expect(claimed.hostDeck).toEqual(deckOf(harness, 0));

        expect(await store.rooms.claim("ABC234", loser.id, id(), harness.now())).toBeNull();
        expect(must(await store.rooms.get("ABC234"), "the room").guestProfileId).toBe(guest.id);
      });

      it("refuses a claim after the room has expired", async () => {
        const host = await activeProfile();
        const guest = await activeProfile();
        const now = harness.now();
        await store.rooms.create(await room("ABC234", host.id, { expiresAt: now + 1_000 }));
        expect(await store.rooms.claim("ABC234", guest.id, id(), now + 60_000)).toBeNull();
      });

      /** The whole room path: create -> claim -> the match the registry then writes (§9.5). */
      it("becomes a live match once the registry creates it", async () => {
        const host = await activeProfile();
        const guest = await activeProfile();
        await store.rooms.create(await room("ABC234", host.id));

        const matchId = id();
        must(await store.rooms.claim("ABC234", guest.id, matchId, harness.now()), "the claim");
        const row = matchRow(matchId, host.id, guest.id, harness, harness.now());
        await store.matches.create(row);

        expect(await store.matches.get(matchId)).toEqual(row);
        expect((await store.matches.live()).map((m) => m.id)).toContain(matchId);
      });
    });

    // -----------------------------------------------------------------------
    // Tickets (SPEC §9.5's ranked queue)
    // -----------------------------------------------------------------------

    describe("tickets", () => {
      async function ticket(profileId: string, over: Partial<Parameters<Store["tickets"]["insert"]>[0]> = {}) {
        return {
          id: id(),
          profileId,
          rating: 1000,
          deck: deckOf(harness, 0),
          catalogVersion: harness.catalogVersion,
          enqueuedAt: harness.now(),
          status: "open" as const,
          matchId: null,
          ...over,
        };
      }

      it("inserts a ticket and finds the profile's open one", async () => {
        const profile = await activeProfile();
        const row = await ticket(profile.id);
        await store.tickets.insert(row);

        expect(await store.tickets.get(row.id)).toEqual(row);
        expect(await store.tickets.openForProfile(profile.id)).toEqual(row);
        expect(await store.tickets.countOpen()).toBe(1);
        expect((await store.tickets.listOpen()).map((t) => t.id)).toEqual([row.id]);
      });

      /** `tickets_profile_queued_key`: the race-proof half of §9.5's "not already queued". */
      it("refuses a second open ticket for one profile", async () => {
        const profile = await activeProfile();
        await store.tickets.insert(await ticket(profile.id));
        await expect(store.tickets.insert(await ticket(profile.id))).rejects.toThrow();
        expect(await store.tickets.countOpen()).toBe(1);
      });

      it("cancels an open ticket, and cancelling twice is harmless", async () => {
        const profile = await activeProfile();
        const row = await ticket(profile.id);
        await store.tickets.insert(row);

        await store.tickets.cancel(row.id, harness.now());
        expect(must(await store.tickets.get(row.id), "the ticket").status).toBe("cancelled");
        expect(await store.tickets.openForProfile(profile.id)).toBeNull();
        await store.tickets.cancel(row.id, harness.now());
        expect(await store.tickets.countOpen()).toBe(0);
      });

      /** §9.5: "both tickets are claimed in one atomic statement". */
      it("claims a pair exactly once", async () => {
        const [a, b] = [await activeProfile(), await activeProfile()];
        const [ta, tb] = [await ticket(a.id), await ticket(b.id)];
        await store.tickets.insert(ta);
        await store.tickets.insert(tb);

        const matchId = id();
        expect(await store.tickets.claimPair(ta.id, tb.id, matchId, harness.now())).toBe(true);
        expect(await store.tickets.claimPair(ta.id, tb.id, id(), harness.now())).toBe(false);

        const claimed = must(await store.tickets.get(ta.id), "ticket a");
        expect(claimed.status).toBe("matched");
        expect(claimed.matchId).toBe(matchId);
        expect(await store.tickets.countOpen()).toBe(0);
      });

      it("refuses to pair a ticket with itself", async () => {
        const profile = await activeProfile();
        const row = await ticket(profile.id);
        await store.tickets.insert(row);
        expect(await store.tickets.claimPair(row.id, row.id, id(), harness.now())).toBe(false);
      });

      /** The whole queue path: claim the pair, then write the match the pair produced (§9.5). */
      it("becomes a live match once the pair is claimed and the match created", async () => {
        const [a, b] = [await activeProfile(), await activeProfile()];
        const [ta, tb] = [await ticket(a.id), await ticket(b.id)];
        await store.tickets.insert(ta);
        await store.tickets.insert(tb);

        const matchId = id();
        expect(await store.tickets.claimPair(ta.id, tb.id, matchId, harness.now())).toBe(true);
        const row = matchRow(matchId, a.id, b.id, harness, harness.now());
        await store.matches.create(row);
        expect(await store.matches.get(matchId)).toEqual(row);
      });
    });

    // -----------------------------------------------------------------------
    // Results (SPEC §2.5, §9.5)
    // -----------------------------------------------------------------------

    describe("results", () => {
      it("writes one result per match and refuses a second", async () => {
        const [a, b] = [await activeProfile(), await activeProfile()];
        const matchId = id();
        await store.matches.create(matchRow(matchId, a.id, b.id, harness, harness.now()));

        const row = {
          matchId,
          players: [a.id, b.id] as [string, string],
          winnerProfileId: a.id,
          reason: "concede" as const,
          turns: 7,
          endedAt: harness.now(),
          ratingBefore: [1000, 1000] as [number, number],
          ratingAfter: [1016, 984] as [number, number],
        };
        await store.results.insert(row);
        expect(await store.results.getByMatch(matchId)).toEqual(row);
        await expect(store.results.insert(row)).rejects.toThrow();
      });

      it("records a draw as a null winner", async () => {
        const [a, b] = [await activeProfile(), await activeProfile()];
        const matchId = id();
        await store.matches.create(matchRow(matchId, a.id, b.id, harness, harness.now()));
        await store.results.insert({
          matchId,
          players: [a.id, b.id],
          winnerProfileId: null,
          reason: "match-ceiling",
          turns: 0,
          endedAt: harness.now(),
          ratingBefore: [1000, 1000],
          ratingAfter: [1000, 1000],
        });
        expect(must(await store.results.getByMatch(matchId), "the result").winnerProfileId).toBeNull();
      });

      it("returns null for a match that has not ended", async () => {
        expect(await store.results.getByMatch(id())).toBeNull();
      });
    });

    // -----------------------------------------------------------------------
    // Transactions
    // -----------------------------------------------------------------------

    describe("tx", () => {
      it("joins a nested transaction rather than opening a second one", async () => {
        const profile = await activeProfile();
        await expect(
          store.tx(async (t) => {
            await t.tx(async (inner) => {
              await inner.profiles.setRating(profile.id, 1234);
            });
            throw new Error("outer fails after the inner one returned");
          }),
        ).rejects.toThrow(/outer fails/);

        // The inner `tx` must not have committed on its own.
        expect(must(await store.profiles.getById(profile.id), "the profile").rating).toBe(1000);
      });

      it("returns the callback's value", async () => {
        const value = await store.tx(async () => 42);
        expect(value).toBe(42);
      });
    });
  });
}

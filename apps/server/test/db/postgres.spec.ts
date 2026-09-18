/**
 * What only a real Postgres can prove about `src/db/store.ts` — the half of the store that is not
 * behaviour the in-memory fixture could ever have (`test/db/contract.ts` covers that half against
 * both). Everything here is about the DATABASE: which role the driver runs as, that `SET LOCAL`
 * really is local, that the `app.*` functions are the ones doing the work, and the schema
 * invariants the port leans on (§9.4, §9.5).
 *
 * Run with `pnpm test:db`; `.spec.ts` keeps it out of `pnpm test`.
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "pg";

import { createPostgresStore, type PostgresStore } from "../../src/db/store";
import type { Action } from "@jackioh/shared";
import { adminClient, CATALOG_VERSION, databaseUrl, PLAYABLE_IDS, seedCards } from "./harness";

const TRUNCATE = `truncate
  public.results, public.match_actions, public.tickets, public.matches,
  public.loadout_deck_cards, public.loadout_decks, public.loadouts,
  public.collection_grants, public.collection,
  public.code_attempts, public.invite_codes, public.profiles, auth.users
  restart identity cascade`;

const uuid = (): string => crypto.randomUUID();
const deckOf = (slot: number): string[] => PLAYABLE_IDS.slice(slot * 20, slot * 20 + 20);

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/**
 * The probe that answers "what was the session, inside the store's own transaction?". A trigger on
 * `public.code_attempts` — a table `codes.logAttempt` writes directly — records `current_user` and
 * `auth.uid()` as the store's statement sees them. Nothing here is faked or asserted from the
 * outside: the row is written by Postgres, during the store's call, in the store's transaction.
 */
const PROBE_SETUP = `
create schema if not exists probe;
create table if not exists probe.session_log (
  who text not null, role_setting text, uid uuid, at timestamptz not null default now());
create or replace function probe.record_session() returns trigger
language plpgsql as $$
begin
  insert into probe.session_log (who, role_setting, uid)
  values (current_user, current_setting('role', true), auth.uid());
  return new;
end $$;
drop trigger if exists code_attempts_session_probe on public.code_attempts;
create trigger code_attempts_session_probe after insert on public.code_attempts
  for each row execute function probe.record_session();
grant usage on schema probe to service_role;
grant insert on probe.session_log to service_role;
`;

const PROBE_TEARDOWN = `
drop trigger if exists code_attempts_session_probe on public.code_attempts;
drop schema if exists probe cascade;
`;

describe("postgres store, against a real database", () => {
  let admin: Client;
  let store: PostgresStore;

  beforeAll(async () => {
    admin = await adminClient();
    await admin.query(TRUNCATE);
    await seedCards(admin);
    await admin.query(PROBE_SETUP);
    // One pooled connection, so "the role and the claim do not leak" is measured on the SAME
    // physical connection rather than on a lucky second one.
    store = createPostgresStore({ connectionString: databaseUrl(), max: 1 });
  });

  afterAll(async () => {
    await store.close();
    await admin.query(PROBE_TEARDOWN);
    await admin.end();
  });

  beforeEach(async () => {
    await admin.query(TRUNCATE);
    await admin.query(`truncate probe.session_log`);
  });

  async function probeRows(): Promise<{ who: string; role_setting: string | null; uid: string | null }[]> {
    const { rows } = await admin.query<{ who: string; role_setting: string | null; uid: string | null }>(
      `select who, role_setting, uid from probe.session_log order by at, who`,
    );
    return rows;
  }

  /** A signed-up, email-verified managed-auth identity, with the profile row 0001's trigger makes. */
  async function signUp(email = `${uuid()}@example.test`): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
      [email],
    );
    return must(rows[0]?.id, "the new auth user id");
  }

  async function activeProfile(): Promise<string> {
    const userId = await signUp();
    await store.profiles.setStatus(userId, "active");
    return userId;
  }

  // -------------------------------------------------------------------------
  // The thing that bit this project before: SET LOCAL outside a transaction
  // -------------------------------------------------------------------------

  describe("the acting role (SPEC §9.1, §9.8)", () => {
    it("runs its statements as service_role, with auth.uid() set to the profile in hand", async () => {
      const userId = await signUp();
      await store.codes.logAttempt({
        profileId: userId,
        ipHash: "ip-1",
        result: "rejected",
        reason: "missing",
        at: Date.now(),
      });

      const rows = await probeRows();
      expect(rows).toHaveLength(1);
      // The connection is made as the migration owner; not one statement runs as it.
      expect(rows[0]?.who).toBe("service_role");
      expect(rows[0]?.role_setting).toBe("service_role");
      // `app.current_profile_id()` is `auth.uid()`, which every RLS policy in 0002-0004 reads.
      expect(rows[0]?.uid).toBe(userId);
    });

    it("does not leak the role or the claim into the next transaction on the same connection", async () => {
      const userId = await signUp();
      const at = Date.now();
      await store.codes.logAttempt({ profileId: userId, ipHash: "ip-1", result: "ok", reason: "redeemed", at });
      // Pool size is 1, so this is the same physical connection. `SET LOCAL` is undone at commit,
      // so the second transaction must start from nothing and set its own (null) subject — if the
      // GUC leaked, `uid` below would still be the first profile.
      await store.codes.logAttempt({ profileId: null, ipHash: "ip-2", result: "rejected", reason: "missing", at });

      const rows = await probeRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.uid)).toEqual([userId, null]);
      expect(rows.every((row) => row.who === "service_role")).toBe(true);
    });

    it("stamps each statement's own subject inside one transaction", async () => {
      const [a, b] = [await signUp(), await signUp()];
      const at = Date.now();
      await store.tx(async (t) => {
        await t.codes.logAttempt({ profileId: a, ipHash: "ip", result: "rejected", reason: "x", at });
        await t.codes.logAttempt({ profileId: b, ipHash: "ip", result: "rejected", reason: "x", at });
      });
      const rows = await probeRows();
      expect(rows).toHaveLength(2);
      // One `begin`, one role switch, two subjects: `auth.uid()` follows the profile each statement
      // is about rather than being stuck on whoever opened the transaction.
      expect(new Set(rows.map((row) => row.uid))).toEqual(new Set([a, b]));
      expect(rows.every((row) => row.who === "service_role")).toBe(true);
    });

    it("acts inside one transaction per call: a failed write leaves nothing behind", async () => {
      const userId = await signUp();
      // `profiles.current_match_id` is a foreign key into `public.matches`, so this raises.
      await expect(store.profiles.setInMatch(userId, uuid())).rejects.toThrow();
      const { rows } = await admin.query<{ current_match_id: string | null }>(
        `select current_match_id from public.profiles where id = $1`,
        [userId],
      );
      expect(rows[0]?.current_match_id).toBeNull();
      // And the connection is still usable: the rollback happened, rather than the client being
      // left in a failed transaction.
      expect(await store.profiles.getById(userId)).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Migration 0001's signup trigger and R111's launch-grant trigger
  // -------------------------------------------------------------------------

  describe("triggers the application never sees", () => {
    it("provisions a pending profile for a new auth user (0001 on_auth_user_created)", async () => {
      const userId = await signUp();
      const profile = must(await store.profiles.getByUserId(userId), "the auto-provisioned profile");
      expect(profile.status).toBe("pending");
      expect(profile.id).toBe(userId);
      expect(profile.rating).toBe(1000);
    });

    it("R111: the launch grant writes both ledger tables through app.grant_cards", async () => {
      const userId = await signUp();
      await store.profiles.setStatus(userId, "active");

      const owned = await store.collection.get(userId);
      expect(owned).toHaveLength(PLAYABLE_IDS.length);

      const { rows } = await admin.query<{ n: string; reason: string }>(
        `select count(*)::text as n, min(reason) as reason
           from public.collection_grants where profile_id = $1 group by reason`,
        [userId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reason).toBe("launch");
      expect(Number(rows[0]?.n)).toBe(PLAYABLE_IDS.length);
    });
  });

  // -------------------------------------------------------------------------
  // SPEC §9.4's redemption, as the one database transaction the spec describes
  // -------------------------------------------------------------------------

  describe("app.redeem_invite_code (SPEC §9.4)", () => {
    async function mint(over: { maxUses?: number; expiresAt?: number | null; revoked?: boolean } = {}) {
      const code = {
        id: uuid(),
        codeHash: `hash-${uuid()}`,
        maxUses: over.maxUses ?? 1,
        uses: 0,
        revoked: over.revoked ?? false,
        expiresAt: over.expiresAt ?? null,
        createdAt: Date.now(),
      };
      await store.codes.insert(code);
      return code;
    }

    it("flips pending to active and consumes one use, in one call", async () => {
      const userId = await signUp();
      const code = await mint();

      expect(await store.redeemInviteCode({ profileId: userId, codeHash: code.codeHash, ipHash: "ip" })).toBe("ok");

      expect(must(await store.profiles.getById(userId), "the profile").status).toBe("active");
      expect(must(await store.codes.findByHash(code.codeHash), "the code").uses).toBe(1);
      // §9.4 step 4, and R111's trigger on the way past: both ledgers were written too.
      expect(await store.collection.get(userId)).toHaveLength(PLAYABLE_IDS.length);
    });

    it("gives missing, expired, revoked and exhausted codes the same answer", async () => {
      const expired = await mint({ expiresAt: Date.now() - 60_000 });
      const revoked = await mint({ revoked: true });
      const exhausted = await mint();
      await store.codes.claim(exhausted.id, Date.now());

      for (const codeHash of ["no-such-hash", expired.codeHash, revoked.codeHash, exhausted.codeHash]) {
        const userId = await signUp();
        expect(await store.redeemInviteCode({ profileId: userId, codeHash, ipHash: "ip" })).toBe("invalid_code");
        expect(must(await store.profiles.getById(userId), "the profile").status).toBe("pending");
      }
    });

    it("refuses an account that is not pending, and one with an unverified email", async () => {
      const code = await mint({ maxUses: 5 });

      const active = await activeProfile();
      expect(await store.redeemInviteCode({ profileId: active, codeHash: code.codeHash, ipHash: "ip" })).toBe(
        "not_pending",
      );

      const unverified = await signUp();
      await admin.query(`update auth.users set email_confirmed_at = null where id = $1`, [unverified]);
      expect(await store.redeemInviteCode({ profileId: unverified, codeHash: code.codeHash, ipHash: "ip" })).toBe(
        "email_unverified",
      );
    });

    it("rate-limits a profile past 5 attempts in the hour (§9.4 step 2)", async () => {
      const userId = await signUp();
      const code = await mint({ maxUses: 99 });
      for (let i = 0; i < 6; i += 1) {
        await store.codes.logAttempt({
          profileId: userId,
          ipHash: "ip",
          result: "rejected",
          reason: "missing",
          at: Date.now(),
        });
      }
      expect(await store.redeemInviteCode({ profileId: userId, codeHash: code.codeHash, ipHash: "ip" })).toBe(
        "rate_limited_profile",
      );
    });

    it("logs the attempt either way (§9.4 step 4)", async () => {
      const userId = await signUp();
      await store.redeemInviteCode({ profileId: userId, codeHash: "no-such-hash", ipHash: "ip-1" });
      expect(await store.codes.countAttemptsByProfile(userId, Date.now() - 60_000)).toBe(1);
      expect(await store.codes.countFailures(Date.now() - 60_000)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // app.save_loadout: the SQL is stricter than the port, on purpose
  // -------------------------------------------------------------------------

  describe("app.save_loadout (SPEC §9.4 L1-L6)", () => {
    it("refuses a stale catalog version with 'update required'", async () => {
      const userId = await activeProfile();
      await expect(
        store.loadouts.replace(userId, "core-0", [deckOf(0), deckOf(1), deckOf(2)], Date.now()),
      ).rejects.toThrow(/update required/);
    });

    it("refuses a deck that is not exactly DECK_SIZE cards (L2)", async () => {
      const userId = await activeProfile();
      await expect(
        store.loadouts.replace(userId, CATALOG_VERSION, [deckOf(0).slice(0, 19), deckOf(1), deckOf(2)], Date.now()),
      ).rejects.toThrow(/L2/);
    });

    it("refuses a card the profile does not own (L5)", async () => {
      const userId = await activeProfile();
      // R111's trigger has just granted the whole catalog; take it away again, which is the only
      // way to reach L5 in launch mode ("everyone owns every card at launch", §9.1).
      await admin.query(`delete from public.collection where profile_id = $1`, [userId]);
      await expect(
        store.loadouts.replace(userId, CATALOG_VERSION, [deckOf(0), deckOf(1), deckOf(2)], Date.now()),
      ).rejects.toThrow(/L5/);
    });

    it("refuses a loadout for a profile that is not active (§9.4's gate)", async () => {
      const userId = await signUp();
      await expect(
        store.loadouts.replace(userId, CATALOG_VERSION, [deckOf(0), deckOf(1), deckOf(2)], Date.now()),
      ).rejects.toThrow(/not active/);
    });

    it("leaves the previous loadout untouched when a save is refused", async () => {
      const userId = await activeProfile();
      const good = [deckOf(0), deckOf(1), deckOf(2)];
      await store.loadouts.replace(userId, CATALOG_VERSION, good, Date.now());

      await expect(
        store.loadouts.replace(userId, CATALOG_VERSION, [deckOf(0).slice(0, 19), deckOf(1), deckOf(2)], Date.now()),
      ).rejects.toThrow();

      const stored = must(await store.loadouts.get(userId), "the surviving loadout");
      expect(stored.decks.map((deck) => [...deck].sort())).toEqual(good.map((deck) => [...deck].sort()));
    });
  });

  // -------------------------------------------------------------------------
  // app.append_match_action: the nonce dedupe the port cannot express
  // -------------------------------------------------------------------------

  describe("app.append_match_action (SPEC §9.3)", () => {
    async function liveMatch(): Promise<{ id: string; p1: string; p2: string }> {
      const [p1, p2] = [await activeProfile(), await activeProfile()];
      const matchId = uuid();
      const now = Date.now();
      await store.matches.create({
        id: matchId,
        seed: "seed-1",
        players: [p1, p2],
        decks: [deckOf(0), deckOf(1)],
        catalogVersion: CATALOG_VERSION,
        status: "live",
        createdAt: now,
        finishedAt: null,
        clocks: { turnDeadline: null, promptDeadline: null, graceDeadline: { p1: null, p2: null }, ceilingAt: now + 1000 },
      });
      return { id: matchId, p1, p2 };
    }

    const action = (playerId: "p1" | "p2", nonce: string): Action => ({ type: "endTurn", playerId, nonce });

    it("keeps matches.last_seq in step with the seq the actor assigns", async () => {
      const match = await liveMatch();
      for (let seq = 1; seq <= 3; seq += 1) {
        await store.matches.appendActions([
          { matchId: match.id, seq, action: action("p1", `n${String(seq)}`), at: Date.now() },
        ]);
      }
      const { rows } = await admin.query<{ last_seq: string }>(
        `select last_seq::text from public.matches where id = $1`,
        [match.id],
      );
      expect(Number(rows[0]?.last_seq)).toBe(3);
    });

    it("records the seat's profile id alongside the action", async () => {
      const match = await liveMatch();
      await store.matches.appendActions([
        { matchId: match.id, seq: 1, action: action("p2", "n1"), at: Date.now() },
      ]);
      const { rows } = await admin.query<{ player_id: string; player_seat: string }>(
        `select player_id, player_seat from public.match_actions where match_id = $1`,
        [match.id],
      );
      expect(rows[0]?.player_seat).toBe("p2");
      expect(rows[0]?.player_id).toBe(match.p2);
    });

    it("raises rather than double-writing when a nonce is replayed", async () => {
      const match = await liveMatch();
      await store.matches.appendActions([
        { matchId: match.id, seq: 1, action: action("p1", "same"), at: Date.now() },
      ]);
      await expect(
        store.matches.appendActions([
          { matchId: match.id, seq: 2, action: action("p1", "same"), at: Date.now() },
        ]),
      ).rejects.toThrow(/append-only/);
      expect(await store.matches.actions(match.id)).toHaveLength(1);
    });

    it("cannot edit or delete a logged action (app.deny_row_mutation)", async () => {
      const match = await liveMatch();
      await store.matches.appendActions([
        { matchId: match.id, seq: 1, action: action("p1", "n1"), at: Date.now() },
      ]);
      await expect(
        admin.query(`update public.match_actions set nonce = 'edited' where match_id = $1`, [match.id]),
      ).rejects.toThrow(/append-only/);
    });
  });

  // -------------------------------------------------------------------------
  // The two atomic claims (§9.5), under genuine concurrency
  // -------------------------------------------------------------------------

  describe("concurrency (SPEC §9.5)", () => {
    it("lets only one of two simultaneous joiners claim a room", async () => {
      const host = await activeProfile();
      const [a, b] = [await activeProfile(), await activeProfile()];
      const now = Date.now();
      await store.rooms.create({
        code: "ABC234",
        hostProfileId: host,
        hostDeck: deckOf(0),
        catalogVersion: CATALOG_VERSION,
        createdAt: now,
        expiresAt: now + 600_000,
        guestProfileId: null,
        matchId: null,
      });

      const results = await Promise.all([
        store.rooms.claim("ABC234", a, uuid(), now),
        store.rooms.claim("ABC234", b, uuid(), now),
      ]);
      expect(results.filter((room) => room !== null)).toHaveLength(1);
    });

    it("lets only one of two simultaneous matchers claim the same ticket pair", async () => {
      const [a, b] = [await activeProfile(), await activeProfile()];
      const tickets = [a, b].map((profileId) => ({
        id: uuid(),
        profileId,
        rating: 1000,
        deck: deckOf(0),
        catalogVersion: CATALOG_VERSION,
        enqueuedAt: Date.now(),
        status: "open" as const,
        matchId: null,
      }));
      for (const ticket of tickets) await store.tickets.insert(ticket);

      const [ta, tb] = tickets;
      const won = await Promise.all([
        store.tickets.claimPair(must(ta, "ticket a").id, must(tb, "ticket b").id, uuid(), Date.now()),
        store.tickets.claimPair(must(ta, "ticket a").id, must(tb, "ticket b").id, uuid(), Date.now()),
      ]);
      expect(won.filter(Boolean)).toHaveLength(1);
    });

    it("lets only one of two simultaneous redemptions consume the last use", async () => {
      const code = { id: uuid(), codeHash: `hash-${uuid()}`, maxUses: 1, uses: 0, revoked: false, expiresAt: null, createdAt: Date.now() };
      await store.codes.insert(code);
      const claims = await Promise.all([
        store.codes.claim(code.id, Date.now()),
        store.codes.claim(code.id, Date.now()),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(must(await store.codes.findByHash(code.codeHash), "the code").uses).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // The boot path this file exists to close (src/index.ts)
  // -------------------------------------------------------------------------

  it("src/index.ts's loadStore finds this module, and what it loads works", async () => {
    // Run through `tsx`, the way `pnpm --dir apps/server start` does: `loadStore` imports a
    // VARIABLE specifier (`./db/store`), which vitest's module runner cannot resolve but the real
    // runtime can. See test/db/loadstore-boot.ts.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const repo = resolve(here, "../../../..");
    const { stdout } = await promisify(execFile)(
      resolve(repo, "node_modules/.bin/tsx"),
      [resolve(here, "loadstore-boot.ts")],
      { env: { ...process.env, DATABASE_URL: databaseUrl() } },
    );
    expect(stdout.trim()).toMatch(/^loadstore: ok \d+$/);
  }, 60_000);

  // -------------------------------------------------------------------------
  // The reaper's input (§9.5)
  // -------------------------------------------------------------------------

  it("app.live_matches backs matches.live(), and an open room is not one", async () => {
    const host = await activeProfile();
    const guest = await activeProfile();
    const now = Date.now();
    await store.rooms.create({
      code: "ABC234",
      hostProfileId: host,
      hostDeck: deckOf(0),
      catalogVersion: CATALOG_VERSION,
      createdAt: now,
      expiresAt: now + 600_000,
      guestProfileId: null,
      matchId: null,
    });
    expect(await store.matches.live()).toEqual([]);

    const matchId = uuid();
    await store.rooms.claim("ABC234", guest, matchId, now);
    // Claimed but not yet created by the registry: still not a match anyone can fold.
    expect(await store.matches.live()).toEqual([]);
    expect(await store.matches.get(matchId)).toBeNull();

    await store.matches.create({
      id: matchId,
      seed: "seed-1",
      players: [host, guest],
      decks: [deckOf(0), deckOf(1)],
      catalogVersion: CATALOG_VERSION,
      status: "live",
      createdAt: now,
      finishedAt: null,
      clocks: { turnDeadline: null, promptDeadline: null, graceDeadline: { p1: null, p2: null }, ceilingAt: now + 1000 },
    });
    expect((await store.matches.live()).map((m) => m.id)).toEqual([matchId]);
  });
});

// Admin script: creates ready-to-play test accounts.
//
// Not part of BUILD. It exists because the ordinary path to a playable account has three manual
// steps -- sign up, click a confirmation link in a real inbox, redeem an invite code -- and none
// of them is what you want when you are testing the game itself.
//
// It skips the inbox on purpose. `POST /auth/v1/admin/users` with `email_confirm: true` creates an
// account whose email is already verified, which satisfies §9.4 step 1 ("reject unless the account
// is pending with a verified email") without an email ever being sent. That also sidesteps
// Supabase's Site URL entirely -- a project whose Site URL still points at localhost mails a
// confirmation link nobody on a deployed site can use.
//
// It then flips `profiles.status` to 'active'. That is a real activation, not a shortcut around
// one: migration 0002's `profiles_grant_launch_collection` trigger fires on exactly that
// transition and calls `app.grant_launch_collection`, so the account ends up with the same
// entitlement ledger a redeemed invite code would have produced. What it skips is the invite gate
// (§9.4's six-step redemption), which is the point -- that path has its own tests.
//
// REFUSES TO RUN AGAINST NODE_ENV=production. These are accounts with known passwords.

import { randomUUID } from "node:crypto";

import { Client } from "pg";

import { TRIO_DECKS } from "../api/loadout-validator";
import { MAX_SAVED_DECKS, MAX_SAVED_TRIOS } from "../config";
import { loadEnv } from "../env";

/** Known-weak by design; these accounts are for a test deployment, never a real one. */
const DEFAULT_COUNT = 2;
const PASSWORD = "jackioh-test-account";
const EMAIL_DOMAIN = "example.com";

export type SeededAccount = {
  email: string;
  password: string;
  userId: string;
  created: boolean;
};

function emailFor(index: number): string {
  return `player${String(index)}@${EMAIL_DOMAIN}`;
}

type AdminUser = { id?: unknown; msg?: unknown; error_code?: unknown };

/**
 * Creates one already-confirmed account, or returns the existing one. Supabase answers a duplicate
 * with 422 `email_exists`, which is not a failure here: the script is meant to be re-runnable.
 */
async function createOrFindUser(
  env: { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string },
  email: string,
): Promise<{ id: string; created: boolean }> {
  const headers = {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
  };

  const created = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = (await created.json().catch(() => ({}))) as AdminUser;

  if (created.ok && typeof body.id === "string") {
    return { id: body.id, created: true };
  }

  // Already there: find it by email so a re-run is a no-op rather than an error.
  const listed = await fetch(
    `${env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`,
    { headers },
  );
  const users = (await listed.json().catch(() => ({}))) as {
    users?: { id?: unknown; email?: unknown }[];
  };
  const found = users.users?.find((u) => u.email === email);
  if (found !== undefined && typeof found.id === "string") {
    return { id: found.id, created: false };
  }

  throw new Error(
    `could not create or find ${email}: ${created.status} ${JSON.stringify(body)}`,
  );
}

/**
 * Three legal decks and a trio of them, so a seeded account can queue immediately in any mode —
 * Best of 1 with any of the decks, Conquest with the trio (SPEC §9.5, R257) — instead of building
 * 60 cards by hand before it can play once.
 *
 * Saved through `app.upsert_deck` and `app.upsert_trio` (migration 0007) rather than by writing
 * `public.decks` and `public.trios` directly, because those functions are the one write path the
 * server uses too: they take the profile lock, apply the caps and refuse a shape the builder could
 * not have produced. A saved deck is only a draft (R250), so the legality that matters here is the
 * queue's (R253): `DECK_SIZE` cards each, and — for the trio — no card in two decks.
 *
 * `MAX_COPIES` is 1, so the format is singleton and the three decks need 60 DISTINCT non-token
 * cards. The launch grant gives every active profile all 100 of them, so ordering by id and slicing
 * is enough; no deck here is trying to be good, only legal.
 *
 * Re-runnable: a profile that already holds a deck or a trio is left alone, so a second run neither
 * piles up starters nor touches decks a tester has built since.
 */
async function saveStarterDecks(
  client: Client,
  profileId: string,
  catalogVersion: string,
): Promise<void> {
  const { rows: held } = await client.query<{ n: string }>(
    `select ((select count(*) from public.decks where profile_id = $1)
           + (select count(*) from public.trios where profile_id = $1))::text as n`,
    [profileId],
  );
  if (Number(held[0]?.n ?? "0") > 0) return;

  const { rows } = await client.query<{ id: string }>(
    "select id from public.cards where not token and catalog_version = $1 order by id",
    [catalogVersion],
  );
  const ids = rows.map((r) => r.id);

  // The database's own copy of `DECK_SIZE` (migration 0003), which `app.upsert_deck` checks a deck
  // against: read rather than imported, since `src/match/engine.real.ts` is the one file in this
  // app that imports the engine.
  const { rows: sizes } = await client.query<{ deck_size: number | null }>(
    "select (app.setting('deck_size'))::text::int as deck_size",
  );
  const deckSize = sizes[0]?.deck_size;
  if (deckSize === null || deckSize === undefined) {
    throw new Error("app.settings has no deck_size: is migration 0003 applied?");
  }

  const needed = deckSize * TRIO_DECKS;
  if (ids.length < needed) {
    throw new Error(
      `need ${String(needed)} distinct non-token cards for ${String(TRIO_DECKS)} decks of ` +
        `${String(deckSize)}, but the catalog has ${String(ids.length)}`,
    );
  }

  const deckIds: string[] = [];
  for (let i = 0; i < TRIO_DECKS; i += 1) {
    const deckId = randomUUID();
    const cards = ids.slice(i * deckSize, (i + 1) * deckSize);
    const { rows: saved } = await client.query<{ outcome: string }>(
      "select app.upsert_deck($1::uuid, $2::uuid, $3::text, $4::jsonb, $5::text, now(), $6::int) as outcome",
      [profileId, deckId, `Starter ${String(i + 1)}`, JSON.stringify(cards), catalogVersion, MAX_SAVED_DECKS],
    );
    if (saved[0]?.outcome !== "created") {
      throw new Error(`app.upsert_deck answered ${String(saved[0]?.outcome)} for starter deck ${String(i + 1)}`);
    }
    deckIds.push(deckId);
  }

  const { rows: trio } = await client.query<{ outcome: string }>(
    "select app.upsert_trio($1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::uuid, now(), $7::int) as outcome",
    [profileId, randomUUID(), "Starter trio", deckIds[0], deckIds[1], deckIds[2], MAX_SAVED_TRIOS],
  );
  if (trio[0]?.outcome !== "created") {
    throw new Error(`app.upsert_trio answered ${String(trio[0]?.outcome)} for the starter trio`);
  }
}

export async function seedAccounts(count: number): Promise<SeededAccount[]> {
  const env = loadEnv();
  if (env.NODE_ENV === "production") {
    throw new Error(
      "refusing to seed accounts with NODE_ENV=production: these have known passwords.",
    );
  }

  const out: SeededAccount[] = [];
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    for (let i = 1; i <= count; i += 1) {
      const email = emailFor(i);
      const { id, created } = await createOrFindUser(env, email);

      // `app.handle_new_user` inserts the profile from an auth.users trigger; that runs in
      // Supabase's transaction, not ours, so the row can lag a beat behind the API response.
      let profileExists = false;
      for (let attempt = 0; attempt < 20 && !profileExists; attempt += 1) {
        const { rowCount } = await client.query("select 1 from public.profiles where id = $1", [id]);
        profileExists = (rowCount ?? 0) > 0;
        if (!profileExists) await new Promise((r) => setTimeout(r, 250));
      }
      if (!profileExists) {
        throw new Error(`no profiles row appeared for ${email} (${id}) — is migration 0001 applied?`);
      }

      // The real activation: this UPDATE is what `profiles_grant_launch_collection` watches.
      await client.query(
        "update public.profiles set status = 'active', activated_at = coalesce(activated_at, now()) " +
          "where id = $1 and status <> 'active'",
        [id],
      );

      await saveStarterDecks(client, id, env.CATALOG_VERSION);
      out.push({ email, password: PASSWORD, userId: id, created });
    }
  } finally {
    await client.end();
  }

  return out;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const count = arg === undefined ? DEFAULT_COUNT : Number(arg);
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error(`account count must be an integer between 1 and 20 (got ${String(arg)})`);
  }

  const accounts = await seedAccounts(count);
  process.stderr.write(`seed-accounts: ${String(accounts.length)} account(s), all active\n`);
  for (const a of accounts) {
    process.stdout.write(`${a.email}  ${a.password}  ${a.created ? "created" : "already existed"}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

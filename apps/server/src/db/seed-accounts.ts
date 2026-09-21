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

import { Client } from "pg";

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

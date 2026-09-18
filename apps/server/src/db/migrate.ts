// Migration runner. Applies every file in ./migrations in lexical order over DATABASE_URL and
// records what it applied in `app.migrations`, so bring-up is one command against a fresh Supabase
// project (docs/architecture.md, step 4 of the bring-up checklist).
//
// Why not the Supabase CLI: `supabase db push` only reads `supabase/migrations/<timestamp>_<name>.sql`,
// and BUILD §1 puts the canonical SQL at `apps/server/src/db/migrations/`. The SQL is plain Postgres,
// so either path works; this runner is the one the checklist uses because it needs nothing but a
// connection string. See docs/architecture.md for the CLI variant.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** One advisory lock id for the whole runner, so two deploys cannot interleave migrations. */
const LOCK_ID = 0x6a61636b; // "jack"

const LEDGER = `
create schema if not exists app;
create table if not exists app.migrations (
  filename   text primary key,
  applied_at timestamptz not null default now(),
  checksum   text not null
);
comment on table app.migrations is
  'Which files in apps/server/src/db/migrations have been applied. Written by src/db/migrate.ts.';
`;

/** FNV-1a, so a changed file that was already applied is reported instead of silently skipped. */
function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function listMigrations(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith(".sql")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function migrate(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(LEDGER);

    const done = new Map<string, string>();
    const ledger = await client.query<{ filename: string; checksum: string }>(
      "select filename, checksum from app.migrations",
    );
    for (const row of ledger.rows) done.set(row.filename, row.checksum);

    for (const filename of await listMigrations()) {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
      const sum = checksum(sql);
      const previous = done.get(filename);

      if (previous !== undefined) {
        if (previous !== sum) {
          throw new Error(
            `${filename} was already applied but its contents changed (${previous} -> ${sum}). ` +
              `Migrations are append-only: add a new file instead of editing this one.`,
          );
        }
        continue;
      }

      // One transaction per file: a migration either lands whole or not at all.
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into app.migrations (filename, checksum) values ($1, $2)", [
          filename,
          sum,
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(
          `${filename} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      applied.push(filename);
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    await client.end();
  }

  return applied;
}

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    throw new Error(
      "DATABASE_URL is not set. Supabase dashboard -> Project Settings -> Database -> " +
        "Connection string -> URI (or the local value printed by `supabase start`).",
    );
  }

  const applied = await migrate(connectionString);
  if (applied.length === 0) {
    process.stdout.write("migrate: nothing to do, the database is up to date\n");
    return;
  }
  for (const filename of applied) process.stdout.write(`migrate: applied ${filename}\n`);
}

// Only run when invoked directly, so tests can import `migrate` without side effects.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

// Admin script: mints one invite code and prints the plaintext exactly once (SPEC §9.4).
//
// Step 7 of docs/architecture.md's bring-up checklist, which BUILD M6-T1 owes as "an admin
// script". Every account starts `pending` and a pending account can do nothing but look at the
// code screen, so until a code exists there is no way into the game.
//
// Why this reads the whole environment through `loadEnv()` when it only needs two variables:
// the hash stored here has to be byte-identical to the one the running server computes when it
// redeems, and `loadEnv` plus the `${CODE_PEPPER}:code` derivation below is the single contract
// that guarantees it. `migrate.ts` and `seed-catalog.ts` read `process.env` directly because a
// connection string that is wrong fails loudly on the first query; a pepper that is merely
// *different* mints a well-formed code that nobody can ever redeem, and nothing reports it.

import { mintInviteCode } from "../api/codes";
import { createHashes, systemIds } from "../api/crypto";
import { systemTimers } from "../api/ports";
import { loadEnv } from "../env";
import { createPostgresStore } from "./store";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const USAGE = `Usage: pnpm --filter @jackioh/server codes:mint [options]

  --max-uses=N          How many accounts this code activates. Default 1 (R161).
  --expires-in-days=N   Expire the code N days from now. Default: never expires.

Prints the plaintext code once. Only its keyed hash is stored, so a lost code
cannot be recovered — mint another.`;

export type MintOptions = {
  maxUses?: number;
  expiresInDays?: number;
};

/** Parses `--flag=value` arguments, rejecting anything it does not recognise. */
export function parseMintArgs(argv: readonly string[]): MintOptions {
  const options: MintOptions = {};

  for (const arg of argv) {
    const match = /^--(?<name>[a-z-]+)=(?<value>.*)$/u.exec(arg);
    const name = match?.groups?.["name"];
    const raw = match?.groups?.["value"];
    if (name === undefined || raw === undefined) {
      throw new Error(`Unrecognised argument ${JSON.stringify(arg)}.\n\n${USAGE}`);
    }

    // The name is checked before the value, so `--label=bring-up` is reported as the unknown
    // option it is rather than as a malformed number.
    if (name !== "max-uses" && name !== "expires-in-days") {
      throw new Error(`Unrecognised option --${name}.\n\n${USAGE}`);
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `--${name} must be a positive integer (got ${JSON.stringify(raw)}).\n\n${USAGE}`,
      );
    }

    if (name === "max-uses") {
      options.maxUses = value;
    } else {
      options.expiresInDays = value;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseMintArgs(process.argv.slice(2));
  const env = loadEnv();

  // One connection: this process runs a single insert and exits.
  const store = createPostgresStore({ connectionString: env.DATABASE_URL, max: 1 });
  try {
    const expiresAt =
      options.expiresInDays === undefined
        ? null
        : systemTimers.now() + options.expiresInDays * MS_PER_DAY;

    const minted = await mintInviteCode(
      {
        store,
        ids: systemIds,
        // §9.4, §9.8: one pepper in the environment, two domains — the same derivation
        // `src/index.ts` uses, so this code hashes to what redemption will look up.
        hashes: createHashes({ code: `${env.CODE_PEPPER}:code`, ip: `${env.CODE_PEPPER}:ip` }),
        timers: systemTimers,
      },
      { maxUses: options.maxUses, expiresAt },
    );

    // The plaintext goes to stdout and the metadata to stderr, so `codes:mint > code.txt`
    // captures the code alone.
    process.stderr.write(
      `codes:mint: id ${minted.id}, max uses ${String(options.maxUses ?? 1)}, ` +
        `${expiresAt === null ? "never expires" : `expires ${new Date(expiresAt).toISOString()}`}\n` +
        "codes:mint: this is the only time the code is shown; the database holds only its hash.\n",
    );
    process.stdout.write(`${minted.formatted}\n`);
  } finally {
    await store.close();
  }
}

// Only run when invoked directly, so a test can import `parseMintArgs` without side effects.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
